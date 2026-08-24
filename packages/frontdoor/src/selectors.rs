//! The two global selectors: which machine runs a command, and in which
//! directory it runs.
//!
//! Both are parsed once, ahead of dispatch, because both are properties of the
//! call rather than of any single command (`genet-remote-execution.md` §5.1 and
//! §5.5). Neither is ever inferred. There is no remembered machine, no name
//! prefix matching, and `--cwd` never falls back to the caller's process
//! directory — an agent that typed a command in `/tmp` must not have it
//! mysteriously act on `/tmp`.
//!
//! Parsing lives in the front door; the table of which verbs a selector *means*
//! something for stays in the component, where the verbs are. What the front
//! door does know is that its own handful of verbs — daemon lifecycle, status,
//! update, the agent entry — act on this machine's own process and therefore
//! accept neither selector.

use crate::envelope::{CliFailure, EXIT_INVALID_ARGS};

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

/// Refuses both selectors for a verb that acts on this machine's own process.
///
/// The front door's verbs are all of that kind, which is exactly why they stay
/// native: a remote daemon cannot stop the daemon in front of you, and `--cwd`
/// has no meaning for a command that runs nothing. Answered here rather than
/// left to the component's routing table, because these verbs never reach it —
/// a selector silently ignored is the outcome nobody notices.
pub fn refuse_on_local_verb(
    selection: &Selection,
    command: Option<&str>,
) -> Result<(), CliFailure> {
    let Some(command) = command else {
        return Ok(());
    };
    if selection.machine.is_some() {
        return Err(CliFailure {
            code: "commandNotRoutable",
            message: format!(
                "{command} cannot run on another machine: it acts on this machine's own daemon \
                 process, which a remote daemon cannot do for you"
            ),
            retryable: false,
            details: Some(serde_json::json!({"command": command})),
            exit: EXIT_INVALID_ARGS,
        });
    }
    if selection.cwd.is_some() {
        return Err(CliFailure::invalid_args(format!(
            "{command} has no working directory; --cwd applies to commands that run something"
        )));
    }
    Ok(())
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
    fn a_front_door_verb_refuses_a_machine_with_the_frozen_code() {
        let selection = Selection {
            machine: Some("m_1".into()),
            cwd: None,
        };
        for command in ["daemon.stop", "status", "update", "agent-serve"] {
            let error = refuse_on_local_verb(&selection, Some(command)).unwrap_err();
            assert_eq!(error.code, "commandNotRoutable");
            assert_eq!(error.exit, EXIT_INVALID_ARGS);
            assert_eq!(error.details.unwrap()["command"], command);
        }
    }

    #[test]
    fn a_front_door_verb_refuses_a_working_directory_it_would_not_use() {
        let selection = Selection {
            machine: None,
            cwd: Some("/srv/app".into()),
        };
        assert_eq!(
            refuse_on_local_verb(&selection, Some("daemon.start"))
                .unwrap_err()
                .code,
            "invalidArgs"
        );
    }

    #[test]
    fn nothing_is_refused_when_no_selector_was_given() {
        assert!(refuse_on_local_verb(&Selection::default(), Some("daemon.stop")).is_ok());
        // No recognised command means there is no usage error to report yet:
        // the caller prints usage instead of inventing a routing complaint.
        assert!(refuse_on_local_verb(
            &Selection {
                machine: Some("m_1".into()),
                cwd: None
            },
            None
        )
        .is_ok());
    }
}
