//! Agent-friendly, read-only CLI commands.
//!
//! Every dynamic answer comes from the selected daemon RPC. The commands in
//! this module are deterministic reads; target selection and remote transport
//! stay centralized in `target` and `connect_selected`.

use base64::Engine;
use genehub_proto::{
    BlobRef, ErrorCode, HelloResult, ProtocolError, Reply, Request, RoundLayer, RoundTrunk,
    SessionContext, SessionInspection, SessionNarrativePage, SessionRoundPage, SessionSnapshot,
    SessionSummary, WorkspaceInfo,
};
use serde_json::{json, Value};

use crate::output::{self, CliFailure, CLI_SCHEMA};
use crate::rpc::{ConnectError, Refusal, Rpc, RpcError};
use crate::target::{self, Routing, Selection};

const COMMAND_NAMES: [&str; 28] = [
    "schema",
    "context",
    "capabilities",
    "shell",
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
    "agent.list",
    "agent.run",
    "session.send",
    "session.respond",
    "session.interrupt",
    "session.close",
    "machine.list",
    "machine.show",
    "machine.pair",
    "machine.forget",
    "device.list",
    "device.invite",
    "device.revoke",
];

/// The capability vocabulary a machine grants a device, named here so `genet
/// schema` can offer it as an enum rather than leaving an agent to discover the
/// spelling by being refused.
const GRANTS: [&str; 9] = [
    "handshake",
    "read",
    "session",
    "files",
    "git",
    "pty",
    "devices",
    "settings",
    "update",
];

/// Commands that change something on the target machine. Read by agents that
/// need to know what is safe to retry, so it is a property of the command
/// rather than a judgement made at each call site.
fn mutates(name: &str) -> bool {
    matches!(
        name,
        "shell"
            | "agent.run"
            | "session.send"
            | "session.respond"
            | "session.interrupt"
            | "session.close"
            | "machine.pair"
            | "machine.forget"
            | "device.invite"
            | "device.revoke"
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Query {
    Schema {
        command: Option<String>,
    },
    Context,
    Capabilities,
    WorkspaceList,
    WorkspaceShow {
        workspace_id: String,
    },
    SessionList {
        workspace_id: Option<String>,
    },
    SessionGet {
        session_id: String,
    },
    SessionInspect {
        session_id: String,
        through_round_id: Option<String>,
    },
    SessionNarrative {
        session_id: String,
        through_round_id: Option<String>,
        item_id: Option<String>,
        cursor: Option<String>,
        limit: Option<u32>,
    },
    SessionRounds {
        session_id: String,
        through_round_id: Option<String>,
        cursor: Option<String>,
        limit: Option<u32>,
    },
    SessionTrunks {
        session_id: String,
        round_id: String,
        cursor: Option<String>,
        limit: Option<u32>,
    },
    SessionTrunk {
        session_id: String,
        round_id: String,
        index: u32,
    },
    SessionBlob {
        session_id: String,
        reference: String,
    },
    SessionContext {
        session_id: String,
        through_round_id: Option<String>,
        token_budget: Option<u64>,
    },
}

pub async fn run(args: &[String], selection: &Selection) -> i32 {
    let command = match parse(args) {
        Ok(command) => command,
        Err(error) => return output::fail(error),
    };
    match execute(command, selection).await {
        Ok((kind, data)) => output::succeed(kind, data),
        Err(error) => output::fail(error),
    }
}

fn parse(args: &[String]) -> Result<Query, CliFailure> {
    let Some(command) = args.first().map(String::as_str) else {
        return Err(CliFailure::invalid_args("a command is required"));
    };
    let rest = &args[1..];
    match command {
        "schema" => parse_schema(rest),
        "context" => no_args(rest, Query::Context, "context"),
        "capabilities" => no_args(rest, Query::Capabilities, "capabilities"),
        "workspace" => parse_workspace(rest),
        "session" => parse_session(rest),
        _ => Err(CliFailure::invalid_args(format!(
            "unknown read-only command: {command}"
        ))),
    }
}

fn no_args(args: &[String], command: Query, name: &str) -> Result<Query, CliFailure> {
    if args.is_empty() {
        Ok(command)
    } else {
        Err(CliFailure::invalid_args(format!(
            "genet {name} takes no arguments"
        )))
    }
}

fn parse_schema(args: &[String]) -> Result<Query, CliFailure> {
    let command = match args {
        [] => None,
        [one] => Some(one.clone()),
        [group, verb] => Some(format!("{group}.{verb}")),
        _ => return Err(CliFailure::invalid_args("usage: genet schema [command]")),
    };
    if let Some(name) = command.as_deref() {
        if !COMMAND_NAMES.contains(&name) {
            return Err(CliFailure::invalid_args(format!(
                "unknown schema command '{name}'; use `genet schema` to list commands"
            )));
        }
    }
    Ok(Query::Schema { command })
}

fn parse_workspace(args: &[String]) -> Result<Query, CliFailure> {
    match args {
        [verb] if verb == "list" => Ok(Query::WorkspaceList),
        [verb, workspace_id] if verb == "show" && !workspace_id.trim().is_empty() => {
            Ok(Query::WorkspaceShow {
                workspace_id: workspace_id.clone(),
            })
        }
        [verb] if verb == "show" => Err(CliFailure::invalid_args(
            "workspace show needs a workspace id",
        )),
        _ => Err(CliFailure::invalid_args(
            "usage: genet workspace list | genet workspace show <id>",
        )),
    }
}

fn parse_session(args: &[String]) -> Result<Query, CliFailure> {
    let Some(verb) = args.first().map(String::as_str) else {
        return Err(CliFailure::invalid_args(
            "usage: genet session <list|get|inspect|narrative|rounds|trunks|trunk|blob|context> ...",
        ));
    };
    match verb {
        "list" => {
            let mut workspace_id = None;
            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--workspace" => {
                        if workspace_id.is_some() {
                            return Err(CliFailure::invalid_args(
                                "--workspace may be supplied only once",
                            ));
                        }
                        index += 1;
                        let value = args.get(index).ok_or_else(|| {
                            CliFailure::invalid_args("--workspace needs a workspace id")
                        })?;
                        if value.trim().is_empty() {
                            return Err(CliFailure::invalid_args(
                                "--workspace needs a non-empty workspace id",
                            ));
                        }
                        workspace_id = Some(value.clone());
                    }
                    other => {
                        return Err(CliFailure::invalid_args(format!(
                            "unknown session list argument: {other}"
                        )))
                    }
                }
                index += 1;
            }
            Ok(Query::SessionList { workspace_id })
        }
        "get" => match &args[1..] {
            [session_id] if !session_id.trim().is_empty() => Ok(Query::SessionGet {
                session_id: session_id.clone(),
            }),
            _ => Err(CliFailure::invalid_args(
                "session get needs exactly one session id",
            )),
        },
        "inspect" => {
            let (session_id, flags) = session_id_and_flags(args, "inspect")?;
            reject_unknown_flags(&flags, &["--through-round"])?;
            Ok(Query::SessionInspect {
                session_id,
                through_round_id: optional_string_flag(&flags, "--through-round")?,
            })
        }
        "narrative" => {
            let (session_id, flags) = session_id_and_flags(args, "narrative")?;
            reject_unknown_flags(
                &flags,
                &["--through-round", "--item", "--cursor", "--limit"],
            )?;
            let item_id = optional_string_flag(&flags, "--item")?;
            let cursor = optional_string_flag(&flags, "--cursor")?;
            if item_id.is_some() && cursor.is_some() {
                return Err(CliFailure::invalid_args(
                    "--item and --cursor are mutually exclusive",
                ));
            }
            Ok(Query::SessionNarrative {
                session_id,
                through_round_id: optional_string_flag(&flags, "--through-round")?,
                item_id,
                cursor,
                limit: optional_u32_flag(&flags, "--limit")?,
            })
        }
        "rounds" => {
            let (session_id, flags) = session_id_and_flags(args, "rounds")?;
            reject_unknown_flags(&flags, &["--through-round", "--cursor", "--limit"])?;
            Ok(Query::SessionRounds {
                session_id,
                through_round_id: optional_string_flag(&flags, "--through-round")?,
                cursor: optional_string_flag(&flags, "--cursor")?,
                limit: optional_u32_flag(&flags, "--limit")?,
            })
        }
        "trunks" => {
            let (session_id, flags) = session_id_and_flags(args, "trunks")?;
            reject_unknown_flags(&flags, &["--round", "--cursor", "--limit"])?;
            Ok(Query::SessionTrunks {
                session_id,
                round_id: required_string_flag(&flags, "--round")?,
                cursor: optional_string_flag(&flags, "--cursor")?,
                limit: optional_u32_flag(&flags, "--limit")?,
            })
        }
        "trunk" => {
            let (session_id, flags) = session_id_and_flags(args, "trunk")?;
            reject_unknown_flags(&flags, &["--round", "--index"])?;
            Ok(Query::SessionTrunk {
                session_id,
                round_id: required_string_flag(&flags, "--round")?,
                index: required_u32_flag(&flags, "--index")?,
            })
        }
        "blob" => {
            let (session_id, flags) = session_id_and_flags(args, "blob")?;
            reject_unknown_flags(&flags, &["--ref"])?;
            Ok(Query::SessionBlob {
                session_id,
                reference: required_string_flag(&flags, "--ref")?,
            })
        }
        "context" => {
            let (session_id, flags) = session_id_and_flags(args, "context")?;
            reject_unknown_flags(&flags, &["--through-round", "--budget-tokens"])?;
            Ok(Query::SessionContext {
                session_id,
                through_round_id: optional_string_flag(&flags, "--through-round")?,
                token_budget: optional_u64_flag(&flags, "--budget-tokens")?,
            })
        }
        _ => Err(CliFailure::invalid_args(format!(
            "unknown session command: {verb}"
        ))),
    }
}

