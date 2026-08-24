//! The agent loop. The event order is part of the protocol contract: the
//! daemon rebuilds conversation history from these frames, so turns must open
//! and close in the documented sequence.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::mpsc::unbounded_channel;
use tokio::sync::Mutex;

use crate::protocol::{now_ms, AssistantDraft, Content, Message, StopReason, Usage};
use crate::provider::{self, ProviderEvent, Request};
use crate::rpc::Emitter;
use crate::state::State;
use crate::tools;

const TRUNCATED_TOOL_CALL_MESSAGE: &str =
    "was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.";

pub async fn run_prompt(state: Arc<Mutex<State>>, text: String) {
    let (emitter, prompt_message) = {
        let mut guard = state.lock().await;
        guard.streaming = true;
        guard.abort.reset();
        let message = Message::user(text);
        guard.session.append_message(message.clone());
        (guard.emitter.clone(), message)
    };

    let mut produced: Vec<Value> = Vec::new();
    let prompt_value = to_value(&prompt_message);

    emitter.send(json!({ "type": "agent_start" }));
    emitter.send(json!({ "type": "turn_start" }));
    emitter.send(json!({ "type": "message_start", "message": prompt_value }));
    emitter.send(json!({ "type": "message_end", "message": prompt_value }));
    produced.push(prompt_value);

    loop {
        let snapshot = {
            let guard = state.lock().await;
            let Some(model) = guard.current_model.clone() else {
                drop(guard);
                finish_without_model(&state, &emitter, &mut produced).await;
                return;
            };
            Snapshot {
                model,
                messages: guard.session.messages.clone(),
                system_prompt: crate::prompt::build(
                    &guard.cwd,
                    &guard.skills,
                    &guard.additional_system_prompts,
                ),
                tools_enabled: guard.tools_enabled,
                thinking_level: guard.thinking_level.clone(),
                cwd: guard.cwd.clone(),
            }
        };

        let assistant = stream_assistant(&state, &emitter, &snapshot).await;
        let assistant_value = to_value(&assistant.message);
        produced.push(assistant_value.clone());

        {
            let mut guard = state.lock().await;
            guard.session.append_message(assistant.message.clone());
            guard.stats.add(&assistant.usage);
        }

        if matches!(
            assistant.stop_reason,
            StopReason::Error | StopReason::Aborted
        ) {
            emitter.send(json!({
                "type": "turn_end",
                "message": assistant_value,
                "toolResults": [],
            }));
            break;
        }

        let calls = assistant.message.tool_calls();
        if calls.is_empty() {
            emitter.send(json!({
                "type": "turn_end",
                "message": assistant_value,
                "toolResults": [],
            }));
            break;
        }

        let results = if assistant.stop_reason == StopReason::Length {
            fail_truncated_calls(&emitter, &calls)
        } else {
            execute_calls(&state, &emitter, &snapshot, &calls).await
        };

        let mut result_values = Vec::new();
        for message in &results {
            let value = to_value(message);
            emitter.send(json!({ "type": "message_start", "message": value }));
            emitter.send(json!({ "type": "message_end", "message": value }));
            result_values.push(value.clone());
            produced.push(value);
        }

        {
            let mut guard = state.lock().await;
            for message in results {
                guard.session.append_message(message);
            }
        }

        emitter.send(json!({
            "type": "turn_end",
            "message": assistant_value,
            "toolResults": result_values,
        }));

        if state.lock().await.abort.requested() {
            eprintln!("event=turn_cancelled_after_tools");
            break;
        }

        emitter.send(json!({ "type": "turn_start" }));
    }

    {
        let mut guard = state.lock().await;
        guard.streaming = false;
        guard.abort.reset();
    }
    emitter.send(json!({ "type": "agent_end", "messages": produced }));
}

struct Snapshot {
    model: crate::config::ModelConfig,
    messages: Vec<Message>,
    system_prompt: String,
    thinking_level: String,
    cwd: std::path::PathBuf,
    tools_enabled: bool,
}

struct StreamedAssistant {
    message: Message,
    stop_reason: StopReason,
    usage: Usage,
}

