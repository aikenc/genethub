//! Talking to an agent from the command line.
//!
//! This is the mutating half of the session surface, kept out of `query.rs` so
//! that module's read-only guarantee stays a guarantee. What it drives is the
//! ordinary session machinery — create, subscribe, send, resume — so a
//! conversation started here is a real session: it persists, it appears in the
//! workbench, another device can take it over, and a dropped connection can
//! replay it. There is deliberately no one-shot stateless chat path, because a
//! second kind of session is a second set of rules for everything that reads
//! one (`genet-remote-execution.md` §6.2).

use std::time::Duration;

use genehub_proto::{
    PermissionOptionKind, PermissionOutcome, PermissionRequest, PermissionRequestKind, Reply,
    Request, SequencedEvent, SessionEvent, SessionSnapshot, SessionSummary, TurnError,
};
use serde_json::{json, Value};

use super::output::{self, CliFailure};
use super::query;
use super::rpc::{Payload, Rpc};
use super::target::Selection;
use super::{EXIT_FAILED, EXIT_OK, EXIT_UNREACHABLE};

/// How a wait ended. Only `Completed` is a success; everything else leaves
/// something for the caller to do, and the exit code has to say so.
#[derive(Debug)]
enum Outcome {
    Completed {
        turn_id: String,
    },
    Failed {
        turn_id: String,
        error: TurnError,
    },
    Canceled {
        turn_id: String,
    },
    /// The turn stopped at a question the CLI must not answer on the user's
    /// behalf (`genet-remote-execution.md` §6.4).
    Waiting(Box<PermissionRequest>),
    /// A second Ctrl-C. The session keeps running in the daemon.
    Detached,
    TimedOut,
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub agent_id: Option<String>,
    pub prompt: String,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub cwd: Option<String>,
    pub model_id: Option<String>,
    pub mode_id: Option<String>,
    pub effort_id: Option<String>,
    pub title: Option<String>,
    pub wait: bool,
    pub since_seq: Option<u64>,
    pub auto_approve: bool,
    pub open_workspace: bool,
    pub timeout: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    AgentList,
    Run(Box<Run>),
    Respond {
        session_id: String,
        request_id: String,
        choose: String,
    },
    Interrupt {
        session_id: String,
    },
    Close {
        session_id: String,
    },
}

/// `genet agent …` and the `genet <agentId> …` sugar.
pub async fn agent(args: &[String], selection: &Selection) -> i32 {
    match parse_agent(args, selection) {
        Ok(command) => execute(command, selection).await,
        Err(error) => output::fail(error),
    }
}

/// The mutating `genet session …` verbs. Reading verbs stay in `query.rs`.
pub async fn session(args: &[String], selection: &Selection) -> i32 {
    match parse_session(args, selection) {
        Ok(command) => execute(command, selection).await,
        Err(error) => output::fail(error),
    }
}

/// `genet <agentId> "<prompt>"`. The head token was already established as
/// neither a reserved subcommand nor a flag.
pub async fn sugar(agent_id: &str, args: &[String], selection: &Selection) -> i32 {
    let mut run = match Options::parse(args, selection) {
        Ok(options) => match options.into_run(None) {
            Ok(run) => run,
            Err(error) => return output::fail(error),
        },
        Err(error) => return output::fail(error),
    };
    run.agent_id = Some(agent_id.to_string());
    execute(Command::Run(Box::new(run)), selection).await
}

fn parse_agent(args: &[String], selection: &Selection) -> Result<Command, CliFailure> {
    match args.first().map(String::as_str) {
        Some("list") => {
            if args.len() > 1 {
                return Err(CliFailure::invalid_args(
                    "genet agent list takes no arguments",
                ));
            }
            Ok(Command::AgentList)
        }
        Some("run") => {
            let options = Options::parse(&args[1..], selection)?;
            let agent_id = options.agent.clone();
            let run = options.into_run(agent_id)?;
            if run.agent_id.is_none() && run.session_id.is_none() {
                return Err(CliFailure::invalid_args(
                    "genet agent run needs --agent <id>, or --session <id> to continue one",
                ));
            }
            Ok(Command::Run(Box::new(run)))
        }
        _ => Err(CliFailure::invalid_args(
            "usage: genet agent list | genet agent run --agent <id> \"<prompt>\"",
        )),
    }
}