fn session_id_and_flags(
    args: &[String],
    verb: &str,
) -> Result<(String, Vec<(String, String)>), CliFailure> {
    let session_id = args
        .get(1)
        .filter(|value| !value.trim().is_empty() && !value.starts_with("--"))
        .cloned()
        .ok_or_else(|| CliFailure::invalid_args(format!("session {verb} needs a session id")))?;
    let mut flags = Vec::new();
    let mut index = 2;
    while index < args.len() {
        let name = args[index].clone();
        if !name.starts_with("--") {
            return Err(CliFailure::invalid_args(format!(
                "unexpected session {verb} argument: {name}"
            )));
        }
        let value = args
            .get(index + 1)
            .ok_or_else(|| CliFailure::invalid_args(format!("{name} needs a value")))?;
        if value.trim().is_empty() || value.starts_with("--") {
            return Err(CliFailure::invalid_args(format!("{name} needs a value")));
        }
        if flags.iter().any(|(seen, _)| seen == &name) {
            return Err(CliFailure::invalid_args(format!(
                "{name} may be supplied only once"
            )));
        }
        flags.push((name, value.clone()));
        index += 2;
    }
    Ok((session_id, flags))
}

fn optional_string_flag(
    flags: &[(String, String)],
    name: &str,
) -> Result<Option<String>, CliFailure> {
    Ok(flags
        .iter()
        .find(|(flag, _)| flag == name)
        .map(|(_, value)| value.clone()))
}

fn required_string_flag(flags: &[(String, String)], name: &str) -> Result<String, CliFailure> {
    optional_string_flag(flags, name)?
        .ok_or_else(|| CliFailure::invalid_args(format!("session command requires {name} <value>")))
}

fn optional_u32_flag(flags: &[(String, String)], name: &str) -> Result<Option<u32>, CliFailure> {
    optional_number_flag(flags, name)
}

fn required_u32_flag(flags: &[(String, String)], name: &str) -> Result<u32, CliFailure> {
    optional_u32_flag(flags, name)?.ok_or_else(|| {
        CliFailure::invalid_args(format!("session command requires {name} <number>"))
    })
}

fn optional_u64_flag(flags: &[(String, String)], name: &str) -> Result<Option<u64>, CliFailure> {
    optional_number_flag(flags, name)
}

fn optional_number_flag<T>(flags: &[(String, String)], name: &str) -> Result<Option<T>, CliFailure>
where
    T: std::str::FromStr,
{
    optional_string_flag(flags, name)?
        .map(|value| {
            value.parse().map_err(|_| {
                CliFailure::invalid_args(format!("{name} needs a non-negative integer"))
            })
        })
        .transpose()
}

fn reject_unknown_flags(flags: &[(String, String)], allowed: &[&str]) -> Result<(), CliFailure> {
    if let Some((name, _)) = flags
        .iter()
        .find(|(name, _)| !allowed.contains(&name.as_str()))
    {
        return Err(CliFailure::invalid_args(format!(
            "unknown argument: {name}"
        )));
    }
    Ok(())
}

