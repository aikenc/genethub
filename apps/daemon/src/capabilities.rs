//! What a model can do, from four layers merged field by field
//! (`docs/builtin-agent-next-proposal.md` §3):
//!
//! 1. Fallback: nothing. An unknown `contextWindow` leaves auto-archive to the
//!    overflow error, an unknown `maxTokens` leaves the agent's per-dialect
//!    default, and the agent clamps every thinking budget either way.
//! 2. Dialect and endpoint rules, after pi's `detectCompat`: request-shape
//!    quirks by provider id and base URL, plus the only id-based guesses left
//!    anywhere — whether a model reasons, and whether an Anthropic one needs
//!    adaptive thinking. The agent no longer guesses; it reads what this says.
//! 3. Discovery: what the provider's own model list reports (`provider.rs`).
//! 4. The user: `modelDefaults`, then `modelCapabilities.<id>`.
//!
//! Every effective field remembers which layer set it, so the settings page
//! can say which values are guesses and where to change them.

use std::collections::BTreeMap;

use anyhow::{bail, Result};
use genehub_proto::{ModelCapabilities, ModelCapabilityInfo, ModelCompat};

use crate::config::ProviderConfig;
use crate::provider::Dialect;

pub const SOURCE_RULE: &str = "rule";
pub const SOURCE_DISCOVERED: &str = "discovered";
pub const SOURCE_USER: &str = "user";

pub const THINKING_MODES: &[&str] = &["adaptive", "budget", "only", "none"];
pub const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// One model's merged capabilities and where each field came from.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Resolved {
    pub caps: ModelCapabilities,
    pub sources: BTreeMap<String, String>,
}

impl Resolved {
    fn apply(&mut self, layer: &ModelCapabilities, source: &str) {
        for field in self.caps.overlay(layer) {
            self.sources.insert(field.to_string(), source.to_string());
        }
    }
}

/// Merges all four layers for `model` of provider `id`.
pub fn resolve(id: &str, config: &ProviderConfig, model: &str) -> Resolved {
    let endpoint = crate::provider::resolve(id, config);
    let mut resolved = Resolved::default();
    resolved.apply(
        &rules(
            id,
            endpoint.base_url.as_deref().unwrap_or_default(),
            endpoint.dialect,
            model,
        ),
        SOURCE_RULE,
    );
    if let Some(found) = config.discovered.get(model) {
        resolved.apply(found, SOURCE_DISCOVERED);
    }
    resolved.apply(&config.model_defaults, SOURCE_USER);
    if let Some(user) = config.model_capabilities.get(model) {
        resolved.apply(user, SOURCE_USER);
    }
    resolved
}

/// What the settings page shows for one model.
pub fn info(id: &str, config: &ProviderConfig, model: &str) -> ModelCapabilityInfo {
    let Resolved { caps, sources } = resolve(id, config, model);
    ModelCapabilityInfo {
        effective: caps,
        user: config
            .model_capabilities
            .get(model)
            .cloned()
            .unwrap_or_default(),
        sources,
    }
}

/// Layer 2. Only what the endpoint or a well-known id makes certain enough to
/// send; anything else stays unset so the agent's conservative default holds.
pub fn rules(provider: &str, base_url: &str, dialect: Dialect, model: &str) -> ModelCapabilities {
    let lowered = model.to_ascii_lowercase();
    let mut caps = ModelCapabilities::default();
    if reasons(&lowered) {
        caps.reasoning = Some(true);
    }
    match dialect {
        Dialect::Anthropic => {
            if caps.reasoning == Some(true) {
                caps.thinking = Some(
                    if requires_adaptive_thinking(&lowered) {
                        "adaptive"
                    } else {
                        "budget"
                    }
                    .into(),
                );
            }
        }
        Dialect::OpenAi => {
            let compat = openai_compat(provider, base_url, &lowered);
            if compat != ModelCompat::default() {
                caps.compat = Some(compat);
            }
        }
    }
    caps
}

