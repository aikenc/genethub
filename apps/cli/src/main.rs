//! genet — the GeneHub CLI.
//!
//! The native binary keeps only what cannot live in the guest: version,
//! confine, daemon lifecycle, `agent-serve`, and update of this binary.
//! Every product verb is forwarded to the running daemon over loopback
//! `POST /cli`. See `docs/cli-thin-forwarder.md`.

mod control;
mod invoke;
mod wasm;

use genet_daemon::cli_front::{output, target};

/// Exit codes, frozen for scripts and agents (`genethub-cli.md` §3.2).
pub const EXIT_OK: i32 = 0;
pub const EXIT_INVALID_ARGS: i32 = 2;
pub const EXIT_UNREACHABLE: i32 = 3;
pub const EXIT_FAILED: i32 = 4;

const FORWARDED: &[&str] = &[
    "schema",
    "context",
    "capabilities",
    "workspace",
    "session",
    "agent",
    "shell",
    "speech",
    "process",
    "machine",
    "device",
    "hub",
    "desktop",
];

/// Deliberately not the async entry point, and deliberately doing one thing
/// before the runtime exists.
///
/// The confinement wrapper has to run in a process that has never started a
/// thread: creating a user namespace is refused outright for a multi-threaded
/// caller, so the same code that works here fails with `EINVAL` if it is moved
/// a few lines down into `#[tokio::main]`, where the worker pool is already up
/// (`apps/daemon/src/isolation.rs`).
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.first().map(String::as_str) == Some(genet_daemon::isolation::CONFINE_ARG) {
        std::process::exit(genet_daemon::isolation::confine_and_exec(&args[1..]));
    }

    run(args)
}

