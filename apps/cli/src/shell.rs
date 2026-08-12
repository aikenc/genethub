//! Running one command on a machine, from here.
//!
//! The same command means the same thing locally and remotely, which is the
//! property the whole remote surface rests on (`genet-remote-execution.md`
//! §2). So this always goes through a daemon, even without `--machine`: a
//! local shortcut that ran the command in this process would be a second
//! implementation with its own working directory rules, its own idea of which
//! workspace it is in, and its own bugs.
//!
//! Two things about the output are deliberate.
//!
//! **The two streams stay apart.** Every line of stdout and stderr is its own
//! JSON Lines record naming which stream it came from. A caller that has to
//! tell a diagnostic from a result cannot un-merge them afterwards, and this
//! is the difference between this and a terminal.
//!
//! **The exit code of this process is not the exit code of the command.** The
//! CLI's codes are frozen and mean something about the CLI (`genethub-cli.md`
//! §3.2): 4 is "the command could not be run". If a command exiting 4 also
//! produced 4 here, no caller could tell "the build failed" from "the machine
//! refused me". So this exits 0 whenever the command *ran*, and what the
//! command itself returned is in the final record.

use genehub_proto::{ShellFrame, ShellRunRequest};
use serde_json::json;

use crate::output::{self, CliFailure};
use crate::query;
use crate::rpc::Rpc;
use crate::target::Selection;
use crate::{EXIT_FAILED, EXIT_OK};

pub async fn shell(args: &[String], selection: &Selection) -> i32 {
    let request = match parse(args) {
        Ok(request) => request,
        Err(error) => return output::fail(error),
    };
    let rpc = match query::connect_selected(selection).await {
        Ok(rpc) => rpc,
        Err(error) => return output::fail(error),
    };
    match run(&rpc, request, selection).await {
        Ok(code) => code,
        Err(error) => output::fail(error),
    }
}

/// What was asked for, before a workspace has been resolved for it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Ask {
    workspace_id: Option<String>,
    argv: Vec<String>,
}

/// Reads the leading options, then treats everything left as the command.
///
/// Scanning stops at the first token that is not one of ours, so the command
/// keeps its own flags without needing to be quoted: `--machine` and `--cwd`
/// were already taken off by `target::split`, and a bare `--` before the
/// command line makes the boundary explicit when the program name itself could
/// be mistaken for an option.
fn parse(args: &[String]) -> Result<Ask, CliFailure> {
    let mut workspace_id = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--workspace" => {
                let value = args.get(index + 1).filter(|value| !value.is_empty());
                let Some(value) = value else {
                    return Err(CliFailure::invalid_args("--workspace needs a value"));
                };
                if workspace_id.is_some() {
                    return Err(CliFailure::invalid_args(
                        "--workspace may be supplied only once",
                    ));
                }
                workspace_id = Some(value.clone());
                index += 2;
            }
            other => {
                if let Some(value) = other.strip_prefix("--workspace=") {
                    if value.is_empty() {
                        return Err(CliFailure::invalid_args("--workspace needs a value"));
                    }
                    workspace_id = Some(value.to_string());
                    index += 1;
                    continue;
                }
                break;
            }
        }
    }
    let argv: Vec<String> = args[index..].to_vec();
    if argv.is_empty() {
        return Err(CliFailure::invalid_args(
            "nothing to run; `genet shell -- <command> [args...]`",
        ));
    }
    Ok(Ask { workspace_id, argv })
}

