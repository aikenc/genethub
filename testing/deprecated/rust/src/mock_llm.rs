//! A scriptable stand-in for an OpenAI-compatible model API.
//!
//! The frame shapes here are copied from what the real DeepSeek API actually
//! sends (`docs/testing.md` §8), not from the documentation. A mock that emits
//! a tidier stream than reality is worse than no mock: it hides exactly the
//! parsing bugs it should be catching.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::Mutex;

/// What the model should do on the next request.
#[derive(Debug, Clone)]
pub enum Scripted {
    /// A normal streamed reply.
    Reply(Turn),
    /// An HTTP-level failure before any streaming starts.
    Status { code: u16, message: String },
    /// Frames, then the connection drops without `[DONE]`.
    Truncated(Turn),
    /// A reply that dribbles out, so the turn is still open when the test acts.
    ///
    /// Interrupting or disconnecting only means anything mid-turn, and a mock
    /// that answers instantly never leaves a mid-turn to catch.
    Slow { turn: Turn, gap: Duration },
    /// A syntactically broken SSE payload.
    Malformed,
}

/// One assistant turn, described in terms of what the model produces.
#[derive(Debug, Clone, Default)]
pub struct Turn {
    reasoning: Option<String>,
    text: Option<String>,
    tools: Vec<(String, Value)>,
    prompt_tokens: u64,
    completion_tokens: u64,
}

/// Deterministic model-and-tool workloads for capacity journeys.
///
/// The profile changes both the number and shape of real Agent tool loops and
/// the SSE cadence. `Normal` is deliberately the default: an accidental run
/// must not fall back to the old one-read microbenchmark.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MockWorkloadProfile {
    Fast,
    #[default]
    Normal,
    Deep,
}

impl MockWorkloadProfile {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Normal => "normal",
            Self::Deep => "deep",
        }
    }

    pub const fn tool_rounds(self) -> usize {
        match self {
            Self::Fast => 1,
            Self::Normal => 4,
            Self::Deep => 10,
        }
    }

    pub const fn tool_calls_per_turn(self) -> usize {
        match self {
            Self::Fast => 1,
            Self::Normal => 6,
            Self::Deep => 17,
        }
    }

    pub const fn model_requests_per_turn(self) -> usize {
        self.tool_rounds() + 1
    }

    pub const fn frame_gap(self) -> Duration {
        match self {
            Self::Fast => Duration::ZERO,
            Self::Normal => Duration::from_millis(15),
            Self::Deep => Duration::from_millis(40),
        }
    }
}

impl FromStr for MockWorkloadProfile {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "fast" => Ok(Self::Fast),
            "normal" => Ok(Self::Normal),
            "deep" => Ok(Self::Deep),
            other => Err(format!(
                "unknown mock workload {other:?}; expected fast, normal, or deep"
            )),
        }
    }
}

impl Turn {
    pub fn text(text: impl Into<String>) -> Self {
        Turn {
            text: Some(text.into()),
            prompt_tokens: 40,
            completion_tokens: 12,
            ..Turn::default()
        }
    }

    /// A turn that only calls tools. The agent will run them and come back.
    pub fn tool(name: impl Into<String>, arguments: Value) -> Self {
        Turn {
            tools: vec![(name.into(), arguments)],
            prompt_tokens: 40,
            completion_tokens: 20,
            ..Turn::default()
        }
    }

    pub fn and_tool(mut self, name: impl Into<String>, arguments: Value) -> Self {
        self.tools.push((name.into(), arguments));
        self
    }

    pub fn thinking(mut self, reasoning: impl Into<String>) -> Self {
        self.reasoning = Some(reasoning.into());
        self
    }

