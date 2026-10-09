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
use futures_util::StreamExt;

use crate::config::ProviderConfig;

/// How long a provider may take to list its models.
///
/// Short, because this is on the path of showing the model picker. A provider
/// that cannot answer in this long leaves its models missing and says why,
/// which beats a picker that will not open.
const LIST_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_MODEL_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// The providers we ship an address for.
///
/// Being in this list buys exactly two things: a name to show, and an address
/// so nobody has to look one up. It is not a permission — any other id works
/// too, with an address the user gives it.
const KNOWN: &[(&str, &str, &str, Dialect)] = &[
    (
        "kimi",
        "Kimi",
        "https://api.moonshot.cn/v1",
        Dialect::OpenAi,
    ),
    (
        "minimax",
        "MiniMax",
        "https://api.minimax.io/v1",
        Dialect::OpenAi,
    ),
    (
        "qwen",
        "千问",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        Dialect::OpenAi,
    ),
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

/// A provider credential may cross the network only under TLS, except for an
/// exact IP loopback endpoint used by local model servers and tests.
pub fn validate_credential_url(value: &str) -> Result<()> {
    let parsed = crate::http::Url::parse(value).context("读取模型接口地址")?;
    if !credential_url_allowed(&parsed) {
        return Err(anyhow!(
            "带 API Key 的模型接口必须使用 https；明文 http 只允许 127.0.0.1 或 [::1]，且地址不能包含凭证、query 或 fragment"
        ));
    }
    Ok(())
}

fn credential_url_allowed(parsed: &crate::http::Url) -> bool {
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return false;
    }
    let loopback = parsed
        .host_str()
        .and_then(|host| {
            host.trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<std::net::IpAddr>()
                .ok()
        })
        .is_some_and(|address| address.is_loopback());
    parsed.scheme() == "https" || (parsed.scheme() == "http" && loopback)
}

fn credential_redirect_policy() -> crate::http::redirect::Policy {
    crate::http::redirect::Policy::custom(|attempt| {
        let same_origin = attempt.previous().first().is_some_and(|original| {
            credential_origin(original) == credential_origin(attempt.url())
        });
        if attempt.previous().len() >= 5 || !credential_url_allowed(attempt.url()) || !same_origin {
            attempt.stop()
        } else {
            attempt.follow()
        }
    })
}

fn credential_origin(url: &crate::http::Url) -> (&str, Option<&str>, Option<u16>) {
    (url.scheme(), url.host_str(), url.port_or_known_default())
}

/// The providers a fresh install offers to fill in, in the order shown.
pub fn known() -> Vec<(&'static str, &'static str)> {
    KNOWN.iter().map(|(id, label, ..)| (*id, *label)).collect()
}

/// One model a provider says this key can use, and whatever the list itself
/// says about it.
///
/// Anthropic's own list carries the context window, the output cap, thinking
/// types and effort levels; Kimi and OpenRouter carry some of the same; most
/// gateways give an id and nothing else (`crate::capabilities`). Nothing is
/// invented per model here — inventing it was how the hardcoded table started.
#[derive(Debug, Clone)]
pub struct ListedModel {
    pub id: String,
    pub capabilities: genehub_proto::ModelCapabilities,
}

/// Anthropic pages its list, 20 by default; ask for its maximum per page and
/// follow `has_more`, but never forever.
const ANTHROPIC_PAGE_LIMIT: u32 = 1000;
const MAX_MODEL_PAGES: usize = 10;

#[derive(Debug)]
struct ProviderStatusError {
    status: u16,
    message: String,
}
impl std::fmt::Display for ProviderStatusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ProviderStatusError {}

