//! The agent loop. The event order is part of the protocol contract: the
//! daemon rebuilds conversation history from these frames, so turns must open
//! and close in the documented sequence.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::mpsc::unbounded_channel;
use tokio::sync::Mutex;

use crate::protocol::{
    now_ms, AssistantDraft, Content, MediaAttachment, Message, StopReason, Usage,
};
use crate::provider::{self, ProviderEvent, Request};
use crate::rpc::Emitter;
use crate::state::State;
use crate::{archive, recovery, tools};

const TRUNCATED_TOOL_CALL_MESSAGE: &str =
    "was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.";

pub async fn run_prompt(state: Arc<Mutex<State>>, text: String) {
    run_prompt_with_attachments(state, text, Vec::new()).await;
}

pub async fn run_prompt_with_attachments(
    state: Arc<Mutex<State>>,
    text: String,
    attachments: Vec<MediaAttachment>,
) {
    let (emitter, prompt_message, mut prompt_index) = {
        let mut guard = state.lock().await;
        guard.streaming = true;
        guard.abort.reset();
        let prompt_index = guard.session.messages.len();
        let message = Message::user_with_attachments(text, attachments);
        guard.session.append_message(message.clone());
        (guard.emitter.clone(), message, prompt_index)
    };

    let mut produced: Vec<Value> = Vec::new();
    let prompt_value = to_value(&prompt_message);

    emitter.send(json!({ "type": "agent_start" }));
    emitter.send(json!({ "type": "turn_start" }));
    emitter.send(json!({ "type": "message_start", "message": prompt_value }));
    emitter.send(json!({ "type": "message_end", "message": prompt_value }));
    produced.push(prompt_value);
    let mut retry_without_answer = false;
    // Recovery state for this run (pi `_retryAttempt`,
    // `_overflowRecoveryAttempted`).
    let mut retry_attempt: u32 = 0;
    let mut overflow_recovered = false;
    let mut threshold_checked_at: Option<usize> = None;
    let mut side_effects = false;
    let mut settled = false;
    let mut rolled_back = false;

    loop {
        let snapshot = {
            let guard = state.lock().await;
            let Some(model) = guard.current_model.clone() else {
                drop(guard);
                finish_without_model(&state, &emitter, &mut produced).await;
                return;
            };
            let mut system_prompt =
                crate::prompt::build(&guard.cwd, &guard.skills, &guard.additional_system_prompts);
            if retry_without_answer {
                system_prompt.push_str("\n\nThe previous model response contained no user-visible answer or tool call. Continue from the existing facts and provide a visible answer or a valid tool call. Inspect current state before any side effect; do not repeat an action merely because this is a continuation.");
            }
            Snapshot {
                model,
                messages: guard.session.messages.clone(),
                skills: guard.skills.clone(),
                system_prompt,
                tools_enabled: guard.tools_enabled,
                thinking_level: guard.thinking_level.clone(),
                cwd: guard.cwd.clone(),
            }
        };

        // Archive rollover before a request that would carry more than the
        // threshold. Checked once per context size, so an archive that frees
        // too little does not repeat until the context grows again.
        let (auto_archive, usage_floor) = {
            let guard = state.lock().await;
            (guard.auto_compaction, guard.session.usage_floor)
        };
        if auto_archive && threshold_checked_at != Some(snapshot.messages.len()) {
            let overhead = fixed_request_tokens(&snapshot);
            let tokens = recovery::context_tokens(&snapshot.messages, usage_floor, overhead);
            if recovery::over_threshold(tokens, snapshot.model.context_window) {
                match archive::archive(&state, prompt_index, "threshold").await {
                    archive::Outcome::Archived { pinned } => {
                        prompt_index = pinned;
                        // Whatever the archive left is what this request
                        // carries; re-archiving the same context cannot help.
                        threshold_checked_at = Some(state.lock().await.session.messages.len());
                        emitter.send(json!({ "type": "compaction_end", "reason": "threshold", "willRetry": false }));
                        continue;
                    }
                    archive::Outcome::NothingToArchive => {}
                    archive::Outcome::Cancelled => {
                        emit_archive_cancelled(&emitter, "threshold");
                        break;
                    }
                }
            }
            threshold_checked_at = Some(snapshot.messages.len());
        }

        let assistant = stream_assistant(&state, &emitter, &snapshot, retry_without_answer).await;
        let assistant_value = to_value(&assistant.message);
        produced.push(assistant_value.clone());

        let (before_assistant, retry) = {
            let mut guard = state.lock().await;
            let before_assistant = guard.session.messages.len();
            guard.session.append_message(assistant.message.clone());
            guard.stats.add(&assistant.usage);
            (before_assistant, guard.retry.clone())
        };

        // Context overflow: archive and replay the request once (pi
        // `_checkCompaction`). A complete answer that merely filled the
        // window is kept; the threshold check archives before the next one.
        if auto_archive
            && assistant.stop_reason != StopReason::Stop
            && recovery::is_context_overflow(&assistant.message, snapshot.model.context_window)
        {
            emitter
                .send(json!({ "type": "turn_end", "message": assistant_value, "toolResults": [] }));
            if overflow_recovered {
                emitter.send(json!({
                    "type": "compaction_end",
                    "reason": "overflow",
                    "willRetry": false,
                    "errorMessage": recovery::OVERFLOW_RECOVERY_FAILED,
                }));
                rolled_back |= rollback_if_clean(&state, side_effects, prompt_index).await;
                break;
            }
            state
                .lock()
                .await
                .session
                .rollback_failed_turn(before_assistant);
            match archive::archive(&state, prompt_index, "overflow").await {
                archive::Outcome::Archived { pinned } => {
                    prompt_index = pinned;
                    overflow_recovered = true;
                    emitter.send(json!({ "type": "compaction_end", "reason": "overflow", "willRetry": true }));
                    emitter.send(json!({ "type": "turn_start" }));
                    continue;
                }
                archive::Outcome::NothingToArchive => {
                    emitter.send(json!({
                        "type": "compaction_end",
                        "reason": "overflow",
                        "willRetry": false,
                        "errorMessage": "The context overflowed and only the current request is left; nothing older can be archived. Shorten the request or switch to a larger-context model.",
                    }));
                    break;
                }
                archive::Outcome::Cancelled => {
                    emit_archive_cancelled(&emitter, "overflow");
                    break;
                }
            }
        }

        // Transient provider failure: back off and replay (pi `_prepareRetry`).
        if retry.enabled
            && retry_attempt < retry.max_retries
            && recovery::is_retryable(
                &assistant.message,
                assistant.http_status,
                snapshot.model.context_window,
            )
        {
            retry_attempt += 1;
            let delay_ms = recovery::retry_delay_ms(
                retry.base_delay_ms,
                retry_attempt,
                assistant.retry_after_ms,
            );
            emitter
                .send(json!({ "type": "turn_end", "message": assistant_value, "toolResults": [] }));
            emitter.send(json!({
                "type": "auto_retry_start",
                "attempt": retry_attempt,
                "maxAttempts": retry.max_retries,
                "delayMs": delay_ms,
                "errorMessage": error_message(&assistant.message),
            }));
            // The failed response leaves the context but stays on disk.
            let abort = {
                let mut guard = state.lock().await;
                guard.session.rollback_failed_turn(before_assistant);
                guard.abort.clone()
            };
            let cancelled = tokio::select! {
                () = tokio::time::sleep(std::time::Duration::from_millis(delay_ms)) => false,
                () = abort.cancelled() => true,
            };
            if cancelled {
                emitter.send(json!({
                    "type": "auto_retry_end",
                    "success": false,
                    "attempt": retry_attempt,
                    "finalError": "Retry cancelled",
                }));
                break;
            }
            emitter.send(json!({ "type": "turn_start" }));
            continue;
        }
        if retry_attempt > 0 {
            let success = !matches!(
                assistant.stop_reason,
                StopReason::Error | StopReason::Aborted
            );
            let mut end =
                json!({ "type": "auto_retry_end", "success": success, "attempt": retry_attempt });
            if !success {
                end["finalError"] = json!(error_message(&assistant.message));
            }
            emitter.send(end);
            retry_attempt = 0;
        }

        // A provider rejection with no tool side effects in this run: keep
        // its emitted transcript and append-only audit, but do not make the
        // rejected prompt (especially large native media) part of every
        // later provider request.
        if assistant.stop_reason == StopReason::Error {
            rolled_back |= rollback_if_clean(&state, side_effects, prompt_index).await;
        }

        if matches!(assistant.stop_reason, StopReason::Stop | StopReason::Length)
            && !has_visible_answer_or_tool(&assistant.message)
        {
            // This response had no side effects and is dropped from provider
            // history by the converters. One bounded continuation can turn a
            // reasoning-only completion into an actual answer without replaying
            // any tool call or the user's prompt as a new request.
            emitter.send(json!({
                "type": "turn_end",
                "message": assistant_value,
                "toolResults": [],
            }));
            emitter.send(json!({ "type": "turn_start" }));
            retry_without_answer = true;
            continue;
        }
        retry_without_answer = false;

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
            // pi `runLoop`: input queued while this answer streamed keeps the
            // run going instead of ending it.
            let Some(message) = take_queued(&state, true).await else {
                settled = true;
                break;
            };
            // The answer just delivered is a fact now; a later failure must
            // not roll the conversation back past it.
            side_effects = true;
            emitter.send(json!({ "type": "turn_start" }));
            inject_queued(&state, &emitter, &mut produced, message).await;
            continue;
        }

        let (results, requested_input, attachments) = if assistant.stop_reason == StopReason::Length
        {
            (fail_truncated_calls(&emitter, &calls), false, Vec::new())
        } else {
            execute_calls(&state, &emitter, &snapshot, &calls).await
        };

        side_effects |= !results.is_empty();
        let mut result_values = Vec::new();
        for message in &results {
            let value = to_value(message);
            emitter.send(json!({ "type": "message_start", "message": value }));
            emitter.send(json!({ "type": "message_end", "message": value }));
            result_values.push(value.clone());
            produced.push(value);
        }

        let injected = {
            let mut guard = state.lock().await;
            for message in results {
                guard.session.append_message(message);
            }
            // Media registered by read_media enters the conversation as a
            // marked user-message attachment — the only shape providers map
            // to image_url/video_url — so history replay and compaction treat
            // it exactly like a chat upload.
            let fresh = fresh_attachments(&guard.session, attachments);
            if fresh.is_empty() {
                None
            } else {
                let names = fresh
                    .iter()
                    .map(|attachment| attachment.name.clone())
                    .collect::<Vec<_>>()
                    .join("、");
                let message = Message::user_with_attachments(
                    format!("你通过 read_media 附加了 {names}。媒体内容随本条消息提供，请结合当前任务继续分析。"),
                    fresh,
                );
                guard.session.append_message(message.clone());
                Some(message)
            }
        };
        if let Some(message) = injected {
            let value = to_value(&message);
            emitter.send(json!({ "type": "message_start", "message": value }));
            emitter.send(json!({ "type": "message_end", "message": value }));
            produced.push(value);
        }

        emitter.send(json!({
            "type": "turn_end",
            "message": assistant_value,
            "toolResults": result_values,
        }));

        if requested_input {
            break;
        }

        if state.lock().await.abort.requested() {
            eprintln!("event=turn_cancelled_after_tools");
            break;
        }

        emitter.send(json!({ "type": "turn_start" }));
        // Steering lands after the tool results, before the next request.
        if let Some(message) = take_queued(&state, false).await {
            inject_queued(&state, &emitter, &mut produced, message).await;
        }
    }

    if !settled {
        settle(&state, &emitter, &mut produced, !rolled_back).await;
    }
    emitter.send(json!({ "type": "agent_end", "messages": produced }));
}