async fn run(rpc: &Rpc, ask: Ask, selection: &Selection) -> Result<i32, CliFailure> {
    let here = selection.machine.is_none();
    let located =
        crate::place::locate(rpc, ask.workspace_id, selection.cwd.as_deref(), here).await?;
    let (workspace_id, cwd) = match located {
        crate::place::Located::In { workspace_id, cwd } => (workspace_id, cwd),
        // Deliberately not opening one on the caller's behalf. Registering a
        // workspace is a lasting change to that machine, and it should not be
        // a side effect of running `ls` in the wrong directory.
        crate::place::Located::Uncovered(path) => {
            return Err(CliFailure::business(
                "targetNotFound",
                format!(
                    "no workspace on the machine that answered contains {}; a command runs inside \
                     a workspace, so open it there first or pass --workspace <id>",
                    path.display()
                ),
                json!({"cwd": path.to_string_lossy()}).into(),
            ))
        }
    };

    let request = ShellRunRequest {
        workspace_id,
        argv: ask.argv.clone(),
        cwd,
    };
    let mut running = rpc.run_command(&request).await.map_err(query::rpc_error)?;

    output::succeed(
        "shell.started",
        json!({
            "argv": request.argv,
            "workspace": request.workspace_id,
            "cwd": request.cwd,
            // Ahead of the output rather than alongside the failure, because
            // the failure will not look like one: outside these roots a file
            // is missing, not forbidden, and "missing" is the wrong lesson.
            "confinement": running.confinement,
        }),
    );

    while let Some(frame) = running.next().await {
        match frame {
            ShellFrame::Stdout { data } => {
                output::succeed("shell.output", json!({"stream": "stdout", "data": data}));
            }
            ShellFrame::Stderr { data } => {
                output::succeed("shell.output", json!({"stream": "stderr", "data": data}));
            }
            ShellFrame::Exit { code, signal } => {
                output::succeed("shell.exit", json!({"exitCode": code, "signal": signal}));
                // Zero because the command ran, whatever it thought of the
                // result. Its own verdict is in the record above.
                return Ok(EXIT_OK);
            }
        }
    }
    // The stream ended without the machine saying how the command finished, so
    // it may well still be running over there. Saying "it failed" would be a
    // guess, and saying nothing would be worse.
    Err(CliFailure {
        code: "commandInterrupted",
        message: "the connection ended before the command reported an exit status; it may still \
                  be running on that machine"
            .into(),
        retryable: false,
        details: Some(json!({"argv": request.argv})),
        exit: EXIT_FAILED,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(input: &[&str]) -> Vec<String> {
        input.iter().map(|word| (*word).to_string()).collect()
    }

    #[test]
    fn the_command_keeps_its_own_flags() {
        // `target::split` has already removed `--machine`, `--cwd` and the
        // `--`; what arrives here is the command and nothing else.
        let ask = parse(&words(&["cargo", "test", "--release", "--", "-q"])).unwrap();
        assert_eq!(ask.argv, words(&["cargo", "test", "--release", "--", "-q"]));
        assert_eq!(ask.workspace_id, None);
    }

    #[test]
    fn a_workspace_can_be_named_ahead_of_the_command() {
        for args in [
            words(&["--workspace", "w_1", "ls"]),
            words(&["--workspace=w_1", "ls"]),
        ] {
            let ask = parse(&args).unwrap();
            assert_eq!(ask.workspace_id.as_deref(), Some("w_1"));
            assert_eq!(ask.argv, words(&["ls"]));
        }
    }

    #[test]
    fn an_option_after_the_command_belongs_to_the_command() {
        // Otherwise `genet shell -- git log --workspace` would quietly become a
        // different request than the one that was typed.
        let ask = parse(&words(&["git", "log", "--workspace", "w_1"])).unwrap();
        assert_eq!(ask.workspace_id, None);
        assert_eq!(ask.argv, words(&["git", "log", "--workspace", "w_1"]));
    }

    #[test]
    fn nothing_to_run_is_a_usage_error_rather_than_an_empty_success() {
        for args in [words(&[]), words(&["--workspace", "w_1"])] {
            let error = parse(&args).unwrap_err();
            assert_eq!(error.code, "invalidArgs");
            assert_eq!(error.exit, crate::EXIT_INVALID_ARGS);
        }
        assert_eq!(
            parse(&words(&["--workspace"])).unwrap_err().code,
            "invalidArgs"
        );
    }
}