fn parse_session(args: &[String], selection: &Selection) -> Result<Command, CliFailure> {
    let verb = args.first().map(String::as_str).unwrap_or_default();
    let session_id = args
        .get(1)
        .filter(|id| !id.trim().is_empty() && !id.starts_with('-'))
        .cloned()
        .ok_or_else(|| {
            CliFailure::invalid_args(format!("genet session {verb} needs a session id"))
        })?;
    match verb {
        "send" => {
            let options = Options::parse(&args[2..], selection)?;
            let mut run = options.into_run(None)?;
            run.session_id = Some(session_id);
            Ok(Command::Run(Box::new(run)))
        }
        "respond" => {
            let options = Options::parse(&args[2..], selection)?;
            let (Some(request_id), Some(choose)) = (options.request, options.choose) else {
                return Err(CliFailure::invalid_args(
                    "genet session respond needs --request <id> and --choose <optionId>",
                ));
            };
            Ok(Command::Respond {
                session_id,
                request_id,
                choose,
            })
        }
        "interrupt" => Ok(Command::Interrupt { session_id }),
        "close" => Ok(Command::Close { session_id }),
        _ => Err(CliFailure::invalid_args(format!(
            "unknown session command: {verb}"
        ))),
    }
}

/// Flags shared by the conversation verbs, parsed once so `genet agent run`,
/// `genet <agentId>` and `genet session send` cannot drift apart.
#[derive(Debug, Default)]
struct Options {
    positional: Vec<String>,
    agent: Option<String>,
    session: Option<String>,
    workspace: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    effort: Option<String>,
    title: Option<String>,
    request: Option<String>,
    choose: Option<String>,
    since_seq: Option<u64>,
    timeout: Option<u64>,
    wait: Option<bool>,
    auto_approve: bool,
    open_workspace: bool,
}

impl Options {
    fn parse(args: &[String], selection: &Selection) -> Result<Self, CliFailure> {
        let mut options = Self {
            cwd: selection.cwd.clone(),
            ..Self::default()
        };
        let mut index = 0;
        while index < args.len() {
            let argument = args[index].as_str();
            let mut value = || -> Result<String, CliFailure> {
                index += 1;
                args.get(index)
                    .filter(|value| !value.trim().is_empty())
                    .cloned()
                    .ok_or_else(|| {
                        CliFailure::invalid_args(format!("{argument} needs a non-empty value"))
                    })
            };
            match argument {
                "--agent" => options.agent = Some(value()?),
                "--session" => options.session = Some(value()?),
                "--workspace" => options.workspace = Some(value()?),
                "--model" => options.model = Some(value()?),
                "--mode" => options.mode = Some(value()?),
                "--effort" => options.effort = Some(value()?),
                "--title" => options.title = Some(value()?),
                "--message" => options.positional.push(value()?),
                "--request" => options.request = Some(value()?),
                "--choose" => options.choose = Some(value()?),
                "--since-seq" => options.since_seq = Some(number(&value()?, "--since-seq")?),
                "--timeout" => options.timeout = Some(number(&value()?, "--timeout")?),
                "--wait" => options.wait = Some(true),
                "--no-wait" => options.wait = Some(false),
                "--auto-approve" => options.auto_approve = true,
                "--open-workspace" => options.open_workspace = true,
                other if other.starts_with('-') => {
                    return Err(CliFailure::invalid_args(format!("unknown option: {other}")))
                }
                other => options.positional.push(other.to_string()),
            }
            index += 1;
        }
        Ok(options)
    }

    fn into_run(self, agent_id: Option<String>) -> Result<Run, CliFailure> {
        if self.workspace.is_some() && self.cwd.is_some() {
            return Err(CliFailure::invalid_args(
                "--workspace and --cwd are two answers to the same question; give one",
            ));
        }
        let prompt = self.positional.join(" ").trim().to_string();
        if prompt.is_empty() {
            return Err(CliFailure::invalid_args(
                "nothing to say; pass the prompt as an argument or with --message",
            ));
        }
        Ok(Run {
            agent_id,
            prompt,
            session_id: self.session,
            workspace_id: self.workspace,
            cwd: self.cwd,
            model_id: self.model,
            mode_id: self.mode,
            effort_id: self.effort,
            title: self.title,
            wait: self.wait.unwrap_or(true),
            since_seq: self.since_seq,
            auto_approve: self.auto_approve,
            open_workspace: self.open_workspace,
            timeout: self.timeout,
        })
    }
}