async fn stream_assistant(
    state: &Arc<Mutex<State>>,
    emitter: &Emitter,
    snapshot: &Snapshot,
) -> StreamedAssistant {
    let mut draft = AssistantDraft::new(
        snapshot.model.api(),
        &snapshot.model.provider,
        &snapshot.model.id,
    );
    emitter.send(json!({ "type": "message_start", "message": draft.to_value() }));

    let (tx, mut rx) = unbounded_channel::<ProviderEvent>();
    let request = Request {
        system_prompt: snapshot.system_prompt.clone(),
        messages: snapshot.messages.clone(),
        tools: if snapshot.tools_enabled {
            tools::definitions()
        } else {
            Vec::new()
        },
        thinking_level: snapshot.thinking_level.clone(),
    };
    let model = snapshot.model.clone();
    let handle = tokio::spawn(async move { provider::stream(&model, request, tx).await });

    let abort = { state.lock().await.abort.clone() };
    let mut tool_argument_buffer = String::new();
    let mut stop_reason = StopReason::Stop;
    let mut aborted = false;

    loop {
        let event = tokio::select! {
            event = rx.recv() => event,
            () = abort.cancelled() => {
                aborted = true;
                eprintln!("event=provider_stream_cancelled");
                None
            }
        };
        let Some(event) = event else { break };
        match event {
            ProviderEvent::TextStart => {
                draft.content.push(Content::text(""));
                emit_update(emitter, &draft, json!({ "type": "text_start" }));
            }
            ProviderEvent::TextDelta(delta) => {
                if let Some(Content::Text { text }) = draft.content.last_mut() {
                    text.push_str(&delta);
                }
                emit_update(
                    emitter,
                    &draft,
                    json!({ "type": "text_delta", "delta": delta }),
                );
            }
            ProviderEvent::TextEnd => {
                let content = match draft.content.last() {
                    Some(Content::Text { text }) => text.clone(),
                    _ => String::new(),
                };
                emit_update(
                    emitter,
                    &draft,
                    json!({ "type": "text_end", "content": content }),
                );
            }
            ProviderEvent::ThinkingStart => {
                draft.content.push(Content::Thinking {
                    thinking: String::new(),
                });
                emit_update(emitter, &draft, json!({ "type": "thinking_start" }));
            }
            ProviderEvent::ThinkingDelta(delta) => {
                if let Some(Content::Thinking { thinking }) = draft.content.last_mut() {
                    thinking.push_str(&delta);
                }
                emit_update(
                    emitter,
                    &draft,
                    json!({ "type": "thinking_delta", "delta": delta }),
                );
            }
            ProviderEvent::ThinkingEnd => {
                emit_update(emitter, &draft, json!({ "type": "thinking_end" }));
            }
            ProviderEvent::ToolCallStart { id, name } => {
                tool_argument_buffer.clear();
                draft.content.push(Content::ToolCall {
                    id,
                    name,
                    arguments: json!({}),
                });
                emit_update(emitter, &draft, json!({ "type": "toolcall_start" }));
            }
            ProviderEvent::ToolCallDelta(delta) => {
                tool_argument_buffer.push_str(&delta);
                emit_update(
                    emitter,
                    &draft,
                    json!({ "type": "toolcall_delta", "delta": delta }),
                );
            }
            ProviderEvent::ToolCallEnd {
                id,
                name,
                arguments,
            } => {
                let target = draft.content.iter_mut().find_map(|block| match block {
                    Content::ToolCall {
                        id: draft_id,
                        name: draft_name,
                        arguments: draft_arguments,
                    } if *draft_id == id => Some((draft_id, draft_name, draft_arguments)),
                    _ => None,
                });
                if let Some((draft_id, draft_name, draft_arguments)) = target {
                    *draft_id = id.clone();
                    *draft_name = name.clone();
                    *draft_arguments = arguments.clone();
                }
                let tool_call =
                    json!({ "type": "toolCall", "id": id, "name": name, "arguments": arguments });
                emit_update(
                    emitter,
                    &draft,
                    json!({ "type": "toolcall_end", "toolCall": tool_call }),
                );
            }
            ProviderEvent::Usage(usage) => draft.usage = usage,
            ProviderEvent::Done(reason) => stop_reason = reason,
        }
    }

    if aborted {
        handle.abort();
    }
    let provider_error = match handle.await {
        Ok(Ok(())) => None,
        Ok(Err(err)) => Some(err.to_string()),
        Err(err) if aborted && err.is_cancelled() => None,
        Err(err) => Some(format!("provider task failed: {err}")),
    };

    if aborted {
        draft.stop_reason = StopReason::Aborted;
        draft.error_message = Some("Aborted".into());
    } else if let Some(error) = provider_error {
        draft.stop_reason = StopReason::Error;
        draft.error_message = Some(error.clone());
        if draft.content.is_empty() {
            draft.content.push(Content::text(error));
        }
    } else {
        draft.stop_reason = stop_reason;
    }
    draft.timestamp = now_ms();

    let message = draft.to_message();
    emitter.send(json!({ "type": "message_end", "message": to_value(&message) }));

    StreamedAssistant {
        message,
        stop_reason: draft.stop_reason,
        usage: draft.usage,
    }
}

