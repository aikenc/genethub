//! What the agents on a machine left running, from here.
//!
//! The workbench shows this in a panel, which is the right place for a person
//! and the wrong place for everyone else: a machine reached over `--machine`
//! has no workbench in front of anybody, and the caller most likely to have
//! left a dev server running is an agent, which cannot click. So the same
//! three questions — what is running, end this one, end them all — are asked
//! here too.
//!
//! Ownership is not decided here. The daemon will only end a process the named
//! session is currently answerable for, and passing a pid it does not
//! recognise is refused rather than obeyed. What this adds is the convenience
//! of not having to name the session: a pid is looked up in the list first, so
//! that `genet process kill 4123` works from what the previous command
//! printed.

use genehub_proto::{Reply, Request};
use serde_json::json;

use super::output::{self, CliFailure};
use super::query;
use super::rpc::Rpc;
use super::target::Selection;

pub async fn process(args: &[String], selection: &Selection) -> i32 {
    let verb = args.first().cloned().unwrap_or_else(|| "list".into());
    let outcome = match verb.as_str() {
        "list" => list(selection).await,
        "kill" => kill(&args[1..], selection).await,
        "kill-all" => kill_all(&args[1..], selection).await,
        other => Err(CliFailure::invalid_args(format!(
            "`process {other}` is not a command; expected one of list, kill, kill-all"
        ))),
    };
    match outcome {
        Ok(value) => output::succeed(&format!("process.{verb}"), value),
        Err(error) => output::fail(error),
    }
}

async fn list(selection: &Selection) -> Result<serde_json::Value, CliFailure> {
    let rpc = query::connect_selected(selection).await?;
    Ok(json!({"processes": running(&rpc).await?}))
}

async fn running(rpc: &Rpc) -> Result<Vec<genehub_proto::BackgroundProcess>, CliFailure> {
    match rpc.call(Request::ProcessList).await {
        Ok(Reply::Processes(processes)) => Ok(processes),
        Ok(other) => Err(unexpected(&other)),
        Err(error) => Err(query::rpc_error(error)),
    }
}

async fn kill(args: &[String], selection: &Selection) -> Result<serde_json::Value, CliFailure> {
    let (pid, session_id) = kill_arguments(args)?;
    let rpc = query::connect_selected(selection).await?;
    let session_id = match session_id {
        Some(session_id) => session_id,
        // Looked up rather than demanded. The pid came from a list that said
        // which session it belonged to, and making the caller repeat that back
        // would be asking them to carry something we already know.
        None => {
            let processes = running(&rpc).await?;
            let found = processes.iter().find(|process| process.pid == pid);
            let Some(found) = found else {
                return Err(CliFailure::business(
                    "targetNotFound",
                    format!(
                        "no process {pid} is running for any session on that machine; it may have \
                         finished already"
                    ),
                    json!({"pid": pid}).into(),
                ));
            };
            found.session_id.clone()
        }
    };
    match rpc
        .call(Request::ProcessKill {
            session_id: session_id.clone(),
            pid,
        })
        .await
    {
        Ok(Reply::Ack) => Ok(json!({"pid": pid, "sessionId": session_id})),
        Ok(other) => Err(unexpected(&other)),
        Err(error) => Err(query::rpc_error(error)),
    }
}