    /// Splits content into small pieces the way a real stream arrives, so the
    /// consumer's incremental handling is actually exercised.
    fn frames(&self) -> Vec<Value> {
        let mut frames = Vec::new();

        if let Some(reasoning) = &self.reasoning {
            for piece in split(reasoning) {
                frames.push(delta(json!({ "reasoning_content": piece })));
            }
        }

        if !self.tools.is_empty() {
            for (index, (name, arguments)) in self.tools.iter().enumerate() {
                // The opening frame carries id and name; later frames carry
                // only argument fragments, keyed by index.
                frames.push(delta(json!({
                    "tool_calls": [{
                        "index": index,
                        "id": format!("call_{index}_{}", name),
                        "type": "function",
                        "function": { "name": name, "arguments": "" }
                    }]
                })));
                let encoded = arguments.to_string();
                for piece in split(&encoded) {
                    frames.push(delta(json!({
                        "tool_calls": [{
                            "index": index,
                            "function": { "arguments": piece }
                        }]
                    })));
                }
            }
            frames.push(finish("tool_calls"));
        } else {
            let text = self.text.clone().unwrap_or_default();
            for piece in split(&text) {
                frames.push(delta(json!({ "content": piece })));
            }
            frames.push(finish("stop"));
        }

        frames.push(json!({
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "choices": [],
            "usage": {
                "prompt_tokens": self.prompt_tokens,
                "completion_tokens": self.completion_tokens,
                "total_tokens": self.prompt_tokens + self.completion_tokens,
                "prompt_cache_hit_tokens": 0,
                "prompt_cache_miss_tokens": self.prompt_tokens,
            }
        }));
        frames
    }
}

fn delta(delta: Value) -> Value {
    json!({
        "id": "chatcmpl-mock",
        "object": "chat.completion.chunk",
        "choices": [{ "index": 0, "delta": delta, "finish_reason": null }]
    })
}

fn finish(reason: &str) -> Value {
    json!({
        "id": "chatcmpl-mock",
        "object": "chat.completion.chunk",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": reason }]
    })
}

/// Chunks a string into a handful of pieces, splitting mid-word on purpose.
fn split(text: &str) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    let chars: Vec<char> = text.chars().collect();
    let size = chars.len().div_ceil(4).max(1);
    chars
        .chunks(size)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

#[derive(Default)]
struct Inner {
    script: VecDeque<Scripted>,
    repeated: Option<Repeated>,
    /// Every request body received, for assertions about what we sent the model.
    requests: Vec<Value>,
    request_body_bytes: Vec<usize>,
}

#[derive(Debug, Clone)]
enum Repeated {
    ToolThenText {
        name: String,
        arguments: Value,
        text: String,
    },
    SlowText {
        text: String,
        gap: Duration,
    },
    Workload(MockWorkloadProfile),
}

pub struct MockLlm {
    inner: Arc<Mutex<Inner>>,
    pub base_url: String,
    handle: tokio::task::JoinHandle<()>,
}

/// The one model this mock has, taken from what journeys ask for.
fn mock_model_id() -> &'static str {
    crate::harness::REAL_MODEL
        .split_once('/')
        .map(|(_, id)| id)
        .unwrap_or(crate::harness::REAL_MODEL)
}

/// What this "provider" has. Shaped like OpenAI's answer, embeddings entry and
/// all: the daemon filters those out and a test should see it happen.
async fn models() -> Json<Value> {
    Json(json!({
        "object": "list",
        "data": [
            { "id": mock_model_id(), "object": "model" },
            { "id": "text-embedding-3-small", "object": "model" },
        ],
    }))
}