fn number(raw: &str, flag: &str) -> Result<u64, CliFailure> {
    raw.parse()
        .map_err(|_| CliFailure::invalid_args(format!("{flag} needs a whole number, got {raw}")))
}

async fn execute(command: Command, selection: &Selection) -> i32 {
    let rpc = match query::connect_selected(selection).await {
        Ok(rpc) => rpc,
        Err(error) => return output::fail(error),
    };
    let result = match command {
        Command::AgentList => agent_list(&rpc).await.map(|data| {
            output::succeed("agent.list", data);
            EXIT_OK
        }),
        Command::Run(run) => run_conversation(&rpc, *run, selection.machine.is_none()).await,
        Command::Respond {
            session_id,
            request_id,
            choose,
        } => respond(&rpc, &session_id, &request_id, &choose)
            .await
            .map(|data| {
                output::succeed("session.respond", data);
                EXIT_OK
            }),
        Command::Interrupt { session_id } => {
            acknowledge(
                &rpc,
                Request::SessionInterrupt {
                    session_id: session_id.clone(),
                },
                "session.interrupt",
                &session_id,
            )
            .await
        }
        Command::Close { session_id } => {
            acknowledge(
                &rpc,
                Request::SessionClose {
                    session_id: session_id.clone(),
                },
                "session.close",
                &session_id,
            )
            .await
        }
    };
    match result {
        Ok(code) => code,
        Err(error) => output::fail(error),
    }
}

async fn acknowledge(
    rpc: &Rpc,
    request: Request,
    kind: &str,
    session_id: &str,
) -> Result<i32, CliFailure> {
    rpc.call(request).await.map_err(query::rpc_error)?;
    output::succeed(kind, json!({"sessionId": session_id}));
    Ok(EXIT_OK)
}

async fn agent_list(rpc: &Rpc) -> Result<Value, CliFailure> {
    match rpc
        .call(Request::AgentList)
        .await
        .map_err(query::rpc_error)?
    {
        Reply::Agents(agents) => Ok(json!({"agents": agents})),
        other => Err(query::unexpected_reply("agents", &other)),
    }
}

async fn respond(
    rpc: &Rpc,
    session_id: &str,
    request_id: &str,
    choose: &str,
) -> Result<Value, CliFailure> {
    rpc.call(Request::SessionRespondPermission {
        session_id: session_id.to_string(),
        request_id: request_id.to_string(),
        outcome: PermissionOutcome::Selected {
            option_id: choose.to_string(),
        },
    })
    .await
    .map_err(query::rpc_error)?;
    Ok(json!({"sessionId": session_id, "requestId": request_id, "chose": choose}))
}