async fn execute(
    command: Query,
    selection: &Selection,
) -> Result<(&'static str, Value), CliFailure> {
    match command {
        Query::Schema { command } => Ok(("schema", schema_data(command.as_deref()))),
        Query::Capabilities => Ok(("capabilities", capabilities_data())),
        Query::Context => {
            let rpc = connect_selected(selection).await?;
            Ok((
                "context",
                context_data(rpc.hello(), selection.machine.as_deref()),
            ))
        }
        Query::WorkspaceList => {
            let rpc = connect_selected(selection).await?;
            let workspaces =
                workspaces(rpc.call(Request::WorkspaceList).await.map_err(rpc_error)?)?;
            Ok(("workspace.list", json!({"workspaces": workspaces})))
        }
        Query::WorkspaceShow { workspace_id } => {
            let rpc = connect_selected(selection).await?;
            let listed = workspaces(rpc.call(Request::WorkspaceList).await.map_err(rpc_error)?)?;
            let workspace = listed
                .into_iter()
                .find(|workspace| workspace.id == workspace_id)
                .ok_or_else(|| CliFailure::target_not_found("workspace", &workspace_id))?;
            Ok(("workspace.show", json!({"workspace": workspace})))
        }
        Query::SessionList { workspace_id } => {
            let rpc = connect_selected(selection).await?;
            if let Some(id) = workspace_id.as_deref() {
                let listed =
                    workspaces(rpc.call(Request::WorkspaceList).await.map_err(rpc_error)?)?;
                if !listed.iter().any(|workspace| workspace.id == id) {
                    return Err(CliFailure::target_not_found("workspace", id));
                }
            }
            let sessions = sessions(
                rpc.call(Request::SessionList {
                    workspace_id: workspace_id.clone(),
                    include_archived: false,
                })
                .await
                .map_err(rpc_error)?,
            )?;
            Ok((
                "session.list",
                json!({"workspaceId": workspace_id, "sessions": sessions}),
            ))
        }
        Query::SessionGet { session_id } => {
            let rpc = connect_selected(selection).await?;
            let snapshot = snapshot(
                rpc.call(Request::SessionGet {
                    session_id: session_id.clone(),
                })
                .await
                .map_err(rpc_error)?,
            )?;
            Ok(("session.get", json!({"session": snapshot})))
        }
        Query::SessionInspect {
            session_id,
            through_round_id,
        } => {
            let rpc = connect_selected(selection).await?;
            let inspection = inspection(
                rpc.call(Request::SessionInspect {
                    session_id,
                    through_round_id,
                })
                .await
                .map_err(rpc_error)?,
            )?;
            Ok(("session.inspect", json!({"inspection": inspection})))
        }
        Query::SessionNarrative {
            session_id,
            through_round_id,
            item_id,
            cursor,
            limit,
        } => {
            let rpc = connect_selected(selection).await?;
            let page = narrative(
                rpc.call(Request::SessionNarrative {
                    session_id,
                    through_round_id,
                    item_id,
                    cursor,
                    limit,
                })
                .await
                .map_err(rpc_error)?,
            )?;
            Ok(("session.narrative", json!({"page": page})))
        }
        Query::SessionRounds {
            session_id,
            through_round_id,
            cursor,
            limit,
        } => {
            let rpc = connect_selected(selection).await?;
            let page = round_page(
                rpc.call(Request::SessionRounds {
                    session_id,
                    through_round_id,
                    cursor,
                    limit,
                })
                .await
                .map_err(rpc_error)?,
            )?;
            Ok(("session.rounds", json!({"page": page})))
        }
        Query::SessionTrunks {
            session_id,
            round_id,
            cursor,
            limit,
        } => {
            let rpc = connect_selected(selection).await?;
            let layer = round_layer(
                rpc.call(Request::RoundTrunkList {
                    session_id,
                    round_id,
                    cursor,
                    limit,
                })
                .await
                .map_err(rpc_error)?,
            )?;
            Ok(("session.trunks", json!({"layer": layer})))
        }
        Query::SessionTrunk {
            session_id,
            round_id,
            index,
        } => {
            let rpc = connect_selected(selection).await?;
            let trunk = round_trunk(
                rpc.call(Request::RoundTrunkGet {
                    session_id,
                    round_id,
                    trunk_index: index,
                })
                .await
                .map_err(rpc_error)?,
            )?;
            let blob_refs = encoded_blob_refs(&trunk);
            Ok((
                "session.trunk",
                json!({"trunk": trunk, "blobRefs": blob_refs}),
            ))
        }
        Query::SessionBlob {
            session_id,
            reference,
        } => {
            let rpc = connect_selected(selection).await?;
            let blob_ref = decode_blob_ref(&reference)?;
            let blob = blob(
                rpc.call(Request::BlobGet {
                    session_id,
                    blob: blob_ref,
                })
                .await
                .map_err(rpc_error)?,
            )?;
            Ok(("session.blob", json!({"blob": blob})))
        }
        Query::SessionContext {
            session_id,
            through_round_id,
            token_budget,
        } => {
            let rpc = connect_selected(selection).await?;
            let context = session_context(
                rpc.call(Request::SessionContext {
                    session_id,
                    through_round_id,
                    token_budget,
                })
                .await
                .map_err(rpc_error)?,
            )?;
            Ok(("session.context", json!({"context": context})))
        }
    }
}

/// The workspace catalogue, shared with the conversation surface so both
/// resolve `--workspace` and `--cwd` against exactly the same list.
pub async fn list_workspaces(rpc: &Rpc) -> Result<Vec<WorkspaceInfo>, CliFailure> {
    workspaces(rpc.call(Request::WorkspaceList).await.map_err(rpc_error)?)
}

fn encode_blob_ref(blob: &BlobRef) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(blob).expect("BlobRef is always JSON serializable"))
}

fn decode_blob_ref(encoded: &str) -> Result<BlobRef, CliFailure> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| CliFailure::invalid_args("--ref is not a valid genet blob reference"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| CliFailure::invalid_args("--ref is not a valid genet blob reference"))
}

fn encoded_blob_refs(trunk: &RoundTrunk) -> Vec<Value> {
    trunk
        .batches
        .iter()
        .flat_map(|batch| batch.blobs.iter())
        .filter_map(|blob| {
            blob.blob.as_ref().map(|reference| {
                json!({
                    "itemId": blob.item_id,
                    "kind": blob.kind,
                    "ref": encode_blob_ref(reference),
                })
            })
        })
        .collect()
}

pub fn connect_error(error: ConnectError) -> CliFailure {
    match error {
        ConnectError::Rejected(ProtocolError {
            code: ErrorCode::ProtocolVersion,
            message,
        })
        | ConnectError::Protocol(message) => CliFailure::protocol(message),
        ConnectError::Rejected(error) => rpc_error(RpcError::Remote(error)),
        ConnectError::Unavailable(message) | ConnectError::Refused { message, .. } => {
            CliFailure::daemon_unavailable(format!(
                "could not reach the local daemon: {message}; run `{} daemon start`",
                genet_daemon::channel::CLI_BINARY
            ))
        }
    }
}

/// The same failures, said in the vocabulary of another machine.
///
/// The distinction that earns its place here is `retryable`. A machine that is
/// merely asleep and a credential that was revoked both look like "cannot
/// connect", but an agent should wait out the first and stop on the second,
/// and it can only do that if the two arrive under different codes.
pub fn remote_connect_error(machine_id: &str, error: ConnectError) -> CliFailure {
    let details = Some(json!({"machineId": machine_id}));
    match error {
        ConnectError::Rejected(ProtocolError {
            code: ErrorCode::ProtocolVersion,
            message,
        })
        | ConnectError::Protocol(message) => CliFailure::protocol(message),
        ConnectError::Rejected(ProtocolError {
            code: ErrorCode::Unauthorized,
            message,
        }) => CliFailure {
            code: "credentialRevoked",
            message: format!(
                "{machine_id} no longer accepts this installation's credential ({message}); \
                 pair again with a fresh invite"
            ),
            retryable: false,
            details,
            exit: crate::EXIT_FAILED,
        },
        ConnectError::Rejected(error) => rpc_error(RpcError::Remote(error)),
        // Nothing was consumed finding out that nobody was home, which is
        // exactly why retrying is safe and why a brief absence should not be
        // reported as breakage.
        ConnectError::Refused {
            reason: Refusal::Offline,
            ..
        } => CliFailure {
            code: "machineOffline",
            message: format!("{machine_id} is not currently connected to its relay"),
            retryable: true,
            details,
            exit: crate::EXIT_UNREACHABLE,
        },
        ConnectError::Refused {
            reason: Refusal::Credential,
            message,
        } => CliFailure {
            code: "credentialRevoked",
            message: format!(
                "{machine_id} no longer accepts this installation's credential ({message}); \
                 pair again with a fresh invite"
            ),
            retryable: false,
            details,
            exit: crate::EXIT_FAILED,
        },
        ConnectError::Refused { message, .. } => CliFailure {
            code: "relayUnavailable",
            message: format!("the relay in front of {machine_id} refused this call: {message}"),
            retryable: true,
            details,
            exit: crate::EXIT_UNREACHABLE,
        },
        ConnectError::Unavailable(message) => CliFailure {
            code: "relayUnavailable",
            message: format!("could not reach {machine_id}: {message}"),
            retryable: true,
            details,
            exit: crate::EXIT_UNREACHABLE,
        },
    }
}

