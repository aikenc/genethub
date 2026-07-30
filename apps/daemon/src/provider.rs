//! Where a model provider lives, and which models it has.
//!
//! Both answers used to be spread out, and both were wrong in a way that only
//! showed up on someone's machine:
//!
//! A key saved under `deepseek` with no address went to `api.openai.com`,
//! because the agent's OpenAI-compatible code fell back to OpenAI's own URL when
//! it had none. The user got "Incorrect API key provided: sk-dfd…" with a link
//! to a console they had never opened — after typing a perfectly good DeepSeek
//! key. Sending one company's secret to another company's server is not a
//! configuration mistake, it is ours. So a provider's address is resolved here,
//! once, and a provider we have no address for is an error rather than a guess.
//!
//! The model list was a hardcoded table. It went stale the day a provider
//! shipped anything, it could not describe a provider we had never heard of, and
//! it offered models a key might not even have access to. Providers can be asked
//! — the OpenAI-compatible ones through `GET /models`, Anthropic through its own
//! `/v1/models` — so they are.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};

use crate::config::ProviderConfig;

/// How long a provider may take to list its models.
///
/// Short, because this is on the path of showing the model picker. A provider
/// that cannot answer in this long leaves its models missing and says why,
/// which beats a picker that will not open.
const LIST_TIMEOUT: Duration = Duration::from_secs(4);

/// The providers we ship an address for.
///
/// Being in this list buys exactly two things: a name to show, and an address
/// so nobody has to look one up. It is not a permission — any other id works
/// too, with an address the user gives it.
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

/// The wire protocol to speak, which is not the same thing as the company.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// Chat Completions, as copied by DeepSeek, Kimi, OpenRouter, vLLM, Ollama…
    OpenAi,
    Anthropic,
}

impl Dialect {
    pub fn as_str(self) -> &'static str {
        match self {
            Dialect::OpenAi => "openai",
            Dialect::Anthropic => "anthropic",
        }
    }

    fn parse(name: &str) -> Option<Dialect> {
        match name {
            "openai" => Some(Dialect::OpenAi),
            "anthropic" => Some(Dialect::Anthropic),
            _ => None,
        }
    }
}

/// Everything about a provider that does not depend on the network.
pub struct Resolved {
    pub label: String,
    pub base_url: Option<String>,
    pub dialect: Dialect,
    /// True when this provider is not one we ship, i.e. the user added it.
    pub custom: bool,
}

pub fn resolve(id: &str, config: &ProviderConfig) -> Resolved {
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
            // Only for providers we ship one for. A provider nobody told us the
            // address of has no address — the alternative is what this module
            // exists to prevent.
            .or_else(|| known.map(|(_, _, url, _)| (*url).to_string())),
        dialect: config
            .dialect
            .as_deref()
            .and_then(Dialect::parse)
            .or_else(|| known.map(|(.., dialect)| *dialect))
            .unwrap_or(Dialect::OpenAi),
        custom: known.is_none(),
    }
}

/// The providers a fresh install offers to fill in, in the order shown.
pub fn known() -> Vec<(&'static str, &'static str)> {
    KNOWN.iter().map(|(id, label, ..)| (*id, *label)).collect()
}

/// Asks a provider which models this key can use.
///
/// Ids only. What comes back is enough to choose one and send it, and the
/// context window and whether it reasons are not in any of these responses —
/// inventing them per model was how the hardcoded table started.
pub async fn list_models(id: &str, config: &ProviderConfig) -> Result<Vec<String>> {
    let resolved = resolve(id, config);
    let base = resolved
        .base_url
        .ok_or_else(|| anyhow!("{id} 没有接口地址，请填一个"))?;
    let key = config
        .api_key
        .clone()
        .filter(|key| !key.is_empty())
        .ok_or_else(|| anyhow!("{id} 还没有 API Key"))?;
    let base = base.trim_end_matches('/');

    let client = reqwest::Client::builder().timeout(LIST_TIMEOUT).build()?;
    let request = match resolved.dialect {
        Dialect::OpenAi => client.get(format!("{base}/models")).bearer_auth(key),
        // Anthropic puts the version in a header and the key in its own, and
        // its base URL has no `/v1` in it.
        Dialect::Anthropic => client
            .get(format!("{base}/v1/models"))
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
    };

    let response = request
        .send()
        .await
        .with_context(|| format!("问 {id} 要模型列表"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        // The provider's own words, trimmed. A key that was rejected is the
        // common case here and only the provider can say why.
        let detail: String = body.chars().take(300).collect();
        return Err(anyhow!("{id} 返回 {status}：{detail}"));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).with_context(|| format!("解析 {id} 的模型列表"))?;
    let mut ids: Vec<String> = parsed["data"]
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry["id"].as_str())
                .filter(|id| usable_for_chat(id))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Err(anyhow!("{id} 没有返回任何可用于对话的模型"));
    }
    Ok(ids)
}