impl MockLlm {
    pub async fn start() -> Result<Self> {
        let inner = Arc::new(Mutex::new(Inner::default()));
        let app = Router::new()
            .route("/chat/completions", post(completions))
            // The daemon asks a provider what it has before it offers a picker,
            // so a mock that cannot answer this is a mock that has no models —
            // and every journey would run against an empty catalog.
            .route("/models", axum::routing::get(models))
            .with_state(inner.clone());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });

        Ok(MockLlm {
            inner,
            base_url: format!("http://127.0.0.1:{port}"),
            handle,
        })
    }

    /// Queues one response. Calls are consumed in order.
    pub async fn push(&self, scripted: Scripted) {
        self.inner.lock().await.script.push_back(scripted);
    }

    pub async fn reply(&self, turn: Turn) {
        self.push(Scripted::Reply(turn)).await;
    }

    /// Queues a reply that takes `gap` between frames.
    pub async fn reply_slowly(&self, turn: Turn, gap: Duration) {
        self.push(Scripted::Slow { turn, gap }).await;
    }

    /// Answers any number of concurrent, independent agent turns with the
    /// same tool-then-text flow. A FIFO script cannot model this honestly:
    /// one fast agent's follow-up may arrive before another agent's first
    /// request. The request history decides which half of the flow applies.
    pub async fn repeat_tool_then_text(
        &self,
        name: impl Into<String>,
        arguments: Value,
        text: impl Into<String>,
    ) {
        self.inner.lock().await.repeated = Some(Repeated::ToolThenText {
            name: name.into(),
            arguments,
            text: text.into(),
        });
    }

    /// Keeps one or more model requests in flight for an isolation probe.
    pub async fn repeat_slow_text(&self, text: impl Into<String>, gap: Duration) {
        self.inner.lock().await.repeated = Some(Repeated::SlowText {
            text: text.into(),
            gap,
        });
    }

    /// Replays a concurrency-safe coding workload for any number of Agents.
    /// Progress is derived from each request's conversation after its latest
    /// user message, so interleaved requests never share mutable round state.
    pub async fn repeat_workload(&self, profile: MockWorkloadProfile) {
        self.inner.lock().await.repeated = Some(Repeated::Workload(profile));
    }

    pub async fn clear_repeated(&self) {
        self.inner.lock().await.repeated = None;
    }

    /// What the agent sent the model, in order.
    pub async fn requests(&self) -> Vec<Value> {
        self.inner.lock().await.requests.clone()
    }

    pub async fn request_count(&self) -> usize {
        self.inner.lock().await.requests.len()
    }

    /// Compact-JSON request sizes approximate the real provider body emitted
    /// by the Agent and make accumulated tool history visible in load reports.
    pub async fn request_body_bytes(&self) -> Vec<usize> {
        self.inner.lock().await.request_body_bytes.clone()
    }

    pub fn shutdown(self) {
        self.handle.abort();
    }
}

async fn completions(
    State(inner): State<Arc<Mutex<Inner>>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    // The agent must authenticate even against the mock; skipping it here would
    // let a missing-credentials bug through.
    if !headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("Bearer ") && value.len() > 7)
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": {"message": "no api key"}})),
        )
            .into_response();
    }

    let scripted = {
        let mut guard = inner.lock().await;
        guard
            .request_body_bytes
            .push(serde_json::to_vec(&body).map_or(0, |bytes| bytes.len()));
        guard.requests.push(body.clone());
        guard
            .script
            .pop_front()
            .or_else(|| guard.repeated.as_ref().map(|plan| repeated(plan, &body)))
    };

    let scripted = match scripted {
        Some(scripted) => scripted,
        // Running off the end of the script is a test bug, and saying so beats
        // hanging or returning something plausible.
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": {"message": "mock llm: the script is empty"}})),
            )
                .into_response()
        }
    };

    match scripted {
        Scripted::Status { code, message } => (
            StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(json!({ "error": { "message": message } })),
        )
            .into_response(),
        Scripted::Malformed => sse(vec!["data: {this is not json\n\n".to_string()]),
        Scripted::Truncated(turn) => {
            let mut lines: Vec<String> = turn
                .frames()
                .iter()
                .take(2)
                .map(|frame| format!("data: {frame}\n\n"))
                .collect();
            // No [DONE]: the stream simply stops.
            lines.truncate(2);
            sse(lines)
        }
        Scripted::Reply(turn) => {
            let mut lines: Vec<String> = turn
                .frames()
                .iter()
                .map(|frame| format!("data: {frame}\n\n"))
                .collect();
            lines.push("data: [DONE]\n\n".to_string());
            sse(lines)
        }
        Scripted::Slow { turn, gap } => {
            let mut lines: Vec<String> = turn
                .frames()
                .iter()
                .map(|frame| format!("data: {frame}\n\n"))
                .collect();
            lines.push("data: [DONE]\n\n".to_string());
            trickle(lines, gap)
        }
    }
}

fn repeated(plan: &Repeated, body: &Value) -> Scripted {
    match plan {
        Repeated::ToolThenText {
            name,
            arguments,
            text,
        } => {
            let has_tool_result = body["messages"]
                .as_array()
                .and_then(|messages| messages.last())
                .is_some_and(|message| message["role"] == "tool");
            if has_tool_result {
                Scripted::Reply(Turn::text(text.clone()))
            } else {
                Scripted::Reply(Turn::tool(name.clone(), arguments.clone()))
            }
        }
        Repeated::SlowText { text, gap } => Scripted::Slow {
            turn: Turn::text(text.clone()),
            gap: *gap,
        },
        Repeated::Workload(profile) => workload(*profile, body),
    }
}