/// Connects to whichever machine this invocation named.
///
/// Every command that can be routed goes through here, so there is exactly one
/// place where `--machine` turns into a different socket. A command that
/// forgot to use it would run locally while claiming to run elsewhere, which is
/// the one failure mode nobody would notice.
pub async fn connect_selected(selection: &Selection) -> Result<Rpc, CliFailure> {
    let Some(machine_id) = selection.machine.as_deref() else {
        return Rpc::connect().await.map_err(connect_error);
    };
    // A machine paired directly with this installation wins. Its credential is
    // this installation's own, so reaching it does not depend on a daemon
    // running here or on a Hub being up.
    if let Some(machine) = crate::machines::lookup(machine_id)? {
        return Rpc::connect_remote(&machine)
            .await
            .map_err(|error| remote_connect_error(machine_id, error));
    }
    hosted(machine_id).await
}

/// The hosted-Hub path: a per-connection ticket, fetched through the local
/// daemon's enrolment.
///
/// The CLI holds no Hub enrolment of its own, so this only works where a local
/// daemon is running and paired. That is a real limit and it is reported as
/// one — a machine that is unreachable because nothing here is enrolled must
/// not read as a machine that does not exist.
async fn hosted(machine_id: &str) -> Result<Rpc, CliFailure> {
    let local = Rpc::connect().await.map_err(|_| {
        not_paired(
            machine_id,
            "no local daemon is running here to fetch a hosted ticket with",
        )
    })?;
    let ticket = match local
        .call(Request::HubConnect {
            machine_id: machine_id.to_string(),
        })
        .await
    {
        Ok(Reply::HubTicket(ticket)) => ticket,
        Ok(other) => return Err(CliFailure::protocol(format!("unexpected reply: {other:?}"))),
        Err(RpcError::Remote(error)) => {
            return Err(not_paired(
                machine_id,
                &format!("the Hub did not issue a ticket for it: {}", error.message),
            ))
        }
        Err(error) => return Err(rpc_error(error)),
    };
    drop(local);
    Rpc::connect_hosted(&ticket)
        .await
        .map_err(|error| remote_connect_error(machine_id, error))
}

fn not_paired(machine_id: &str, why: &str) -> CliFailure {
    CliFailure::business(
        "machineNotPaired",
        format!(
            "{machine_id} is not a machine this installation can reach: {why}. \
             `genet machine list` shows the ones it paired with directly, and \
             `genet hub status` whether a Hub can introduce the rest"
        ),
        Some(json!({"machineId": machine_id})),
    )
}

fn context_data(hello: &HelloResult, machine: Option<&str>) -> Value {
    // A mutually authenticated Hello withholds the machine's public identity,
    // because proving the shared credential already settled who answered and
    // repeating it would only tell an eavesdropper. So when a machine was
    // named, that name is the honest answer for what this resolved to.
    let (machine_id, machine_name) = match machine {
        Some(id) => (id.to_string(), String::new()),
        None => (hello.machine_id.clone(), hello.machine_name.clone()),
    };
    json!({
        "source": if machine.is_some() { "remoteDaemon" } else { "localDaemon" },
        "principal": {"type": if machine.is_some() { "pairedDevice" } else { "localUser" }},
        "defaultWorkspaceId": null,
        "workspaceSelection": "explicitOnly",
        "remoteExec": true,
        "deviceSelector": false,
        // Which machine this call actually resolved to, and how. An agent that
        // wants to know whether it is talking to itself should read this rather
        // than infer it from the absence of a flag.
        "target": {
            "machineId": machine_id,
            "machineName": machine_name,
            "resolvedFrom": if machine.is_some() { "--machine" } else { "loopback" },
            "transport": hello.transport,
            "credential": if machine.is_some() { "pairedDeviceSecret" } else { "loopbackAdmission" },
        },
        "workingDirectory": {"selector": "--cwd", "value": null, "inferred": false},
        "daemon": {
            "version": hello.daemon_version,
            "protocolVersion": hello.protocol_version,
            "machineId": hello.machine_id,
            "machineName": hello.machine_name,
            "fingerprint": hello.fingerprint,
            "transport": hello.transport,
            // What that machine can hold a process to, as measured there
            // rather than assumed here. An agent weighing whether to run
            // something it does not fully trust reads this; null means the
            // daemon predates the question, which is not the same as "no"
            // (`genet-remote-execution.md` §7.5).
            "isolation": hello.isolation,
        }
    })
}

fn capabilities_data() -> Value {
    json!({
        "source": "staticCliContract",
        "transport": "localDaemon",
        "readOnly": false,
        "agentConversation": {
            "sugar": "genet <agentId> \"<prompt>\"",
            "canonical": "agent.run",
            "reserved": crate::target::RESERVED,
            "sessionBacked": true,
            "resume": ["--session", "--since-seq", "session.respond"],
            "permissionsWithoutAPerson": "denied unless --auto-approve; questions always stop",
        },
        // Kept a boolean because agents and scripts already branch on it. The
        // detail that does not fit in a boolean lives in `remote` beside it,
        // which is an added field rather than a changed type.
        "remoteExec": true,
        "remote": {
            "transports": ["rendezvous", "hostedHub"],
            "hostedHub": true,
            // The condition is stated because it is not one an agent could
            // guess from a boolean. The CLI holds no Hub enrolment of its own,
            // so a hosted machine is reached by borrowing the local daemon's —
            // which means this path needs a daemon running here, and the
            // rendezvous path does not.
            "hostedHubRequires": "a local daemon enrolled with the Hub",
            "resolutionOrder": ["machines.json", "hub.connect"],
            "selector": {"kind": "exactId", "flag": "--machine", "implicitDefault": false},
            "pairing": ["machine.pair", "device.invite"],
            "credentialStore": "machines.json",
        },
        // What the target machine will let a command touch. `genet shell` runs
        // an argv list, never a command line, so this binary never parses a
        // shell and there is no interpreter of ours to sandbox — what holds is
        // the operating system confinement on the machine that runs it.
        "isolation": {
            "arbitraryCommands": true,
            "commandLineParsing": false,
            "engine": null,
            // What a *machine* can enforce is not a property of this binary,
            // and answering it from here would be answering it about the
            // wrong computer. It is measured on the machine that would run
            // the process and reported where that machine speaks.
            "reportedBy": "context.daemon.isolation",
        },
        "deviceSelector": false,
        "workspaceSelector": {
            "kind": "exactId",
            "supportedBy": ["session.list"],
            "implicitDefault": false,
        },
        "workingDirectory": {
            "flag": "--cwd",
            "supportedBy": COMMAND_NAMES.iter().filter(|name| target::accepts_cwd(name))
                .collect::<Vec<_>>(),
            "inferred": false,
        },
        "commands": COMMAND_NAMES.iter().map(|name| json!({
            "name": name,
            "requiresDaemon": !matches!(*name, "schema" | "capabilities"),
            "mutation": mutates(name),
            "routable": matches!(target::routing(name), Routing::Routable),
            "streaming": streams(name),
        })).collect::<Vec<_>>(),
    })
}

