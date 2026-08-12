//! The two global selectors: which machine runs a command, and in which
//! directory it runs.
//!
//! Both are parsed once, ahead of dispatch, because both are properties of the
//! call rather than of any single command (`genet-remote-execution.md` §5.1 and
//! §5.5). Neither is ever inferred. There is no remembered machine, no name
//! prefix matching, and `--cwd` never falls back to the caller's process
//! directory — an agent that typed a command in `/tmp` must not have it
//! mysteriously act on `/tmp`.

use crate::output::CliFailure;

/// Whether a command means the same thing when aimed at another machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Routing {
    /// Same meaning locally and remotely.
    Routable,
    /// Acts on this process or on this machine's daemon lifecycle, so it has
    /// no remote meaning at all.
    LocalOnly,
    /// Answered from the binary itself, without reaching any daemon.
    Static,
}

/// Subcommand names the CLI owns. A token in this list is never treated as an
/// agent id, so `genet session list` cannot change meaning because someone
/// installed an agent called `session` (`genet-remote-execution.md` §6.1).
///
/// `machine`, `device` and `shell` are reserved before they are implemented,
/// which is the point: reserving them later would be a breaking change for
/// anyone who had shipped an agent under one of those names.
pub const RESERVED: [&str; 13] = [
    "schema",
    "context",
    "capabilities",
    "workspace",
    "session",
    "agent",
    "machine",
    "device",
    "daemon",
    "hub",
    "status",
    "update",
    "shell",
];

const ROUTABLE: [&str; 21] = [
    "context",
    "workspace.list",
    "workspace.show",
    "session.list",
    "session.get",
    "session.inspect",
    "session.narrative",
    "session.rounds",
    "session.trunks",
    "session.trunk",
    "session.blob",
    "session.context",
    "session.send",
    "session.respond",
    "session.interrupt",
    "session.close",
    "agent.list",
    "agent.run",
    "device.list",
    "device.invite",
    "device.revoke",
];

const STATIC: [&str; 2] = ["schema", "capabilities"];

/// Commands that carry a working directory. Everything else rejects `--cwd`
/// rather than accepting and ignoring it.
const TAKES_CWD: [&str; 1] = ["agent.run"];

pub fn routing(command: &str) -> Routing {
    if STATIC.contains(&command) {
        Routing::Static
    } else if ROUTABLE.contains(&command) {
        Routing::Routable
    } else {
        Routing::LocalOnly
    }
}