/// pi `detectCompat` (`openai-completions.ts`), reduced to the fields the
/// agent acts on and the endpoints GeneHub users reach.
fn openai_compat(provider: &str, base_url: &str, model: &str) -> ModelCompat {
    let is = |ids: &[&str], hosts: &[&str]| {
        ids.contains(&provider) || hosts.iter().any(|host| base_url.contains(host))
    };
    let deepseek = is(&["deepseek"], &["deepseek.com"]);
    let moonshot = is(&["kimi", "moonshot"], &["api.moonshot.", "api.kimi.com"]);
    let openrouter = is(&["openrouter"], &["openrouter.ai"]);
    let zai = is(&["zai", "zhipu"], &["api.z.ai", "open.bigmodel.cn"]);
    let openai = is(&["openai"], &["api.openai.com"]);
    let mut compat = ModelCompat::default();
    if deepseek {
        compat.thinking_format = Some("deepseek".into());
        compat.requires_reasoning_content = Some(true);
        compat.supports_developer_role = Some(false);
    }
    if moonshot {
        // Kimi's thinking models reject an assistant tool-call turn that lost
        // its `reasoning_content`, like DeepSeek's.
        compat.requires_reasoning_content = Some(true);
        compat.supports_reasoning_effort = Some(false);
        compat.supports_developer_role = Some(false);
        compat.max_tokens_field = Some("max_tokens".into());
    }
    if zai {
        compat.supports_reasoning_effort = Some(false);
        compat.supports_developer_role = Some(false);
        compat.max_tokens_field = Some("max_tokens".into());
    }
    if openrouter {
        compat.thinking_format = Some("openrouter".into());
        compat.supports_developer_role =
            Some(model.starts_with("anthropic/") || model.starts_with("openai/"));
    }
    if openai {
        compat.max_tokens_field = Some("max_completion_tokens".into());
        compat.supports_developer_role = Some(true);
    }
    compat
}

/// Whether asking for thinking is something this model will accept.
///
/// A guess, from the name, and deliberately a conservative one: most lists say
/// nothing about it. Getting it wrong towards "yes" is not harmless — OpenAI
/// rejects the whole request with a 400 when a plain chat model is asked to
/// reason — so discovery and the user both override it.
fn reasons(lowered: &str) -> bool {
    const REASONERS: &[&str] = &[
        "reasoner",
        "reasoning",
        "thinking",
        "-r1",
        "deepseek-v4",
        "o1",
        "o3",
        "o4",
        "gpt-5",
        "claude-3-7",
        "claude-3.7",
        "sonnet-4",
        "opus-4",
        "haiku-4",
        "sonnet-5",
        "opus-5",
        "fable-5",
    ];
    REASONERS.iter().any(|hint| lowered.contains(hint))
}