fn schema_data(command: Option<&str>) -> Value {
    match command {
        Some(command) => json!({"command": command_schema(command)}),
        None => json!({
            "commands": COMMAND_NAMES.iter().map(|name| command_schema(name)).collect::<Vec<_>>()
        }),
    }
}

fn command_schema(name: &str) -> Value {
    let (synopsis, requires_daemon, input) = match name {
        "schema" => (
            "genet schema [command]",
            false,
            object_input(json!({"command": {"type": "string"}}), &[]),
        ),
        "context" => ("genet context", true, object_input(json!({}), &[])),
        "capabilities" => ("genet capabilities", false, object_input(json!({}), &[])),
        "workspace.list" => ("genet workspace list", true, object_input(json!({}), &[])),
        "workspace.show" => (
            "genet workspace show <id>",
            true,
            object_input(
                json!({"workspaceId": {"type": "string", "minLength": 1}}),
                &["workspaceId"],
            ),
        ),
        "session.list" => (
            "genet session list [--workspace <id>]",
            true,
            object_input(
                json!({"workspaceId": {"type": ["string", "null"], "minLength": 1}}),
                &[],
            ),
        ),
        "session.get" => (
            "genet session get <id>",
            true,
            object_input(
                json!({"sessionId": {"type": "string", "minLength": 1}}),
                &["sessionId"],
            ),
        ),
        "shell" => (
            "genet shell [--workspace <id> | --cwd <dir>] [--machine <id>] -- <command> [args...]",
            true,
            object_input(
                json!({
                    "argv": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                        "$comment": "a list, never a command line: it is not parsed by a shell, \
                                     so nothing in it can become a second command",
                    },
                    "workspaceId": {"type": ["string", "null"], "minLength": 1},
                }),
                &["argv"],
            ),
        ),
        "agent.list" => ("genet agent list", true, object_input(json!({}), &[])),
        "agent.run" => (
            "genet agent run --agent <id> \"<prompt>\" [--cwd <dir> | --workspace <id>] \
             [--session <id>] [--model <id>] [--mode <id>] [--effort <id>] [--title <t>] \
             [--wait|--no-wait] [--since-seq <n>] [--auto-approve] [--timeout <s>] \
             [--open-workspace]",
            true,
            object_input(
                json!({
                    "agentId": {"type": "string", "minLength": 1},
                    "prompt": {"type": "string", "minLength": 1},
                    "sessionId": {"type": ["string", "null"], "minLength": 1},
                    "workspaceId": {"type": ["string", "null"], "minLength": 1},
                    "modelId": {"type": ["string", "null"], "minLength": 1},
                    "modeId": {"type": ["string", "null"], "minLength": 1},
                    "effortId": {"type": ["string", "null"], "minLength": 1},
                    "title": {"type": ["string", "null"], "minLength": 1},
                    "wait": {"type": "boolean", "default": true},
                    "sinceSeq": {"type": ["integer", "null"], "minimum": 0},
                    "autoApprove": {"type": "boolean", "default": false},
                    "timeout": {"type": ["integer", "null"], "minimum": 1},
                    "openWorkspace": {"type": "boolean", "default": false},
                }),
                &["agentId", "prompt"],
            ),
        ),
        "session.send" => (
            "genet session send <id> \"<text>\" [--wait|--no-wait] [--timeout <s>]",
            true,
            object_input(
                json!({
                    "sessionId": {"type": "string", "minLength": 1},
                    "prompt": {"type": "string", "minLength": 1},
                    "wait": {"type": "boolean", "default": true},
                    "timeout": {"type": ["integer", "null"], "minimum": 1},
                }),
                &["sessionId", "prompt"],
            ),
        ),
        "session.respond" => (
            "genet session respond <id> --request <rid> --choose <optionId>",
            true,
            object_input(
                json!({
                    "sessionId": {"type": "string", "minLength": 1},
                    "requestId": {"type": "string", "minLength": 1},
                    "optionId": {"type": "string", "minLength": 1},
                }),
                &["sessionId", "requestId", "optionId"],
            ),
        ),
        "session.interrupt" | "session.close" => (
            if name == "session.close" {
                "genet session close <id>"
            } else {
                "genet session interrupt <id>"
            },
            true,
            object_input(
                json!({"sessionId": {"type": "string", "minLength": 1}}),
                &["sessionId"],
            ),
        ),
        "machine.list" => ("genet machine list", false, object_input(json!({}), &[])),
        "machine.show" => (
            "genet machine show <machineId>",
            false,
            object_input(
                json!({"machineId": {"type": "string", "minLength": 1}}),
                &["machineId"],
            ),
        ),
        "machine.pair" => (
            "genet machine pair <code> --endpoint <url> [--name <label>]",
            false,
            object_input(
                json!({
                    "code": {"type": "string", "minLength": 1},
                    "endpoint": {"type": "string", "minLength": 1},
                    "name": {"type": ["string", "null"], "minLength": 1},
                }),
                &["code", "endpoint"],
            ),
        ),
        "machine.forget" => (
            "genet machine forget <machineId>",
            false,
            object_input(
                json!({"machineId": {"type": "string", "minLength": 1}}),
                &["machineId"],
            ),
        ),
        "device.list" => ("genet device list", true, object_input(json!({}), &[])),
        "device.invite" => (
            "genet device invite [--grant <capability>]…",
            true,
            object_input(
                json!({"grants": {
                    "type": ["array", "null"],
                    "items": {"type": "string", "enum": GRANTS},
                    "description": "absent means an unrestricted device",
                }}),
                &[],
            ),
        ),
        "device.revoke" => (
            "genet device revoke <deviceId>",
            true,
            object_input(
                json!({"deviceId": {"type": "string", "minLength": 1}}),
                &["deviceId"],
            ),
        ),
        "session.inspect" => session_schema(
            "genet session inspect <id> [--through-round <round-id>]",
            json!({"throughRoundId": nullable_string()}),
        ),
        "session.narrative" => session_schema(
            "genet session narrative <id> [--through-round <round-id>] [--item <item-id> | --cursor <cursor>] [--limit <n>]",
            json!({
                "throughRoundId": nullable_string(),
                "itemId": nullable_string(),
                "cursor": nullable_string(),
                "limit": nullable_integer(),
            }),
        ),
        "session.rounds" => session_schema(
            "genet session rounds <id> [--through-round <round-id>] [--cursor <cursor>] [--limit <n>]",
            json!({
                "throughRoundId": nullable_string(),
                "cursor": nullable_string(),
                "limit": nullable_integer(),
            }),
        ),
        "session.trunks" => session_schema_required(
            "genet session trunks <id> --round <round-id> [--cursor <cursor>] [--limit <n>]",
            json!({
                "roundId": {"type": "string", "minLength": 1},
                "cursor": nullable_string(),
                "limit": nullable_integer(),
            }),
            &["sessionId", "roundId"],
        ),
        "session.trunk" => session_schema_required(
            "genet session trunk <id> --round <round-id> --index <n>",
            json!({
                "roundId": {"type": "string", "minLength": 1},
                "index": {"type": "integer", "minimum": 0},
            }),
            &["sessionId", "roundId", "index"],
        ),
        "session.blob" => session_schema_required(
            "genet session blob <id> --ref <opaque-ref>",
            json!({"ref": {"type": "string", "minLength": 1}}),
            &["sessionId", "ref"],
        ),
        "session.context" => session_schema(
            "genet session context <id> [--through-round <round-id>] [--budget-tokens <n>]",
            json!({
                "throughRoundId": nullable_string(),
                "tokenBudget": nullable_integer(),
            }),
        ),
        _ => unreachable!("schema names are validated before lookup"),
    };
    json!({
        "name": name,
        "synopsis": synopsis,
        "requiresDaemon": requires_daemon,
        "mutation": mutates(name),
        "routable": matches!(target::routing(name), Routing::Routable),
        "streaming": streams(name),
        "inputSchema": with_selectors(name, input),
        "outputSchema": match name {
            _ if !streams(name) => single_output(name),
            "shell" => command_output(),
            _ => stream_output(),
        },
    })
}

