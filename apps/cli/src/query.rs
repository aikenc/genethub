//! Agent-friendly, read-only CLI commands.
//!
//! Every dynamic answer in this module comes from the existing loopback daemon
//! RPC. There is deliberately no device selector, remote transport, mutation,
//! cwd inference, or remembered-target fallback in this slice.

use genehub_proto::{
    ErrorCode, HelloResult, ProtocolError, Reply, Request, SessionSnapshot, SessionSummary,
    WorkspaceInfo,
};
use serde_json::{json, Value};

use crate::output::{self, CliFailure, CLI_SCHEMA};
use crate::rpc::{ConnectError, Refusal, Rpc, RpcError};
use crate::target::{self, Routing, Selection};

const COMMAND_NAMES: [&str; 20] = [
    "schema",
    "context",
    "capabilities",
    "workspace.list",
    "workspace.show",
    "session.list",
    "session.get",
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
        "agent.run"
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
    Schema { command: Option<String> },
    Context,
    Capabilities,
    WorkspaceList,
    WorkspaceShow { workspace_id: String },
    SessionList { workspace_id: Option<String> },
    SessionGet { session_id: String },
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
            "usage: genet session list [--workspace <id>] | genet session get <id>",
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
        _ => Err(CliFailure::invalid_args(format!(
            "unknown session command: {verb}"
        ))),
    }
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
    }
}

/// The workspace catalogue, shared with the conversation surface so both
/// resolve `--workspace` and `--cwd` against exactly the same list.
pub async fn list_workspaces(rpc: &Rpc) -> Result<Vec<WorkspaceInfo>, CliFailure> {
    workspaces(rpc.call(Request::WorkspaceList).await.map_err(rpc_error)?)
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
        // What the target machine will let a command touch. Arbitrary commands
        // are not offered at all yet, so there is nothing to isolate and the
        // engine is absent rather than "none" — an agent must not read a
        // missing sandbox as a permissive one.
        "isolation": {"arbitraryCommands": false, "engine": null},
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
        "outputSchema": if streams(name) { stream_output() } else { single_output(name) },
    })
}

fn streams(name: &str) -> bool {
    matches!(name, "agent.run" | "session.send")
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
        Reply::Update(_) => "update",
        Reply::UpdateDownload(_) => "update download",
        Reply::Session(_) => "session",
        Reply::Sessions(_) => "sessions",
        Reply::Snapshot(_) => "session snapshot",
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
