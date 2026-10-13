//! Native shell for GeneHub Wasm v2.
//!
//! This binary is the OS entry. It must not grow Session / Agent / Hub /
//! workspace / provider types. `CHANNEL` is compile-time `dev`: no verify.

mod abi;
mod artifact;
mod artifact_cli;
mod bindings;
mod channel;
mod derived;
mod error;
mod file_lock;
mod fs_perms;
mod guest_paths;
mod http_hooks;
mod image_cache;
mod image_preview;
mod isolation;
mod keys;
mod load;
mod process;
mod pty;
mod rtc;
mod store;
mod update;
mod version;

use std::env;
use std::path::PathBuf;

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        // Before anything else, and deliberately before the tokio runtime the
        // guest needs: a process that has started a thread can no longer
        // create a user namespace, so the confinement wrapper has to be the
        // first thing this binary can become
        // (`packages/native/src/confine.rs`).
        //
        // The guest names whichever native front door the shell told it about,
        // and that may be this one, so this one has to answer to it too.
        Some(genet_native::confine::CONFINE_ARG) => {
            let rest: Vec<String> = args.collect();
            std::process::exit(genet_native::confine::confine_and_exec(&rest));
        }
        Some("run") => {
            let (component, entry, guest_args) = parse_run(args).unwrap_or_else(|error| {
                eprintln!("{error}");
                std::process::exit(2);
            });
            if matches!(entry, load::Entry::Daemon) {
                forget_launching_session();
            }
            run_and_exit(&component, &guest_args, entry);
        }
        Some("thumbnail") => {
            if let Err(error) = image_preview::thumbnail_cli(args) {
                eprintln!("error: {error}");
                std::process::exit(1);
            }
        }
        Some(command @ ("pack" | "inspect")) => {
            let mut artifact_args = vec![command.to_string()];
            artifact_args.extend(args);
            if let Err(error) = artifact_cli::run(&artifact_args) {
                eprintln!("error: {error}");
                std::process::exit(1);
            }
        }
        Some("--version" | "-V") => println!("{}", env!("CARGO_PKG_VERSION")),
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    }
}

/// What an Agent session hands each of its own processes. A daemon is often
/// started or restarted from inside one, and everything this process inherits
/// reaches every terminal, remote command and script the daemon starts, which
/// would then speak for a session they are not part of, possibly on another
/// channel's daemon. The daemon sets them again for its own sessions' agents.
const SESSION_SCOPED: &[&str] = &[
    "GENEHUB_SESSION_ID",
    "GENEHUB_CONTROLLER_TOKEN",
    "GENEHUB_EVIDENCE_SCOPE",
    "GENEHUB_SKILLS_DIR",
    "GENET_WORKSPACE_ROOT",
];

/// What *another* Agent exports for the shell it gives its own tools: its HTTP
/// endpoint, its session and request identity, its trace context. The same
/// start-from-inside-a-session case as above, for Agents that are not ours:
/// a daemon started by a CodeBuddy, Claude, Cursor or Codex session keeps all
/// of it, and then hands it to every CLI, terminal and script it starts.
///
/// The endpoint is the one that breaks things. CodeBuddy's `cbc` binds
/// `SERVER__PORT` before it answers anything; the launching `cbc` is still
/// listening there, so every `cbc` this daemon started failed to bind and
/// stayed alive and silent forever (a turn that never ends, no token
/// statistics). Settings a person chose on purpose — the internet environment,
/// API keys, proxies — are not in the list.
///
/// The agent SDK drops the same names before it starts a CLI
/// (`genehub_agent.process.LAUNCHING_AGENT_SESSION`), which also covers a daemon
/// that was started before this one; `launching_agent_session_matches_the_sdk`
/// keeps the two lists equal.
const LAUNCHING_AGENT_SESSION: &[&str] = &[
    "SERVER__PORT",
    "SERVER__HOST",
    "CODEBUDDY_SERVICE_PROXY_URL",
    "CODEBUDDY_SESSION_ID",
    "CODEBUDDY_ROOT_REQUEST_ID",
    "CODEBUDDY_CONVERSATION_REQUEST_ID",
    "CODEBUDDY_CONVERSATION_MESSAGE_ID",
    "CODEBUDDY_ARTIFACTS",
    "CODEBUDDY_PROJECT_DIR",
    "CODEBUDDY_CURRENT_MODEL_ID",
    "CODEBUDDY_SESSION_KIND",
    "CODEBUDDY_SESSION_NAME",
    "CODEBUDDY_SESSION_LOG",
    "CODEBUDDY_OWNER_KEY",
    "CODEBUDDY_TEAMMATE_OWNER_KEY",
    "CODEBUDDY_GATEWAY_AUTH",
    "CLAUDE_SESSION_ID",
    "CLAUDE_PROJECT_DIR",
    "CURSOR_AGENT",
    "CURSOR_CONVERSATION_ID",
    "CURSOR_INVOKED_AS",
    "CURSOR_LAYOUT",
    "__CURSOR_SANDBOX_ENV_RESTORE",
    "CODEX_CI",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "TRACEPARENT",
    "TRACESTATE",
    "BAGGAGE",
];