/// What a running command prints: the same envelope per line, and the two
/// output streams named rather than merged.
///
/// `shell.exit` is the terminal record and carries the command's own status.
/// The exit code of the CLI process deliberately does not: its codes are
/// frozen and describe whether the CLI could do its job, so a command exiting 4
/// must not be indistinguishable from a machine refusing the request.
fn command_output() -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$comment": "JSON Lines: one envelope per line, in order",
        "type": "object",
        "required": ["schema", "type"],
        "properties": {
            "schema": {"const": CLI_SCHEMA},
            "type": {"enum": ["shell.started", "shell.output", "shell.exit", "error"]},
        },
        "x-terminalTypes": ["shell.exit", "error"],
        "x-streams": ["stdout", "stderr"],
        "x-exitCode": "shell.exit.data.exitCode, not the exit code of this process",
        "x-confinement": "shell.started.data.confinement: null, or the backend and \
                          the roots the command can reach. Read every missing path \
                          outside those roots as out of bounds, not as absent: with \
                          the namespaces backend the rest of the filesystem is not \
                          there at all, so the machine reports no such file rather \
                          than permission denied. The command itself is told the \
                          same thing in GENEHUB_CONFINEMENT and GENEHUB_CONFINED_ROOTS.",
    })
}

fn streams(name: &str) -> bool {
    matches!(name, "shell" | "agent.run" | "session.send")
}

fn single_output(name: &str) -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": false,
        "required": ["schema", "type", "data"],
        "properties": {
            "schema": {"const": CLI_SCHEMA},
            "type": {"const": name},
            "data": {"type": "object"},
        }
    })
}

/// A watched conversation prints many lines, but not a second envelope shape:
/// each line is the same three fields with a different `type`, and the last one
/// is always terminal so a reader knows it is done without relying on EOF —
/// which could equally mean the pipe broke.
fn stream_output() -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$comment": "JSON Lines: one envelope per line, in order",
        "type": "object",
        "required": ["schema", "type"],
        "properties": {
            "schema": {"const": CLI_SCHEMA},
            "type": {"enum": [
                "session.created",
                "session.attached",
                "session.desync",
                "session.event",
                "session.result",
                "error",
            ]},
        },
        "x-terminalTypes": ["session.result", "error"],
        "x-resultStatuses": [
            "completed", "failed", "canceled", "waiting",
            "detached", "timedOut", "disconnected", "running",
        ],
    })
}

/// Adds the global selectors to a command's input schema, but only where they
/// mean something. A command that would reject `--machine` at runtime must not
/// advertise it here, or the map an agent reads once will send it down a path
/// that always fails.
fn with_selectors(name: &str, mut input: Value) -> Value {
    let Some(properties) = input.get_mut("properties").and_then(Value::as_object_mut) else {
        return input;
    };
    if matches!(target::routing(name), Routing::Routable) {
        // Named for the flag rather than for what it holds, so it cannot
        // collide with a command whose own subject is a machine id. `genet
        // machine show m_a --machine m_b` is a coherent thing to type, and a
        // schema that spelled both of those `machineId` could not say so.
        properties.insert(
            "machine".into(),
            json!({
                "type": ["string", "null"],
                "minLength": 1,
                "description": "--machine; exact id of a paired machine, never a name or a prefix",
            }),
        );
    }
    if target::accepts_cwd(name) {
        properties.insert(
            "cwd".into(),
            json!({
                "type": ["string", "null"],
                "minLength": 1,
                "description": "--cwd; working directory on the target machine, absolute when --machine is used",
            }),
        );
    }
    input
}

fn session_schema(synopsis: &'static str, extra: Value) -> (&'static str, bool, Value) {
    session_schema_required(synopsis, extra, &["sessionId"])
}

fn session_schema_required(
    synopsis: &'static str,
    extra: Value,
    required: &[&str],
) -> (&'static str, bool, Value) {
    let mut properties = serde_json::Map::new();
    properties.insert(
        "sessionId".into(),
        json!({"type": "string", "minLength": 1}),
    );
    properties.extend(extra.as_object().cloned().unwrap_or_default());
    (
        synopsis,
        true,
        object_input(Value::Object(properties), required),
    )
}

fn nullable_string() -> Value {
    json!({"type": ["string", "null"], "minLength": 1})
}

fn nullable_integer() -> Value {
    json!({"type": ["integer", "null"], "minimum": 0})
}

fn object_input(properties: Value, required: &[&str]) -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": false,
        "properties": properties,
        "required": required,
    })
}

fn workspaces(reply: Reply) -> Result<Vec<WorkspaceInfo>, CliFailure> {
    match reply {
        Reply::Workspaces(workspaces) => Ok(workspaces),
        other => Err(unexpected_reply("workspaces", &other)),
    }
}

fn sessions(reply: Reply) -> Result<Vec<SessionSummary>, CliFailure> {
    match reply {
        Reply::Sessions(sessions) => Ok(sessions),
        other => Err(unexpected_reply("sessions", &other)),
    }
}

fn snapshot(reply: Reply) -> Result<SessionSnapshot, CliFailure> {
    match reply {
        Reply::Snapshot(snapshot) => Ok(snapshot),
        other => Err(unexpected_reply("session snapshot", &other)),
    }
}

fn inspection(reply: Reply) -> Result<SessionInspection, CliFailure> {
    match reply {
        Reply::SessionInspection(value) => Ok(value),
        other => Err(unexpected_reply("session inspection", &other)),
    }
}