/// The next queued message. When a stopping run finds none, it ends under the
/// same lock, so `steer` can never be accepted after the last look.
async fn take_queued(state: &Arc<Mutex<State>>, stopping: bool) -> Option<Message> {
    let mut guard = state.lock().await;
    let next = guard.queued.next(stopping);
    if next.is_none() && stopping {
        guard.streaming = false;
        guard.abort.reset();
    }
    next
}

/// One queued message enters the conversation as the next user turn.
async fn inject_queued(
    state: &Arc<Mutex<State>>,
    emitter: &Emitter,
    produced: &mut Vec<Value>,
    message: Message,
) {
    let value = to_value(&message);
    state.lock().await.session.append_message(message);
    emitter.send(json!({ "type": "message_start", "message": value }));
    emitter.send(json!({ "type": "message_end", "message": value }));
    produced.push(value);
}

/// Ends a run that stopped early (abort, error, a question for the person).
/// Input already accepted is kept in the conversation rather than dropped: the
/// client was told it was taken, and the next turn sees it. A run rolled back
/// to before its prompt drops them with it; the client resends both.
async fn settle(
    state: &Arc<Mutex<State>>,
    emitter: &Emitter,
    produced: &mut Vec<Value>,
    keep: bool,
) {
    let leftovers = {
        let mut guard = state.lock().await;
        guard.streaming = false;
        guard.abort.reset();
        let mut leftovers = guard.queued.drain();
        if !keep {
            leftovers.clear();
        }
        for message in &leftovers {
            guard.session.append_message(message.clone());
        }
        leftovers
    };
    for message in leftovers {
        let value = to_value(&message);
        emitter.send(json!({ "type": "message_start", "message": value }));
        emitter.send(json!({ "type": "message_end", "message": value }));
        produced.push(value);
    }
}

