//! genet-agent — GeneHub's built-in coding agent.
//!
//! RPC mode only: the daemon spawns this agent and speaks JSONL over stdio.
//! There is no interactive interface on purpose.
//!
//! The same code runs two ways: the native `genet-agent-local` binary (a thin
//! shim over [`run`]), and the `agent-run` export of the single v2 wasm
//! component (`apps/guest`).

mod agent;
mod channel;
mod cli;
mod config;
mod os;
mod os_io;
mod os_process;
mod prompt;
mod protocol;
mod provider;
mod rpc;
mod session;
mod skills;
mod state;
mod tools;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use protocol::{error_response, error_response_with, response, Command, Message, Usage, THINKING_LEVELS};
use session::Session;
use state::State;

const SKILL_COMMAND_PREFIX: &str = "/skill:";

/// The agent's whole life, as an exit code. Whoever owns the process — the
/// native shim or the wasm component's `agent-run` export — turns this into
/// the process status.
pub async fn run() -> i32 {
    let args = match cli::parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(err) => {
            eprintln!("genet-agent: {err}");
            return 2;
        }
    };

    match args.mode.as_deref() {
        Some("rpc") => {}
        Some(other) => {
            eprintln!("genet-agent: only --mode rpc is supported, got '{other}'");
            return 2;
        }
        None => {
            eprintln!("genet-agent: --mode rpc is required; this binary has no interactive mode");
            return 2;
        }
    }

    for ignored in &args.ignored {
        eprintln!("genet-agent: ignoring unsupported argument: {ignored}");
    }

    let cwd = crate::os::cwd();
    let data_dir = config::data_dir();
    let models = config::load_models();
    let current_model = select_model(&models, args.model.as_deref());

    if current_model.is_none() {
        eprintln!("genet-agent: no model configured; prompts will fail until an API key is set");
    }

    let session = if args.no_session {
        Session::in_memory(cwd.clone())
    } else {
        let path = args
            .session
            .map(PathBuf::from)
            .unwrap_or_else(|| Session::default_path(&data_dir, &cwd));
        Session::open(path, cwd.clone())
    };

    let thinking_level = args
        .thinking
        .filter(|level| THINKING_LEVELS.contains(&level.as_str()))
        .unwrap_or_else(|| "medium".to_string());

    let state = Arc::new(Mutex::new(State {
        emitter: rpc::start_writer(),
        session,
        models,
        current_model,
        thinking_level,
        genehub_session_id: args.genehub_session_id,
        skills: skills::load(&cwd, &data_dir),
        additional_system_prompts: args.add_system_prompt,
        cwd,
        stats: Usage::default(),
        last_request: None,
        streaming: false,
        compacting: false,
        tools_enabled: true,
        abort: Arc::new(state::Abort::new()),
        running: None,
    }));

    let mut commands = rpc::start_reader();
    while let Some(line) = commands.recv().await {
        let emitter = { state.lock().await.emitter.clone() };
        match serde_json::from_str::<Command>(&line) {
            Ok(command) => handle(&state, command).await,
            Err(err) => emitter.send(error_response(
                None,
                "unknown",
                format!("invalid JSON: {err}"),
            )),
        }
    }

    // stdin closed: let the run in flight finish and the queue drain, or the
    // caller loses the tail of the conversation.
    let running = state.lock().await.running.take();
    if let Some(handle) = running {
        let _ = handle.await;
    }
    let emitter = { state.lock().await.emitter.clone() };
    emitter.flush().await;
    0
}

