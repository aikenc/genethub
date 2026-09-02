//! Verb implementations that used to live in the native `genet` binary.
//!
//! The native CLI now forwards argv here through loopback `POST /cli`.
//! See `docs/cli-thin-forwarder.md`.

mod converse;
mod desktop;
mod hub;
mod machine;
mod machines;
pub mod output;
mod place;
mod process;
mod query;
mod rpc;
// The local CLI now calls the router in-process. Keep the loopback dialer in
// the shared wire client for native compatibility without treating that
// intentionally dormant entry point as a release-blocking lint.
#[allow(dead_code)]
mod rpc_wire;
mod shell;
mod speech;
pub mod target;
mod update;
mod workflow;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc;

use crate::authz::Principal;
use crate::state::Shared;

// Frozen for scripts and agents, and shared with the native front door: a verb
// that runs here and a verb that stays on the CLI must not disagree about what
// exit 3 means (`genethub-cli.md` §3.2).
pub use genet_frontdoor::envelope::{EXIT_FAILED, EXIT_INVALID_ARGS, EXIT_OK, EXIT_UNREACHABLE};

tokio::task_local! {
    static LOCAL_STATE: Shared;
    static CALLER_CWD: PathBuf;
    static CALLER_STDIN: Vec<u8>;
    static CALLER_PRINCIPAL: Principal;
    static CLI_IO: CliIo;
}

#[derive(Clone)]
struct CliIo {
    sink: mpsc::UnboundedSender<CliRecord>,
}

pub struct Invocation {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub stdin: Vec<u8>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CliRecord {
    Stdout { line: String },
    Stderr { text: String },
    Exit { code: i32 },
}

/// Runs one CLI invocation against this daemon. Never calls `process::exit`.
///
/// Records are pushed on `sink` as the verb prints, so a long `agent run`
/// reaches the native CLI while it is still happening.
pub async fn invoke(
    state: Shared,
    principal: Principal,
    invocation: Invocation,
    sink: mpsc::UnboundedSender<CliRecord>,
) {
    // This is one ordered NDJSON stream. An earlier two-pump design waited
    // for task-local senders to be destroyed before emitting Exit; under the
    // Wasm host that made an Agent's CLI process hang after dispatch returned.
    let io = CliIo { sink: sink.clone() };
    let code = tokio::spawn(CALLER_PRINCIPAL.scope(
        principal,
        LOCAL_STATE.scope(
            state,
            CALLER_CWD.scope(
                invocation.cwd,
                CALLER_STDIN.scope(
                    invocation.stdin,
                    CLI_IO.scope(io, dispatch(invocation.argv)),
                ),
            ),
        ),
    ))
    .await
    .unwrap_or(EXIT_FAILED);
    let _ = sink.send(CliRecord::Exit { code });
}

pub(crate) fn local_state() -> Result<Shared, String> {
    LOCAL_STATE
        .try_with(Arc::clone)
        .map_err(|_| "cli front has no daemon state".to_string())
}

pub(crate) fn caller_cwd() -> PathBuf {
    CALLER_CWD
        .try_with(Clone::clone)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

pub(crate) fn caller_stdin() -> Vec<u8> {
    CALLER_STDIN.try_with(Clone::clone).unwrap_or_default()
}

pub(crate) fn caller_principal() -> Principal {
    CALLER_PRINCIPAL
        .try_with(Clone::clone)
        .unwrap_or(Principal::LocalUser)
}

pub fn emit_stdout(line: impl AsRef<str>) {
    let line = line.as_ref().to_string();
    if CLI_IO
        .try_with(|io| {
            let _ = io.sink.send(CliRecord::Stdout { line: line.clone() });
        })
        .is_err()
    {
        println!("{line}");
    }
}

pub fn emit_stderr(text: impl AsRef<str>) {
    let text = text.as_ref().to_string();
    if CLI_IO
        .try_with(|io| {
            let _ = io.sink.send(CliRecord::Stderr { text: text.clone() });
        })
        .is_err()
    {
        eprint!("{text}");
        if !text.ends_with('\n') {
            eprintln!();
        }
    }
}

pub fn fail(code: &str, message: &str, exit: i32) -> i32 {
    emit_stderr(format!("error: {message}"));
    emit_stdout(output::generic_error_envelope(code, message).to_string());
    exit
}

pub fn ok(value: Value) -> i32 {
    emit_stdout(value.to_string());
    EXIT_OK
}

pub fn usage() -> i32 {
    emit_stderr(
        "usage: genet <command> … ; run `genet` with no arguments on the native CLI for the full list",
    );
    fail(
        "invalid_args",
        "no or unknown command; usage is on stderr",
        EXIT_INVALID_ARGS,
    )
}

async fn dispatch(args: Vec<String>) -> i32 {
    let (selection, args) = match target::split(&args) {
        Ok(split) => split,
        Err(error) => return output::fail(error),
    };
    if let Err(error) = target::enforce(&selection, target::canonical(&args).as_deref()) {
        return output::fail(error);
    }
    match args.first().map(String::as_str) {
        Some("schema" | "context" | "capabilities" | "workspace") => {
            Box::pin(query::run(&args, &selection)).await
        }
        Some("session") => match args.get(1).map(String::as_str) {
            Some(
                "list" | "get" | "inspect" | "narrative" | "rounds" | "trunks" | "trunk" | "blob"
                | "context",
            )
            | None => Box::pin(query::run(&args, &selection)).await,
            Some(_) => Box::pin(converse::session(&args[1..], &selection)).await,
        },
        Some("agent") => Box::pin(converse::agent(&args[1..], &selection)).await,
        Some("shell") => Box::pin(shell::shell(&args[1..], &selection)).await,
        Some("speech") => Box::pin(speech::speech(&args[1..], &selection)).await,
        Some("workflow") => Box::pin(workflow::workflow(&args[1..], &selection)).await,
        Some("process") => Box::pin(process::process(&args[1..], &selection)).await,
        Some("machine") => Box::pin(machine::machine(&args[1..])).await,
        Some("device") => Box::pin(machine::device(&args[1..], &selection)).await,
        Some("hub") => Box::pin(hub::hub(&args[1..])).await,
        Some("desktop") => Box::pin(desktop::desktop(&args[1..])).await,
        Some("update") => update::update(&args[1..]),
        Some("status" | "daemon" | "agent-serve") => fail(
            "invalid_args",
            "this verb stays on the native CLI and is not forwarded",
            EXIT_INVALID_ARGS,
        ),
        Some(head) if !head.starts_with('-') && args.len() > 1 => {
            Box::pin(converse::sugar(head, &args[1..], &selection)).await
        }
        _ => usage(),
    }
}