/// A message cut off by the output token limit can still yield tool calls whose
/// arguments parse but are silently incomplete. None are safe to run.
fn fail_truncated_calls(emitter: &Emitter, calls: &[(String, String, Value)]) -> Vec<Message> {
    let mut messages = Vec::new();
    for (id, name, arguments) in calls {
        emitter.send(json!({
            "type": "tool_execution_start",
            "toolCallId": id,
            "toolName": name,
            "args": arguments,
        }));
        let text = format!("Tool call \"{name}\" {TRUNCATED_TOOL_CALL_MESSAGE}");
        let details = json!({});
        emitter.send(json!({
            "type": "tool_execution_end",
            "toolCallId": id,
            "toolName": name,
            "result": crate::protocol::tool_result_value(&text, Some(&details)),
            "isError": true,
        }));
        messages.push(Message::ToolResult {
            tool_call_id: id.clone(),
            tool_name: name.clone(),
            content: vec![Content::text(text)],
            details: Some(details),
            is_error: true,
            timestamp: now_ms(),
        });
    }
    messages
}

async fn execute_calls(
    state: &Arc<Mutex<State>>,
    emitter: &Emitter,
    snapshot: &Snapshot,
    calls: &[(String, String, Value)],
) -> Vec<Message> {
    for (id, name, arguments) in calls {
        emitter.send(json!({
            "type": "tool_execution_start",
            "toolCallId": id,
            "toolName": name,
            "args": arguments,
        }));
    }

    let abort = { state.lock().await.abort.clone() };
    let tools_enabled = snapshot.tools_enabled;
    let futures = calls.iter().map(|(id, name, arguments)| {
        let emitter = emitter.clone();
        let cwd = snapshot.cwd.clone();
        let abort = abort.clone();
        async move {
            let result = if !tools_enabled {
                tools::ToolResult::error("Tools are disabled for this private analysis run")
            } else if abort.requested() {
                tools::ToolResult::error("Operation aborted")
            } else {
                tokio::select! {
                    result = tools::execute(name, arguments, &cwd) => result,
                    () = abort.cancelled() => {
                        eprintln!("event=tool_cancelled tool={name} tool_call_id={id}");
                        tools::ToolResult::error("Operation aborted")
                    }
                }
            };
            emitter.send(json!({
                "type": "tool_execution_end",
                "toolCallId": id,
                "toolName": name,
                "result": crate::protocol::tool_result_value(&result.text, result.details.as_ref()),
                "isError": result.is_error,
            }));
            Message::ToolResult {
                tool_call_id: id.clone(),
                tool_name: name.clone(),
                content: vec![Content::text(result.text)],
                details: result.details,
                is_error: result.is_error,
                timestamp: now_ms(),
            }
        }
    });

    futures_util::future::join_all(futures).await
}