fn narrative(reply: Reply) -> Result<SessionNarrativePage, CliFailure> {
    match reply {
        Reply::SessionNarrative(value) => Ok(value),
        other => Err(unexpected_reply("session narrative", &other)),
    }
}

fn round_page(reply: Reply) -> Result<SessionRoundPage, CliFailure> {
    match reply {
        Reply::SessionRounds(value) => Ok(value),
        other => Err(unexpected_reply("session rounds", &other)),
    }
}

fn round_layer(reply: Reply) -> Result<RoundLayer, CliFailure> {
    match reply {
        Reply::RoundLayer(value) => Ok(value),
        other => Err(unexpected_reply("round layer", &other)),
    }
}

fn round_trunk(reply: Reply) -> Result<RoundTrunk, CliFailure> {
    match reply {
        Reply::RoundTrunk(value) => Ok(value),
        other => Err(unexpected_reply("round trunk", &other)),
    }
}

fn blob(reply: Reply) -> Result<genehub_proto::BlobPayload, CliFailure> {
    match reply {
        Reply::Blob(value) => Ok(value),
        other => Err(unexpected_reply("blob", &other)),
    }
}

fn session_context(reply: Reply) -> Result<SessionContext, CliFailure> {
    match reply {
        Reply::SessionContext(value) => Ok(value),
        other => Err(unexpected_reply("session context", &other)),
    }
}

pub fn unexpected_reply(expected: &str, actual: &Reply) -> CliFailure {
    CliFailure::protocol(format!(
        "the local daemon returned {}, expected {expected}",
        reply_kind(actual)
    ))
}

fn reply_kind(reply: &Reply) -> &'static str {
    match reply {
        Reply::Hello(_) => "hello",
        Reply::Subscribed { .. } => "subscribed",
        Reply::Agents(_) => "agents",
        Reply::HubStatus(_) => "hub status",
        Reply::HubClaim { .. } => "hub claim",
        Reply::HubMachines(_) => "hub machines",
        Reply::HubTicket(_) => "hub ticket",
        Reply::Devices { .. } => "devices",
        Reply::Invite(_) => "invite",
        Reply::Claimed(_) => "claimed device",
        Reply::RemoteAccess(_) => "remote access",
        Reply::Settings(_) => "settings",
        Reply::Log(_) => "log",
        Reply::Diagnostics(_) => "diagnostics",
        Reply::Update(_) => "update",
        Reply::UpdateDownload(_) => "update download",
        Reply::Session(_) => "session",
        Reply::Sessions(_) => "sessions",
        Reply::SessionImports(_) => "session imports",
        Reply::Snapshot(_) => "session snapshot",
        Reply::SessionInspection(_) => "session inspection",
        Reply::SessionNarrative(_) => "session narrative",
        Reply::SessionRounds(_) => "session rounds",
        Reply::SessionContext(_) => "session context",
        Reply::RoundLayer(_) => "round layer",
        Reply::RoundTrunk(_) => "round trunk",
        Reply::Blob(_) => "blob",
        Reply::Workspace(_) => "workspace",
        Reply::Workspaces(_) => "workspaces",
        Reply::Directory(_) => "directory",
        Reply::FileTree(_) => "file tree",
        Reply::GitStatus(_) => "git status",
        Reply::GitDiff { .. } => "git diff",
        Reply::GitCommit { .. } => "git commit",
        Reply::Pty { .. } => "pty",
        Reply::Ack => "ack",
    }
}