async fn handle(state: &Arc<Mutex<State>>, command: Command) {
    let id = command.id.clone();
    let id = id.as_deref();
    let kind = command.kind.as_str();
    let emitter = { state.lock().await.emitter.clone() };

    match kind {
        "prompt" => {
            let Some(message) = command.str_field("message") else {
                emitter.send(error_response(id, kind, "prompt requires 'message'"));
                return;
            };

            let busy = { state.lock().await.streaming };
            if busy {
            emitter.send(error_response_with(
                id,
                kind,
                "agent is streaming; queueing is not supported",
                "busy",
                Some(409),
                true,
            ));
                return;
            }

            let message = expand_skill_command(state, message).await;
            let attachments = match serde_json::from_value::<Vec<protocol::MediaAttachment>>(
                command
                    .rest
                    .get("attachments")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            ) {
                Ok(attachments) => attachments,
                Err(error) => {
                    emitter.send(error_response(
                        id,
                        kind,
                        format!("invalid attachments: {error}"),
                    ));
                    return;
                }
            };
            emitter.send(response(id, kind, Some(json!({ "agentInvoked": true }))));

            let spawned = state.clone();
            let handle = tokio::spawn(async move {
                let watched = spawned.clone();
                let outcome = tokio::spawn(async move {
                    agent::run_prompt_with_attachments(watched, message, attachments).await;
                })
                .await;
                if outcome.is_err_and(|error| error.is_panic()) {
                    recover_panicked_turn(&spawned).await;
                }
            });
            state.lock().await.running = Some(handle);
        }
        "abort" => {
            let already_requested = {
                let guard = state.lock().await;
                guard.abort.request()
            };
            eprintln!("event=interrupt_requested already_requested={already_requested}");
            emitter.send(response(id, kind, None));
        }
        "get_state" => {
            let value = state.lock().await.state_value();
            emitter.send(response(id, kind, Some(value)));
        }
        "get_messages" => {
            let value = state.lock().await.messages_value();
            emitter.send(response(id, kind, Some(value)));
        }
        "get_available_models" => {
            let value = state.lock().await.models_value();
            emitter.send(response(id, kind, Some(value)));
        }
        "get_session_stats" => {
            let value = state.lock().await.stats_value();
            emitter.send(response(id, kind, Some(value)));
        }
        "get_commands" => {
            let value = state.lock().await.commands_value();
            emitter.send(response(id, kind, Some(value)));
        }
        "set_model" => {
            let (Some(provider), Some(model_id)) =
                (command.str_field("provider"), command.str_field("modelId"))
            else {
                emitter.send(error_response(
                    id,
                    kind,
                    "set_model requires provider and modelId",
                ));
                return;
            };
            let mut guard = state.lock().await;
            let found = guard
                .models
                .iter()
                .find(|model| model.provider == provider && model.id == model_id)
                .cloned();
            match found {
                Some(model) => {
                    guard.session.append_model_change(&provider, &model_id);
                    let value = serde_json::to_value(model.to_ref()).unwrap_or(Value::Null);
                    guard.current_model = Some(model);
                    emitter.send(response(id, kind, Some(value)));
                }
                None => emitter.send(error_response(
                    id,
                    kind,
                    format!("unknown model: {provider}/{model_id}"),
                )),
            }
        }
        "set_thinking_level" => {
            let Some(level) = command.str_field("level") else {
                emitter.send(error_response(
                    id,
                    kind,
                    "set_thinking_level requires 'level'",
                ));
                return;
            };
            if !THINKING_LEVELS.contains(&level.as_str()) {
                emitter.send(error_response(
                    id,
                    kind,
                    format!("unknown thinking level: {level}"),
                ));
                return;
            }
            let mut guard = state.lock().await;
            guard.session.append_thinking_level_change(&level);
            guard.thinking_level = level;
            emitter.send(response(id, kind, None));
        }
        "compact" => {
            let busy = { state.lock().await.streaming };
            if busy {
                emitter.send(error_response_with(
                    id,
                    kind,
                    "agent is already running",
                    "busy",
                    Some(409),
                    true,
                ));
                return;
            }
            {
                let mut guard = state.lock().await;
                guard.streaming = true;
                guard.compacting = true;
            }
            emitter.send(response(id, kind, Some(json!({ "agentInvoked": true }))));
            let spawned = state.clone();
            let handle = tokio::spawn(async move {
                let watched = spawned.clone();
                let outcome = tokio::spawn(async move {
                    run_compaction(watched).await;
                })
                .await;
                if outcome.is_err_and(|error| error.is_panic()) {
                    recover_panicked_turn(&spawned).await;
                }
            });
            state.lock().await.running = Some(handle);
        }
        "set_session_name" => {
            let Some(name) = command.str_field("name") else {
                emitter.send(error_response(id, kind, "set_session_name requires 'name'"));
                return;
            };
            state.lock().await.session.set_name(name);
            emitter.send(response(id, kind, None));
        }
        other => emitter.send(error_response(
            id,
            other,
            format!("command not supported: {other}"),
        )),
    }
}

struct ContextMaterial {
    text: String,
    source_index: String,
    fallback_error: Option<String>,
}

async fn recover_panicked_turn(state: &Arc<Mutex<State>>) {
    let emitter = {
        let mut guard = state.lock().await;
        guard.streaming = false;
        guard.compacting = false;
        guard.emitter.clone()
    };
    emitter.send(json!({
        "type": "agent_end",
        "messages": [],
        "error": "The agent task panicked before it could finish the turn."
    }));
}

