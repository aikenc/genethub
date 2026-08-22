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

use std::collections::{BTreeMap, VecDeque};

use genehub_proto::{ShellFrame, ShellRunRequest};
use serde_json::json;

use super::output::{self, CliFailure};
use super::query;
use super::rpc::Rpc;
use super::target::Selection;
use super::{EXIT_FAILED, EXIT_OK};

/// How much of a command's output is repeated here by default.
///
/// There is a reader on the other end of this whose attention is finite and
/// which cannot skim: an agent is handed the whole of what this prints. A
/// build that fails after ten thousand lines of progress bars would spend all
/// of that budget on the progress bars, so what does not fit is dropped from
/// the middle — the beginning says what was run and the end says what went
/// wrong, and it is the middle that is filler.
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024;

/// The most standard input that can be handed over in one request. Matches
/// what the machine will accept, so that too much is refused here with an
/// explanation rather than there as a broken stream.
const MAX_STDIN_BYTES: usize = 1024 * 1024;

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
    env: BTreeMap<String, String>,
    timeout_seconds: Option<u64>,
    /// Zero means all of it.
    max_output_bytes: usize,
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
    let mut env = BTreeMap::new();
    let mut timeout_seconds = None;
    let mut max_output_bytes = DEFAULT_MAX_OUTPUT_BYTES;
    let mut index = 0;
    while index < args.len() {
        let (name, inline) = match args[index].split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (args[index].as_str(), None),
        };
        if !matches!(name, "--workspace" | "--env" | "--timeout" | "--max-output") {
            break;
        }
        let taken = if inline.is_some() { 1 } else { 2 };
        let value = match inline {
            Some(value) => value,
            None => match args.get(index + 1) {
                Some(value) => value.clone(),
                None => return Err(CliFailure::invalid_args(format!("{name} needs a value"))),
            },
        };
        if value.is_empty() {
            return Err(CliFailure::invalid_args(format!("{name} needs a value")));
        }
        match name {
            "--workspace" => {
                if workspace_id.is_some() {
                    return Err(CliFailure::invalid_args(
                        "--workspace may be supplied only once",
                    ));
                }
                workspace_id = Some(value);
            }
            // Repeatable, because setting two variables is the ordinary case
            // and quoting them into one string would make the CLI parse what
            // the shell already parsed.
            "--env" => {
                let Some((key, setting)) = value.split_once('=') else {
                    return Err(CliFailure::invalid_args(
                        "--env takes NAME=VALUE; a bare name would mean passing through this \
                         machine's value, which is not what the command runs with",
                    ));
                };
                if key.is_empty() {
                    return Err(CliFailure::invalid_args("--env needs a name before the ="));
                }
                env.insert(key.to_string(), setting.to_string());
            }
            "--timeout" => {
                let seconds = value.parse::<u64>().ok().filter(|seconds| *seconds > 0);
                let Some(seconds) = seconds else {
                    return Err(CliFailure::invalid_args(
                        "--timeout takes a whole number of seconds greater than zero",
                    ));
                };
                timeout_seconds = Some(seconds);
            }
            "--max-output" => {
                let Ok(bytes) = value.parse::<usize>() else {
                    return Err(CliFailure::invalid_args(
                        "--max-output takes a number of bytes, or 0 for all of it",
                    ));
                };
                max_output_bytes = bytes;
            }
            _ => unreachable!("the name was matched above"),
        }
        index += taken;
    }
    let argv: Vec<String> = args[index..].to_vec();
    if argv.is_empty() {
        return Err(CliFailure::invalid_args(
            "nothing to run; `genet shell -- <command> [args...]`",
        ));
    }
    Ok(Ask {
        workspace_id,
        argv,
        env,
        timeout_seconds,
        max_output_bytes,
    })
}

/// Whatever was piped in, to be handed to the command as its standard input.
///
/// A terminal is not read from: `genet shell -- ls` typed at a prompt must run
/// `ls`, not sit waiting for the person to type the input they did not mean to
/// give it. Everything else — a pipe, a redirected file, an agent's captured
/// handle — is input that was meant.
fn piped_stdin() -> Result<Vec<u8>, CliFailure> {
    let buffer = super::caller_stdin();
    if buffer.len() > MAX_STDIN_BYTES {
        return Err(CliFailure::invalid_args(format!(
            "too much standard input: at most {MAX_STDIN_BYTES} bytes can be sent with a command, \
             so write it to a file in the workspace and have the command read that"
        )));
    }
    Ok(buffer)
}

