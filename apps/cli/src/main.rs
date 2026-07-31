//! genet — the GeneHub CLI, and the daemon it controls.
//!
//! One binary, two shapes (`genethub-cli.md` §2): with no subcommand it is
//! the client; `genet daemon run` is the resident daemon. The client is how
//! an agent inside a session reaches its own machine — query workspaces,
//! drive sessions, manage the daemon — so stdout speaks JSON Lines first and
//! human words go to stderr (`genethub-cli.md` §3.2).

mod control;

/// Exit codes, frozen for scripts and agents (`genethub-cli.md` §3.2).
pub const EXIT_OK: i32 = 0;
pub const EXIT_INVALID_ARGS: i32 = 2;
pub const EXIT_UNREACHABLE: i32 = 3;
pub const EXIT_FAILED: i32 = 4;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Answered before anything touches the disk: "which build is this" is a
    // question asked of a machine that is already misbehaving, and the answer
    // should not depend on a data directory being readable. The release
    // workflow asks it too (`scripts/version.sh --verify`).
    if args
        .iter()
        .any(|argument| argument == "--version" || argument == "-V")
    {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let code = match args.first().map(String::as_str) {
        Some("daemon") => control::daemon(&args[1..]).await,
        Some("status") => control::status(&args[1..]),
        _ => usage(),
    };
    std::process::exit(code);
}

pub fn usage() -> i32 {
    eprintln!(
        "usage:
  genet status                      overview: channel, version, daemon, hub
  genet daemon run                  run the daemon in the foreground (systemd)
  genet daemon start                start the daemon in the background
  genet daemon stop                 stop the daemon (by lock-file pid)
  genet daemon restart              stop + start
  genet daemon status               whether the daemon is running
  genet daemon endpoint             how to connect: wsUrl, port, token
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
        serde_json::json!({"error": {"code": code, "message": message}})
    );
    std::process::exit(exit);
}

/// The one way a command succeeds: a single JSON value on stdout.
pub fn ok(value: serde_json::Value) -> i32 {
    println!("{value}");
    EXIT_OK
}