async fn finish_without_model(
    state: &Arc<Mutex<State>>,
    emitter: &Emitter,
    produced: &mut Vec<Value>,
) {
    // The provider's own words when there are any: "add an API key" is the
    // wrong sentence for someone whose key was just refused.
    let text = crate::config::no_model_reason().unwrap_or_else(|| {
        format!(
            "No model is configured. Add an API key in {} settings (or set \
             ANTHROPIC_API_KEY / OPENAI_API_KEY) and try again.",
            crate::channel::PRODUCT
        )
    });
    let text = text.as_str();
    let mut draft = AssistantDraft::new("none", "none", "none");
    draft.content.push(Content::text(text));
    draft.stop_reason = StopReason::Error;
    draft.error_message = Some(text.into());
    let message = draft.to_message();
    let value = to_value(&message);

    emitter.send(json!({ "type": "message_start", "message": value }));
    emitter.send(json!({ "type": "message_end", "message": value }));
    emitter.send(json!({ "type": "turn_end", "message": value, "toolResults": [] }));
    produced.push(value);

    {
        let mut guard = state.lock().await;
        guard.session.append_message(message);
        guard.streaming = false;
    }
    emitter.send(json!({ "type": "agent_end", "messages": produced }));
}

fn emit_update(emitter: &Emitter, draft: &AssistantDraft, mut event: Value) {
    let message = draft.to_value();
    event["partial"] = message.clone();
    event["contentIndex"] = json!(draft.content.len().saturating_sub(1));
    emitter.send(json!({
        "type": "message_update",
        "message": message,
        "assistantMessageEvent": event,
    }));
}