struct Snapshot {
    model: crate::config::ModelConfig,
    messages: Vec<Message>,
    skills: Vec<crate::skills::Skill>,
    system_prompt: String,
    thinking_level: String,
    cwd: std::path::PathBuf,
    tools_enabled: bool,
}

struct StreamedAssistant {
    message: Message,
    stop_reason: StopReason,
    usage: Usage,
    /// From a provider [`provider::HttpError`], for retry decisions.
    http_status: Option<u16>,
    retry_after_ms: Option<u64>,
}

/// System prompt and tool definitions, which every request carries but no
/// message accounts for.
fn fixed_request_tokens(snapshot: &Snapshot) -> u64 {
    let tools = if snapshot.tools_enabled {
        tools::definitions()
            .iter()
            .map(|tool| tool.to_string().len())
            .sum::<usize>()
    } else {
        0
    };
    ((snapshot.system_prompt.chars().count() + tools) / 4) as u64
}

fn error_message(message: &Message) -> String {
    match message {
        Message::Assistant {
            error_message: Some(error),
            ..
        } => error.clone(),
        _ => "Unknown error".into(),
    }
}

/// Drops a failed run from future context when it changed nothing.
async fn rollback_if_clean(
    state: &Arc<Mutex<State>>,
    side_effects: bool,
    prompt_index: usize,
) -> bool {
    if !side_effects {
        state
            .lock()
            .await
            .session
            .rollback_failed_turn(prompt_index);
    }
    !side_effects
}

/// The user stopped the run while an archive was being prepared. Nothing was
/// replaced; the frame lets the host settle the run as cancelled.
fn emit_archive_cancelled(emitter: &Emitter, reason: &str) {
    emitter.send(json!({
        "type": "compaction_end",
        "reason": reason,
        "aborted": true,
        "willRetry": false,
    }));
}

fn has_visible_answer_or_tool(message: &Message) -> bool {
    let Message::Assistant { content, .. } = message else {
        return false;
    };
    content.iter().any(|part| match part {
        Content::Text { text } => !text.trim().is_empty(),
        Content::ToolCall { .. } => true,
        Content::Thinking { .. } => false,
    })
}

