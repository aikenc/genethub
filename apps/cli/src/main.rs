//! genet — the GeneHub CLI, and the daemon it controls.
//!
//! One binary, two shapes (`genethub-cli.md` §2): with no subcommand it is
//! the client; `genet daemon run` is the resident daemon. The client is how
//! an agent inside a session reaches its own machine — query workspaces,
//! drive sessions, manage the daemon — so stdout speaks JSON Lines first and
//! human words go to stderr (`genethub-cli.md` §3.2).

mod control;
mod converse;
mod hub;
mod machine;
mod machines;
mod output;
mod place;
mod query;
mod rpc;
mod shell;
mod target;
mod update;

/// Exit codes, frozen for scripts and agents (`genethub-cli.md` §3.2).
pub const EXIT_OK: i32 = 0;
pub const EXIT_INVALID_ARGS: i32 = 2;
pub const EXIT_UNREACHABLE: i32 = 3;
pub const EXIT_FAILED: i32 = 4;

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

    // Not a subcommand anybody is meant to type: this is the daemon re-running
    // itself to put a process inside an operating system sandbox before
    // becoming it. It parses its own arguments, restricts itself and execs;
    // nothing below this line runs.
    if args.first().map(String::as_str) == Some(genet_daemon::isolation::CONFINE_ARG) {
        std::process::exit(genet_daemon::isolation::confine_and_exec(&args[1..]));
    }

    run(args)
}

#[tokio::main]
async fn run(args: Vec<String>) {
    // Answered before anything touches the disk: "which build is this" is a
    // question asked of a machine that is already misbehaving, and the answer
    // should not depend on a data directory being readable. The release
    // workflow asks it too (`scripts/version.mjs --verify`).
    if args
        .iter()
        .any(|argument| argument == "--version" || argument == "-V")
    {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }

    // The global selectors come off first, so every command sees the same
    // rules about which machine and which directory it runs in, and so a
    // command that has no answer for one of them says so instead of ignoring
    // it (`genet-remote-execution.md` §5.1).
    let (selection, args) = match target::split(&args) {
        Ok(split) => split,
        Err(error) => std::process::exit(output::fail(error)),
    };
    if let Err(error) = target::enforce(&selection, target::canonical(&args).as_deref()) {
        std::process::exit(output::fail(error));
    }

    let code = match args.first().map(String::as_str) {
        Some("schema" | "context" | "capabilities" | "workspace") => {
            query::run(&args, &selection).await
        }
        // Reading and writing the same resource split here, so `query.rs` can
        // keep guaranteeing it never mutates anything.
        Some("session") => match args.get(1).map(String::as_str) {
            Some(
                "list" | "get" | "inspect" | "narrative" | "rounds" | "trunks" | "trunk" | "blob"
                | "context",
            )
            | None => query::run(&args, &selection).await,
            Some(_) => converse::session(&args[1..], &selection).await,
        },
        Some("agent") => converse::agent(&args[1..], &selection).await,
        Some("shell") => shell::shell(&args[1..], &selection).await,
        Some("machine") => machine::machine(&args[1..]).await,
        Some("device") => machine::device(&args[1..], &selection).await,
        Some("daemon") => control::daemon(&args[1..]).await,
        Some("status") => control::status(&args[1..]).await,
        Some("hub") => hub::hub(&args[1..]).await,
        Some("update") => update::update(&args[1..]),
        // Not a subcommand, so it names an agent — but only with something to
        // say, which keeps a plain typo reporting the usage error rather than
        // dialling a daemon (`genet-remote-execution.md` §6.1).
        Some(head) if !head.starts_with('-') && args.len() > 1 => {
            converse::sugar(head, &args[1..], &selection).await
        }
        _ => usage(),
    };
    std::process::exit(code);
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
  genet shell [--workspace <id>] --cwd <dir> -- <command> [args...]
                                    run one command in a workspace and stream
                                    stdout and stderr apart as JSON Lines
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
    println!("{}", output::generic_error_envelope(code, message));
    std::process::exit(exit);
}

/// The one way a command succeeds: a single JSON value on stdout.
pub fn ok(value: serde_json::Value) -> i32 {
    println!("{value}");
    EXIT_OK
}