async fn run_compaction(state: Arc<Mutex<State>>) {
    capsule_replace(state, "manual:capsule", None).await;
}

/// Replaces provider context with the deterministic capsule. `open_round_from`
/// is the index of the current round; `None` keeps no tail (manual `/compact`).
/// Automatic calls no-op until usage reaches 80% of the configured window, and
/// run at most once per invocation.
pub(crate) async fn capsule_replace(
    state: Arc<Mutex<State>>,
    reason: &str,
    open_round_from: Option<usize>,
) -> bool {
    let idle = open_round_from.is_none();
    let (session_id, fallback_messages, tail, abort, budget, tokens_before) = {
        let guard = state.lock().await;
        let window = guard
            .current_model
            .as_ref()
            .and_then(|model| model.context_window)
            .filter(|window| *window > 0);
        if !idle {
            let Some(window) = window else {
                return false;
            };
            if !state::exceeds_capsule_threshold(guard.context_tokens(), window) {
                return false;
            }
        }
        let budget = capsule_token_budget(window);
        let tail = match open_round_from {
            Some(index) => {
                let messages = &guard.session.messages;
                let start = index.min(messages.len());
                let room = window
                    .unwrap_or(0)
                    .saturating_mul(4)
                    .saturating_div(5)
                    .saturating_sub(budget);
                fit_open_round(messages[start..].to_vec(), room)
            }
            None => Vec::new(),
        };
        (
            guard.genehub_session_id.clone(),
            guard.session.messages.clone(),
            tail,
            guard.abort.clone(),
            budget,
            guard.context_tokens(),
        )
    };

    let emitter = { state.lock().await.emitter.clone() };
    {
        let mut guard = state.lock().await;
        guard.compacting = true;
    }
    emitter.send(json!({ "type": "compaction_start", "reason": reason }));

    let material = match session_id.as_deref() {
        Some(session_id) => fetch_context_material(session_id, budget)
            .await
            .unwrap_or_else(|error| {
                fallback_context(session_id, &fallback_messages, &error, budget)
            }),
        None => fallback_context(
            "unknown",
            &fallback_messages,
            "GeneHub session id is unavailable",
            budget,
        ),
    };
    if abort.requested() {
        emitter.send(json!({
            "type": "compaction_end",
            "reason": reason,
            "aborted": true
        }));
        let mut guard = state.lock().await;
        guard.compacting = false;
        if idle {
            guard.streaming = false;
            guard.abort.reset();
        }
        return false;
    }
    let summary = format!("{}\n\n{}", material.text, material.source_index);
    let end_reason = if material.fallback_error.is_some() {
        format!("{reason}-fallback")
    } else {
        reason.to_string()
    };
    let tokens_after = {
        let mut guard = state.lock().await;
        guard.session.replace_with_capsule(summary, tail);
        guard.last_request = None;
        guard.compacting = false;
        if idle {
            guard.streaming = false;
            guard.abort.reset();
        }
        guard.context_tokens()
    };
    let mut end = json!({
        "type": "compaction_end",
        "reason": end_reason,
        "tokensBefore": tokens_before,
        "tokensAfter": tokens_after,
    });
    if let Some(error) = material.fallback_error {
        end["error"] = json!(error);
    }
    emitter.send(end);
    true
}

fn fit_open_round(tail: Vec<Message>, room: u64) -> Vec<Message> {
    if state::estimate_message_tokens(&tail) <= room {
        return tail;
    }
    let mut leading = Vec::new();
    let mut groups: Vec<Vec<Message>> = Vec::new();
    for message in tail {
        if matches!(message, Message::Assistant { .. }) {
            groups.push(vec![message]);
        } else if let Some(group) = groups.last_mut() {
            group.push(message);
        } else {
            leading.push(message);
        }
    }
    let mut omitted = Vec::new();
    while groups.len() > 1 {
        let dropped = groups.remove(0);
        omitted.extend(tool_names(&dropped));
        let fitted = assemble_round(&leading, &omitted, &groups);
        if state::estimate_message_tokens(&fitted) <= room {
            return fitted;
        }
    }
    if groups.len() == 1 {
        let fitted = assemble_round(&leading, &omitted, &groups);
        if state::estimate_message_tokens(&fitted) <= room || omitted.is_empty() {
            return fitted;
        }
        // The newest group alone still overflows. Keep it paired rather than
        // splitting a tool call from its result; the request is sent anyway.
        return fitted;
    }
    assemble_round(&leading, &omitted, &groups)
}

