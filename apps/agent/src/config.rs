//! Model configuration: `models.json` in the agent data dir, plus env fallbacks.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::protocol::ModelRef;

pub const FAKE_PROVIDER: &str = "fake";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub provider: String,
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    /// `anthropic` | `openai` | `fake`. Defaults to the provider name.
    #[serde(default)]
    pub api: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
    #[serde(default)]
    pub reasoning: Option<bool>,
}

impl ModelConfig {
    pub fn api(&self) -> &str {
        self.api.as_deref().unwrap_or(&self.provider)
    }

    pub fn resolved_key(&self) -> Option<String> {
        if let Some(key) = self.api_key.as_ref().filter(|k| !k.is_empty()) {
            return Some(key.clone());
        }
        let var = self.api_key_env.as_deref()?;
        std::env::var(var).ok().filter(|k| !k.is_empty())
    }

    pub fn to_ref(&self) -> ModelRef {
        ModelRef {
            provider: self.provider.clone(),
            id: self.id.clone(),
            name: self.name.clone(),
            reasoning: self.reasoning,
            context_window: self.context_window,
            max_tokens: self.max_tokens,
            api: Some(self.api().to_string()),
            base_url: self.base_url.clone(),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct ModelsFile {
    #[serde(default)]
    models: Vec<ModelConfig>,
}

/// Where sessions and `models.json` live.
pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("GENET_AGENT_HOME") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    Path::new(&home).join(".genet-agent")
}

pub fn load_models() -> Vec<ModelConfig> {
    let mut models = load_models_file(&data_dir().join("models.json"));
    models.extend(env_models());
    dedupe(models)
}

fn load_models_file(path: &Path) -> Vec<ModelConfig> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<ModelsFile>(&raw) {
        Ok(parsed) => parsed.models,
        Err(err) => {
            eprintln!("genet-agent: ignoring {}: {err}", path.display());
            Vec::new()
        }
    }
}

/// Keys already in the environment should just work, with no config file.
fn env_models() -> Vec<ModelConfig> {
    let mut models = Vec::new();

    if std::env::var("GENET_AGENT_FAKE_PROVIDER").is_ok() {
        models.push(ModelConfig {
            provider: FAKE_PROVIDER.into(),
            id: "echo".into(),
            name: Some("Fake echo model".into()),
            api: Some(FAKE_PROVIDER.into()),
            base_url: None,
            api_key: None,
            api_key_env: None,
            context_window: Some(8192),
            max_tokens: Some(1024),
            reasoning: Some(false),
        });
    }

    if env_present("ANTHROPIC_API_KEY") {
        let id = std::env::var("ANTHROPIC_MODEL")
            .unwrap_or_else(|_| "claude-sonnet-4-20250514".to_string());
        models.push(ModelConfig {
            provider: "anthropic".into(),
            id,
            name: None,
            api: Some("anthropic".into()),
            // Here the provider really is Anthropic, so its own address is the
            // right default — unlike in the provider code, which only knows a
            // protocol and must be told where to speak it.
            base_url: Some(
                std::env::var("ANTHROPIC_BASE_URL")
                    .unwrap_or_else(|_| "https://api.anthropic.com".to_string()),
            ),
            api_key: None,
            api_key_env: Some("ANTHROPIC_API_KEY".into()),
            context_window: Some(200_000),
            max_tokens: Some(8192),
            reasoning: Some(true),
        });
    }

    if env_present("OPENAI_API_KEY") {
        let id = std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o-mini".to_string());
        models.push(ModelConfig {
            provider: "openai".into(),
            id,
            name: None,
            api: Some("openai".into()),
            base_url: Some(
                std::env::var("OPENAI_BASE_URL")
                    .unwrap_or_else(|_| "https://api.openai.com/v1".to_string()),
            ),
            api_key: None,
            api_key_env: Some("OPENAI_API_KEY".into()),
            context_window: Some(128_000),
            max_tokens: Some(4096),
            reasoning: Some(false),
        });
    }

    models
}

fn env_present(key: &str) -> bool {
    std::env::var(key).map(|v| !v.is_empty()).unwrap_or(false)
}

fn dedupe(models: Vec<ModelConfig>) -> Vec<ModelConfig> {
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for model in models {
        let key = format!("{}/{}", model.provider, model.id);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(model);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_defaults_to_provider_name() {
        let model = ModelConfig {
            provider: "anthropic".into(),
            id: "claude".into(),
            name: None,
            api: None,
            base_url: None,
            api_key: None,
            api_key_env: None,
            context_window: None,
            max_tokens: None,
            reasoning: None,
        };
        assert_eq!(model.api(), "anthropic");
        assert_eq!(model.to_ref().reference(), "anthropic/claude");
    }

    #[test]
    fn duplicate_provider_and_id_collapse() {
        let make = |id: &str| ModelConfig {
            provider: "openai".into(),
            id: id.into(),
            name: None,
            api: None,
            base_url: None,
            api_key: None,
            api_key_env: None,
            context_window: None,
            max_tokens: None,
            reasoning: None,
        };
        let models = dedupe(vec![make("a"), make("a"), make("b")]);
        assert_eq!(models.len(), 2);
    }
}