/// Anthropic families that reject `thinking.type="enabled"` and take only
/// `adaptive`. Used only when the endpoint does not say so itself.
fn requires_adaptive_thinking(lowered: &str) -> bool {
    [
        "opus-4-6",
        "opus-4.6",
        "opus-4-7",
        "opus-4.7",
        "opus-4-8",
        "opus-4.8",
        "opus-5",
        "opus.5",
        "sonnet-4-6",
        "sonnet-4.6",
        "sonnet-5",
        "sonnet.5",
        "fable-5",
        "fable.5",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

/// Rejects a value the agent could not act on, before it is stored.
pub fn validate(model: &str, caps: &ModelCapabilities, dialect: Dialect) -> Result<()> {
    if model.trim().is_empty() || model.len() > 200 || model.chars().any(char::is_control) {
        bail!("模型名称无效");
    }
    if let Some(inputs) = &caps.inputs {
        if inputs
            .iter()
            .any(|input| input != "image" && input != "video")
        {
            bail!("模型输入能力只接受 image 和 video");
        }
        if dialect == Dialect::Anthropic && inputs.iter().any(|input| input == "video") {
            bail!("Anthropic Messages API 不支持原生视频输入");
        }
    }
    if let Some(thinking) = &caps.thinking {
        if !THINKING_MODES.contains(&thinking.as_str()) {
            bail!("思考方式只接受 adaptive、budget、only、none");
        }
    }
    if let Some(efforts) = &caps.efforts {
        if efforts
            .iter()
            .any(|effort| !EFFORTS.contains(&effort.as_str()))
        {
            bail!("思考档位只接受 low、medium、high、xhigh、max");
        }
    }
    if caps
        .context_window
        .is_some_and(|tokens| !(1024..=10_000_000).contains(&tokens))
    {
        bail!("上下文窗口应在 1024 到 10000000 之间");
    }
    if caps
        .max_tokens
        .is_some_and(|tokens| !(256..=1_000_000).contains(&tokens))
    {
        bail!("最大输出应在 256 到 1000000 之间");
    }
    if let (Some(window), Some(max)) = (caps.context_window, caps.max_tokens) {
        if max >= window {
            bail!("最大输出必须小于上下文窗口");
        }
    }
    if let Some(compat) = &caps.compat {
        let one_of = |value: &Option<String>, allowed: &[&str]| {
            value
                .as_deref()
                .is_none_or(|value| allowed.contains(&value))
        };
        if !one_of(
            &compat.max_tokens_field,
            &["max_tokens", "max_completion_tokens"],
        ) || !one_of(
            &compat.thinking_format,
            &["openai", "deepseek", "openrouter"],
        ) || !one_of(&compat.thinking_display, &["summarized", "omitted"])
        {
            bail!("compat 字段取值无效");
        }
    }
    Ok(())
}

/// The one rule for a provider whose endpoint (address or dialect) changed,
/// shared by the settings page and the Agent-proposed configuration.
///
/// The key never follows the endpoint: it was given for the old one. What the
/// user wrote about each model stays, because the same model names behind a
/// new address usually mean the same models. What discovery said belonged to
/// the old endpoint and is dropped; the discovery cache is keyed by endpoint,
/// so the next look asks the new one.
pub fn retarget(entry: &mut ProviderConfig) {
    entry.api_key = None;
    entry.discovered.clear();
}

/// Parses one entry of an Anthropic `GET /v1/models` page.
pub fn from_anthropic(entry: &serde_json::Value) -> ModelCapabilities {
    let caps_of = &entry["capabilities"];
    let supported = |path: &str| caps_of.pointer(path).and_then(serde_json::Value::as_bool);
    let mut caps = ModelCapabilities {
        context_window: positive(&entry["max_input_tokens"]),
        max_tokens: positive(&entry["max_tokens"]),
        ..Default::default()
    };
    if caps_of.is_object() {
        if let Some(image) = supported("/image_input/supported") {
            caps.inputs = Some(if image {
                vec!["image".into()]
            } else {
                Vec::new()
            });
        }
        if let Some(thinking) = supported("/thinking/supported") {
            caps.reasoning = Some(thinking);
            let adaptive = supported("/thinking/types/adaptive/supported") == Some(true);
            let enabled = supported("/thinking/types/enabled/supported") == Some(true);
            let can_disable = supported("/thinking/types/disabled/supported") != Some(false);
            caps.thinking = Some(
                match (thinking, adaptive, enabled, can_disable) {
                    (false, ..) => "none",
                    (true, _, _, false) => "only",
                    (true, true, _, _) => "adaptive",
                    (true, false, true, _) => "budget",
                    (true, false, false, _) => "only",
                }
                .into(),
            );
        }
        if supported("/effort/supported") == Some(true) {
            let efforts: Vec<String> = EFFORTS
                .iter()
                .filter(|level| supported(&format!("/effort/{level}/supported")) == Some(true))
                .map(|level| level.to_string())
                .collect();
            if !efforts.is_empty() {
                caps.efforts = Some(efforts);
            }
        }
    }
    caps
}

/// Parses one entry of an OpenAI-compatible `GET /models` list. Kimi and
/// OpenRouter put capability fields there; most others give only an id.
pub fn from_openai(entry: &serde_json::Value) -> ModelCapabilities {
    let mut caps = ModelCapabilities {
        context_window: positive(&entry["context_length"])
            .or_else(|| positive(&entry["context_window"])),
        max_tokens: positive(&entry["top_provider"]["max_completion_tokens"])
            .or_else(|| positive(&entry["max_output_tokens"])),
        ..Default::default()
    };

    // Kimi: `supports_image_in`/`supports_video_in`; OpenRouter:
    // `architecture.input_modalities`; both: `modalities.input`.
    let listed: Option<Vec<String>> = entry["architecture"]["input_modalities"]
        .as_array()
        .or_else(|| entry["modalities"]["input"].as_array())
        .map(|kinds| {
            kinds
                .iter()
                .filter_map(serde_json::Value::as_str)
                .filter(|kind| matches!(*kind, "image" | "video"))
                .map(str::to_string)
                .collect()
        });
    let flags = [
        ("supports_image_in", "image"),
        ("supports_video_in", "video"),
    ];
    if let Some(inputs) = listed {
        caps.inputs = Some(inputs);
    } else if flags.iter().any(|(field, _)| entry[*field].is_boolean()) {
        caps.inputs = Some(
            flags
                .iter()
                .filter(|(field, _)| entry[*field].as_bool() == Some(true))
                .map(|(_, kind)| kind.to_string())
                .collect(),
        );
    }
    if let Some(inputs) = caps.inputs.as_mut() {
        inputs.sort();
        inputs.dedup();
    }

    let parameters = entry["supported_parameters"].as_array();
    caps.reasoning = entry["supports_reasoning"].as_bool().or_else(|| {
        parameters.map(|list| {
            list.iter()
                .any(|p| matches!(p.as_str(), Some("reasoning" | "include_reasoning")))
        })
    });
    // Kimi `supports_thinking_type`: `only` means always on, no switch.
    if let Some(kind) = entry["supports_thinking_type"].as_str() {
        caps.thinking = Some(
            match kind {
                "only" | "always" => "only",
                "none" | "disabled" => "none",
                _ => "budget",
            }
            .into(),
        );
        caps.reasoning
            .get_or_insert(kind != "none" && kind != "disabled");
    }
    let efforts = entry["think_efforts"]["valid_efforts"]
        .as_array()
        .or_else(|| entry["reasoning"]["supported_efforts"].as_array());
    if let Some(efforts) = efforts {
        let efforts: Vec<String> = EFFORTS
            .iter()
            .filter(|level| efforts.iter().any(|e| e.as_str() == Some(level)))
            .map(|level| level.to_string())
            .collect();
        if !efforts.is_empty() {
            caps.efforts = Some(efforts);
        }
    }
    caps
}

fn positive(value: &serde_json::Value) -> Option<u64> {
    value.as_u64().filter(|n| *n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn provider(dialect: &str, base: &str) -> ProviderConfig {
        ProviderConfig {
            api_key: Some("sk-test".into()),
            base_url: Some(base.into()),
            dialect: Some(dialect.into()),
            ..Default::default()
        }
    }

    #[test]
    fn the_four_layers_merge_field_by_field_and_say_where_each_came_from() {
        let mut config = provider("anthropic", "https://gateway.example");
        // Layer 3: the endpoint reports a window but nothing about thinking.
        config.discovered.insert(
            "claude-opus-5-5".into(),
            ModelCapabilities {
                context_window: Some(200_000),
                ..Default::default()
            },
        );
        // Layer 4: a provider default, then one model's own value.
        config.model_defaults.max_tokens = Some(32_000);
        config.model_capabilities.insert(
            "claude-opus-5-5".into(),
            ModelCapabilities {
                max_tokens: Some(64_000),
                inputs: Some(vec!["image".into()]),
                ..Default::default()
            },
        );

        let resolved = resolve("aiclick", &config, "claude-opus-5-5");
        assert_eq!(resolved.caps.thinking.as_deref(), Some("adaptive"));
        assert_eq!(resolved.caps.reasoning, Some(true));
        assert_eq!(resolved.caps.context_window, Some(200_000));
        assert_eq!(resolved.caps.max_tokens, Some(64_000));
        assert_eq!(resolved.sources["thinking"], SOURCE_RULE);
        assert_eq!(resolved.sources["contextWindow"], SOURCE_DISCOVERED);
        assert_eq!(resolved.sources["maxTokens"], SOURCE_USER);
        assert_eq!(resolved.sources["inputs"], SOURCE_USER);
        assert!(!resolved.sources.contains_key("efforts"));

        // The user's word beats the rule.
        config
            .model_capabilities
            .get_mut("claude-opus-5-5")
            .unwrap()
            .thinking = Some("budget".into());
        let resolved = resolve("aiclick", &config, "claude-opus-5-5");
        assert_eq!(resolved.caps.thinking.as_deref(), Some("budget"));
        assert_eq!(resolved.sources["thinking"], SOURCE_USER);
    }

    #[test]
    fn discovery_beats_the_id_rule() {
        let mut config = provider("anthropic", "https://api.anthropic.com");
        config.discovered.insert(
            "claude-sonnet-4-6".into(),
            ModelCapabilities {
                thinking: Some("budget".into()),
                ..Default::default()
            },
        );
        let resolved = resolve("anthropic", &config, "claude-sonnet-4-6");
        assert_eq!(resolved.caps.thinking.as_deref(), Some("budget"));
        assert_eq!(resolved.sources["thinking"], SOURCE_DISCOVERED);
    }

    #[test]
    fn endpoint_rules_follow_pi_detect_compat() {
        let deepseek = rules(
            "deepseek",
            "https://api.deepseek.com/v1",
            Dialect::OpenAi,
            "deepseek-reasoner",
        );
        let compat = deepseek.compat.unwrap();
        assert_eq!(compat.thinking_format.as_deref(), Some("deepseek"));
        assert_eq!(compat.requires_reasoning_content, Some(true));
        assert_eq!(deepseek.reasoning, Some(true));

        let kimi = rules(
            "coding",
            "https://api.kimi.com/coding/v1",
            Dialect::OpenAi,
            "kimi-for-coding",
        );
        let compat = kimi.compat.unwrap();
        assert_eq!(compat.max_tokens_field.as_deref(), Some("max_tokens"));
        assert_eq!(compat.supports_reasoning_effort, Some(false));

        let openai = rules(
            "openai",
            "https://api.openai.com/v1",
            Dialect::OpenAi,
            "gpt-5",
        );
        let compat = openai.compat.unwrap();
        assert_eq!(
            compat.max_tokens_field.as_deref(),
            Some("max_completion_tokens")
        );
        assert_eq!(compat.supports_developer_role, Some(true));

        let router = rules(
            "openrouter",
            "https://openrouter.ai/api/v1",
            Dialect::OpenAi,
            "anthropic/claude-opus-5",
        );
        let compat = router.compat.unwrap();
        assert_eq!(compat.thinking_format.as_deref(), Some("openrouter"));
        assert_eq!(compat.supports_developer_role, Some(true));

        // An endpoint we know nothing about gets nothing invented for it.
        let unknown = rules(
            "inhouse",
            "https://llm.example/v1",
            Dialect::OpenAi,
            "qwen3-coder",
        );
        assert_eq!(unknown, ModelCapabilities::default());
        // A plain chat model is not asked to reason.
        let plain = rules(
            "anthropic",
            "https://api.anthropic.com",
            Dialect::Anthropic,
            "claude-3-5-haiku",
        );
        assert_eq!(plain.thinking, None);
        let older = rules(
            "anthropic",
            "https://api.anthropic.com",
            Dialect::Anthropic,
            "claude-sonnet-4-5",
        );
        assert_eq!(older.thinking.as_deref(), Some("budget"));
    }

    #[test]
    fn anthropic_model_entries_carry_window_output_thinking_and_effort() {
        let caps = from_anthropic(&json!({
            "id": "claude-opus-5",
            "max_input_tokens": 1_000_000,
            "max_tokens": 128_000,
            "capabilities": {
                "image_input": {"supported": true},
                "thinking": {"supported": true, "types": {
                    "adaptive": {"supported": true},
                    "disabled": {"supported": true},
                    "enabled": {"supported": false}
                }},
                "effort": {"supported": true,
                    "low": {"supported": true}, "medium": {"supported": true},
                    "high": {"supported": true}, "xhigh": {"supported": true},
                    "max": {"supported": true}}
            }
        }));
        assert_eq!(caps.context_window, Some(1_000_000));
        assert_eq!(caps.max_tokens, Some(128_000));
        assert_eq!(caps.thinking.as_deref(), Some("adaptive"));
        assert_eq!(caps.reasoning, Some(true));
        assert_eq!(caps.inputs, Some(vec!["image".to_string()]));
        assert_eq!(caps.efforts.unwrap().len(), 5);

        // A gateway that only echoes ids says nothing, and is not read as "no".
        let bare =
            from_anthropic(&json!({"id": "claude-opus-5-5", "display_name": "x", "type": "model"}));
        assert_eq!(bare, ModelCapabilities::default());
        // A model that cannot switch thinking off always thinks.
        let only = from_anthropic(&json!({"capabilities": {"thinking": {"supported": true,
            "types": {"adaptive": {"supported": true}, "disabled": {"supported": false}}}}}));
        assert_eq!(only.thinking.as_deref(), Some("only"));
    }

    #[test]
    fn kimi_and_openrouter_entries_are_read_and_bare_ids_say_nothing() {
        let kimi = from_openai(&json!({
            "id": "kimi-for-coding",
            "context_length": 262_144,
            "supports_reasoning": true,
            "supports_thinking_type": "only",
            "think_efforts": {"valid_efforts": ["low", "high"], "default_effort": "high"},
            "supports_image_in": true,
            "supports_video_in": true
        }));
        assert_eq!(kimi.context_window, Some(262_144));
        assert_eq!(kimi.thinking.as_deref(), Some("only"));
        assert_eq!(kimi.reasoning, Some(true));
        assert_eq!(
            kimi.inputs,
            Some(vec!["image".to_string(), "video".to_string()])
        );
        assert_eq!(
            kimi.efforts,
            Some(vec!["low".to_string(), "high".to_string()])
        );

        let router = from_openai(&json!({
            "id": "anthropic/claude-opus-5",
            "context_length": 1_000_000,
            "architecture": {"input_modalities": ["text", "image", "file"]},
            "top_provider": {"max_completion_tokens": 128_000},
            "supported_parameters": ["tools", "reasoning"],
            "reasoning": {"supported_efforts": ["low", "medium", "high", "xhigh"]}
        }));
        assert_eq!(router.inputs, Some(vec!["image".to_string()]));
        assert_eq!(router.max_tokens, Some(128_000));
        assert_eq!(router.reasoning, Some(true));
        assert_eq!(router.efforts.unwrap().len(), 4);

        assert_eq!(
            from_openai(&json!({"id": "mimo-v2", "created": 1})),
            ModelCapabilities::default()
        );
    }

    #[test]
    fn values_the_agent_cannot_act_on_are_refused() {
        let bad = |caps: ModelCapabilities| validate("m", &caps, Dialect::Anthropic).is_err();
        assert!(bad(ModelCapabilities {
            thinking: Some("enabled".into()),
            ..Default::default()
        }));
        assert!(bad(ModelCapabilities {
            inputs: Some(vec!["video".into()]),
            ..Default::default()
        }));
        assert!(bad(ModelCapabilities {
            efforts: Some(vec!["ultra".into()]),
            ..Default::default()
        }));
        assert!(bad(ModelCapabilities {
            context_window: Some(8000),
            max_tokens: Some(8000),
            ..Default::default()
        }));
        assert!(!bad(ModelCapabilities {
            thinking: Some("adaptive".into()),
            context_window: Some(200_000),
            max_tokens: Some(64_000),
            ..Default::default()
        }));
    }

    #[test]
    fn legacy_fields_migrate_into_capabilities_and_are_not_written_back() {
        let mut config: ProviderConfig = serde_json::from_value(json!({
            "apiKey": "sk-test",
            "modelInputs": {"kimi-k2": ["image", "video"]},
            "thinkingMode": "adaptive",
            "modelThinking": {"legacy-model": "budget"},
            "modelCapabilities": {"legacy-model": {"thinking": "none"}}
        }))
        .unwrap();
        config.migrate();
        assert_eq!(config.model_defaults.thinking.as_deref(), Some("adaptive"));
        assert_eq!(
            config.model_capabilities["kimi-k2"].inputs,
            Some(vec!["image".to_string(), "video".to_string()])
        );
        // An explicit new-style value wins over the legacy one.
        assert_eq!(
            config.model_capabilities["legacy-model"]
                .thinking
                .as_deref(),
            Some("none")
        );
        let written = serde_json::to_value(&config).unwrap();
        for legacy in ["modelInputs", "thinkingMode", "modelThinking", "discovered"] {
            assert!(
                written.get(legacy).is_none(),
                "{legacy} written back: {written}"
            );
        }
        assert!(written["modelCapabilities"]["kimi-k2"]["inputs"].is_array());
    }
}