pub fn rpc_error(error: RpcError) -> CliFailure {
    match error {
        RpcError::Transport(message) => CliFailure::daemon_unavailable(message),
        RpcError::Remote(ProtocolError { code, message }) => match code {
            ErrorCode::BadRequest => CliFailure::business("invalidInput", message, None),
            ErrorCode::Unauthorized => CliFailure::business("unauthenticated", message, None),
            ErrorCode::NotFound => CliFailure::business("targetNotFound", message, None),
            ErrorCode::Conflict => CliFailure::business("conflict", message, None),
            ErrorCode::Unsupported => CliFailure::business("unsupportedCapability", message, None),
            ErrorCode::Forbidden => CliFailure::business("forbidden", message, None),
            ErrorCode::Internal => CliFailure::business("internal", message, None),
            ErrorCode::ProtocolVersion => CliFailure::protocol(message),
            // Not retryable and not fixable by asking for more: this machine
            // cannot confine a process, and an agent told to wait would wait
            // forever (`genet-remote-execution.md` §7.5).
            ErrorCode::IsolationUnavailable => {
                CliFailure::business("isolationUnavailable", message, None)
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::{SessionStatus, TransportKind};

    fn words(input: &[&str]) -> Vec<String> {
        input.iter().map(|word| (*word).to_string()).collect()
    }

    #[test]
    fn parses_the_complete_read_only_command_surface() {
        assert_eq!(
            parse(&words(&["schema"])).unwrap(),
            Query::Schema { command: None }
        );
        assert_eq!(parse(&words(&["context"])).unwrap(), Query::Context);
        assert_eq!(
            parse(&words(&["capabilities"])).unwrap(),
            Query::Capabilities
        );
        assert_eq!(
            parse(&words(&["workspace", "list"])).unwrap(),
            Query::WorkspaceList
        );
        assert_eq!(
            parse(&words(&["workspace", "show", "w_1"])).unwrap(),
            Query::WorkspaceShow {
                workspace_id: "w_1".into()
            }
        );
        assert_eq!(
            parse(&words(&["session", "get", "s_1"])).unwrap(),
            Query::SessionGet {
                session_id: "s_1".into()
            }
        );
        assert_eq!(
            parse(&words(&[
                "session",
                "narrative",
                "s_1",
                "--through-round",
                "r_2",
                "--cursor",
                "before:20",
                "--limit",
                "10",
            ]))
            .unwrap(),
            Query::SessionNarrative {
                session_id: "s_1".into(),
                through_round_id: Some("r_2".into()),
                item_id: None,
                cursor: Some("before:20".into()),
                limit: Some(10),
            }
        );
        assert_eq!(
            parse(&words(&[
                "session", "trunk", "s_1", "--round", "r_2", "--index", "3"
            ]))
            .unwrap(),
            Query::SessionTrunk {
                session_id: "s_1".into(),
                round_id: "r_2".into(),
                index: 3,
            }
        );
        assert_eq!(
            parse(&words(&[
                "session",
                "context",
                "s_1",
                "--budget-tokens",
                "12000"
            ]))
            .unwrap(),
            Query::SessionContext {
                session_id: "s_1".into(),
                through_round_id: None,
                token_budget: Some(12_000),
            }
        );
    }

    #[test]
    fn schema_accepts_both_dotted_and_command_path_names() {
        assert_eq!(
            parse(&words(&["schema", "workspace.list"])).unwrap(),
            Query::Schema {
                command: Some("workspace.list".into())
            }
        );
        assert_eq!(
            parse(&words(&["schema", "workspace", "list"])).unwrap(),
            Query::Schema {
                command: Some("workspace.list".into())
            }
        );
    }

    #[test]
    fn session_list_has_only_an_explicit_optional_workspace() {
        assert_eq!(
            parse(&words(&["session", "list"])).unwrap(),
            Query::SessionList { workspace_id: None }
        );
        assert_eq!(
            parse(&words(&["session", "list", "--workspace", "w_1"])).unwrap(),
            Query::SessionList {
                workspace_id: Some("w_1".into())
            }
        );
        let duplicate = parse(&words(&[
            "session",
            "list",
            "--workspace",
            "w_1",
            "--workspace",
            "w_2",
        ]))
        .unwrap_err();
        assert_eq!(duplicate.code, "invalidArgs");
        assert!(duplicate.message.contains("only once"));
    }

    #[test]
    fn a_device_selector_is_rejected_instead_of_silently_becoming_a_target() {
        let error = parse(&words(&["session", "list", "--device", "node-a"])).unwrap_err();
        assert_eq!(error.code, "invalidArgs");
        assert!(error.message.contains("--device"));
    }

    #[test]
    fn bounded_history_flags_are_strict_and_unambiguous() {
        for args in [
            words(&[
                "session",
                "narrative",
                "s_1",
                "--item",
                "i_1",
                "--cursor",
                "before:2",
            ]),
            words(&["session", "trunks", "s_1"]),
            words(&["session", "trunk", "s_1", "--round", "r_1", "--index", "-1"]),
            words(&["session", "context", "s_1", "--unknown", "x"]),
        ] {
            assert_eq!(parse(&args).unwrap_err().code, "invalidArgs");
        }
    }

    #[test]
    fn blob_references_are_opaque_url_safe_round_trips() {
        let reference = BlobRef {
            id: "0123456789abcdef01234567".into(),
            bytes: 42,
            at: "3:100:42".into(),
        };
        let encoded = encode_blob_ref(&reference);
        assert!(!encoded.contains(['+', '/', '=']));
        assert_eq!(decode_blob_ref(&encoded).unwrap(), reference);
        assert_eq!(decode_blob_ref("not-json").unwrap_err().code, "invalidArgs");
    }

    #[test]
    fn missing_and_extra_arguments_have_the_same_stable_error_code() {
        for args in [
            words(&["workspace", "show"]),
            words(&["workspace", "list", "extra"]),
            words(&["session", "get"]),
            words(&["context", "extra"]),
            words(&["schema", "not.real"]),
        ] {
            assert_eq!(parse(&args).unwrap_err().code, "invalidArgs");
        }
    }

    fn hello() -> HelloResult {
        HelloResult {
            daemon_version: "1.2.3".into(),
            protocol_version: genehub_proto::DATA_PLANE_VERSION,
            machine_id: "m_local".into(),
            fingerprint: "AA-BB".into(),
            transport: TransportKind::Loopback,
            machine_name: "desk".into(),
            rtc_supported: false,
            isolation: None,
        }
    }

    #[test]
    fn context_never_invents_a_workspace_and_says_which_machine_answered() {
        let data = context_data(&hello(), None);
        assert_eq!(data["source"], "localDaemon");
        assert_eq!(data["target"]["resolvedFrom"], "loopback");
        assert_eq!(data["defaultWorkspaceId"], Value::Null);
        assert_eq!(data["workspaceSelection"], "explicitOnly");
        assert_eq!(data["daemon"]["machineId"], "m_local");

        // A mutually authenticated Hello withholds the machine's public
        // identity, so the named machine is the only honest answer for what
        // this resolved to. Reporting the empty string it came back with would
        // read as "nowhere".
        let routed = context_data(&hello(), Some("m_far"));
        assert_eq!(routed["source"], "remoteDaemon");
        assert_eq!(routed["target"]["machineId"], "m_far");
        assert_eq!(routed["target"]["resolvedFrom"], "--machine");
        assert_eq!(routed["target"]["credential"], "pairedDeviceSecret");
    }

    #[test]
    fn schema_and_capabilities_are_complete_without_a_daemon() {
        let schema = schema_data(None);
        assert_eq!(
            schema["commands"].as_array().unwrap().len(),
            COMMAND_NAMES.len()
        );
        assert_eq!(
            schema["commands"][0]["outputSchema"]["properties"]["schema"]["const"],
            CLI_SCHEMA
        );

        let capabilities = capabilities_data();
        assert_eq!(capabilities["source"], "staticCliContract");
        assert_eq!(capabilities["remoteExec"], true);
        assert_eq!(capabilities["remote"]["transports"][0], "rendezvous");
        assert_eq!(capabilities["deviceSelector"], false);
        assert_eq!(capabilities["workspaceSelector"]["implicitDefault"], false);
    }

    #[tokio::test]
    async fn static_introspection_executes_without_opening_an_rpc_connection() {
        let here = Selection::default();
        let (schema_kind, schema) = execute(
            Query::Schema {
                command: Some("session.list".into()),
            },
            &here,
        )
        .await
        .unwrap();
        assert_eq!(schema_kind, "schema");
        assert_eq!(schema["command"]["name"], "session.list");

        let (capability_kind, capabilities) = execute(Query::Capabilities, &here).await.unwrap();
        assert_eq!(capability_kind, "capabilities");
        assert_eq!(capabilities["remoteExec"], true);
    }

    #[test]
    fn an_exact_workspace_miss_names_the_resource_without_guessing() {
        let error = CliFailure::target_not_found("workspace", "w_missing");
        assert_eq!(error.code, "targetNotFound");
        assert_eq!(error.details.unwrap()["workspaceId"], "w_missing");
    }

    #[test]
    fn reply_extractors_accept_only_the_expected_variant() {
        assert!(workspaces(Reply::Workspaces(Vec::new())).is_ok());
        let mismatch = workspaces(Reply::Sessions(Vec::new())).unwrap_err();
        assert_eq!(mismatch.code, "protocolIncompatible");
        assert!(mismatch.message.contains("returned sessions"));

        let summary = SessionSummary {
            id: "s_1".into(),
            workspace_id: "w_1".into(),
            agent_id: "genet".into(),
            title: None,
            status: SessionStatus::Idle,
            model_id: None,
            mode_id: None,
            effort_id: None,
            created_at_ms: 1,
            updated_at_ms: 1,
            archived: false,
            unsupported: None,
            lineage: None,
            imported: None,
        };
        assert_eq!(
            sessions(Reply::Sessions(vec![summary.clone()])).unwrap(),
            vec![summary]
        );
        assert!(sessions(Reply::Ack).is_err());
        assert!(snapshot(Reply::Ack).is_err());
    }

    #[test]
    fn daemon_error_codes_are_mapped_without_parsing_the_message() {
        let forbidden = rpc_error(RpcError::Remote(ProtocolError {
            code: ErrorCode::Forbidden,
            message: "translated wording may change".into(),
        }));
        assert_eq!(forbidden.code, "forbidden");

        let version = rpc_error(RpcError::Remote(ProtocolError {
            code: ErrorCode::ProtocolVersion,
            message: "wrong version".into(),
        }));
        assert_eq!(version.code, "protocolIncompatible");
        assert_eq!(version.exit, crate::EXIT_UNREACHABLE);

        let handshake = connect_error(ConnectError::Rejected(ProtocolError {
            code: ErrorCode::ProtocolVersion,
            message: "wrong version during Hello".into(),
        }));
        assert_eq!(handshake.code, "protocolIncompatible");
        assert!(!handshake.retryable);
    }
}