fn workload(profile: MockWorkloadProfile, body: &Value) -> Scripted {
    let round = completed_tool_rounds(body);
    let rounds = workload_rounds(profile);
    let turn = if let Some(calls) = rounds.get(round) {
        let mut calls = calls.iter();
        let (name, arguments) = calls
            .next()
            .expect("every workload round has at least one tool");
        let mut turn = Turn::tool(*name, arguments.clone());
        for (name, arguments) in calls {
            turn = turn.and_tool(*name, arguments.clone());
        }
        if profile == MockWorkloadProfile::Fast {
            turn
        } else {
            turn.thinking(format!(
                "Inspecting the workspace: {} round {}.",
                profile.name(),
                round + 1
            ))
        }
    } else {
        let turn = Turn::text(format!(
            "{} workspace investigation complete.",
            profile.name()
        ));
        if profile == MockWorkloadProfile::Deep {
            turn.thinking("Cross-checking the accumulated evidence before reporting.")
        } else {
            turn
        }
    };
    if profile.frame_gap().is_zero() {
        Scripted::Reply(turn)
    } else {
        Scripted::Slow {
            turn,
            gap: profile.frame_gap(),
        }
    }
}

fn completed_tool_rounds(body: &Value) -> usize {
    let Some(messages) = body["messages"].as_array() else {
        return 0;
    };
    let after_user = messages
        .iter()
        .rposition(|message| message["role"] == "user")
        .map_or(messages.as_slice(), |index| &messages[index + 1..]);
    after_user
        .iter()
        .filter(|message| {
            message["role"] == "assistant"
                && message["tool_calls"]
                    .as_array()
                    .is_some_and(|calls| !calls.is_empty())
        })
        .count()
}

fn workload_rounds(profile: MockWorkloadProfile) -> Vec<Vec<(&'static str, Value)>> {
    let list_and_find = vec![
        ("ls", json!({"path": ""})),
        ("find", json!({"pattern": ".rs", "path": "", "limit": 40})),
    ];
    match profile {
        MockWorkloadProfile::Fast => vec![vec![("read", json!({"path": "task.txt"}))]],
        MockWorkloadProfile::Normal => vec![
            list_and_find,
            vec![(
                "grep",
                json!({"pattern": "GENEHUB_LOAD_MARKER", "path": "src", "limit": 40}),
            )],
            vec![
                ("read", json!({"path": "README.md"})),
                ("read", json!({"path": "src/lib.rs"})),
            ],
            vec![(
                "bash",
                json!({"command": "wc -l README.md src/lib.rs src/main.rs tests/workflow.rs"}),
            )],
        ],
        MockWorkloadProfile::Deep => vec![
            list_and_find,
            vec![
                (
                    "grep",
                    json!({"pattern": "GENEHUB_LOAD_MARKER", "path": "src", "limit": 100}),
                ),
                ("grep", json!({"pattern": "TODO", "path": "", "limit": 100})),
            ],
            vec![
                ("read", json!({"path": "README.md"})),
                ("read", json!({"path": "task.txt"})),
            ],
            vec![
                ("read", json!({"path": "src/lib.rs"})),
                ("read", json!({"path": "src/main.rs"})),
            ],
            vec![
                (
                    "grep",
                    json!({"pattern": "#[test]", "path": "tests", "limit": 20}),
                ),
                (
                    "grep",
                    json!({"pattern": "architecture", "path": "docs", "limit": 20}),
                ),
            ],
            vec![
                (
                    "bash",
                    json!({"command": "wc -l README.md src/lib.rs src/main.rs tests/workflow.rs docs/design.md"}),
                ),
                (
                    "bash",
                    json!({"command": "find src tests docs -type f -print | sort"}),
                ),
            ],
            vec![(
                "grep",
                json!({"pattern": "pub fn", "path": "src", "limit": 100}),
            )],
            vec![(
                "grep",
                json!({"pattern": "evidence-", "path": "data/deep-context.txt", "limit": 40}),
            )],
            vec![(
                "bash",
                json!({"command": "cksum data/deep-context.txt && head -n 20 data/deep-context.txt"}),
            )],
            vec![
                ("find", json!({"pattern": ".md", "path": "", "limit": 40})),
                (
                    "grep",
                    json!({"pattern": "architecture", "path": "docs", "limit": 40}),
                ),
            ],
        ],
    }
}