/// Everything a daemon drops of the session that launched it.
fn forgotten_names() -> impl Iterator<Item = &'static str> {
    SESSION_SCOPED
        .iter()
        .chain(LAUNCHING_AGENT_SESSION)
        .copied()
}

/// Must run while this process still has one thread.
fn forget_launching_session() {
    for name in forgotten_names() {
        env::remove_var(name);
    }
    // The session's front door, too. Whatever this daemon starts should reach
    // this daemon's own CLI, as its launcher named it under the channel's
    // variable — on Stable that variable is this very name.
    match env::var(channel::ENV_CLI)
        .ok()
        .filter(|cli| !cli.is_empty())
    {
        Some(cli) => env::set_var("GENEHUB_CLI", cli),
        None => env::remove_var("GENEHUB_CLI"),
    }
}

fn run_and_exit(component: &std::path::Path, guest_args: &[String], entry: load::Entry) -> ! {
    let code = match load::run_component(component, guest_args, entry) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error:#}");
            if crate::abi::is_pairing_failure(&error) {
                crate::abi::EXIT_PAIRING
            } else {
                4
            }
        }
    };
    // Leave the moment the guest is done. Everything it held — the
    // listener, the single-instance lock — is already released, and a
    // client that just watched the lock drop will look for this pid
    // next. Dropping a Store and a tokio runtime first would keep the
    // process visible for a few hundred milliseconds after it has
    // stopped being the daemon, which on native is not a state that
    // exists: there the lock and the process end together.
    let _ = std::io::Write::flush(&mut std::io::stderr());
    let _ = std::io::Write::flush(&mut std::io::stdout());
    std::process::exit(code);
}

const USAGE: &str = "usage: genehub-host-local run --component <path.wasm> [--entry daemon|agent] [-- <guest args>]\n       genehub-host-local thumbnail --input <image> --output <file> --max-edge <pixels>";

/// Anything after `--` belongs to the guest, which reads it as its own argv.
fn parse_run(
    mut args: impl Iterator<Item = String>,
) -> Result<(PathBuf, load::Entry, Vec<String>), String> {
    let path = match (args.next().as_deref(), args.next()) {
        (Some("--component"), Some(path)) => PathBuf::from(path),
        _ => return Err(USAGE.into()),
    };
    let mut entry = load::Entry::Daemon;
    let guest: Vec<String> = loop {
        match args.next().as_deref() {
            None => break Vec::new(),
            Some("--") => break args.collect(),
            Some("--entry") => {
                entry = match args.next().as_deref() {
                    Some("daemon") => load::Entry::Daemon,
                    Some("agent") => load::Entry::Agent,
                    other => {
                        return Err(format!(
                            "--entry wants daemon or agent, got {}\n{USAGE}",
                            other.unwrap_or("nothing")
                        ))
                    }
                };
            }
            Some(other) => return Err(format!("unexpected argument {other:?}\n{USAGE}")),
        }
    };
    Ok((path, entry, guest))
}

#[cfg(test)]
mod launching_session_tests {
    use super::*;

    #[test]
    fn a_launching_cbcs_endpoint_is_forgotten() {
        // The variable that made every CodeBuddy session of a daemon started
        // from a CodeBuddy session hang (fb_dsnk7EPzireY, fb_6z8pp5UaLaxg).
        let names: Vec<_> = forgotten_names().collect();
        assert!(names.contains(&"SERVER__PORT"));
        assert!(names.contains(&"SERVER__HOST"));
        assert!(names.contains(&"CODEBUDDY_SERVICE_PROXY_URL"));
        assert!(names.contains(&"GENEHUB_SESSION_ID"));
    }

    #[test]
    fn settings_a_person_chose_are_kept() {
        let names: Vec<_> = forgotten_names().collect();
        for kept in [
            "CODEBUDDY_API_KEY",
            "CODEBUDDY_INTERNET_ENVIRONMENT",
            "CODEBUDDY_CONFIG_DIR",
            "ANTHROPIC_API_KEY",
            "CODEX_HOME",
            "HTTPS_PROXY",
            "PATH",
            "HOME",
        ] {
            assert!(
                !names.contains(&kept),
                "{kept} is configuration, not a launching session"
            );
        }
    }

    #[test]
    fn no_name_is_listed_twice() {
        let mut names: Vec<_> = forgotten_names().collect();
        let before = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), before);
    }

    /// The agent SDK drops these before it starts a CLI; a daemon that was
    /// started before this shell knew them still gets that protection only if
    /// the two lists stay the same.
    #[test]
    fn launching_agent_session_matches_the_sdk() {
        let sdk = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../daemon/builtin-agents/sdk/genehub_agent/process.py");
        let source = std::fs::read_to_string(&sdk)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", sdk.display()));
        let after = source
            .split("LAUNCHING_AGENT_SESSION = (")
            .nth(1)
            .expect("the SDK declares LAUNCHING_AGENT_SESSION");
        let body = after.split("\n)").next().expect("the tuple ends");
        let mut sdk_names: Vec<&str> = body
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"')?.split('"').next())
            .collect();
        let mut host_names: Vec<&str> = LAUNCHING_AGENT_SESSION.to_vec();
        sdk_names.sort_unstable();
        host_names.sort_unstable();
        assert_eq!(host_names, sdk_names);
    }
}
