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
use crate::rpc::{ConnectError, Rpc, RpcError};

const COMMAND_NAMES: [&str; 7] = [
    "schema",
    "context",
    "capabilities",
    "workspace.list",
    "workspace.show",
    "session.list",
    "session.get",
];

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

pub async fn run(args: &[String]) -> i32 {
    let command = match parse(args) {
        Ok(command) => command,
        Err(error) => return output::fail(error),
    };
    match execute(command).await {
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

async fn execute(command: Query) -> Result<(&'static str, Value), CliFailure> {
    match command {
        Query::Schema { command } => Ok(("schema", schema_data(command.as_deref()))),
        Query::Capabilities => Ok(("capabilities", capabilities_data())),
        Query::Context => {
            let rpc = connect().await?;
            Ok(("context", context_data(rpc.hello())))
        }
        Query::WorkspaceList => {
            let rpc = connect().await?;
            let workspaces =
                workspaces(rpc.call(Request::WorkspaceList).await.map_err(rpc_error)?)?;
            Ok(("workspace.list", json!({"workspaces": workspaces})))
        }
        Query::WorkspaceShow { workspace_id } => {
            let rpc = connect().await?;
            let listed = workspaces(rpc.call(Request::WorkspaceList).await.map_err(rpc_error)?)?;
            let workspace = listed
                .into_iter()
                .find(|workspace| workspace.id == workspace_id)
                .ok_or_else(|| CliFailure::target_not_found("workspace", &workspace_id))?;
            Ok(("workspace.show", json!({"workspace": workspace})))
        }
        Query::SessionList { workspace_id } => {
            let rpc = connect().await?;
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
            let rpc = connect().await?;
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

async fn connect() -> Result<Rpc, CliFailure> {
    Rpc::connect().await.map_err(connect_error)
}

fn connect_error(error: ConnectError) -> CliFailure {
    match error {
        ConnectError::Rejected(ProtocolError {
            code: ErrorCode::ProtocolVersion,
            message,
        })
        | ConnectError::Protocol(message) => CliFailure::protocol(message),
        ConnectError::Rejected(error) => rpc_error(RpcError::Remote(error)),
        ConnectError::Unavailable(message) => CliFailure::daemon_unavailable(format!(
            "could not reach the local daemon: {message}; run `{} daemon start`",
            genet_daemon::channel::CLI_BINARY
        )),
    }
}

fn context_data(hello: &HelloResult) -> Value {
    json!({
        "source": "localDaemon",
        "principal": {"type": "localUser"},
        "defaultWorkspaceId": null,
        "workspaceSelection": "explicitOnly",
        "remoteExec": false,
        "deviceSelector": false,
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
        "readOnly": true,
        "remoteExec": false,
        "deviceSelector": false,
        "workspaceSelector": {
            "kind": "exactId",
            "supportedBy": ["session.list"],
            "implicitDefault": false,
        },
        "commands": COMMAND_NAMES.iter().map(|name| json!({
            "name": name,
            "requiresDaemon": !matches!(*name, "schema" | "capabilities"),
            "mutation": false,
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
        _ => unreachable!("schema names are validated before lookup"),
    };
    json!({
        "name": name,
        "synopsis": synopsis,
        "requiresDaemon": requires_daemon,
        "mutation": false,
        "inputSchema": input,
        "outputSchema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "additionalProperties": false,
            "required": ["schema", "type", "data"],
            "properties": {
                "schema": {"const": CLI_SCHEMA},
                "type": {"const": name},
                "data": {"type": "object"},
            }
        }
    })
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

fn unexpected_reply(expected: &str, actual: &Reply) -> CliFailure {
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
        Reply::Workspace(_) => "workspace",
        Reply::Workspaces(_) => "workspaces",
        Reply::Directory(_) => "directory",
        Reply::FileTree(_) => "file tree",
        Reply::FileContent(_) => "file content",
        Reply::ResourceMeta(_) => "resource meta",
        Reply::ResourceContent(_) => "resource content",
        Reply::ResourceList(_) => "resource list",
        Reply::GitStatus(_) => "git status",
        Reply::GitDiff { .. } => "git diff",
        Reply::GitCommit { .. } => "git commit",
        Reply::Pty { .. } => "pty",
        Reply::Ack => "ack",
    }
}

fn rpc_error(error: RpcError) -> CliFailure {
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

    #[test]
    fn context_is_explicitly_local_and_never_invents_a_workspace() {
        let data = context_data(&HelloResult {
            daemon_version: "1.2.3".into(),
            protocol_version: 1,
            machine_id: "m_local".into(),
            fingerprint: "AA-BB".into(),
            transport: TransportKind::Loopback,
            machine_name: "desk".into(),
            proof: None,
            server_nonce: None,
        });

        assert_eq!(data["source"], "localDaemon");
        assert_eq!(data["remoteExec"], false);
        assert_eq!(data["defaultWorkspaceId"], Value::Null);
        assert_eq!(data["workspaceSelection"], "explicitOnly");
        assert_eq!(data["daemon"]["machineId"], "m_local");
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
        assert_eq!(capabilities["remoteExec"], false);
        assert_eq!(capabilities["deviceSelector"], false);
        assert_eq!(capabilities["workspaceSelector"]["implicitDefault"], false);
    }

    #[tokio::test]
    async fn static_introspection_executes_without_opening_an_rpc_connection() {
        let (schema_kind, schema) = execute(Query::Schema {
            command: Some("session.list".into()),
        })
        .await
        .unwrap();
        assert_eq!(schema_kind, "schema");
        assert_eq!(schema["command"]["name"], "session.list");

        let (capability_kind, capabilities) = execute(Query::Capabilities).await.unwrap();
        assert_eq!(capability_kind, "capabilities");
        assert_eq!(capabilities["remoteExec"], false);
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