async fn run_conversation(rpc: &Rpc, run: Run, here: bool) -> Result<i32, CliFailure> {
    let session = match run.session_id.as_deref() {
        Some(session_id) => attach(rpc, session_id, run.agent_id.as_deref()).await?,
        None => create(rpc, &run, here).await?,
    };

    // Subscribing before sending is what makes the stream gap-free: a turn that
    // starts and finishes between the two calls would otherwise be invisible.
    let mut seq = 0;
    if run.wait {
        rpc.watch_events().await.map_err(query::rpc_error)?;
        let Reply::Subscribed {
            snapshot,
            replayed,
            reset,
        } = rpc
            .call(Request::Subscribe {
                session_id: session.id.clone(),
                since_seq: run.since_seq,
                expand_last_round: false,
            })
            .await
            .map_err(query::rpc_error)?
        else {
            return Err(CliFailure::protocol(
                "the daemon answered subscribe with something other than a subscription",
            ));
        };
        seq = snapshot.seq;
        opened(&session, &snapshot, run.session_id.is_some());
        // Only meaningful to a caller that asked to resume from a point: on a
        // fresh subscription the daemon always reports a reset, and saying
        // "desynced" there would train readers to ignore the one signal that
        // means events were actually lost.
        if reset && run.since_seq.is_some() {
            emit(
                "session.desync",
                json!({"sessionId": session.id, "sinceSeq": run.since_seq, "seq": seq}),
            );
        }
        for event in replayed {
            seq = seq.max(event.seq);
            emit_event(&event);
        }
    } else {
        emit(
            if run.session_id.is_some() {
                "session.attached"
            } else {
                "session.created"
            },
            json!({
                "sessionId": session.id,
                "workspaceId": session.workspace_id,
                "agentId": session.agent_id,
            }),
        );
    }

    if let Some(effort_id) = run.effort_id.clone() {
        // `session.create` has no field for it, so it rides immediately behind,
        // exactly as the workbench does.
        rpc.call(Request::SessionSetEffort {
            session_id: session.id.clone(),
            effort_id,
        })
        .await
        .map_err(query::rpc_error)?;
    }

    rpc.call(Request::SessionSend {
        session_id: session.id.clone(),
        text: run.prompt.clone(),
        attachments: Vec::new(),
        artifact_preview_base_url: None,
        continues_round: None,
    })
    .await
    .map_err(query::rpc_error)?;

    if !run.wait {
        emit(
            "session.result",
            json!({"sessionId": session.id, "status": "running", "waited": false}),
        );
        return Ok(EXIT_OK);
    }

    let outcome = pump(rpc, &session.id, run.auto_approve, run.timeout, seq).await;
    Ok(report(&session.id, outcome))
}

fn opened(session: &SessionSummary, snapshot: &SessionSnapshot, attached: bool) {
    emit(
        if attached {
            "session.attached"
        } else {
            "session.created"
        },
        json!({
            "sessionId": session.id,
            "workspaceId": session.workspace_id,
            "agentId": session.agent_id,
            "status": snapshot.summary.status,
            "seq": snapshot.seq,
            "pendingPermissions": snapshot.pending_permissions,
        }),
    );
}

async fn attach(
    rpc: &Rpc,
    session_id: &str,
    expected_agent: Option<&str>,
) -> Result<SessionSummary, CliFailure> {
    let Reply::Snapshot(snapshot) = rpc
        .call(Request::SessionGet {
            session_id: session_id.to_string(),
        })
        .await
        .map_err(query::rpc_error)?
    else {
        return Err(CliFailure::protocol(
            "the daemon answered session.get with something other than a snapshot",
        ));
    };
    if let Some(expected) = expected_agent {
        if expected != snapshot.summary.agent_id {
            return Err(CliFailure::invalid_args(format!(
                "session {session_id} belongs to {}, not {expected}; drop the agent name to \
                 continue it",
                snapshot.summary.agent_id
            )));
        }
    }
    Ok(snapshot.summary)
}

async fn create(rpc: &Rpc, run: &Run, here: bool) -> Result<SessionSummary, CliFailure> {
    let agent_id = run
        .agent_id
        .clone()
        .ok_or_else(|| CliFailure::invalid_args("no agent named"))?;
    let (workspace_id, cwd) = resolve_workspace(rpc, run, here).await?;
    let Reply::Session(summary) = rpc
        .call(Request::SessionCreate {
            workspace_id,
            agent_id,
            model_id: run.model_id.clone(),
            mode_id: run.mode_id.clone(),
            runtime_values: None,
            title: run.title.clone(),
            cwd,
        })
        .await
        .map_err(query::rpc_error)?
    else {
        return Err(CliFailure::protocol(
            "the daemon answered session.create with something other than a session",
        ));
    };
    Ok(summary)
}