/// Exercise an actual model, even for endpoints with a hand-written model list.
/// Remote bodies and credentials never enter the operation receipt.
pub async fn verify(id: &str, config: &ProviderConfig) -> genehub_proto::ProviderValidation {
    use genehub_proto::ProviderValidation;
    let result = |status: &str, detail: &str, model: Option<String>| ProviderValidation {
        status: status.into(),
        detail: detail.into(),
        model,
    };
    let Some(key) = config.api_key.as_deref().filter(|key| !key.is_empty()) else {
        return result("missingCredential", "尚未配置密钥", None);
    };
    let resolved = resolve(id, config);
    let Some(base) = resolved
        .base_url
        .filter(|base| validate_credential_url(base).is_ok())
    else {
        return result("unreachable", "接口地址无效", None);
    };
    let model = if let Some(model) = config.models.first() {
        model.clone()
    } else {
        match list_models(id, config).await {
            Ok(models) => match models.first().filter(|m| {
                !m.id.is_empty() && m.id.len() <= 200 && !m.id.chars().any(char::is_control)
            }) {
                Some(model) => model.id.clone(),
                None => {
                    return result(
                        "modelUnavailable",
                        "服务商未返回可用模型；可指定模型后重新配置",
                        None,
                    )
                }
            },
            Err(error) => {
                if error
                    .downcast_ref::<ProviderStatusError>()
                    .is_some_and(|e| matches!(e.status, 401 | 403))
                {
                    return result(
                        "authenticationFailed",
                        "模型服务拒绝了认证，请检查密钥和权限",
                        None,
                    );
                }
                return result(
                    "modelUnavailable",
                    "无法发现模型；可指定模型后重新配置",
                    None,
                );
            }
        }
    };
    let base = base.trim_end_matches('/').to_string();
    let caps = crate::capabilities::resolve(id, config, &model).caps;
    // OpenAI's reasoning models refuse `max_tokens`; ask in the field a
    // session would use, so the plain probe is not a false failure.
    let max_field = caps
        .compat
        .as_ref()
        .and_then(|compat| compat.max_tokens_field.clone());
    let max_field = max_field
        .as_deref()
        .filter(|_| resolved.dialect == Dialect::OpenAi)
        .unwrap_or("max_tokens");
    match probe(&base, key, resolved.dialect, &model, max_field, None).await {
        Ok((200..=299, true, _)) => {}
        Ok((401 | 403, ..)) => {
            return result(
                "authenticationFailed",
                "模型服务拒绝了认证，请检查密钥和权限",
                Some(model),
            )
        }
        Ok((200..=299, false, _)) => {
            return result("invalidResponse", "服务响应不符合所选协议", Some(model))
        }
        Ok(_) => {
            return result(
                "modelUnavailable",
                "模型调用失败，请检查模型名称、协议和额度",
                Some(model),
            )
        }
        Err(_) => {
            return result(
                "unreachable",
                "验证请求失败或超时，请检查地址和网络后重新验证",
                Some(model),
            )
        }
    }
    // §3: a model that reasons is asked once more the way a session will ask
    // it, so a gateway that insists on adaptive thinking says so here rather
    // than with a 400 in the middle of someone's task.
    let Some(thinking) = thinking_probe(resolved.dialect, &caps) else {
        return result("ready", "认证与模型调用已验证", Some(model));
    };
    match probe(
        &base,
        key,
        resolved.dialect,
        &model,
        max_field,
        Some(thinking),
    )
    .await
    {
        Ok((200..=299, true, _)) => result("ready", "认证、模型调用与思考参数已验证", Some(model)),
        Ok((400 | 422, _, hint)) => result(
            "thinkingRejected",
            &match (caps.thinking.as_deref(), hint.contains("adaptive")) {
                (Some("budget") | None, true) => {
                    "该模型要求 adaptive 思考；请在设置页把它的思考方式改为 adaptive".to_string()
                }
                (mode, _) => format!(
                    "模型拒绝了当前的思考参数（{}）；请在设置页调整该模型的思考方式",
                    mode.unwrap_or("budget")
                ),
            },
            Some(model),
        ),
        // Anything else is not about thinking; the plain call already passed.
        _ => result(
            "ready",
            "认证与模型调用已验证；思考参数未能确认",
            Some(model),
        ),
    }
}