/// Drops the models that cannot hold a conversation.
///
/// OpenAI answers this call with its whole catalogue: embeddings, speech,
/// transcription, images, moderation. None of them can be picked in a chat
/// picker, and a list of sixty entries where fifty are unusable is worse than a
/// slightly wrong filter. Matched on the name because that is all the response
/// gives us; a name we do not recognise stays.
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

/// Whether asking for thinking is something this model will accept.
///
/// A guess, from the name, and deliberately a conservative one: the lists
/// providers hand out say nothing about it. It decides one thing — whether
/// `reasoning_effort` goes in the request — and getting it wrong in the other
/// direction is not harmless: OpenAI rejects the whole request with a 400 when a
/// plain chat model is asked to reason.
pub fn reasons(id: &str) -> bool {
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
        "sonnet-4",
        "opus-4",
    ];
    let lowered = id.to_ascii_lowercase();
    REASONERS.iter().any(|hint| lowered.contains(hint))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_only() -> ProviderConfig {
        ProviderConfig {
            api_key: Some("sk-test".into()),
            ..Default::default()
        }
    }

    /// The bug this module was written for: a DeepSeek key and no address must
    /// not end up at OpenAI.
    #[test]
    fn a_provider_we_ship_knows_its_own_address() {
        let resolved = resolve("deepseek", &key_only());
        assert_eq!(
            resolved.base_url.as_deref(),
            Some("https://api.deepseek.com/v1")
        );
        assert_eq!(resolved.label, "DeepSeek");
        assert!(!resolved.custom);
    }

    #[test]
    fn what_the_user_typed_wins_over_what_we_ship() {
        let config = ProviderConfig {
            api_key: Some("sk-test".into()),
            base_url: Some("http://127.0.0.1:8080/v1".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve("deepseek", &config).base_url.as_deref(),
            Some("http://127.0.0.1:8080/v1")
        );
    }

    /// A provider we have never heard of is usable, and has no address until
    /// someone gives it one. Guessing here is the whole problem.
    #[test]
    fn a_provider_we_do_not_know_has_no_address_of_its_own() {
        let resolved = resolve("kimi", &key_only());
        assert_eq!(resolved.base_url, None);
        assert_eq!(resolved.label, "kimi");
        assert!(resolved.custom);
        assert_eq!(resolved.dialect, Dialect::OpenAi);
    }

    #[test]
    fn a_custom_provider_can_say_it_speaks_anthropic() {
        let config = ProviderConfig {
            api_key: Some("sk-test".into()),
            base_url: Some("https://example.test".into()),
            dialect: Some("anthropic".into()),
            label: Some("公司内网".into()),
            ..Default::default()
        };
        let resolved = resolve("inhouse", &config);
        assert_eq!(resolved.dialect, Dialect::Anthropic);
        assert_eq!(resolved.label, "公司内网");
    }

    #[tokio::test]
    async fn listing_without_an_address_says_so_instead_of_picking_one() {
        let error = list_models("kimi", &key_only())
            .await
            .expect_err("there is nowhere to ask");
        assert!(
            format!("{error:#}").contains("接口地址"),
            "unhelpful: {error:#}"
        );
    }

    #[test]
    fn the_things_a_chat_picker_cannot_use_are_left_out() {
        assert!(usable_for_chat("gpt-4o"));
        assert!(usable_for_chat("deepseek-chat"));
        assert!(!usable_for_chat("text-embedding-3-small"));
        assert!(!usable_for_chat("whisper-1"));
        assert!(!usable_for_chat("dall-e-3"));
    }
}
