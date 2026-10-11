//! What a script Agent may ask the daemon about model providers.
//!
//! The daemon keeps the providers a person configured (address, protocol,
//! key, models). A script Agent that wants to run its own CLI on one of them
//! needs the whole configuration, key included, to assemble that CLI's
//! settings — and only the script knows how. So the platform offers exactly
//! one thing: on the private pipe to that script, answer "list" (everything
//! but keys) and "get one" (everything).
//!
//! The pipe, not the command line: a command is available to every process on
//! the machine, including whatever shell tool a model drives, and a key that
//! a command can print is a key that can reach a model. Nothing here is
//! logged, and a script gets nothing it did not ask for by id.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, RwLock};

use serde_json::{json, Value};

use crate::config::ProviderConfig;

pub type Providers = BTreeMap<String, ProviderConfig>;
pub type Lookup = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Providers> + Send>> + Send + Sync>;

/// Where the daemon's providers come from. Filled in once the daemon state
/// exists; before that every question is answered with "not available yet".
#[derive(Clone, Default)]
pub struct ProviderSource(Arc<RwLock<Option<Lookup>>>);

impl ProviderSource {
    pub fn set(&self, lookup: Lookup) {
        *self.0.write().expect("never poisoned") = Some(lookup);
    }

    pub async fn all(&self) -> Option<Providers> {
        let lookup = self.0.read().expect("never poisoned").clone()?;
        Some(lookup().await)
    }
}

/// The reply frame for one `provider.request`. `error` is for the person.
pub fn reply(id: &str, answer: Result<Value, String>) -> Value {
    match answer {
        Ok(result) => json!({ "id": id, "result": result }),
        Err(error) => json!({ "id": id, "error": error }),
    }
}

/// Answers `op` (`list` or `get`) over `all`, which is already resolved:
/// addresses filled in, models known, a provider without a usable address
/// carrying none.
pub fn answer(op: &str, provider: Option<&str>, all: &Providers) -> Result<Value, String> {
    match op {
        "list" => Ok(json!({
            "providers": all.iter().map(|(id, config)| describe(id, config, false)).collect::<Vec<_>>()
        })),
        "get" => {
            let id = provider
                .filter(|id| !id.is_empty())
                .ok_or_else(|| "没有指定 provider".to_string())?;
            let config = all
                .get(id)
                .ok_or_else(|| format!("没有名为 {id} 的 provider"))?;
            let label = config.label.clone().unwrap_or_else(|| id.to_string());
            if config.api_key.as_deref().unwrap_or("").is_empty() {
                return Err(format!("{label} 还没有保存 API Key"));
            }
            if config.base_url.as_deref().unwrap_or("").is_empty() {
                return Err(match config.problem.as_deref() {
                    Some(problem) if !problem.is_empty() => {
                        format!("{label} 的地址不可用：{problem}")
                    }
                    _ => format!("{label} 没有可用的接口地址"),
                });
            }
            Ok(json!({ "provider": describe(id, config, true) }))
        }
        other => Err(format!("不认识的 provider 操作：{other}")),
    }
}

fn describe(id: &str, config: &ProviderConfig, with_key: bool) -> Value {
    let has_key = !config.api_key.as_deref().unwrap_or("").is_empty();
    let has_address = !config.base_url.as_deref().unwrap_or("").is_empty();
    let mut value = json!({
        "id": id,
        "label": config.label.clone().unwrap_or_else(|| id.to_string()),
        "dialect": config.dialect.clone().unwrap_or_else(|| "openai".into()),
        "baseUrl": config.base_url,
        "models": config.models,
        "hasApiKey": has_key,
        "usable": has_key && has_address,
        "problem": config.problem,
    });
    if with_key {
        value["apiKey"] = json!(config.api_key);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(key: Option<&str>, url: Option<&str>) -> ProviderConfig {
        ProviderConfig {
            api_key: key.map(str::to_string),
            base_url: url.map(str::to_string),
            label: Some("DeepSeek".into()),
            dialect: Some("openai".into()),
            models: vec!["deepseek-chat".into()],
            ..ProviderConfig::default()
        }
    }

    fn all() -> Providers {
        let mut all = Providers::new();
        all.insert(
            "deepseek".into(),
            config(Some("sk-secret"), Some("https://api.deepseek.com/v1")),
        );
        all.insert("nokey".into(), config(None, Some("https://example.com/v1")));
        all.insert("noaddress".into(), config(Some("sk-x"), None));
        all
    }

    #[test]
    fn a_listing_never_carries_a_key() {
        let listed = answer("list", None, &all()).expect("list works");
        assert!(!listed.to_string().contains("sk-secret"));
        let first = &listed["providers"][0];
        assert_eq!(first["id"], "deepseek");
        assert_eq!(first["usable"], true);
        assert_eq!(
            listed["providers"][1]["usable"], false,
            "no key, not usable"
        );
        assert_eq!(
            listed["providers"][2]["usable"], false,
            "no address, not usable"
        );
    }

    #[test]
    fn getting_one_returns_its_whole_configuration() {
        let got = answer("get", Some("deepseek"), &all()).expect("get works");
        assert_eq!(got["provider"]["apiKey"], "sk-secret");
        assert_eq!(got["provider"]["baseUrl"], "https://api.deepseek.com/v1");
        assert_eq!(got["provider"]["models"][0], "deepseek-chat");
        assert_eq!(got["provider"]["dialect"], "openai");
    }

    #[test]
    fn what_cannot_be_used_is_refused_with_a_reason() {
        let providers = all();
        assert!(answer("get", Some("missing"), &providers)
            .unwrap_err()
            .contains("没有名为 missing"));
        assert!(answer("get", Some("nokey"), &providers)
            .unwrap_err()
            .contains("API Key"));
        assert!(answer("get", Some("noaddress"), &providers)
            .unwrap_err()
            .contains("地址"));
        assert!(answer("get", None, &providers).is_err());
        assert!(answer("rotate", None, &providers).is_err());
    }

    #[test]
    fn an_address_the_daemon_refused_says_why() {
        let mut providers = all();
        providers.get_mut("noaddress").unwrap().problem = Some("只能通过 https 发送密钥".into());
        let error = answer("get", Some("noaddress"), &providers).unwrap_err();
        assert!(error.contains("只能通过 https"), "{error}");
    }

    #[test]
    fn a_reply_frame_is_either_a_result_or_an_error() {
        assert_eq!(
            reply("r1", Ok(json!({"a": 1}))),
            json!({"id": "r1", "result": {"a": 1}})
        );
        assert_eq!(
            reply("r1", Err("没有".into())),
            json!({"id": "r1", "error": "没有"})
        );
    }
}