fn assemble_round(leading: &[Message], omitted: &[String], groups: &[Vec<Message>]) -> Vec<Message> {
    let mut out = leading.to_vec();
    if !omitted.is_empty() {
        out.push(Message::user(format!(
            "Earlier tool results in this round were omitted to fit the context window: {}. Use `genet session rounds` to inspect them.",
            omitted.join(", ")
        )));
    }
    for group in groups {
        out.extend(group.iter().cloned());
    }
    out
}

fn tool_names(group: &[Message]) -> Vec<String> {
    let calls = group
        .iter()
        .filter_map(|message| match message {
            Message::Assistant { content, .. } => Some(
                content
                    .iter()
                    .filter_map(|block| match block {
                        protocol::Content::ToolCall { name, .. } => Some(name.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>(),
            ),
            _ => None,
        })
        .flatten()
        .collect::<Vec<_>>();
    if !calls.is_empty() {
        return calls;
    }
    group
        .iter()
        .filter_map(|message| match message {
            Message::ToolResult { tool_name, .. } => Some(tool_name.clone()),
            _ => None,
        })
        .collect()
}

fn capsule_token_budget(window: Option<u64>) -> u64 {
    window
        .map(|value| (value.saturating_mul(35) / 100).clamp(2_048, 64_000))
        .unwrap_or(16_000)
}

async fn fetch_context_material(session_id: &str, budget: u64) -> Result<ContextMaterial, String> {
    let binary = std::env::var_os("GENEHUB_CLI")
        .map(PathBuf::from)
        .ok_or_else(|| "GENEHUB_CLI is unavailable".to_string())?;
    let output = crate::os_process::Command::new(binary)
        .args([
            "session",
            "context",
            session_id,
            "--budget-tokens",
            &budget.to_string(),
        ])
        .output()
        .await
        .map_err(|error| format!("could not invoke genet session context: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "genet session context exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let envelope: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid genet session context output: {error}"))?;
    let context = envelope
        .pointer("/data/context")
        .ok_or_else(|| "genet output has no data.context".to_string())?;
    let text = context
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "genet context text is empty".to_string())?
        .to_string();
    let source_index = format_source_index(session_id, context);
    Ok(ContextMaterial {
        text,
        source_index,
        fallback_error: None,
    })
}

fn format_source_index(session_id: &str, context: &Value) -> String {
    let digest = context
        .get("digest")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let coverage = context.get("coverage").cloned().unwrap_or(Value::Null);
    let references = context
        .get("references")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|reference| reference.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    let commands = context
        .get("retrievalCommands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "<genehub-source-index session-id=\"{session_id}\" digest=\"{digest}\">\n\
         Coverage: {coverage}\n\
         Durable references (resolve details instead of guessing):\n{references}\n\
         Retrieval commands:\n{commands}\n\
         </genehub-source-index>"
    )
}

fn fallback_context(
    session_id: &str,
    messages: &[Message],
    error: &str,
    budget: u64,
) -> ContextMaterial {
    let raw = serde_json::to_string(messages).unwrap_or_default();
    let text = tail_chars(&raw, usize::try_from(budget.saturating_mul(4)).unwrap_or(usize::MAX));
    ContextMaterial {
        text: format!(
            "The deterministic context projection was unavailable ({error}). The following is a bounded tail of the built-in Agent's private context and may be incomplete:\n{text}"
        ),
        source_index: format!(
            "<genehub-source-index session-id=\"{session_id}\" digest=\"unavailable\">\n\
             Coverage: unavailable; do not infer omitted detail.\n\
             Retrieval command: genet session inspect {session_id}\n\
             </genehub-source-index>"
        ),
        fallback_error: Some(error.to_string()),
    }
}

fn tail_chars(value: &str, max_chars: usize) -> String {
    let count = value.chars().count();
    if count <= max_chars {
        return value.to_string();
    }
    value.chars().skip(count - max_chars).collect()
}

/// `/skill:name [args]` loads the skill file, with any arguments appended as a
/// user line.
async fn expand_skill_command(state: &Arc<Mutex<State>>, message: String) -> String {
    let Some(rest) = message.strip_prefix(SKILL_COMMAND_PREFIX) else {
        return message;
    };
    let (name, arguments) = match rest.split_once(char::is_whitespace) {
        Some((name, arguments)) => (name, arguments.trim()),
        None => (rest, ""),
    };

    let located = {
        let guard = state.lock().await;
        guard.skills.iter().find(|skill| skill.name == name).map(|skill| {
            (skill.file_path.clone(), skill.base_dir.clone())
        })
    };
    let Some((path, base_dir)) = located else {
        return message;
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return message;
    };
    render_skill(&base_dir, &content, arguments)
}

fn render_skill(base_dir: &std::path::Path, content: &str, arguments: &str) -> String {
    let mut text = format!("Skill base directory: {}\n\n{content}", base_dir.display());
    if !arguments.is_empty() {
        text.push_str("\n\nUser: ");
        text.push_str(arguments);
    }
    text
}

fn select_model(
    models: &[config::ModelConfig],
    requested: Option<&str>,
) -> Option<config::ModelConfig> {
    if let Some(reference) = requested {
        let wanted = reference.trim();
        if let Some(model) = models
            .iter()
            .find(|model| model.to_ref().reference() == wanted || model.id == wanted)
        {
            return Some(model.clone());
        }
        eprintln!("genet-agent: requested model '{wanted}' is not configured");
    }
    models.first().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use config::ModelConfig;

    fn model(provider: &str, id: &str) -> ModelConfig {
        ModelConfig {
            provider: provider.into(),
            id: id.into(),
            name: None,
            api: None,
            base_url: None,
            api_key: None,
            api_key_env: None,
            context_window: None,
            max_tokens: None,
            reasoning: None,
            input_modalities: Vec::new(),
        }
    }

    #[test]
    fn model_is_selected_by_provider_slash_id() {
        let models = vec![model("anthropic", "claude"), model("openai", "gpt")];
        let selected = select_model(&models, Some("openai/gpt")).unwrap();
        assert_eq!(selected.id, "gpt");
    }

    #[test]
    fn bare_model_ids_also_resolve() {
        let models = vec![model("anthropic", "claude")];
        assert_eq!(select_model(&models, Some("claude")).unwrap().id, "claude");
    }

    #[test]
    fn a_skill_command_names_its_base_directory() {
        let text = render_skill(
            std::path::Path::new("/skills/demo"),
            "Read scripts/run.sh",
            "extra",
        );
        assert!(text.starts_with("Skill base directory: /skills/demo\n\nRead scripts/run.sh"));
        assert!(text.ends_with("\n\nUser: extra"));
    }

    #[test]
    fn unknown_model_falls_back_to_the_first_configured_one() {
        let models = vec![model("anthropic", "claude")];
        assert_eq!(
            select_model(&models, Some("nope/nope")).unwrap().id,
            "claude"
        );
        assert!(select_model(&[], Some("nope")).is_none());
    }

    #[tokio::test]
    async fn compaction_replaces_context_with_the_capsule_and_keeps_one_file() {
        let dir = std::env::temp_dir().join(format!(
            "genet-compact-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("parent.jsonl");
        let mut parent = Session::open(file.clone(), dir.clone());
        parent.append_message(Message::user("old context"));
        let mut fake = model("fake", "echo");
        fake.api = Some("fake".into());
        let (sink, _frames) = tokio::sync::mpsc::unbounded_channel();
        let state = Arc::new(Mutex::new(State {
            emitter: rpc::Emitter::collector(sink),
            session: parent,
            models: vec![fake.clone()],
            current_model: Some(fake),
            thinking_level: "off".into(),
            genehub_session_id: None,
            skills: Vec::new(),
            additional_system_prompts: Vec::new(),
            cwd: dir.clone(),
            stats: Usage::default(),
            last_request: None,
            streaming: true,
            compacting: true,
            tools_enabled: true,
            abort: Arc::new(state::Abort::new()),
            running: None,
        }));

        run_compaction(state.clone()).await;

        let guard = state.lock().await;
        assert!(!guard.streaming);
        assert!(!guard.compacting);
        assert_eq!(guard.session.messages.len(), 1);
        drop(guard);
        let raw = std::fs::read_to_string(&file).unwrap();
        assert!(raw.contains("\"type\":\"compaction\""));
        assert!(raw.contains("genehub-source-index"));
        assert!(raw.contains("deterministic context projection was unavailable"));
        assert!(!raw.contains("Forced compaction task"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn capsule_budget_follows_the_window_and_stays_inside_the_daemon_clamp() {
        assert_eq!(capsule_token_budget(None), 16_000);
        assert_eq!(capsule_token_budget(Some(262_144)), 64_000);
        assert_eq!(capsule_token_budget(Some(524_288)), 64_000);
        assert_eq!(capsule_token_budget(Some(1_000)), 2_048);
    }

    #[tokio::test]
    async fn a_panicked_turn_still_closes_with_agent_end() {
        let (sink, mut frames) = tokio::sync::mpsc::unbounded_channel();
        let dir = std::env::temp_dir();
        let state = Arc::new(Mutex::new(State {
            emitter: rpc::Emitter::collector(sink),
            session: Session::in_memory(dir.clone()),
            models: Vec::new(),
            current_model: None,
            thinking_level: "off".into(),
            genehub_session_id: None,
            skills: Vec::new(),
            additional_system_prompts: Vec::new(),
            cwd: dir,
            stats: Usage::default(),
            last_request: None,
            streaming: true,
            compacting: true,
            tools_enabled: true,
            abort: Arc::new(state::Abort::new()),
            running: None,
        }));
        recover_panicked_turn(&state).await;
        state.lock().await.emitter.flush().await;
        let frame = frames.recv().await.expect("agent_end");
        assert_eq!(frame["type"], "agent_end");
        assert!(frame["error"].as_str().unwrap().contains("panicked"));
        let guard = state.lock().await;
        assert!(!guard.streaming);
        assert!(!guard.compacting);
    }

    #[tokio::test]
    async fn an_aborted_compaction_leaves_the_previous_context_in_place() {
        let dir = std::env::temp_dir().join(format!(
            "genet-compact-abort-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut parent = Session::open(dir.join("parent.jsonl"), dir.clone());
        parent.append_message(Message::user("keep this"));
        let abort = Arc::new(state::Abort::new());
        abort.request();
        let (sink, _frames) = tokio::sync::mpsc::unbounded_channel();
        let state = Arc::new(Mutex::new(State {
            emitter: rpc::Emitter::collector(sink),
            session: parent,
            models: Vec::new(),
            current_model: None,
            thinking_level: "off".into(),
            genehub_session_id: None,
            skills: Vec::new(),
            additional_system_prompts: Vec::new(),
            cwd: dir,
            stats: Usage::default(),
            last_request: None,
            streaming: true,
            compacting: true,
            tools_enabled: true,
            abort,
            running: None,
        }));
        run_compaction(state.clone()).await;
        let guard = state.lock().await;
        assert_eq!(guard.session.messages.len(), 1);
        match &guard.session.messages[0] {
            Message::User { content, .. } => assert_eq!(content, "keep this"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn an_oversized_round_drops_older_tool_groups_without_splitting_the_newest() {
        let prompt = Message::user("do the work");
        let tail = vec![
            prompt,
            assistant_call("old_tool"),
            tool_result("old_tool", &"x".repeat(4_000)),
            assistant_call("new_tool"),
            tool_result("new_tool", "ok"),
        ];
        let fitted = fit_open_round(tail, 0);
        match &fitted[0] {
            Message::User { content, .. } => assert_eq!(content, "do the work"),
            other => panic!("unexpected {other:?}"),
        }
        let note = fitted
            .iter()
            .find_map(|message| match message {
                Message::User { content, .. } if content.contains("omitted") => Some(content),
                _ => None,
            })
            .expect("omission note");
        assert!(note.contains("old_tool"));
        assert!(note.contains("genet session rounds"));
        assert!(fitted.iter().any(|message| message
            .tool_calls()
            .iter()
            .any(|(_, name, _)| name == "new_tool")));
        assert!(!fitted.iter().any(|message| message
            .tool_calls()
            .iter()
            .any(|(_, name, _)| name == "old_tool")));
        assert!(fitted.iter().any(|message| matches!(
            message,
            Message::ToolResult { tool_name, .. } if tool_name == "new_tool"
        )));
    }

    fn assistant_call(name: &str) -> Message {
        Message::Assistant {
            content: vec![crate::protocol::Content::ToolCall {
                id: name.into(),
                name: name.into(),
                arguments: json!({}),
            }],
            api: "fake".into(),
            provider: "fake".into(),
            model: "echo".into(),
            usage: Usage::default(),
            stop_reason: crate::protocol::StopReason::ToolUse,
            error_message: None,
            timestamp: 0,
        }
    }

    fn tool_result(name: &str, body: &str) -> Message {
        Message::ToolResult {
            tool_call_id: name.into(),
            tool_name: name.into(),
            content: vec![crate::protocol::Content::text(body)],
            details: None,
            is_error: false,
            timestamp: 0,
        }
    }
}