fn to_value(message: &Message) -> Value {
    serde_json::to_value(message).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ModelConfig;
    use crate::session::Session;
    use crate::skills::Skill;
    use std::path::PathBuf;

    fn fake_model() -> ModelConfig {
        ModelConfig {
            provider: "fake".into(),
            id: "echo".into(),
            name: None,
            api: Some("fake".into()),
            base_url: None,
            api_key: None,
            api_key_env: None,
            context_window: Some(8192),
            max_tokens: None,
            reasoning: None,
        }
    }

    fn state_with(model: Option<ModelConfig>, emitter: Emitter, cwd: PathBuf) -> Arc<Mutex<State>> {
        Arc::new(Mutex::new(State {
            emitter,
            session: Session::in_memory(cwd.clone()),
            models: Vec::new(),
            current_model: model,
            thinking_level: "medium".into(),
            auto_compaction: true,
            genehub_session_id: None,
            additional_system_prompts: Vec::new(),
            skills: Vec::<Skill>::new(),
            cwd,
            stats: Usage::default(),
            streaming: false,
            compacting: false,
            tools_enabled: true,
            abort: Arc::new(crate::state::Abort::new()),
            running: None,
        }))
    }

    /// Captures emitted frames instead of writing them to stdout.
    fn capture() -> (Emitter, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        (Emitter::for_test(tx), rx)
    }

    async fn drain(mut rx: tokio::sync::mpsc::UnboundedReceiver<Value>) -> Vec<Value> {
        let mut frames = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            frames.push(frame);
        }
        // Give spawned emitters a chance to flush before reporting.
        tokio::task::yield_now().await;
        while let Ok(frame) = rx.try_recv() {
            frames.push(frame);
        }
        frames
    }

    fn kinds(frames: &[Value]) -> Vec<String> {
        frames
            .iter()
            .map(|f| f["type"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    #[tokio::test]
    async fn full_loop_emits_pi_event_order() {
        let dir = std::env::temp_dir().join(format!("genet-loop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("file.txt"), "x").unwrap();

        let (emitter, rx) = capture();
        let state = state_with(Some(fake_model()), emitter, dir);
        run_prompt(state.clone(), "hello".into()).await;

        let frames = drain(rx).await;
        let order = kinds(&frames);

        assert_eq!(order.first().unwrap(), "agent_start");
        assert_eq!(order[1], "turn_start");
        assert_eq!(order.last().unwrap(), "agent_end");
        assert!(order.contains(&"tool_execution_start".to_string()));
        assert!(order.contains(&"tool_execution_end".to_string()));
        assert!(order.contains(&"message_update".to_string()));
        // Two turns: the tool call turn and the closing turn.
        assert_eq!(order.iter().filter(|k| *k == "turn_start").count(), 2);
        assert_eq!(order.iter().filter(|k| *k == "turn_end").count(), 2);
    }

    #[tokio::test]
    async fn tool_results_are_persisted_and_reported() {
        let dir = std::env::temp_dir().join(format!("genet-loop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("marker.txt"), "").unwrap();

        let (emitter, rx) = capture();
        let state = state_with(Some(fake_model()), emitter, dir);
        run_prompt(state.clone(), "hello".into()).await;

        let frames = drain(rx).await;
        let tool_end = frames
            .iter()
            .find(|f| f["type"] == "tool_execution_end")
            .unwrap();
        assert_eq!(tool_end["toolName"], "ls");
        assert!(tool_end["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("marker.txt"));

        let guard = state.lock().await;
        let roles: Vec<&str> = guard
            .session
            .messages
            .iter()
            .map(|m| match m {
                Message::User { .. } => "user",
                Message::Assistant { .. } => "assistant",
                Message::ToolResult { .. } => "toolResult",
            })
            .collect();
        assert_eq!(roles, vec!["user", "assistant", "toolResult", "assistant"]);
        assert!(!guard.streaming);
    }

    #[tokio::test]
    async fn missing_model_ends_the_run_with_a_clear_error() {
        let dir = std::env::temp_dir();
        let (emitter, rx) = capture();
        let state = state_with(None, emitter, dir);
        run_prompt(state, "hello".into()).await;

        let frames = drain(rx).await;
        let order = kinds(&frames);
        assert_eq!(order.last().unwrap(), "agent_end");
        // The first message_end belongs to the echoed user prompt; the
        // assistant's failure is the last one.
        let end = frames.iter().rfind(|f| f["type"] == "message_end").unwrap();
        assert_eq!(end["message"]["stopReason"], "error");
        assert!(end["message"]["errorMessage"]
            .as_str()
            .unwrap()
            .contains("No model is configured"));
    }

    #[tokio::test]
    async fn truncated_tool_calls_are_failed_without_execution() {
        let (emitter, rx) = capture();
        let calls = vec![(
            "call_1".to_string(),
            "bash".to_string(),
            json!({"command": "rm -rf /"}),
        )];
        let messages = fail_truncated_calls(&emitter, &calls);

        assert_eq!(messages.len(), 1);
        let frames = drain(rx).await;
        let end = frames
            .iter()
            .find(|f| f["type"] == "tool_execution_end")
            .unwrap();
        assert_eq!(end["isError"], true);
        assert!(end["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("output token limit"));
    }

    #[tokio::test]
    async fn an_in_flight_tool_is_released_by_abort() {
        let dir = std::env::temp_dir();
        let (emitter, _rx) = capture();
        let state = state_with(Some(fake_model()), emitter.clone(), dir.clone());
        let snapshot = Snapshot {
            model: fake_model(),
            messages: Vec::new(),
            system_prompt: String::new(),
            tools_enabled: true,
            thinking_level: "medium".into(),
            cwd: dir,
        };
        let calls = vec![(
            "call_1".to_string(),
            "bash".to_string(),
            json!({"command": "sleep 30"}),
        )];
        let running = execute_calls(&state, &emitter, &snapshot, &calls);
        tokio::pin!(running);

        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                state.lock().await.abort.request();
            }
            _ = &mut running => panic!("the command unexpectedly finished before cancellation"),
        }
        let results = tokio::time::timeout(std::time::Duration::from_secs(2), &mut running)
            .await
            .expect("the tool await is cancellation-aware");
        assert_eq!(results.len(), 1);
        assert!(matches!(
            &results[0],
            Message::ToolResult { is_error: true, content, .. }
                if matches!(content.first(), Some(Content::Text { text }) if text == "Operation aborted")
        ));
    }
}