/// The extra request fields a session would send to switch thinking on, or
/// `None` when this model is not asked to think.
fn thinking_probe(
    dialect: Dialect,
    caps: &genehub_proto::ModelCapabilities,
) -> Option<serde_json::Value> {
    if caps.reasoning != Some(true) {
        return None;
    }
    let compat = caps.compat.clone().unwrap_or_default();
    // The cheapest effort the model declares; "low" when it declares none.
    let declared = || {
        caps.efforts.as_ref().and_then(|efforts| {
            efforts
                .iter()
                .find(|effort| effort.as_str() == "low")
                .or(efforts.first())
                .cloned()
        })
    };
    let low = || declared().unwrap_or_else(|| "low".into());
    match dialect {
        // Same shape the agent sends (apps/agent/src/provider/anthropic.rs).
        Dialect::Anthropic => {
            let display = compat
                .thinking_display
                .clone()
                .unwrap_or_else(|| "summarized".into());
            match caps.thinking.as_deref() {
                Some("adaptive") => {
                    let mut extra = serde_json::json!({
                        "max_tokens": 2048,
                        "thinking": {"type": "adaptive", "display": display},
                    });
                    if let Some(effort) = declared() {
                        extra["output_config"] = serde_json::json!({"effort": effort});
                    }
                    Some(extra)
                }
                Some("budget") | None => Some(serde_json::json!({
                    "max_tokens": 2048,
                    "thinking": {"type": "enabled", "budget_tokens": 1024, "display": display},
                })),
                _ => None,
            }
        }
        Dialect::OpenAi => {
            // Same switch as apps/agent/src/provider/openai.rs `build_body`.
            if caps.thinking.as_deref() == Some("none") {
                return None;
            }
            match compat.thinking_format.as_deref() {
                Some("deepseek") => Some(serde_json::json!({"thinking": {"type": "enabled"}})),
                Some("openrouter") => Some(serde_json::json!({"reasoning": {"effort": low()}})),
                _ if compat.supports_reasoning_effort == Some(false) => None,
                _ => Some(serde_json::json!({"reasoning_effort": low()})),
            }
        }
    }
}

/// One minimal, non-streaming call. Returns the status, whether the body has
/// the dialect's shape, and on failure a lowercase hint of why — matched
/// locally, never stored, because a remote body may echo anything.
async fn probe(
    base: &str,
    key: &str,
    dialect: Dialect,
    model: &str,
    max_field: &str,
    extra: Option<serde_json::Value>,
) -> Result<(u16, bool, String)> {
    let client = crate::http::Client::builder()
        .timeout(LIST_TIMEOUT)
        .redirect(credential_redirect_policy())
        .build()?;
    let mut body = serde_json::json!({
        "model": model, "messages": [{"role":"user","content":"Reply OK."}], "stream":false,
    });
    body[max_field] = serde_json::json!(16);
    if let Some(serde_json::Value::Object(extra)) = extra {
        for (field, value) in extra {
            // The thinking probe needs room to think; keep the one cap field.
            let field = if field == "max_tokens" {
                max_field.to_string()
            } else {
                field
            };
            body[field] = value;
        }
    }
    let request = match dialect {
        Dialect::OpenAi => client
            .post(format!("{base}/chat/completions"))
            .bearer_auth(key)
            .json(&body),
        Dialect::Anthropic => client
            .post(format!("{base}/v1/messages"))
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .json(&body),
    };
    let response = request.send().await?;
    let status = response.status();
    if response.content_length().is_some_and(|n| n > 64 * 1024) {
        return Ok((status.as_u16(), false, String::new()));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len().saturating_add(chunk.len()) > 64 * 1024 {
            return Ok((status.as_u16(), false, String::new()));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let hint: String = String::from_utf8_lossy(&bytes).chars().take(2000).collect();
        return Ok((status.as_u16(), false, hint.to_ascii_lowercase()));
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)?;
    let valid = match dialect {
        Dialect::OpenAi => value
            .pointer("/choices/0/message")
            .is_some_and(serde_json::Value::is_object),
        Dialect::Anthropic => value
            .get("content")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|items| !items.is_empty()),
    };
    Ok((status.as_u16(), valid, String::new()))
}

