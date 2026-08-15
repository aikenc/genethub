use std::collections::BTreeMap;

use genehub_proto::{ErrorCode, ProtocolError, ProviderInfo, Settings};
use genet_daemon_logic_api::{
    CapabilityFailure, CapabilityFailureKind, CapabilityRequest, CapabilityValue, HttpRequest,
    RedirectPolicy,
};
use serde::{Deserialize, Serialize};

use crate::capability::Client;
use crate::CapabilityExecutor;

const CONFIG_KEY: &str = "config.json";
const MAX_CONFIG_BYTES: u32 = 1024 * 1024;
const MAX_MODEL_RESPONSE_BYTES: u32 = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub port: u16,
    pub lan_enabled: bool,
    pub agents: AgentsConfig,
    pub workspace_roots: Vec<WorkspaceRootEntry>,
    pub workspaces: Vec<WorkspaceEntry>,
    pub workspace_catalog_generation: String,
    pub workspace_catalog_revision: u64,
    pub replay_window: usize,
    pub update_manifest_url: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 0,
            lan_enabled: false,
            agents: AgentsConfig::default(),
            workspace_roots: Vec::new(),
            workspaces: Vec::new(),
            workspace_catalog_generation: String::new(),
            workspace_catalog_revision: 0,
            replay_window: 2048,
            update_manifest_url: String::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentsConfig {
    pub providers: BTreeMap<String, ProviderConfig>,
    pub custom: BTreeMap<String, CustomAgent>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderConfig {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub label: Option<String>,
    pub dialect: Option<String>,
    #[serde(skip)]
    pub problem: Option<String>,
    pub models: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgent {
    pub extends: String,
    pub command: Vec<String>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRootEntry {
    pub handle: String,
    pub root: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFolderEntry {
    pub name: String,
    pub root: String,
    #[serde(default)]
    pub root_handle: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub id: String,
    pub name: String,
    pub root: String,
    #[serde(default)]
    pub folders: Vec<WorkspaceFolderEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_file: Option<String>,
    #[serde(default)]
    pub removed: bool,
    #[serde(default)]
    pub is_git_repo: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    question: String,
    models: Vec<String>,
    problem: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Dialect {
    OpenAi,
    Anthropic,
}

pub(crate) struct Resolved {
    pub(crate) label: String,
    pub(crate) base_url: Option<String>,
    pub(crate) dialect: Dialect,
    pub(crate) custom: bool,
}

const KNOWN: &[(&str, &str, &str, Dialect)] = &[
    (
        "deepseek",
        "DeepSeek",
        "https://api.deepseek.com/v1",
        Dialect::OpenAi,
    ),
    (
        "openai",
        "OpenAI",
        "https://api.openai.com/v1",
        Dialect::OpenAi,
    ),
    (
        "anthropic",
        "Anthropic",
        "https://api.anthropic.com",
        Dialect::Anthropic,
    ),
];

pub fn load(
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Config, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call_raw(CapabilityRequest::SecureRead {
        key: CONFIG_KEY.to_string(),
        max_bytes: MAX_CONFIG_BYTES,
    })? {
        Ok(CapabilityValue::Bytes(bytes)) => {
            serde_json::from_slice(&bytes).map_err(|error| ProtocolError {
                code: ErrorCode::Internal,
                message: format!("parsing portable daemon config: {error}"),
            })
        }
        Ok(_) => Err(internal("config capability returned the wrong value")),
        Err(error) if error.kind == CapabilityFailureKind::NotFound => Ok(Config::default()),
        Err(error) => Err(map_failure(error)),
    }
}

pub fn save(
    config: &Config,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let bytes = serde_json::to_vec_pretty(config).map_err(|error| ProtocolError {
        code: ErrorCode::Internal,
        message: format!("encoding portable daemon config: {error}"),
    })?;
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::SecureWrite {
        key: CONFIG_KEY.to_string(),
        bytes,
    })? {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal("config write returned the wrong value")),
    }
}

pub fn set_provider(
    config: &mut Config,
    provider_id: String,
    api_key: Option<String>,
    base_url: Option<String>,
    label: Option<String>,
    dialect: Option<String>,
    models: Option<Vec<String>>,
) -> Result<(), ProtocolError> {
    if provider_id.trim().is_empty() || provider_id.len() > 128 {
        return Err(bad_request("provider id is empty or too long"));
    }
    let mut entry = config
        .agents
        .providers
        .get(&provider_id)
        .cloned()
        .unwrap_or_default();
    if let Some(key) = api_key {
        entry.api_key = (!key.is_empty()).then_some(key);
    }
    if let Some(url) = base_url {
        entry.base_url = (!url.is_empty()).then_some(url);
    }
    if let Some(label) = label {
        entry.label = (!label.is_empty()).then_some(label);
    }
    if let Some(dialect) = dialect {
        if !dialect.is_empty() && !matches!(dialect.as_str(), "openai" | "anthropic") {
            return Err(bad_request("provider dialect must be openai or anthropic"));
        }
        entry.dialect = (!dialect.is_empty()).then_some(dialect);
    }
    if let Some(models) = models {
        entry.models = models
            .into_iter()
            .filter(|model| !model.is_empty())
            .collect();
    }
    if entry.api_key.as_deref().is_some_and(|key| !key.is_empty()) {
        if let Some(url) = resolve(&provider_id, &entry).base_url {
            validate_credential_url(&url)?;
        }
    }
    config.agents.providers.insert(provider_id, entry);
    Ok(())
}

pub fn forget_provider(config: &mut Config, provider_id: &str) -> Result<(), ProtocolError> {
    let Some(entry) = config.agents.providers.get(provider_id) else {
        return Ok(());
    };
    if !resolve(provider_id, entry).custom {
        return Err(bad_request(format!(
            "{provider_id} 是内置的，只能清空它的 Key"
        )));
    }
    config.agents.providers.remove(provider_id);
    Ok(())
}

pub fn settings(
    config: &Config,
    discoveries: &mut BTreeMap<String, Discovery>,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Settings {
    let mut providers = Vec::new();
    for (id, provider) in &config.agents.providers {
        let resolved = resolve(id, provider);
        let credential_problem = provider
            .api_key
            .as_deref()
            .filter(|key| !key.is_empty())
            .and(resolved.base_url.as_deref())
            .and_then(|url| validate_credential_url(url).err())
            .map(|error| error.message);
        let question = format!(
            "{}|{}|{}",
            resolved.base_url.clone().unwrap_or_default(),
            match resolved.dialect {
                Dialect::OpenAi => "openai",
                Dialect::Anthropic => "anthropic",
            },
            provider.api_key.clone().unwrap_or_default()
        );
        let found = if provider.models.is_empty() && credential_problem.is_none() {
            let current = discoveries
                .get(id)
                .filter(|found| found.question == question);
            if current.is_none() || current.is_some_and(|found| found.problem.is_some()) {
                let discovery = discover(id, provider, &resolved, executor, next);
                discoveries.insert(
                    id.clone(),
                    Discovery {
                        question: question.clone(),
                        models: discovery.as_ref().cloned().unwrap_or_default(),
                        problem: discovery.err().map(|error| error.message),
                    },
                );
            }
            discoveries.get(id)
        } else {
            None
        };
        providers.push(ProviderInfo {
            id: id.clone(),
            has_api_key: provider
                .api_key
                .as_deref()
                .is_some_and(|key| !key.is_empty()),
            base_url: credential_problem
                .is_none()
                .then_some(resolved.base_url)
                .flatten(),
            label: resolved.label,
            dialect: match resolved.dialect {
                Dialect::OpenAi => "openai",
                Dialect::Anthropic => "anthropic",
            }
            .to_string(),
            custom: resolved.custom,
            models: if provider.models.is_empty() {
                found.map(|value| value.models.clone()).unwrap_or_default()
            } else {
                provider.models.clone()
            },
            problem: credential_problem.or_else(|| found.and_then(|value| value.problem.clone())),
        });
    }
    Settings {
        providers,
        lan_enabled: config.lan_enabled,
    }
}

/// Applies successful provider discovery to an in-memory configuration view.
///
/// User-authored model lists remain the durable source of truth. Discovered
/// lists are deliberately ephemeral, but every consumer in the running guest
/// must still see the same catalogue after discovery.
pub fn with_discoveries(config: &Config, discoveries: &BTreeMap<String, Discovery>) -> Config {
    let mut resolved = config.clone();
    for (id, provider) in &mut resolved.agents.providers {
        if !provider.models.is_empty() {
            continue;
        }
        if let Some(discovery) = discoveries.get(id) {
            provider.models.clone_from(&discovery.models);
            provider.problem.clone_from(&discovery.problem);
        }
    }
    resolved
}

fn discover(
    id: &str,
    config: &ProviderConfig,
    resolved: &Resolved,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<String>, ProtocolError> {
    let base = resolved
        .base_url
        .as_deref()
        .ok_or_else(|| bad_request(format!("{id} 没有接口地址，请填一个")))?
        .trim_end_matches('/');
    let key = config
        .api_key
        .as_deref()
        .filter(|key| !key.is_empty())
        .ok_or_else(|| bad_request(format!("{id} 还没有 API Key")))?;
    validate_credential_url(base)?;
    let (url, headers) = match resolved.dialect {
        Dialect::OpenAi => (
            format!("{base}/models"),
            vec![("authorization".to_string(), format!("Bearer {key}"))],
        ),
        Dialect::Anthropic => (
            format!("{base}/v1/models"),
            vec![
                ("x-api-key".to_string(), key.to_string()),
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
            ],
        ),
    };
    let mut client = Client::new(executor, next);
    let response = match client.call(CapabilityRequest::Http(HttpRequest {
        method: "GET".to_string(),
        url,
        headers,
        body: Vec::new(),
        timeout_millis: 4_000,
        max_response_bytes: MAX_MODEL_RESPONSE_BYTES,
        redirect: RedirectPolicy::SameOrigin,
    }))? {
        CapabilityValue::Http(response) => response,
        _ => return Err(internal("model HTTP capability returned the wrong value")),
    };
    let body = String::from_utf8_lossy(&response.body);
    if !(200..300).contains(&response.status) {
        return Err(ProtocolError {
            code: ErrorCode::Internal,
            message: format!(
                "{id} 返回 {}：{}",
                response.status,
                body.chars().take(300).collect::<String>()
            ),
        });
    }
    let parsed: serde_json::Value =
        serde_json::from_slice(&response.body).map_err(|error| ProtocolError {
            code: ErrorCode::Internal,
            message: format!("解析 {id} 的模型列表：{error}"),
        })?;
    let mut ids = parsed["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["id"].as_str())
        .filter(|model| usable_for_chat(model))
        .map(str::to_string)
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Err(ProtocolError {
            code: ErrorCode::Internal,
            message: format!("{id} 没有返回任何可用于对话的模型"),
        });
    }
    Ok(ids)
}

pub(crate) fn resolve(id: &str, config: &ProviderConfig) -> Resolved {
    let known = KNOWN.iter().find(|(known, ..)| *known == id);
    Resolved {
        label: config
            .label
            .clone()
            .filter(|label| !label.is_empty())
            .or_else(|| known.map(|(_, label, ..)| (*label).to_string()))
            .unwrap_or_else(|| id.to_string()),
        base_url: config
            .base_url
            .clone()
            .filter(|url| !url.is_empty())
            .or_else(|| known.map(|(_, _, url, _)| (*url).to_string())),
        dialect: match config.dialect.as_deref() {
            Some("anthropic") => Dialect::Anthropic,
            Some("openai") => Dialect::OpenAi,
            _ => known
                .map(|(.., dialect)| *dialect)
                .unwrap_or(Dialect::OpenAi),
        },
        custom: known.is_none(),
    }
}

fn validate_credential_url(value: &str) -> Result<(), ProtocolError> {
    let parsed = url::Url::parse(value)
        .map_err(|error| bad_request(format!("读取模型接口地址：{error}")))?;
    let loopback = match parsed.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        Some(url::Host::Domain(_)) | None => false,
    };
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !(parsed.scheme() == "https" || (parsed.scheme() == "http" && loopback))
    {
        return Err(bad_request(
            "带 API Key 的模型接口必须使用 https；明文 http 只允许 127.0.0.1 或 [::1]，且地址不能包含凭证、query 或 fragment",
        ));
    }
    Ok(())
}

fn usable_for_chat(id: &str) -> bool {
    const NOT_CHAT: &[&str] = &[
        "embedding",
        "embed",
        "whisper",
        "tts",
        "audio",
        "transcribe",
        "realtime",
        "dall-e",
        "image",
        "moderation",
        "rerank",
        "davinci",
        "babbage",
    ];
    let lowered = id.to_ascii_lowercase();
    !NOT_CHAT.iter().any(|bad| lowered.contains(bad))
}

fn map_failure(error: CapabilityFailure) -> ProtocolError {
    ProtocolError {
        code: match error.kind {
            CapabilityFailureKind::Invalid => ErrorCode::BadRequest,
            CapabilityFailureKind::Denied => ErrorCode::Forbidden,
            CapabilityFailureKind::NotFound => ErrorCode::NotFound,
            CapabilityFailureKind::Conflict => ErrorCode::Conflict,
            CapabilityFailureKind::Unavailable
            | CapabilityFailureKind::TooLarge
            | CapabilityFailureKind::Internal => ErrorCode::Internal,
        },
        message: error.message,
    }
}

fn internal(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Internal,
        message: message.into(),
    }
}

fn bad_request(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::BadRequest,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_credentials_require_tls_except_on_exact_ip_loopback() {
        for allowed in [
            "https://api.example.com/v1",
            "http://127.0.0.1:8080/v1",
            "http://127.42.0.9:8080/v1",
            "http://[::1]:8080/v1",
        ] {
            validate_credential_url(allowed).unwrap();
        }
        for refused in [
            "http://api.example.com/v1",
            "http://10.0.0.2:8080/v1",
            "http://172.16.0.2:8080/v1",
            "http://192.168.1.20:8080/v1",
            "http://localhost:8080/v1",
            "http://loopback.attacker.test:8080/v1",
            "ftp://api.example.com/v1",
            "https://user:password@api.example.com/v1",
            "https://api.example.com/v1?key=secret",
            "https://api.example.com/v1#credential",
        ] {
            assert!(
                validate_credential_url(refused).is_err(),
                "{refused} was accepted"
            );
        }
    }

    #[test]
    fn rejected_provider_update_does_not_mutate_portable_config() {
        let mut config = Config::default();
        let error = set_provider(
            &mut config,
            "insecure".to_string(),
            Some("secret".to_string()),
            Some("http://192.168.1.20/v1".to_string()),
            None,
            Some("openai".to_string()),
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::BadRequest);
        assert!(!config.agents.providers.contains_key("insecure"));
    }

    #[test]
    fn shipped_and_custom_provider_resolution_stays_in_portable_logic() {
        let shipped = resolve("deepseek", &ProviderConfig::default());
        assert_eq!(
            shipped.base_url.as_deref(),
            Some("https://api.deepseek.com/v1")
        );
        assert!(!shipped.custom);

        let custom = resolve(
            "internal",
            &ProviderConfig {
                base_url: Some("https://models.example".to_string()),
                dialect: Some("anthropic".to_string()),
                label: Some("Internal".to_string()),
                ..ProviderConfig::default()
            },
        );
        assert_eq!(custom.label, "Internal");
        assert_eq!(custom.base_url.as_deref(), Some("https://models.example"));
        assert_eq!(custom.dialect, Dialect::Anthropic);
        assert!(custom.custom);
    }

    #[test]
    fn non_chat_models_are_filtered_before_the_guest_publishes_settings() {
        assert!(usable_for_chat("gpt-4o"));
        assert!(usable_for_chat("deepseek-chat"));
        assert!(!usable_for_chat("text-embedding-3-small"));
        assert!(!usable_for_chat("whisper-1"));
        assert!(!usable_for_chat("dall-e-3"));
    }

    #[test]
    fn discovered_models_feed_runtime_consumers_without_rewriting_user_config() {
        let mut config = Config::default();
        config.agents.providers.insert(
            "deepseek".to_string(),
            ProviderConfig {
                api_key: Some("secret".to_string()),
                ..ProviderConfig::default()
            },
        );
        let discoveries = BTreeMap::from([(
            "deepseek".to_string(),
            Discovery {
                question: "q".to_string(),
                models: vec!["deepseek-chat".to_string()],
                problem: None,
            },
        )]);

        let runtime = with_discoveries(&config, &discoveries);

        assert!(config.agents.providers["deepseek"].models.is_empty());
        assert_eq!(
            runtime.agents.providers["deepseek"].models,
            ["deepseek-chat"]
        );
    }
}