async fn run(rpc: &Rpc, ask: Ask, selection: &Selection) -> Result<i32, CliFailure> {
    let here = selection.machine.is_none();
    let located =
        super::place::locate(rpc, ask.workspace_id, selection.cwd.as_deref(), here).await?;
    let (workspace_id, cwd) = match located {
        super::place::Located::In { workspace_id, cwd } => (workspace_id, cwd),
        // Deliberately not opening one on the caller's behalf. Registering a
        // workspace is a lasting change to that machine, and it should not be
        // a side effect of running `ls` in the wrong directory.
        super::place::Located::Uncovered(path) => {
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

    let stdin = piped_stdin()?;
    let request = ShellRunRequest {
        workspace_id,
        argv: ask.argv.clone(),
        cwd,
        env: ask.env.clone(),
        timeout_ms: ask.timeout_seconds.map(|seconds| seconds * 1_000),
    };
    let mut running = rpc
        .run_command(&request, stdin)
        .await
        .map_err(query::rpc_error)?;

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

    let mut output = Budget::of(ask.max_output_bytes);
    while let Some(frame) = running.next().await {
        match frame {
            ShellFrame::Stdout { data } => output.take("stdout", data),
            ShellFrame::Stderr { data } => output.take("stderr", data),
            ShellFrame::Exit {
                code,
                signal,
                timed_out,
            } => {
                output.flush();
                output::succeed(
                    "shell.exit",
                    json!({"exitCode": code, "signal": signal, "timedOut": timed_out}),
                );
                // Zero because the command ran, whatever it thought of the
                // result. Its own verdict is in the record above.
                return Ok(EXIT_OK);
            }
        }
    }
    output.flush();
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

/// Prints the beginning of a command's output as it arrives, and holds on to
/// the end in case there turns out to be too much.
///
/// Truncating a stream means deciding what to keep before knowing how much
/// there will be. Keeping the beginning is free — print it and move on. The
/// end cannot be known until it is the end, so once the head is spent
/// everything after it is held back, oldest dropped first, and what survives
/// is printed when the command finishes.
///
/// Chunks are kept whole. A limit is a budget, not a promise, and cutting a
/// chunk in the middle to honour it exactly would mean cutting through a
/// character, a line, or an escape sequence — an overshoot bounded by one
/// chunk costs nothing and reads correctly.
struct Budget {
    head_remaining: usize,
    tail_limit: usize,
    tail: VecDeque<(&'static str, String)>,
    tail_bytes: usize,
    dropped_bytes: usize,
    unlimited: bool,
}

impl Budget {
    fn of(bytes: usize) -> Self {
        Budget {
            // Split evenly: what was run and what it went wrong on are worth
            // the same, and any other ratio would be a guess dressed up as a
            // decision.
            head_remaining: bytes / 2,
            tail_limit: bytes - bytes / 2,
            tail: VecDeque::new(),
            tail_bytes: 0,
            dropped_bytes: 0,
            unlimited: bytes == 0,
        }
    }

    fn take(&mut self, stream: &'static str, data: String) {
        if self.unlimited || self.head_remaining > 0 {
            self.head_remaining = self.head_remaining.saturating_sub(data.len());
            emit(stream, &data);
            return;
        }
        self.tail_bytes += data.len();
        self.tail.push_back((stream, data));
        while self.tail_bytes > self.tail_limit {
            let Some((_, dropped)) = self.tail.pop_front() else {
                break;
            };
            self.tail_bytes -= dropped.len();
            self.dropped_bytes += dropped.len();
        }
    }

    fn flush(&mut self) {
        for record in self.held_back() {
            match record {
                Held::Truncated(dropped) => {
                    output::succeed(
                        "shell.truncated",
                        json!({
                            "droppedBytes": dropped,
                            "reason": "the command produced more output than --max-output \
                                       allows; the beginning and the end are kept",
                        }),
                    );
                }
                Held::Output(stream, data) => emit(stream, &data),
            }
        }
    }

    /// What was kept back, in the order it should be printed: the notice
    /// first, so that a reader meeting the output mid-way knows it is mid-way.
    ///
    /// Separated from the printing so that the decision — which is the part
    /// with a rule in it — can be checked without capturing a process's
    /// standard output.
    fn held_back(&mut self) -> Vec<Held> {
        let mut records = Vec::new();
        if self.dropped_bytes > 0 {
            records.push(Held::Truncated(self.dropped_bytes));
        }
        records.extend(
            std::mem::take(&mut self.tail)
                .into_iter()
                .map(|(stream, data)| Held::Output(stream, data)),
        );
        self.dropped_bytes = 0;
        self.tail_bytes = 0;
        records
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Held {
    Truncated(usize),
    Output(&'static str, String),
}

fn emit(stream: &str, data: &str) {
    output::succeed("shell.output", json!({"stream": stream, "data": data}));
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
    fn the_options_before_the_command_are_read_and_the_command_is_not() {
        let ask = parse(&words(&[
            "--env",
            "CI=1",
            "--env=NO_COLOR=1",
            "--timeout",
            "30",
            "--max-output",
            "4096",
            "cargo",
            "test",
            "--timeout",
            "9",
        ]))
        .unwrap();
        assert_eq!(ask.env.get("CI").map(String::as_str), Some("1"));
        assert_eq!(ask.env.get("NO_COLOR").map(String::as_str), Some("1"));
        assert_eq!(ask.timeout_seconds, Some(30));
        assert_eq!(ask.max_output_bytes, 4096);
        // The command's own `--timeout` is the command's business.
        assert_eq!(ask.argv, words(&["cargo", "test", "--timeout", "9"]));
    }

    #[test]
    fn an_option_that_cannot_mean_what_it_says_is_refused() {
        // Each of these would otherwise become a silently different request:
        // a timeout of zero that never fires, an environment entry with no
        // value, an output limit that is not a number.
        for args in [
            words(&["--timeout", "0", "ls"]),
            words(&["--timeout", "soon", "ls"]),
            words(&["--env", "CI", "ls"]),
            words(&["--env", "=1", "ls"]),
            words(&["--max-output", "lots", "ls"]),
        ] {
            assert_eq!(
                parse(&args).unwrap_err().code,
                "invalidArgs",
                "{args:?} was accepted"
            );
        }
    }

    #[test]
    fn output_past_the_limit_loses_its_middle_and_keeps_its_end() {
        // A failing build says what was run at the beginning and what went
        // wrong at the end; everything between them is progress bars. Keeping
        // the first N bytes alone would throw away the error message, which is
        // the one part anybody wanted.
        // Twenty bytes of head and twenty of tail, in chunks of ten: the first
        // two go out as they arrive, and from then on only the most recent two
        // are still being held.
        let mut budget = Budget::of(40);
        budget.take("stdout", "the-first!".into());
        budget.take("stdout", "the-second".into());
        budget.take("stdout", "filler-one".into());
        budget.take("stdout", "filler-two".into());
        budget.take("stderr", "the-error!".into());

        assert_eq!(
            budget.held_back(),
            vec![
                Held::Truncated(10),
                Held::Output("stdout", "filler-two".into()),
                Held::Output("stderr", "the-error!".into()),
            ],
            "the end of the output was not the part that was kept"
        );
    }

    #[test]
    fn output_within_the_limit_is_not_held_back_or_reordered() {
        let mut budget = Budget::of(DEFAULT_MAX_OUTPUT_BYTES);
        budget.take("stdout", "all of it".into());
        assert!(
            budget.held_back().is_empty(),
            "output that fitted was delayed to the end anyway"
        );
    }

    #[test]
    fn a_limit_of_zero_means_all_of_it() {
        let mut budget = Budget::of(0);
        for _ in 0..100 {
            budget.take("stdout", "x".repeat(1000));
        }
        assert!(
            budget.held_back().is_empty(),
            "output was dropped despite the limit being off"
        );
    }

    #[test]
    fn nothing_to_run_is_a_usage_error_rather_than_an_empty_success() {
        for args in [words(&[]), words(&["--workspace", "w_1"])] {
            let error = parse(&args).unwrap_err();
            assert_eq!(error.code, "invalidArgs");
            assert_eq!(error.exit, crate::cli_front::EXIT_INVALID_ARGS);
        }
        assert_eq!(
            parse(&words(&["--workspace"])).unwrap_err().code,
            "invalidArgs"
        );
    }
}