/// The same stream, one frame every `gap`.
fn trickle(lines: Vec<String>, gap: Duration) -> Response {
    let stream = futures_util::stream::iter(lines).then(move |line| async move {
        tokio::time::sleep(gap).await;
        Ok::<_, std::io::Error>(line.into_bytes())
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .expect("building the SSE response")
}

fn sse(lines: Vec<String>) -> Response {
    let stream = futures_util::stream::iter(
        lines
            .into_iter()
            .map(|line| Ok::<_, std::io::Error>(line.into_bytes())),
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .expect("building the SSE response")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_deltas(turn: &Turn) -> Vec<Value> {
        turn.frames()
            .into_iter()
            .filter_map(|frame| frame["choices"][0]["delta"].as_object().cloned())
            .map(Value::Object)
            .filter(|delta| !delta.as_object().unwrap().is_empty())
            .collect()
    }

    #[test]
    fn text_arrives_in_several_pieces_so_streaming_is_exercised() {
        let deltas = frame_deltas(&Turn::text("hello world"));
        assert!(deltas.len() > 1, "a one-frame reply tests nothing");
        let joined: String = deltas
            .iter()
            .filter_map(|d| d["content"].as_str())
            .collect();
        assert_eq!(joined, "hello world");
    }

    /// Reasoning rides on its own field and must not leak into `content`;
    /// conflating them is the exact bug this mock exists to catch.
    #[test]
    fn reasoning_is_carried_separately_from_content() {
        let turn = Turn::text("answer").thinking("let me think");
        let deltas = frame_deltas(&turn);
        let reasoning: String = deltas
            .iter()
            .filter_map(|d| d["reasoning_content"].as_str())
            .collect();
        let content: String = deltas
            .iter()
            .filter_map(|d| d["content"].as_str())
            .collect();
        assert_eq!(reasoning, "let me think");
        assert_eq!(content, "answer");
    }

    #[test]
    fn a_tool_call_opens_with_id_and_name_then_streams_arguments() {
        let turn = Turn::tool("write", json!({"path": "a.txt", "content": "hi"}));
        let deltas = frame_deltas(&turn);

        let first = &deltas[0]["tool_calls"][0];
        assert!(first["id"].is_string());
        assert_eq!(first["function"]["name"], "write");
        assert_eq!(first["function"]["arguments"], "");

        let arguments: String = deltas[1..]
            .iter()
            .filter_map(|d| d["tool_calls"][0]["function"]["arguments"].as_str())
            .collect();
        let parsed: Value = serde_json::from_str(&arguments).expect("fragments reassemble");
        assert_eq!(parsed["path"], "a.txt");
    }

    #[test]
    fn parallel_tool_calls_are_distinguished_by_index() {
        let turn = Turn::tool("read", json!({"path": "a"})).and_tool("read", json!({"path": "b"}));
        let indexes: Vec<u64> = frame_deltas(&turn)
            .iter()
            .filter_map(|d| d["tool_calls"][0]["index"].as_u64())
            .collect();
        assert!(indexes.contains(&0) && indexes.contains(&1));
    }

    #[test]
    fn the_finish_reason_distinguishes_a_tool_turn_from_a_final_one() {
        let reason = |turn: Turn| -> String {
            turn.frames()
                .iter()
                .find_map(|f| f["choices"][0]["finish_reason"].as_str().map(String::from))
                .unwrap()
        };
        assert_eq!(reason(Turn::text("done")), "stop");
        assert_eq!(reason(Turn::tool("read", json!({}))), "tool_calls");
    }

    #[test]
    fn usage_carries_the_cache_fields_the_real_api_sends() {
        let turn = Turn::text("hi");
        let usage = turn
            .frames()
            .into_iter()
            .find_map(|frame| frame.get("usage").cloned())
            .expect("a usage frame");
        assert!(usage["prompt_cache_hit_tokens"].is_number());
        assert!(usage["total_tokens"].as_u64().unwrap() > 0);
    }

    #[test]
    fn workload_profiles_are_named_bounded_and_default_to_normal() {
        assert_eq!(MockWorkloadProfile::default(), MockWorkloadProfile::Normal);
        for (name, profile, rounds, calls, requests, gap) in [
            ("fast", MockWorkloadProfile::Fast, 1, 1, 2, 0),
            ("normal", MockWorkloadProfile::Normal, 4, 6, 5, 15),
            ("deep", MockWorkloadProfile::Deep, 10, 17, 11, 40),
        ] {
            assert_eq!(name.parse::<MockWorkloadProfile>().unwrap(), profile);
            assert_eq!(profile.name(), name);
            assert_eq!(profile.tool_rounds(), rounds);
            assert_eq!(profile.tool_calls_per_turn(), calls);
            assert_eq!(profile.model_requests_per_turn(), requests);
            assert_eq!(profile.frame_gap(), Duration::from_millis(gap));
            assert_eq!(
                workload_rounds(profile).iter().map(Vec::len).sum::<usize>(),
                calls
            );
        }
        assert!("slow".parse::<MockWorkloadProfile>().is_err());
    }

    #[test]
    fn a_repeated_workload_advances_from_each_requests_own_history() {
        let first = scripted_turn(workload(
            MockWorkloadProfile::Normal,
            &json!({"messages": [{"role": "user", "content": "inspect"}]}),
        ));
        assert_eq!(first.tools.len(), 2);
        assert_eq!(first.tools[0].0, "ls");

        let second = scripted_turn(workload(
            MockWorkloadProfile::Normal,
            &json!({"messages": [
                {"role": "user", "content": "inspect"},
                {"role": "assistant", "tool_calls": [{"id": "a"}]},
                {"role": "tool", "tool_call_id": "a", "content": "result"}
            ]}),
        ));
        assert_eq!(second.tools.len(), 1);
        assert_eq!(second.tools[0].0, "grep");

        let reset = scripted_turn(workload(
            MockWorkloadProfile::Normal,
            &json!({"messages": [
                {"role": "user", "content": "old"},
                {"role": "assistant", "tool_calls": [{"id": "old"}]},
                {"role": "tool", "tool_call_id": "old", "content": "result"},
                {"role": "user", "content": "new"}
            ]}),
        ));
        assert_eq!(reset.tools.len(), 2);
        assert_eq!(reset.tools[0].0, "ls");
    }

    fn scripted_turn(scripted: Scripted) -> Turn {
        match scripted {
            Scripted::Reply(turn) | Scripted::Slow { turn, .. } => turn,
            other => panic!("workload returned {other:?}"),
        }
    }

    #[tokio::test]
    async fn requests_are_recorded_for_assertions() {
        let mock = MockLlm::start().await.unwrap();
        mock.reply(Turn::text("hi")).await;

        let response = reqwest_post(&mock.base_url, json!({"model": "m", "messages": []})).await;
        assert!(response.contains("chatcmpl-mock"));
        assert_eq!(mock.request_count().await, 1);
        assert_eq!(mock.requests().await[0]["model"], "m");
        assert_eq!(
            mock.request_body_bytes().await,
            vec![serde_json::to_vec(&json!({"model": "m", "messages": []}))
                .unwrap()
                .len()]
        );
        mock.shutdown();
    }

    #[tokio::test]
    async fn an_empty_script_fails_loudly_rather_than_improvising() {
        let mock = MockLlm::start().await.unwrap();
        let response = reqwest_post(&mock.base_url, json!({})).await;
        assert!(response.contains("the script is empty"), "got {response}");
        mock.shutdown();
    }

    async fn reqwest_post(base: &str, body: Value) -> String {
        let client = tokio::net::TcpStream::connect(base.trim_start_matches("http://"))
            .await
            .map(drop);
        assert!(client.is_ok(), "the mock should be listening");

        let response = simple_post(&format!("{base}/chat/completions"), body).await;
        response
    }

    /// A dependency-free POST so the mock's own tests do not pull in a client.
    async fn simple_post(url: &str, body: Value) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let without_scheme = url.trim_start_matches("http://");
        let (host, path) = without_scheme.split_once('/').unwrap();
        let payload = body.to_string();
        let request = format!(
            "POST /{path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            payload.len()
        );
        let mut stream = tokio::net::TcpStream::connect(host).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }
}