/// Turns `--workspace` or `--cwd` into the pair the daemon wants.
///
/// A `--cwd` inside a registered workspace keeps that workspace and starts the
/// agent in that directory, rather than registering a second workspace per
/// directory — one repository should not fragment into a workspace per
/// subdirectory just because tasks ran in different places inside it.
async fn resolve_workspace(
    rpc: &Rpc,
    run: &Run,
    here: bool,
) -> Result<(String, Option<String>), CliFailure> {
    let located =
        super::place::locate(rpc, run.workspace_id.clone(), run.cwd.as_deref(), here).await?;
    let uncovered = match located {
        super::place::Located::In { workspace_id, cwd } => return Ok((workspace_id, cwd)),
        super::place::Located::Uncovered(path) => path,
    };
    if !run.open_workspace {
        return Err(CliFailure::business(
            "targetNotFound",
            format!(
                "no workspace on the machine that answered contains {}; open it there first, \
                 or pass --workspace <id>",
                uncovered.display()
            ),
            Some(json!({"cwd": uncovered.to_string_lossy()})),
        ));
    }
    let Reply::Workspace(workspace) = rpc
        .call(Request::WorkspaceOpen {
            root: uncovered.to_string_lossy().into_owned(),
        })
        .await
        .map_err(query::rpc_error)?
    else {
        return Err(CliFailure::protocol(
            "the daemon answered workspace.open with something other than a workspace",
        ));
    };
    Ok((workspace.id, None))
}

async fn pump(
    rpc: &Rpc,
    session_id: &str,
    auto_approve: bool,
    timeout: Option<u64>,
    mut seq: u64,
) -> Outcome {
    let mut interrupts = 0u8;
    let deadline =
        timeout.map(|seconds| tokio::time::Instant::now() + Duration::from_secs(seconds));
    loop {
        let event = tokio::select! {
            event = rpc.next_event() => event,
            _ = wait_interrupt() => {
                interrupts += 1;
                // The session runs in the daemon, so quitting here would leave
                // an agent editing files with nobody watching. The first Ctrl-C
                // asks it to stop and keeps waiting for the turn to wind down.
                if interrupts == 1 {
                    super::emit_stderr(
                        "interrupting; press Ctrl-C again to leave the session running in the daemon",
                    );
                    let _ = rpc
                        .call(Request::SessionInterrupt { session_id: session_id.to_string() })
                        .await;
                    continue;
                }
                return Outcome::Detached;
            }
            _ = expire(deadline) => return Outcome::TimedOut,
        };
        let event = match event {
            None => return Outcome::Disconnected,
            // Reported rather than swallowed: what follows is not continuous
            // with what came before, and a reader told nothing about the hole
            // would take the remainder for the whole transcript.
            Some(Payload::Desync {
                session_id: desynced,
                missed,
            }) => {
                if desynced == session_id {
                    emit(
                        "session.desync",
                        json!({"sessionId": desynced, "missed": missed, "seq": seq}),
                    );
                }
                continue;
            }
            Some(Payload::Event(event)) => event,
        };
        if event.session_id != session_id || event.seq <= seq {
            continue;
        }
        seq = event.seq;
        emit_event(&event);
        match &event.event {
            SessionEvent::TurnCompleted { turn_id, .. } => {
                return Outcome::Completed {
                    turn_id: turn_id.clone(),
                }
            }
            SessionEvent::TurnFailed { turn_id, error } => {
                return Outcome::Failed {
                    turn_id: turn_id.clone(),
                    error: error.clone(),
                }
            }
            SessionEvent::TurnCanceled { turn_id } => {
                return Outcome::Canceled {
                    turn_id: turn_id.clone(),
                }
            }
            SessionEvent::PermissionRequested { request } => {
                if let Some(option) = automatic_answer(request, auto_approve) {
                    let _ = rpc
                        .call(Request::SessionRespondPermission {
                            session_id: session_id.to_string(),
                            request_id: request.id.clone(),
                            outcome: PermissionOutcome::Selected { option_id: option },
                        })
                        .await;
                    continue;
                }
                return Outcome::Waiting(Box::new(request.clone()));
            }
            _ => {}
        }
    }
}