#[tokio::main]
async fn run(args: Vec<String>) {
    if args
        .iter()
        .any(|argument| argument == "--version" || argument == "-V")
    {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let code = match args.first().map(String::as_str) {
        Some("daemon") => {
            let rest = match native_rest(&args) {
                Ok(rest) => rest,
                Err(code) => std::process::exit(code),
            };
            control::daemon(&rest[1..]).await
        }
        Some("status") => {
            let rest = match native_rest(&args) {
                Ok(rest) => rest,
                Err(code) => std::process::exit(code),
            };
            control::status(&rest[1..]).await
        }
        Some("agent-serve") => {
            let rest = match native_rest(&args) {
                Ok(rest) => rest,
                Err(code) => std::process::exit(code),
            };
            crate::wasm::become_agent(&rest[1..])
        }
        Some("update") => {
            let rest = match native_rest(&args) {
                Ok(rest) => rest,
                Err(code) => std::process::exit(code),
            };
            update(&rest[1..])
        }
        Some(head) if should_forward(head, &args) => invoke::forward(args).await,
        _ => usage(),
    };
    std::process::exit(code);
}

fn should_forward(head: &str, args: &[String]) -> bool {
    head == "--machine"
        || head == "--cwd"
        || FORWARDED.contains(&head)
        || (!head.starts_with('-') && args.len() > 1)
}

fn native_rest(args: &[String]) -> Result<Vec<String>, i32> {
    let (selection, rest) = target::split(args).map_err(output::fail)?;
    target::enforce(&selection, target::canonical(&rest).as_deref()).map_err(output::fail)?;
    Ok(rest)
}

fn update(args: &[String]) -> i32 {
    if !args.is_empty() {
        return usage();
    }
    fail(
        "unsupported",
        "automatic update is disabled until releases have an independent signing key; download manually from https://github.com/aikenc/genethub/releases and verify SHA256SUMS",
        EXIT_FAILED,
    );
}

pub fn usage() -> i32 {
    eprintln!(
        "usage:
  genet status                      overview: channel, version, daemon, hub
  genet schema [command]            static CLI input/output schemas
  genet context                     explicit local-daemon execution context
  genet capabilities                static read-only capability surface
  genet workspace list              list local daemon workspaces
  genet workspace show <id>         show one workspace by exact id
  genet session list [--workspace <id>]
                                    list local daemon sessions
  genet session get <id>            get one session snapshot
  genet session inspect <id>        inspect session structure and coverage
  genet session narrative <id>      read a bounded narrative page
  genet session rounds <id>         read a bounded round-summary page
  genet session trunks <id> --round <round-id>
                                    list bounded work trunks for one round
  genet session trunk <id> --round <round-id> --index <n>
                                    read one work trunk and opaque blob refs
  genet session blob <id> --ref <opaque-ref>
                                    resolve one blob ref
  genet session context <id>        build bounded, cited context without an LLM
  genet agent list                  agents installed on this machine
  genet agent run --agent <id> \"<prompt>\" [--cwd <dir> | --workspace <id>]
                                    start a session and stream it as JSON Lines
  genet <agentId> \"<prompt>\" [...]   the same thing, spelled shorter
  genet shell [--workspace <id>] --cwd <dir> [--env NAME=VALUE]... [--timeout <s>]
              [--max-output <bytes>] -- <command> [args...]
                                    run one command in a workspace and stream
                                    stdout and stderr apart as JSON Lines;
                                    anything piped in becomes its stdin
  genet process list                what the agents there left running
  genet process kill <pid> [--session <id>]
                                    end one of them, and what it started
  genet process kill-all --session <id>
                                    end everything one conversation left
  genet speech runtime status      inspect the registered local speech adapter
  genet speech runtime probe       actively check the registered adapter
  genet speech runtime register --command <absolute-path> [--arg <value>...]
                                    probe and register a community adapter
  genet speech runtime unregister  remove the adapter registration only
  genet session send <id> \"<text>\"  continue a session
  genet session respond <id> --request <rid> --choose <optionId>
                                    answer what a waiting session asked
  genet session interrupt <id>      stop the running turn
  genet session close <id>          close the session
  genet machine list                machines this installation can reach
  genet machine pair <code> --endpoint <url> [--name <label>]
                                    redeem a pairing code from another machine
  genet machine show <machineId>    one paired machine
  genet machine forget <machineId>  drop the local credential for a machine
  genet device list                 clients authorized on the target machine
  genet device invite [--grant read,session,files,git,pty,devices,settings,update]
                                    mint a pairing code; no --grant means no limits
  genet device revoke <deviceId>    withdraw one client's authorization
  genet <any of the above> --machine <machineId>
                                    run it on a paired machine instead
  genet update                      unsupported until releases are independently signed
  genet daemon run                  run the daemon in the foreground (systemd)
  genet daemon start                start the daemon in the background
  genet daemon stop                 stop the daemon (by lock-file pid)
  genet daemon restart              stop + start
  genet daemon status               whether the daemon is running
  genet daemon endpoint             one-use local wsUrl and process facts
  genet hub status                  Hub pairing state
  genet hub login [--hub <url>] [--name <display>] [--wait]
                                    enroll with the Hub; print a browser URL
  genet hub link                    mint a claim link for another device
  genet hub unpair                  drop Hub enrollment
  genet --version                   print the version"
    );
    fail(
        "invalid_args",
        "no or unknown command; usage is on stderr",
        EXIT_INVALID_ARGS,
    );
}

/// The one way a command fails: human words on stderr, the machine-readable
/// error on stdout, and an exit code from the frozen set.
pub fn fail(code: &str, message: &str, exit: i32) -> ! {
    eprintln!("error: {message}");
    println!(
        "{}",
        serde_json::json!({
            "schema": "genet.cli/v1",
            "type": "error",
            "error": {
                "code": code,
                "message": message,
                "retryable": false,
                "details": null,
            }
        })
    );
    std::process::exit(exit);
}

/// The one way a command succeeds: a single JSON value on stdout.
pub fn ok(value: serde_json::Value) -> i32 {
    println!("{value}");
    EXIT_OK
}