pub async fn list_models(id: &str, config: &ProviderConfig) -> Result<Vec<ListedModel>> {
    let resolved = resolve(id, config);
    let base = resolved
        .base_url
        .ok_or_else(|| anyhow!("{id} 没有接口地址，请填一个"))?;
    let key = config
        .api_key
        .clone()
        .filter(|key| !key.is_empty())
        .ok_or_else(|| anyhow!("{id} 还没有 API Key"))?;
    validate_credential_url(&base)?;
    let base = base.trim_end_matches('/');

    let client = crate::http::Client::builder()
        .timeout(LIST_TIMEOUT)
        .redirect(credential_redirect_policy())
        .build()?;
    let mut models = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_MODEL_PAGES {
        let request = match resolved.dialect {
            Dialect::OpenAi => client.get(format!("{base}/models")).bearer_auth(&key),
            // Anthropic puts the version in a header and the key in its own, and
            // its base URL has no `/v1` in it.
            Dialect::Anthropic => {
                let mut query = vec![("limit", ANTHROPIC_PAGE_LIMIT.to_string())];
                if let Some(after) = &after {
                    query.push(("after_id", after.clone()));
                }
                client
                    .get(format!("{base}/v1/models"))
                    .query(&query)
                    .header("x-api-key", key.as_str())
                    .header("anthropic-version", "2023-06-01")
            }
        };
        let parsed = fetch_page(id, config, request).await?;
        models.extend(parse_models(&parsed, resolved.dialect));
        // Only Anthropic pages; an OpenAI-compatible list is whole.
        let next = parsed["last_id"].as_str().filter(|last| !last.is_empty());
        match (resolved.dialect, parsed["has_more"].as_bool(), next) {
            (Dialect::Anthropic, Some(true), Some(last)) if after.as_deref() != Some(last) => {
                after = Some(last.to_string());
            }
            _ => break,
        }
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    if models.is_empty() {
        return Err(anyhow!("{id} 没有返回任何可用于对话的模型"));
    }
    Ok(models)
}

async fn fetch_page(
    id: &str,
    config: &ProviderConfig,
    request: crate::http::RequestBuilder,
) -> Result<serde_json::Value> {
    let response = request
        .send()
        .await
        .with_context(|| format!("问 {id} 要模型列表"))?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MODEL_RESPONSE_BYTES as u64)
    {
        return Err(anyhow!("{id} 的模型列表超过大小限制"));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("读取 {id} 的模型列表"))?;
        if body.len().saturating_add(chunk.len()) > MAX_MODEL_RESPONSE_BYTES {
            return Err(anyhow!("{id} 的模型列表超过大小限制"));
        }
        body.extend_from_slice(&chunk);
    }
    let body = String::from_utf8_lossy(&body);
    if !status.is_success() {
        // The provider's own words, trimmed. A key that was rejected is the
        // common case here and only the provider can say why.
        let safe_body = body.replace(config.api_key.as_deref().unwrap_or("\0"), "[redacted]");
        let detail: String = safe_body.chars().take(300).collect();
        return Err(ProviderStatusError {
            status: status.as_u16(),
            message: format!("{id} 返回 {status}：{detail}"),
        }
        .into());
    }
    serde_json::from_str(&body).with_context(|| format!("解析 {id} 的模型列表"))
}