async fn expire(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// What to answer without a person present, or `None` to stop and report.
///
/// Nobody is watching a non-interactive run, so an approval is refused unless
/// the caller opted in for this one invocation. A question is different: it has
/// no refusal, and guessing an answer would put words in the user's mouth, so
/// it always stops (`genet-remote-execution.md` §6.6).
fn automatic_answer(request: &PermissionRequest, auto_approve: bool) -> Option<String> {
    if request.kind != PermissionRequestKind::Permission {
        return None;
    }
    let wanted = if auto_approve {
        PermissionOptionKind::AllowOnce
    } else {
        PermissionOptionKind::Reject
    };
    request
        .options
        .iter()
        .find(|option| option.kind == wanted)
        .map(|option| option.id.clone())
}

fn report(session_id: &str, outcome: Outcome) -> i32 {
    let (status, exit, extra) = match outcome {
        Outcome::Completed { turn_id } => ("completed", EXIT_OK, json!({"turnId": turn_id})),
        Outcome::Failed { turn_id, error } => (
            "failed",
            EXIT_FAILED,
            json!({"turnId": turn_id, "error": error}),
        ),
        Outcome::Canceled { turn_id } => ("canceled", EXIT_FAILED, json!({"turnId": turn_id})),
        Outcome::Waiting(request) => (
            "waiting",
            EXIT_FAILED,
            json!({
                "pendingRequest": request,
                "resume": format!("genet session respond {session_id} --request <id> --choose <optionId>"),
            }),
        ),
        Outcome::Detached => (
            "detached",
            EXIT_FAILED,
            json!({"note": "the session is still running in the daemon"}),
        ),
        Outcome::TimedOut => (
            "timedOut",
            EXIT_FAILED,
            json!({"note": "the session is still running in the daemon"}),
        ),
        Outcome::Disconnected => (
            "disconnected",
            EXIT_UNREACHABLE,
            json!({"note": "the daemon connection closed mid-turn; resubscribe with --since-seq"}),
        ),
    };
    let mut data = json!({"sessionId": session_id, "status": status, "waited": true});
    if let (Some(data), Some(extra)) = (data.as_object_mut(), extra.as_object()) {
        data.extend(extra.clone());
    }
    // A turn that failed is not a CLI failure: the command did exactly what it
    // was asked and observed the outcome. The terminal line therefore stays
    // `session.result`, which has somewhere to put the session and turn ids,
    // and the exit code carries the verdict.
    emit("session.result", data);
    exit
}

async fn wait_interrupt() {
    #[cfg(not(target_family = "wasm"))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    #[cfg(target_family = "wasm")]
    {
        // The native CLI owns the tty. Closing /cli is how a user walks away;
        // the guest has no signal stream of its own.
        std::future::pending::<()>().await;
    }
}

fn emit_event(event: &SequencedEvent) {
    emit(
        "session.event",
        json!({"seq": event.seq, "sessionId": event.session_id, "event": event.event}),
    );
}

fn emit(kind: &str, data: Value) {
    let _ = output::succeed(kind, data);
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::PermissionOption;

    fn words(input: &[&str]) -> Vec<String> {
        input.iter().map(|word| (*word).to_string()).collect()
    }

    fn selection(cwd: Option<&str>) -> Selection {
        Selection {
            machine: None,
            cwd: cwd.map(str::to_string),
        }
    }

    fn run_of(command: Command) -> Run {
        match command {
            Command::Run(run) => *run,
            other => panic!("expected a run, got {other:?}"),
        }
    }

    #[test]
    fn the_sugar_and_the_canonical_form_parse_to_the_same_request() {
        let canonical = run_of(
            parse_agent(
                &words(&["run", "--agent", "codex", "fix the build"]),
                &selection(Some("/srv/app")),
            )
            .unwrap(),
        );
        assert_eq!(canonical.agent_id.as_deref(), Some("codex"));
        assert_eq!(canonical.prompt, "fix the build");
        assert_eq!(canonical.cwd.as_deref(), Some("/srv/app"));
        // Waiting is the default: a caller that wanted fire-and-forget has to
        // say so, because the opposite mistake is silent.
        assert!(canonical.wait);
    }

    #[test]
    fn a_prompt_split_across_words_is_rejoined_rather_than_truncated() {
        let run = run_of(
            parse_agent(
                &words(&["run", "--agent", "codex", "fix", "the", "build"]),
                &selection(Some("/srv/app")),
            )
            .unwrap(),
        );
        assert_eq!(run.prompt, "fix the build");
    }

    #[test]
    fn a_conversation_without_a_prompt_is_a_mistake_not_an_empty_turn() {
        let error =
            parse_agent(&words(&["run", "--agent", "codex"]), &selection(Some("/s"))).unwrap_err();
        assert_eq!(error.code, "invalidArgs");
        assert!(error.message.contains("nothing to say"));
    }

    #[test]
    fn the_two_ways_to_name_a_directory_cannot_both_be_given() {
        let error = parse_agent(
            &words(&["run", "--agent", "codex", "--workspace", "w_1", "hello"]),
            &selection(Some("/srv/app")),
        )
        .unwrap_err();
        assert_eq!(error.code, "invalidArgs");
        assert!(error.message.contains("--workspace"));
    }

    #[test]
    fn session_verbs_keep_their_session_id_and_reject_the_rest() {
        assert_eq!(
            parse_session(&words(&["interrupt", "s_1"]), &selection(None)).unwrap(),
            Command::Interrupt {
                session_id: "s_1".into()
            }
        );
        assert_eq!(
            parse_session(
                &words(&["respond", "s_1", "--request", "r_1", "--choose", "allow"]),
                &selection(None)
            )
            .unwrap(),
            Command::Respond {
                session_id: "s_1".into(),
                request_id: "r_1".into(),
                choose: "allow".into()
            }
        );
        assert_eq!(
            parse_session(
                &words(&["respond", "s_1", "--request", "r_1"]),
                &selection(None)
            )
            .unwrap_err()
            .code,
            "invalidArgs"
        );
        assert_eq!(
            parse_session(&words(&["interrupt"]), &selection(None))
                .unwrap_err()
                .code,
            "invalidArgs"
        );
    }

    #[test]
    fn session_send_continues_the_named_session_rather_than_opening_one() {
        let run =
            run_of(parse_session(&words(&["send", "s_1", "carry on"]), &selection(None)).unwrap());
        assert_eq!(run.session_id.as_deref(), Some("s_1"));
        assert_eq!(run.prompt, "carry on");
        assert_eq!(run.agent_id, None);
    }

    fn request(
        kind: PermissionRequestKind,
        options: &[(&str, PermissionOptionKind)],
    ) -> PermissionRequest {
        PermissionRequest {
            id: "r_1".into(),
            kind,
            title: "write a file".into(),
            detail: None,
            tool_call_id: None,
            options: options
                .iter()
                .map(|(id, kind)| PermissionOption {
                    id: (*id).to_string(),
                    label: (*id).to_string(),
                    kind: *kind,
                })
                .collect(),
            questions: None,
        }
    }

    #[test]
    fn nobody_is_watching_so_an_approval_is_refused_unless_it_was_opted_into() {
        let approval = request(
            PermissionRequestKind::Permission,
            &[
                ("yes", PermissionOptionKind::AllowOnce),
                ("no", PermissionOptionKind::Reject),
            ],
        );
        assert_eq!(automatic_answer(&approval, false).as_deref(), Some("no"));
        assert_eq!(automatic_answer(&approval, true).as_deref(), Some("yes"));
    }

    #[test]
    fn a_question_is_never_answered_on_the_users_behalf() {
        let question = request(
            PermissionRequestKind::Question,
            &[("a", PermissionOptionKind::AllowOnce)],
        );
        assert_eq!(automatic_answer(&question, true), None);
        assert_eq!(automatic_answer(&question, false), None);

        // Nor is a plan, which is a decision rather than a permission.
        let plan = request(
            PermissionRequestKind::PlanApproval,
            &[("go", PermissionOptionKind::AllowOnce)],
        );
        assert_eq!(automatic_answer(&plan, true), None);
    }

    #[test]
    fn an_approval_with_no_refusal_stops_instead_of_picking_something_else() {
        let odd = request(
            PermissionRequestKind::Permission,
            &[("only", PermissionOptionKind::AllowAlways)],
        );
        assert_eq!(automatic_answer(&odd, false), None);
    }

    #[test]
    fn every_terminal_status_maps_to_a_deliberate_exit_code() {
        assert_eq!(
            report(
                "s_1",
                Outcome::Completed {
                    turn_id: "t_1".into()
                }
            ),
            EXIT_OK
        );
        assert_eq!(report("s_1", Outcome::Detached), EXIT_FAILED);
        assert_eq!(report("s_1", Outcome::TimedOut), EXIT_FAILED);
        // A dropped connection is retryable infrastructure, not a verdict on
        // the turn, so it keeps the unreachable code.
        assert_eq!(report("s_1", Outcome::Disconnected), EXIT_UNREACHABLE);
    }
}