async fn stream_assistant(
    state: &Arc<Mutex<State>>,
    emitter: &Emitter,
    snapshot: &Snapshot,
    retry_without_answer: bool,
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
        cwd: std::env::var_os("GENET_WORKSPACE_ROOT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| snapshot.cwd.clone()),
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
                draft.content.push(Content::thinking(""));
                emit_update(emitter, &draft, json!({ "type": "thinking_start" }));
            }
            ProviderEvent::ThinkingDelta(delta) => {
                if let Some(Content::Thinking { thinking, .. }) = draft.content.last_mut() {
                    thinking.push_str(&delta);
                }
                emit_update(
                    emitter,
                    &draft,
                    json!({ "type": "thinking_delta", "delta": delta }),
                );
            }
            ProviderEvent::ThinkingSignature(part) => {
                // No frame of its own: the signature is replay material, not
                // something to show. It rides along on message_end.
                if let Some(Content::Thinking { signature, .. }) = draft.content.last_mut() {
                    signature.get_or_insert_with(String::new).push_str(&part);
                }
            }
            ProviderEvent::RedactedThinking(data) => {
                draft.content.push(Content::Thinking {
                    thinking: provider::anthropic::REDACTED_THINKING_TEXT.into(),
                    signature: Some(data),
                    redacted: true,
                });
                emit_update(emitter, &draft, json!({ "type": "thinking_start" }));
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
    let mut http_status = None;
    let mut retry_after_ms = None;
    let provider_error = match handle.await {
        Ok(Ok(())) => None,
        Ok(Err(err)) => {
            if let Some(http) = err.downcast_ref::<provider::HttpError>() {
                http_status = Some(http.status);
                retry_after_ms = http.retry_after_ms;
            }
            Some(err.to_string())
        }
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
    } else if retry_without_answer
        && matches!(stop_reason, StopReason::Stop | StopReason::Length)
        && !has_visible_answer_or_tool(&draft.to_message())
    {
        draft.stop_reason = StopReason::Error;
        draft.error_message = Some(
            "模型连续两次仅返回思考内容或空内容，没有可见答复或工具调用；本回合未完成，请重试或切换模型。"
                .into(),
        );
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
        http_status,
        retry_after_ms,
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
) -> (Vec<Message>, bool, Vec<MediaAttachment>) {
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
    let interaction_is_valid = calls.len() == 1 && calls[0].1 == "request_user_input";
    let requested_input = interaction_is_valid && tools::user_input(&calls[0].2).is_ok();
    // §6.4: decided before anything runs, one note per Skill per batch.
    let mut noted: Vec<String> = Vec::new();
    let notes: Vec<Option<String>> = calls
        .iter()
        .map(|(_, name, arguments)| {
            let path = arguments.get("path").and_then(Value::as_str)?;
            if name != "write" && name != "edit" {
                return None;
            }
            let (skill, note) = crate::skill_guard::write_note(
                path,
                &snapshot.skills,
                &snapshot.messages,
                calls,
                &snapshot.cwd,
            )?;
            if noted.contains(&skill) {
                return None;
            }
            noted.push(skill);
            Some(note)
        })
        .collect();
    let futures = calls
        .iter()
        .zip(notes)
        .map(|((id, name, arguments), note)| {
            let emitter = emitter.clone();
            let cwd = snapshot.cwd.clone();
            let abort = abort.clone();
            let model = snapshot.model.clone();
            async move {
                let result = if name == "request_user_input" && !interaction_is_valid {
                    tools::ToolResult::error(
                        "request_user_input must be the only tool call in this assistant message",
                    )
                } else if name == "request_user_input" {
                    match tools::user_input(arguments) {
                        Ok(payload) => {
                            emitter.send(json!({
                                "type": "user_input_requested",
                                "toolCallId": id,
                                "questions": payload["questions"],
                            }));
                            tools::ToolResult::ok("Waiting for the user's response.")
                        }
                        Err(error) => tools::ToolResult::error(error),
                    }
                } else if !tools_enabled {
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
                let mut result = enforce_media_modality(result, &model);
                if let Some(note) = note.filter(|_| !result.is_error) {
                    result.text.push_str(&note);
                }
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

    let results = futures_util::future::join_all(futures).await;
    let attachments = results.iter().filter_map(registered_attachment).collect();
    (results, requested_input, attachments)
}

/// The attachment a successful read_media call registered, if any.
fn registered_attachment(message: &Message) -> Option<MediaAttachment> {
    let Message::ToolResult {
        details,
        is_error: false,
        ..
    } = message
    else {
        return None;
    };
    let value = details
        .as_ref()?
        .get(crate::tools::media_attachment_detail_key())?
        .clone();
    serde_json::from_value(value).ok()
}

/// Tools cannot see the current model, so read_media validates everything
/// except the one fact that decides whether the file can actually reach it:
/// the declared input modalities. An unsupported model gets an honest tool
/// error here — before the event is emitted — instead of a silently dropped
/// attachment.
fn enforce_media_modality(
    result: tools::ToolResult,
    model: &crate::config::ModelConfig,
) -> tools::ToolResult {
    if result.is_error {
        return result;
    }
    let Some(value) = result
        .details
        .as_ref()
        .and_then(|details| details.get(crate::tools::media_attachment_detail_key()))
    else {
        return result;
    };
    let Ok(attachment) = serde_json::from_value::<MediaAttachment>(value.clone()) else {
        return result;
    };
    let kind = crate::provider::media::kind(&attachment).unwrap_or("media");
    if model.input_modalities.iter().any(|input| input == kind) {
        return result;
    }
    tools::ToolResult::error(format!(
        "read_media: 模型 {}/{} 未配置 {kind} 输入能力，无法读取 {}",
        model.provider, model.id, attachment.name
    ))
}

/// Skips files already attached to the conversation so a re-read does not
/// resend the same media on every following request.
fn fresh_attachments(
    session: &crate::session::Session,
    attachments: Vec<MediaAttachment>,
) -> Vec<MediaAttachment> {
    attachments
        .into_iter()
        .filter(|attachment| {
            !session.messages.iter().any(|message| match message {
                Message::User { attachments, .. } => attachments
                    .iter()
                    .any(|existing| existing.path.is_some() && existing.path == attachment.path),
                _ => false,
            })
        })
        .collect()
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

    state.lock().await.session.append_message(message);
    settle(state, emitter, produced, true).await;
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
            thinking_mode: None,
            thinking_efforts: Vec::new(),
            compat: crate::config::Compat::default(),
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
            input_modalities: Vec::new(),
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
            retry: crate::state::RetrySettings {
                base_delay_ms: 1,
                ..crate::state::RetrySettings::default()
            },
            queued: crate::state::Queued::default(),
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

    fn texts_by_role(state: &State) -> Vec<(String, String)> {
        state
            .session
            .messages
            .iter()
            .map(|message| {
                let value = serde_json::to_value(message).unwrap();
                let role = value["role"].as_str().unwrap_or_default().to_string();
                let text = match &value["content"] {
                    Value::String(text) => text.clone(),
                    Value::Array(parts) => parts
                        .iter()
                        .filter_map(|part| part["text"].as_str())
                        .collect::<String>(),
                    _ => String::new(),
                };
                (role, text)
            })
            .collect()
    }

    /// pi `runLoop`: steering waits for the tool results, then becomes the
    /// next user turn before the model is asked again.
    #[tokio::test]
    async fn steering_lands_after_the_tool_results_and_before_the_next_request() {
        let dir = std::env::temp_dir().join(format!("genet-steer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (emitter, rx) = capture();
        let state = state_with(Some(fake_model()), emitter, dir);
        state
            .lock()
            .await
            .queued
            .steering
            .push_back(Message::user("also check the docs"));

        run_prompt(state.clone(), "hello".into()).await;

        let guard = state.lock().await;
        let roles: Vec<_> = texts_by_role(&guard)
            .into_iter()
            .map(|(role, text)| format!("{role}:{text}"))
            .collect();
        assert_eq!(roles.len(), 5, "{roles:?}");
        assert_eq!(roles[0], "user:hello");
        assert!(roles[1].starts_with("assistant:"));
        assert!(roles[2].starts_with("toolResult:"));
        assert_eq!(roles[3], "user:also check the docs");
        assert!(roles[4].starts_with("assistant:Done"));
        assert_eq!(guard.queued.len(), 0);
        assert!(!guard.streaming);
        drop(guard);

        let frames = drain(rx).await;
        let steer_at = frames
            .iter()
            .position(|frame| {
                frame["type"] == "message_start"
                    && frame["message"]["content"] == json!("also check the docs")
            })
            .expect("the steering message is announced");
        assert_eq!(frames[steer_at - 1]["type"], "turn_start");
        assert_eq!(kinds(&frames).last().unwrap(), "agent_end");
    }

    /// A follow-up does not cut into the work; it starts once the run would
    /// otherwise stop, inside the same run.
    #[tokio::test]
    async fn a_follow_up_waits_for_the_answer_and_keeps_the_run_going() {
        let dir = std::env::temp_dir().join(format!("genet-follow-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (emitter, rx) = capture();
        let state = state_with(Some(fake_model()), emitter, dir);
        state
            .lock()
            .await
            .queued
            .follow_up
            .push_back(Message::user("and then summarize"));

        run_prompt(state.clone(), "hello".into()).await;

        let guard = state.lock().await;
        let roles: Vec<_> = texts_by_role(&guard)
            .into_iter()
            .map(|(role, _)| role)
            .collect();
        assert_eq!(
            roles,
            [
                "user",
                "assistant",
                "toolResult",
                "assistant",
                "user",
                "assistant"
            ]
        );
        assert_eq!(texts_by_role(&guard)[4].1, "and then summarize");
        drop(guard);
        let frames = drain(rx).await;
        assert_eq!(
            kinds(&frames)
                .iter()
                .filter(|kind| *kind == "agent_end")
                .count(),
            1
        );
    }

    /// A run that ends early keeps what it accepted; one rolled back to before
    /// its prompt drops it too, because the client resends both.
    #[tokio::test]
    async fn queued_input_follows_its_run_when_the_run_ends_early() {
        let dir = std::env::temp_dir().join(format!("genet-leftover-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut failing = fake_model();
        failing.id = "auth-fail".into();
        let (emitter, _rx) = capture();
        let state = state_with(Some(failing), emitter, dir);
        state
            .lock()
            .await
            .queued
            .follow_up
            .push_back(Message::user("later"));

        run_prompt(state.clone(), "hello".into()).await;

        let guard = state.lock().await;
        assert!(texts_by_role(&guard)
            .iter()
            .all(|(_, text)| text != "later"));
        assert_eq!(guard.queued.len(), 0);
        assert!(!guard.streaming);
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
    async fn reasoning_only_completion_continues_once_and_produces_a_visible_answer() {
        let (emitter, rx) = capture();
        let mut model = fake_model();
        model.id = "reasoning-only-once".into();
        let state = state_with(Some(model), emitter, std::env::temp_dir());
        run_prompt(state, "resolve this".into()).await;

        let frames = drain(rx).await;
        let assistants: Vec<_> = frames
            .iter()
            .filter(|frame| {
                frame["type"] == "message_end" && frame["message"]["role"] == "assistant"
            })
            .collect();
        assert_eq!(assistants.len(), 2, "one bounded continuation was needed");
        assert_eq!(assistants[1]["message"]["stopReason"], "stop");
        assert!(assistants[1]["message"]["content"]
            .as_array()
            .unwrap()
            .iter()
            .any(|part| part["text"] == "Here is the result."));
        assert_eq!(
            kinds(&frames)
                .iter()
                .filter(|kind| *kind == "turn_start")
                .count(),
            2
        );
        assert_eq!(
            kinds(&frames)
                .iter()
                .filter(|kind| *kind == "turn_end")
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn repeated_reasoning_only_completion_fails_instead_of_silently_succeeding() {
        let (emitter, rx) = capture();
        let mut model = fake_model();
        model.id = "reasoning-only-always".into();
        let state = state_with(Some(model), emitter, std::env::temp_dir());
        run_prompt(state, "resolve this".into()).await;

        let frames = drain(rx).await;
        let assistants: Vec<_> = frames
            .iter()
            .filter(|frame| {
                frame["type"] == "message_end" && frame["message"]["role"] == "assistant"
            })
            .collect();
        assert_eq!(
            assistants.len(),
            2,
            "a third silent model call must not be made"
        );
        assert_eq!(assistants[1]["message"]["stopReason"], "error");
        assert!(assistants[1]["message"]["errorMessage"]
            .as_str()
            .unwrap()
            .contains("没有可见答复"));
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

    /// §6.4: one note per Skill on the first write into what it owns, none
    /// on the second write of the same batch.
    #[tokio::test]
    async fn a_write_into_an_unread_skills_directory_carries_a_note() {
        let dir = std::env::temp_dir().join(format!("genet-loop-{}", uuid::Uuid::new_v4()));
        let skill_dir = dir.join(".agents/skills/openplay-guidance");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: openplay-guidance\ndescription: d\npaths: guidance/\n---\n",
        )
        .unwrap();
        let skills = crate::skills::load(&dir, &dir.join("no-agent-dir"));
        assert_eq!(skills[0].paths, ["guidance/"]);
        let (emitter, _rx) = capture();
        let state = state_with(Some(fake_model()), emitter.clone(), dir.clone());
        let snapshot = Snapshot {
            model: fake_model(),
            messages: Vec::new(),
            skills,
            system_prompt: String::new(),
            tools_enabled: true,
            thinking_level: "medium".into(),
            cwd: dir.clone(),
        };
        let calls: Vec<_> = ["a", "b"]
            .into_iter()
            .map(|name| {
                (
                    format!("call_{name}"),
                    "write".to_string(),
                    json!({"path": format!("guidance/patrol/{name}.md"), "content": "x"}),
                )
            })
            .collect();
        let (results, _, _) = execute_calls(&state, &emitter, &snapshot, &calls).await;
        let texts: Vec<String> = results
            .iter()
            .map(|message| match message {
                Message::ToolResult { content, .. } => match &content[0] {
                    Content::Text { text } => text.clone(),
                    _ => String::new(),
                },
                _ => String::new(),
            })
            .collect();
        assert!(
            texts[0].contains("belongs to the Skill `openplay-guidance`"),
            "{}",
            texts[0]
        );
        assert!(!texts[1].contains("Skill"), "{}", texts[1]);
        assert!(
            dir.join("guidance/patrol/a.md").is_file(),
            "the write still happens"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_in_flight_tool_is_released_by_abort() {
        let dir = std::env::temp_dir();
        let (emitter, _rx) = capture();
        let state = state_with(Some(fake_model()), emitter.clone(), dir.clone());
        let snapshot = Snapshot {
            model: fake_model(),
            messages: Vec::new(),
            skills: Vec::new(),
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
        let (results, stopped_for_human_input, _) =
            tokio::time::timeout(std::time::Duration::from_secs(2), &mut running)
                .await
                .expect("the tool await is cancellation-aware");
        assert!(!stopped_for_human_input);
        assert_eq!(results.len(), 1);
        assert!(matches!(
            &results[0],
            Message::ToolResult { is_error: true, content, .. }
                if matches!(content.first(), Some(Content::Text { text }) if text == "Operation aborted")
        ));
    }

    #[tokio::test]
    async fn read_media_registers_an_attachment_for_a_capable_model() {
        let dir = std::env::temp_dir().join(format!("genet-loop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("clip.webm"), b"webm-bytes").unwrap();

        let mut model = fake_model();
        model.input_modalities = vec!["video".into()];
        let (emitter, rx) = capture();
        let state = state_with(Some(model.clone()), emitter.clone(), dir.clone());
        let snapshot = Snapshot {
            model,
            messages: Vec::new(),
            skills: Vec::new(),
            system_prompt: String::new(),
            tools_enabled: true,
            thinking_level: "medium".into(),
            cwd: dir,
        };
        let calls = vec![(
            "call_1".to_string(),
            "read_media".to_string(),
            json!({"path": "clip.webm"}),
        )];

        let (results, stopped, attachments) =
            execute_calls(&state, &emitter, &snapshot, &calls).await;

        assert!(!stopped);
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].path.as_deref(), Some("clip.webm"));
        assert_eq!(attachments[0].mime, "video/webm");
        assert!(matches!(
            &results[0],
            Message::ToolResult { is_error: false, content, .. }
                if matches!(content.first(), Some(Content::Text { text }) if text.contains("已附加"))
        ));
        let frames = drain(rx).await;
        let end = frames
            .iter()
            .find(|f| f["type"] == "tool_execution_end")
            .unwrap();
        assert_eq!(end["isError"], false);
    }

    #[tokio::test]
    async fn read_media_fails_honestly_when_the_model_lacks_the_modality() {
        let dir = std::env::temp_dir().join(format!("genet-loop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("clip.webm"), b"webm-bytes").unwrap();

        let (emitter, rx) = capture();
        let model = fake_model();
        let state = state_with(Some(model.clone()), emitter.clone(), dir.clone());
        let snapshot = Snapshot {
            model,
            messages: Vec::new(),
            skills: Vec::new(),
            system_prompt: String::new(),
            tools_enabled: true,
            thinking_level: "medium".into(),
            cwd: dir,
        };
        let calls = vec![(
            "call_1".to_string(),
            "read_media".to_string(),
            json!({"path": "clip.webm"}),
        )];

        let (results, _, attachments) = execute_calls(&state, &emitter, &snapshot, &calls).await;

        assert!(attachments.is_empty());
        assert!(matches!(
            &results[0],
            Message::ToolResult { is_error: true, content, .. }
                if matches!(content.first(), Some(Content::Text { text }) if text.contains("未配置 video 输入能力"))
        ));
        // The emitted event agrees with the recorded result: no false success.
        let frames = drain(rx).await;
        let end = frames
            .iter()
            .find(|f| f["type"] == "tool_execution_end")
            .unwrap();
        assert_eq!(end["isError"], true);
    }

    #[test]
    fn already_attached_files_are_not_resent() {
        let dir = std::env::temp_dir();
        let mut session = Session::in_memory(dir);
        session.append_message(Message::user_with_attachments(
            "hi",
            vec![MediaAttachment {
                name: "clip.webm".into(),
                mime: "video/webm".into(),
                path: Some("clip.webm".into()),
                data_base64: None,
            }],
        ));
        let again = vec![
            MediaAttachment {
                name: "clip.webm".into(),
                mime: "video/webm".into(),
                path: Some("clip.webm".into()),
                data_base64: None,
            },
            MediaAttachment {
                name: "frame.png".into(),
                mime: "image/png".into(),
                path: Some("frame.png".into()),
                data_base64: None,
            },
        ];

        let fresh = fresh_attachments(&session, again);

        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].name, "frame.png");
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("genet-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn model_id(id: &str) -> ModelConfig {
        ModelConfig {
            id: id.into(),
            ..fake_model()
        }
    }

    fn of_type<'a>(frames: &'a [Value], kind: &str) -> Vec<&'a Value> {
        frames
            .iter()
            .filter(|frame| frame["type"] == kind)
            .collect()
    }

    #[tokio::test]
    async fn a_transient_failure_is_retried_and_leaves_no_trace_in_context() {
        let (emitter, rx) = capture();
        let state = state_with(
            Some(model_id("rate-limit-once")),
            emitter,
            temp_dir("retry"),
        );
        run_prompt(state.clone(), "hello".into()).await;

        let frames = drain(rx).await;
        let start = of_type(&frames, "auto_retry_start");
        assert_eq!(start.len(), 1);
        assert_eq!(start[0]["attempt"], 1);
        assert_eq!(start[0]["maxAttempts"], 3);
        assert!(start[0]["errorMessage"].as_str().unwrap().contains("429"));
        let end = of_type(&frames, "auto_retry_end");
        assert_eq!(end.len(), 1);
        assert_eq!(end[0]["success"], true);
        // pi order: the failed turn closes before the retry is announced.
        let order = kinds(&frames);
        let retry_at = order.iter().position(|k| k == "auto_retry_start").unwrap();
        assert_eq!(order[retry_at - 1], "turn_end");
        assert_eq!(order[retry_at + 1], "turn_start");

        let guard = state.lock().await;
        assert!(!guard.session.messages.iter().any(|message| matches!(
            message,
            Message::Assistant {
                stop_reason: StopReason::Error,
                ..
            }
        )));
        assert!(matches!(
            guard.session.messages.last(),
            Some(Message::Assistant {
                stop_reason: StopReason::Stop,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn retries_are_bounded_and_end_with_the_final_error() {
        let (emitter, rx) = capture();
        let state = state_with(
            Some(model_id("rate-limit-always")),
            emitter,
            temp_dir("retry"),
        );
        run_prompt(state.clone(), "hello".into()).await;

        let frames = drain(rx).await;
        assert_eq!(of_type(&frames, "auto_retry_start").len(), 3);
        let end = of_type(&frames, "auto_retry_end");
        assert_eq!(end.len(), 1);
        assert_eq!(end[0]["success"], false);
        assert_eq!(end[0]["attempt"], 3);
        assert!(end[0]["finalError"].as_str().unwrap().contains("429"));
        // Side-effect-free failure: the prompt leaves the context.
        assert!(state.lock().await.session.messages.is_empty());
    }

    #[tokio::test]
    async fn authentication_failures_are_not_retried() {
        let (emitter, rx) = capture();
        let state = state_with(Some(model_id("auth-fail")), emitter, temp_dir("retry"));
        run_prompt(state, "hello".into()).await;
        let frames = drain(rx).await;
        assert!(of_type(&frames, "auto_retry_start").is_empty());
        let end = frames.iter().rfind(|f| f["type"] == "message_end").unwrap();
        assert_eq!(end["message"]["stopReason"], "error");
    }

    #[tokio::test]
    async fn abort_stops_the_backoff_immediately() {
        let (emitter, rx) = capture();
        let state = state_with(
            Some(model_id("rate-limit-always")),
            emitter,
            temp_dir("retry"),
        );
        state.lock().await.retry.base_delay_ms = 60_000;
        let run = tokio::spawn(run_prompt(state.clone(), "hello".into()));
        while !state.lock().await.streaming {
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        state.lock().await.abort.request();
        tokio::time::timeout(std::time::Duration::from_secs(5), run)
            .await
            .expect("the backoff is abortable")
            .unwrap();
        let frames = drain(rx).await;
        let end = of_type(&frames, "auto_retry_end");
        assert_eq!(end[0]["finalError"], "Retry cancelled");
        assert_eq!(kinds(&frames).last().unwrap(), "agent_end");
    }

    fn seed_history(session: &mut Session) {
        session.append_message(Message::user("earlier question"));
        session.append_message(Message::Assistant {
            content: vec![Content::text("earlier answer")],
            api: "fake".into(),
            provider: "fake".into(),
            model: "echo".into(),
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: 0,
        });
    }

    #[tokio::test]
    async fn overflow_archives_and_replays_the_request_once() {
        let (emitter, rx) = capture();
        let state = state_with(
            Some(model_id("overflow-once")),
            emitter,
            temp_dir("overflow"),
        );
        seed_history(&mut state.lock().await.session);
        run_prompt(state.clone(), "current request".into()).await;

        let frames = drain(rx).await;
        let start = of_type(&frames, "compaction_start");
        assert_eq!(start.len(), 1);
        assert_eq!(start[0]["reason"], "overflow");
        let end = of_type(&frames, "compaction_end");
        assert_eq!(end[0]["willRetry"], true);
        assert!(of_type(&frames, "auto_retry_start").is_empty());

        let guard = state.lock().await;
        let messages = &guard.session.messages;
        assert!(matches!(
            &messages[0],
            Message::User { content, .. } if content.contains("<genehub-compacted-context>")
                && content.contains("earlier question")
        ));
        // The request being served stays verbatim after the archive.
        assert!(messages[1..].iter().any(|message| matches!(
            message,
            Message::User { content, .. } if content == "current request"
        )));
        assert!(matches!(
            messages.last(),
            Some(Message::Assistant {
                stop_reason: StopReason::Stop,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn overflow_recovery_is_attempted_once() {
        let (emitter, rx) = capture();
        let state = state_with(
            Some(model_id("overflow-always")),
            emitter,
            temp_dir("overflow"),
        );
        seed_history(&mut state.lock().await.session);
        run_prompt(state, "current request".into()).await;

        let frames = drain(rx).await;
        let end = of_type(&frames, "compaction_end");
        assert_eq!(end.len(), 2);
        assert_eq!(end[0]["willRetry"], true);
        assert_eq!(end[1]["willRetry"], false);
        assert_eq!(end[1]["errorMessage"], recovery::OVERFLOW_RECOVERY_FAILED);
        assert_eq!(kinds(&frames).last().unwrap(), "agent_end");
    }

    #[tokio::test]
    async fn with_auto_archive_off_an_overflow_is_reported_directly() {
        let (emitter, rx) = capture();
        let state = state_with(
            Some(model_id("overflow-once")),
            emitter,
            temp_dir("overflow"),
        );
        {
            let mut guard = state.lock().await;
            guard.auto_compaction = false;
            seed_history(&mut guard.session);
        }
        run_prompt(state, "current request".into()).await;
        let frames = drain(rx).await;
        assert!(of_type(&frames, "compaction_start").is_empty());
        assert!(of_type(&frames, "auto_retry_start").is_empty());
        let end = frames.iter().rfind(|f| f["type"] == "message_end").unwrap();
        assert_eq!(end["message"]["stopReason"], "error");
    }

    #[tokio::test]
    async fn a_full_context_is_archived_before_the_next_request() {
        let (emitter, rx) = capture();
        let state = state_with(Some(fake_model()), emitter, temp_dir("threshold"));
        {
            let mut guard = state.lock().await;
            guard.session.append_message(Message::user("x".repeat(400)));
            guard.session.append_message(Message::Assistant {
                content: vec![Content::text("noted")],
                api: "fake".into(),
                provider: "fake".into(),
                model: "echo".into(),
                usage: Usage {
                    token_usage_reported: true,
                    total_tokens: 7000,
                    ..Usage::default()
                },
                stop_reason: StopReason::Stop,
                error_message: None,
                timestamp: 0,
            });
        }
        run_prompt(state.clone(), "next".into()).await;

        let frames = drain(rx).await;
        let start = of_type(&frames, "compaction_start");
        assert_eq!(start.len(), 1);
        assert_eq!(start[0]["reason"], "threshold");
        let order = kinds(&frames);
        let archived_at = order.iter().position(|k| k == "compaction_end").unwrap();
        let first_request = order.iter().position(|k| k == "message_update").unwrap();
        assert!(
            archived_at < first_request,
            "the archive precedes the request"
        );

        let guard = state.lock().await;
        assert!(matches!(
            &guard.session.messages[0],
            Message::User { content, .. } if content.contains("<genehub-compacted-context>")
        ));
        assert!(guard.session.messages.iter().any(|message| matches!(
            message,
            Message::User { content, .. } if content == "next"
        )));
        assert_eq!(order.last().unwrap(), "agent_end");
    }
}