/// The chat models in one list page, with what each entry says about itself.
fn parse_models(page: &serde_json::Value, dialect: Dialect) -> Vec<ListedModel> {
    page["data"]
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let id = entry["id"].as_str()?;
                    usable_for_chat(id).then(|| ListedModel {
                        id: id.to_string(),
                        capabilities: match dialect {
                            Dialect::Anthropic => crate::capabilities::from_anthropic(entry),
                            Dialect::OpenAi => crate::capabilities::from_openai(entry),
                        },
                    })
                })
                .collect()
        })
        .unwrap_or_default()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_keys_require_tls_except_on_exact_ip_loopback() {
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
        let resolved = resolve("inhouse-llm", &key_only());
        assert_eq!(resolved.base_url, None);
        assert_eq!(resolved.label, "inhouse-llm");
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
        let error = list_models("inhouse-llm", &key_only())
            .await
            .expect_err("there is nowhere to ask");
        assert!(
            format!("{error:#}").contains("接口地址"),
            "unhelpful: {error:#}"
        );
    }

    #[tokio::test]
    async fn provider_credentials_are_not_followed_to_an_insecure_redirect() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let count = socket.read(&mut request).await.unwrap();
            assert!(String::from_utf8_lossy(&request[..count])
                .to_ascii_lowercase()
                .contains("authorization: bearer sk-test"));
            socket
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: http://192.0.2.1/models\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let config = ProviderConfig {
            api_key: Some("sk-test".into()),
            base_url: Some(format!("http://{address}")),
            ..Default::default()
        };

        let error = list_models("redirect-test", &config).await.unwrap_err();
        assert!(format!("{error:#}").contains("302"));
    }

    /// Anthropic returns 20 models unless asked for more, and pages beyond
    /// `limit`. Both pages must arrive, with what each entry says about itself.
    #[tokio::test]
    async fn anthropic_lists_are_paged_and_carry_capabilities() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut seen = Vec::new();
            for page in [
                r#"{"data":[{"id":"claude-opus-5","max_input_tokens":1000000,"max_tokens":128000,"capabilities":{"thinking":{"supported":true,"types":{"adaptive":{"supported":true},"enabled":{"supported":false},"disabled":{"supported":true}}}}}],"has_more":true,"last_id":"claude-opus-5"}"#,
                r#"{"data":[{"id":"claude-haiku-4-5"}],"has_more":false,"last_id":"claude-haiku-4-5"}"#,
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0u8; 4096];
                let count = socket.read(&mut request).await.unwrap();
                let head = String::from_utf8_lossy(&request[..count]);
                seen.push(head.lines().next().unwrap_or_default().to_string());
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
                    page.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            seen
        });
        let config = ProviderConfig {
            api_key: Some("sk-test".into()),
            base_url: Some(format!("http://{address}")),
            dialect: Some("anthropic".into()),
            ..Default::default()
        };
        let models = list_models("anthropic-test", &config).await.unwrap();
        let seen = server.await.unwrap();
        assert!(seen[0].contains("limit=1000"), "{seen:?}");
        assert!(seen[1].contains("after_id=claude-opus-5"), "{seen:?}");
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["claude-haiku-4-5", "claude-opus-5"]
        );
        let opus = &models[1].capabilities;
        assert_eq!(opus.context_window, Some(1_000_000));
        assert_eq!(opus.thinking.as_deref(), Some("adaptive"));
        assert!(models[0].capabilities.is_empty());
    }

    /// A gateway that takes a plain call but refuses budget thinking is caught
    /// by verify, with the fix named, before a session meets the 400.
    #[tokio::test]
    async fn verify_catches_a_model_that_refuses_the_thinking_it_is_sent() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut bodies = Vec::new();
            for (status, reply) in [
                ("200 OK", r#"{"content":[{"type":"text","text":"OK"}]}"#),
                (
                    "400 Bad Request",
                    r#"{"type":"error","error":{"type":"invalid_request_error","message":"thinking.type.enabled is not supported for this model. Use thinking.type.adaptive"}}"#,
                ),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                // Read the head, then exactly the body it announces.
                let body = loop {
                    let count = socket.read(&mut chunk).await.unwrap();
                    request.extend_from_slice(&chunk[..count]);
                    let text = String::from_utf8_lossy(&request).to_string();
                    if let Some(split) = text.find("\r\n\r\n") {
                        let length = text[..split]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= split + 4 + length {
                            break text[split + 4..].to_string();
                        }
                    }
                    assert!(count > 0, "connection closed early");
                };
                bodies.push(serde_json::from_str::<serde_json::Value>(&body).unwrap());
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            bodies
        });
        let config = ProviderConfig {
            api_key: Some("sk-test".into()),
            base_url: Some(format!("http://{address}")),
            dialect: Some("anthropic".into()),
            models: vec!["claude-sonnet-4-5".into()],
            ..Default::default()
        };
        let validation = verify("gateway", &config).await;
        let bodies = server.await.unwrap();
        assert!(bodies[0].get("thinking").is_none(), "{bodies:?}");
        assert_eq!(bodies[1]["thinking"]["type"], "enabled", "{bodies:?}");
        assert_eq!(bodies[1]["thinking"]["budget_tokens"], 1024);
        assert_eq!(validation.status, "thinkingRejected");
        assert!(
            validation.detail.contains("adaptive"),
            "{}",
            validation.detail
        );
        // Nothing the remote said is carried into the receipt.
        assert!(!validation.detail.contains("invalid_request_error"));
    }

    #[test]
    fn thinking_probes_follow_what_a_session_sends() {
        use genehub_proto::{ModelCapabilities, ModelCompat};
        let plain = ModelCapabilities::default();
        assert!(thinking_probe(Dialect::OpenAi, &plain).is_none());
        let reasoner = |thinking: Option<&str>, compat: Option<ModelCompat>| ModelCapabilities {
            reasoning: Some(true),
            thinking: thinking.map(Into::into),
            compat,
            ..Default::default()
        };
        let adaptive =
            thinking_probe(Dialect::Anthropic, &reasoner(Some("adaptive"), None)).unwrap();
        assert_eq!(adaptive["thinking"]["type"], "adaptive");
        assert!(adaptive.get("output_config").is_none());
        assert!(thinking_probe(Dialect::Anthropic, &reasoner(Some("only"), None)).is_none());
        let deepseek = ModelCompat {
            thinking_format: Some("deepseek".into()),
            ..Default::default()
        };
        let probe = thinking_probe(Dialect::OpenAi, &reasoner(None, Some(deepseek))).unwrap();
        assert_eq!(probe["thinking"]["type"], "enabled");
        let kimi = ModelCompat {
            supports_reasoning_effort: Some(false),
            ..Default::default()
        };
        assert!(thinking_probe(Dialect::OpenAi, &reasoner(None, Some(kimi))).is_none());
        assert_eq!(
            thinking_probe(Dialect::OpenAi, &reasoner(None, None)).unwrap()["reasoning_effort"],
            "low"
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