async fn kill_all(args: &[String], selection: &Selection) -> Result<serde_json::Value, CliFailure> {
    let mut session_id = None;
    let mut index = 0;
    while index < args.len() {
        let (name, value) = match args[index].split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (args[index].as_str(), None),
        };
        if name != "--session" {
            return Err(CliFailure::invalid_args(format!(
                "`process kill-all` does not take {name}"
            )));
        }
        let taken = if value.is_some() { 1 } else { 2 };
        let value = match value {
            Some(value) => value,
            None => match args.get(index + 1) {
                Some(value) => value.clone(),
                None => return Err(CliFailure::invalid_args("--session needs a value")),
            },
        };
        if value.is_empty() {
            return Err(CliFailure::invalid_args("--session needs a value"));
        }
        session_id = Some(value);
        index += taken;
    }
    // Required, unlike for `kill`. There is nothing to look it up from, and
    // "end everything on this machine" is not a thing to let somebody ask for
    // by leaving an argument out.
    let Some(session_id) = session_id else {
        return Err(CliFailure::invalid_args(
            "`process kill-all` needs --session <id>; it ends what one conversation left running, \
             not everything on the machine",
        ));
    };
    let rpc = query::connect_selected(selection).await?;
    match rpc
        .call(Request::ProcessKillAll {
            session_id: session_id.clone(),
        })
        .await
    {
        Ok(Reply::Ack) => Ok(json!({"sessionId": session_id})),
        Ok(other) => Err(unexpected(&other)),
        Err(error) => Err(query::rpc_error(error)),
    }
}

fn kill_arguments(args: &[String]) -> Result<(u32, Option<String>), CliFailure> {
    let mut pid = None;
    let mut session_id = None;
    let mut index = 0;
    while index < args.len() {
        let (name, inline) = match args[index].split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (args[index].as_str(), None),
        };
        if name == "--session" {
            let taken = if inline.is_some() { 1 } else { 2 };
            let value = match inline {
                Some(value) => value,
                None => match args.get(index + 1) {
                    Some(value) => value.clone(),
                    None => return Err(CliFailure::invalid_args("--session needs a value")),
                },
            };
            if value.is_empty() {
                return Err(CliFailure::invalid_args("--session needs a value"));
            }
            session_id = Some(value);
            index += taken;
            continue;
        }
        let Ok(given) = args[index].parse::<u32>() else {
            return Err(CliFailure::invalid_args(format!(
                "`{}` is not a pid; `genet process kill <pid> [--session <id>]`",
                args[index]
            )));
        };
        if pid.is_some() {
            return Err(CliFailure::invalid_args(
                "`process kill` ends one process at a time",
            ));
        }
        pid = Some(given);
        index += 1;
    }
    let Some(pid) = pid else {
        return Err(CliFailure::invalid_args(
            "`process kill` needs a pid; `genet process kill <pid> [--session <id>]`",
        ));
    };
    Ok((pid, session_id))
}

fn unexpected(reply: &Reply) -> CliFailure {
    CliFailure::business(
        "unexpectedReply",
        format!("the machine answered with {}", query::reply_kind(reply)),
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(input: &[&str]) -> Vec<String> {
        input.iter().map(|word| (*word).to_string()).collect()
    }

    #[test]
    fn a_pid_is_enough_and_a_session_may_be_named_as_well() {
        assert_eq!(kill_arguments(&words(&["4123"])).unwrap(), (4123, None));
        for args in [
            words(&["4123", "--session", "s_1"]),
            words(&["--session", "s_1", "4123"]),
            words(&["--session=s_1", "4123"]),
        ] {
            assert_eq!(
                kill_arguments(&args).unwrap(),
                (4123, Some("s_1".to_string()))
            );
        }
    }

    #[test]
    fn something_that_is_not_a_pid_is_a_usage_error_rather_than_a_wrong_kill() {
        // A pid is the whole of what is being named, so a typo must not be
        // rounded off to a number that happens to parse.
        for args in [words(&["node"]), words(&["4123abc"]), words(&["-1"])] {
            assert_eq!(
                kill_arguments(&args).unwrap_err().code,
                "invalidArgs",
                "{args:?}"
            );
        }
    }

    #[test]
    fn a_kill_needs_something_to_kill() {
        assert_eq!(
            kill_arguments(&words(&["--session", "s_1"]))
                .unwrap_err()
                .code,
            "invalidArgs"
        );
        assert_eq!(
            kill_arguments(&words(&["1", "2"])).unwrap_err().code,
            "invalidArgs"
        );
    }
}