pub fn accepts_cwd(command: &str) -> bool {
    TAKES_CWD.contains(&command)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Selection {
    pub machine: Option<String>,
    pub cwd: Option<String>,
}

/// Pulls the global selectors out of the argument list and returns the rest in
/// order.
///
/// A bare `--` ends flag scanning and is dropped, so a prompt or a future
/// `genet shell` command line can contain anything without being reinterpreted.
pub fn split(args: &[String]) -> Result<(Selection, Vec<String>), CliFailure> {
    let mut selection = Selection::default();
    let mut rest = Vec::with_capacity(args.len());
    let mut index = 0;
    while index < args.len() {
        let argument = args[index].as_str();
        if argument == "--" {
            rest.extend(args[index + 1..].iter().cloned());
            break;
        }
        if let Some(value) = flag_value(args, &mut index, "--machine")? {
            assign(&mut selection.machine, value, "--machine")?;
            index += 1;
            continue;
        }
        if let Some(value) = flag_value(args, &mut index, "--cwd")? {
            assign(&mut selection.cwd, value, "--cwd")?;
            index += 1;
            continue;
        }
        if argument == "--device" || argument.starts_with("--device=") {
            return Err(CliFailure::invalid_args(
                "--device selects a client that may connect to this machine, not an execution \
                 target; use --machine <machineId> and `genet machine list` to see paired \
                 machines",
            ));
        }
        rest.push(args[index].clone());
        index += 1;
    }
    Ok((selection, rest))
}

/// Reads `--flag value` or `--flag=value`, advancing past a detached value.
fn flag_value(
    args: &[String],
    index: &mut usize,
    flag: &str,
) -> Result<Option<String>, CliFailure> {
    let argument = args[*index].as_str();
    let value = if argument == flag {
        let value = args.get(*index + 1).ok_or_else(|| {
            CliFailure::invalid_args(format!("{flag} needs a value; none followed it"))
        })?;
        if value.starts_with('-') {
            return Err(CliFailure::invalid_args(format!(
                "{flag} needs a value; {value} looks like another flag"
            )));
        }
        *index += 1;
        value.clone()
    } else if let Some(inline) = argument.strip_prefix(&format!("{flag}=")) {
        inline.to_string()
    } else {
        return Ok(None);
    };
    if value.trim().is_empty() {
        return Err(CliFailure::invalid_args(format!(
            "{flag} needs a non-empty value"
        )));
    }
    Ok(Some(value))
}

fn assign(slot: &mut Option<String>, value: String, flag: &str) -> Result<(), CliFailure> {
    if slot.is_some() {
        return Err(CliFailure::invalid_args(format!(
            "{flag} may be supplied only once"
        )));
    }
    *slot = Some(value);
    Ok(())
}

/// The canonical dotted name for an argument list, used to look up routing and
/// to name the command in errors.
///
/// A first token that is neither reserved nor a flag is an agent id, but only
/// when something follows it — `genet <agentId>` with nothing to say is a
/// mistake, not a conversation, and it keeps a plain typo reporting the usage
/// error instead of dialling the daemon.
pub fn canonical(args: &[String]) -> Option<String> {
    let first = args.first()?.as_str();
    if first.starts_with('-') {
        return None;
    }
    let verb = args.get(1).map(String::as_str);
    if !RESERVED.contains(&first) {
        return args.get(1).map(|_| "agent.run".to_string());
    }
    match (first, verb) {
        ("schema" | "context" | "capabilities" | "status" | "update", _) => Some(first.to_string()),
        (_, Some(verb)) if !verb.starts_with('-') => Some(format!("{first}.{verb}")),
        _ => None,
    }
}

/// The one place that decides what a selector means for a command it does not
/// apply to. Keeping it central is why the classification cannot drift into
/// scattered `if` statements.
pub fn enforce(selection: &Selection, command: Option<&str>) -> Result<(), CliFailure> {
    let Some(command) = command else {
        return Ok(());
    };
    if selection.machine.is_some() {
        match routing(command) {
            Routing::Static => {
                return Err(not_routable(
                    command,
                    "it is answered by this binary and never reaches a daemon",
                ))
            }
            Routing::LocalOnly => {
                return Err(not_routable(
                    command,
                    "it acts on this machine's own daemon process, which a remote daemon cannot \
                     do for you",
                ))
            }
            // Routed for real. Dispatch resolves the machine through
            // `query::connect_selected`, which is the single place a selector
            // turns into a different socket.
            Routing::Routable => {}
        }
    }
    if selection.cwd.is_some() && !accepts_cwd(command) {
        return Err(CliFailure::invalid_args(format!(
            "{command} has no working directory; --cwd applies to commands that run something"
        )));
    }
    Ok(())
}

fn not_routable(command: &str, why: &str) -> CliFailure {
    CliFailure {
        code: "commandNotRoutable",
        message: format!("{command} cannot run on another machine: {why}"),
        retryable: false,
        details: Some(serde_json::json!({"command": command})),
        exit: crate::EXIT_INVALID_ARGS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(input: &[&str]) -> Vec<String> {
        input.iter().map(|word| (*word).to_string()).collect()
    }

    #[test]
    fn selectors_are_pulled_out_wherever_they_appear() {
        let (selection, rest) = split(&words(&[
            "session",
            "list",
            "--machine",
            "m_1",
            "--workspace",
            "w_1",
        ]))
        .unwrap();
        assert_eq!(selection.machine.as_deref(), Some("m_1"));
        assert_eq!(rest, words(&["session", "list", "--workspace", "w_1"]));

        let (inline, rest) =
            split(&words(&["context", "--machine=m_2", "--cwd=/srv/app"])).unwrap();
        assert_eq!(inline.machine.as_deref(), Some("m_2"));
        assert_eq!(inline.cwd.as_deref(), Some("/srv/app"));
        assert_eq!(rest, words(&["context"]));
    }

    #[test]
    fn a_double_dash_stops_flag_scanning_so_a_prompt_can_say_anything() {
        let (selection, rest) = split(&words(&[
            "codex",
            "--",
            "explain",
            "--machine",
            "in",
            "git",
        ]))
        .unwrap();
        assert_eq!(selection.machine, None);
        assert_eq!(rest, words(&["codex", "explain", "--machine", "in", "git"]));
    }

    #[test]
    fn malformed_selectors_fail_instead_of_being_guessed() {
        for args in [
            words(&["context", "--machine"]),
            words(&["context", "--machine", "--cwd"]),
            words(&["context", "--machine="]),
            words(&["context", "--machine", "m_1", "--machine", "m_2"]),
            words(&["context", "--cwd", ""]),
        ] {
            assert_eq!(split(&args).unwrap_err().code, "invalidArgs", "{args:?}");
        }
    }

    #[test]
    fn the_device_flag_points_at_the_machine_flag_rather_than_selecting_anything() {
        let error = split(&words(&["session", "list", "--device", "node-a"])).unwrap_err();
        assert_eq!(error.code, "invalidArgs");
        assert!(error.message.contains("--machine"));
        assert!(split(&words(&["session", "list", "--device=node-a"])).is_err());
    }

    #[test]
    fn canonical_names_cover_the_surface_and_treat_unreserved_heads_as_agents() {
        assert_eq!(canonical(&words(&["schema"])).as_deref(), Some("schema"));
        assert_eq!(
            canonical(&words(&["workspace", "list"])).as_deref(),
            Some("workspace.list")
        );
        assert_eq!(
            canonical(&words(&["daemon", "stop"])).as_deref(),
            Some("daemon.stop")
        );
        assert_eq!(
            canonical(&words(&["codex", "fix the build"])).as_deref(),
            Some("agent.run")
        );
        // A bare unknown token stays a usage error rather than becoming a call
        // to an agent nobody named.
        assert_eq!(canonical(&words(&["unknown-command"])), None);
        assert_eq!(canonical(&words(&["--version"])), None);
    }

    #[test]
    fn a_reserved_name_wins_over_an_agent_that_shares_it() {
        // Even with a prompt-shaped tail, `session` is the subcommand.
        assert_eq!(
            canonical(&words(&["session", "list"])).as_deref(),
            Some("session.list")
        );
        assert!(RESERVED.contains(&"shell"));
    }

    #[test]
    fn local_only_and_static_commands_refuse_a_machine_with_a_stable_code() {
        let selection = Selection {
            machine: Some("m_1".into()),
            cwd: None,
        };
        for command in ["daemon.stop", "update", "status"] {
            let error = enforce(&selection, Some(command)).unwrap_err();
            assert_eq!(error.code, "commandNotRoutable");
            assert_eq!(error.exit, crate::EXIT_INVALID_ARGS);
            assert_eq!(error.details.unwrap()["command"], command);
        }
        let statically_answered = enforce(&selection, Some("schema")).unwrap_err();
        assert_eq!(statically_answered.code, "commandNotRoutable");
    }

    #[test]
    fn a_routable_command_accepts_a_machine_and_leaves_resolving_it_to_dispatch() {
        let selection = Selection {
            machine: Some("m_1".into()),
            cwd: None,
        };
        for command in ["session.list", "agent.run", "device.list", "context"] {
            assert!(
                enforce(&selection, Some(command)).is_ok(),
                "{command} refused a machine it can be routed to"
            );
        }
        // Pairing is about this installation's own credential store, so it has
        // no meaning aimed elsewhere — asking machine A to pair with machine B
        // would store the credential on the wrong one.
        assert_eq!(
            enforce(&selection, Some("machine.pair")).unwrap_err().code,
            "commandNotRoutable"
        );
    }

    #[test]
    fn cwd_is_refused_by_commands_that_do_not_run_anything() {
        let selection = Selection {
            machine: None,
            cwd: Some("/srv/app".into()),
        };
        assert_eq!(
            enforce(&selection, Some("workspace.list"))
                .unwrap_err()
                .code,
            "invalidArgs"
        );
        assert!(enforce(&selection, Some("agent.run")).is_ok());
    }
}
