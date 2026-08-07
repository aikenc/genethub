//! genet-agent — GeneHub's built-in coding agent.
//!
//! RPC mode only: the daemon spawns this binary and speaks JSONL over stdio.
//! There is no interactive interface on purpose.

mod agent;
mod channel;
mod cli;
mod config;
mod prompt;
mod protocol;
mod provider;
mod rpc;
mod session;
mod skills;
mod state;
mod tools;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use protocol::{error_response, response, Command, Usage, THINKING_LEVELS};
use session::Session;
use state::State;

const SKILL_COMMAND_PREFIX: &str = "/skill:";

#[tokio::main]
async fn main() {
    let args = match cli::parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(err) => {
            eprintln!("genet-agent: {err}");
            std::process::exit(2);
        }
    };

    match args.mode.as_deref() {
        Some("rpc") => {}
        Some(other) => {
            eprintln!("genet-agent: only --mode rpc is supported, got '{other}'");
            std::process::exit(2);
        }
        None => {
            eprintln!("genet-agent: --mode rpc is required; this binary has no interactive mode");
            std::process::exit(2);
        }
    }

    for ignored in &args.ignored {
        eprintln!("genet-agent: ignoring unsupported argument: {ignored}");
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
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
        auto_compaction: true,
        skills: skills::load(&cwd, &data_dir),
        additional_system_prompts: args.add_system_prompt,
        cwd,
        stats: Usage::default(),
        streaming: false,
        abort: Arc::new(AtomicBool::new(false)),
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
                emitter.send(error_response(
                    id,
                    kind,
                    "agent is streaming; queueing is not supported",
                ));
                return;
            }

            let message = expand_skill_command(state, message).await;
            emitter.send(response(id, kind, Some(json!({ "agentInvoked": true }))));

            let spawned = state.clone();
            let handle = tokio::spawn(async move {
                agent::run_prompt(spawned, message).await;
            });
            state.lock().await.running = Some(handle);
        }
        "abort" => {
            {
                let guard = state.lock().await;
                guard.abort.store(true, std::sync::atomic::Ordering::SeqCst);
            }
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
        "set_auto_compaction" => {
            let enabled = command.bool_field("enabled").unwrap_or(true);
            state.lock().await.auto_compaction = enabled;
            emitter.send(response(id, kind, None));
        }
        "compact" => {
            // No summarisation yet; the daemon still needs the event pair and a
            // response so its request does not hang.
            emitter.send(json!({ "type": "compaction_start", "reason": "manual" }));
            emitter.send(json!({ "type": "compaction_end", "reason": "manual" }));
            emitter.send(response(id, kind, None));
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

    let path = {
        let guard = state.lock().await;
        guard
            .skills
            .iter()
            .find(|skill| skill.name == name)
            .map(|skill| skill.file_path.clone())
    };
    let Some(path) = path else {
        return message;
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return message;
    };

    if arguments.is_empty() {
        content
    } else {
        format!("{content}\n\nUser: {arguments}")
    }
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
    fn unknown_model_falls_back_to_the_first_configured_one() {
        let models = vec![model("anthropic", "claude")];
        assert_eq!(
            select_model(&models, Some("nope/nope")).unwrap().id,
            "claude"
        );
        assert!(select_model(&[], Some("nope")).is_none());
    }
}
