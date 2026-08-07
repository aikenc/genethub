//! Request dispatch: one `Request` in, one `Reply` or `ProtocolError` out.
//!
//! Kept free of transport concerns so the same routing serves loopback and
//! forwarded connections without duplication. Legacy LAN is rejected at bind.

use std::path::Path;
use std::sync::Arc;

use genehub_proto::{
    ErrorCode, HelloResult, ProtocolError, Reply, Request, TransportKind, PROTOCOL_VERSION,
};
use tokio::sync::broadcast;

use crate::state::Shared;
use crate::{files, git};

/// What a handled request may ask the connection to do beyond replying.
pub enum SideEffect {
    None,
    Subscribe {
        session_id: String,
        receiver: broadcast::Receiver<genehub_proto::SequencedEvent>,
    },
    Unsubscribe {
        session_id: String,
    },
}

pub struct Handled {
    pub reply: Result<Reply, ProtocolError>,
    pub effect: SideEffect,
}

impl Handled {
    fn ok(reply: Reply) -> Self {
        Handled {
            reply: Ok(reply),
            effect: SideEffect::None,
        }
    }

    fn err(code: ErrorCode, message: impl Into<String>) -> Self {
        Handled {
            reply: Err(ProtocolError {
                code,
                message: message.into(),
            }),
            effect: SideEffect::None,
        }
    }
}

/// Maps an internal failure onto a client-visible error.
///
/// Everything that reaches a user goes through here, so the wording is worth
/// keeping honest: `docs/testing.md` §4.4 requires every failure to say
/// something actionable rather than render blank.
fn failed(error: anyhow::Error) -> Handled {
    let message = format!("{error:#}");
    let code = if message.contains("escapes the workspace") {
        ErrorCode::Forbidden
    } else if message.contains("already running") {
        ErrorCode::Conflict
    } else if message.contains("no such") {
        ErrorCode::NotFound
    } else if message.contains("does not") || message.contains("not supported") {
        ErrorCode::Unsupported
    } else {
        ErrorCode::Internal
    };
    Handled {
        reply: Err(ProtocolError { code, message }),
        effect: SideEffect::None,
    }
}

pub async fn handle(state: &Shared, transport: TransportKind, request: Request) -> Handled {
    match request {
        Request::ConnectionIdentity => Handled::ok(Reply::Hello(HelloResult {
            daemon_version: state.version.clone(),
            protocol_version: PROTOCOL_VERSION,
            machine_id: state.machine.machine_id.clone(),
            fingerprint: state.machine.fingerprint(),
            transport,
            machine_name: crate::link::default_display_name(),
            rtc_supported: true,
        })),

        Request::Subscribe {
            session_id,
            since_seq,
            expand_last_round,
        } => match state
            .sessions
            .subscribe(&session_id, since_seq, expand_last_round)
            .await
        {
            Ok((snapshot, replayed, reset, receiver)) => Handled {
                reply: Ok(Reply::Subscribed {
                    snapshot,
                    replayed,
                    reset,
                }),
                effect: SideEffect::Subscribe {
                    session_id,
                    receiver,
                },
            },
            Err(error) => failed(error),
        },

        Request::Unsubscribe { session_id } => Handled {
            reply: Ok(Reply::Ack),
            effect: SideEffect::Unsubscribe { session_id },
        },

        Request::AgentList => {
            let providers = state.providers().await;
            Handled::ok(Reply::Agents(state.registry.list(&providers).await))
        }

        Request::AgentRefresh => {
            let providers = state.providers().await;
            Handled::ok(Reply::Agents(state.registry.refresh(&providers).await))
        }

        Request::SessionCreate {
            workspace_id,
            agent_id,
            model_id,
            mode_id,
            title,
        } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match state
                .sessions
                .create(
                    &workspace_id,
                    workspace.root,
                    &agent_id,
                    model_id,
                    mode_id,
                    title,
                )
                .await
            {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }

        Request::SessionList {
            workspace_id,
            include_archived,
        } => match state
            .sessions
            .list(workspace_id.as_deref(), include_archived)
            .await
        {
            Ok(sessions) => Handled::ok(Reply::Sessions(sessions)),
            Err(error) => failed(error),
        },

        Request::SessionGet { session_id } => match state.sessions.snapshot(&session_id).await {
            Ok(snapshot) => Handled::ok(Reply::Snapshot(snapshot)),
            Err(error) => failed(error),
        },

        Request::RoundTrunkList {
            session_id,
            round_id,
            cursor,
            limit,
        } => match state
            .sessions
            .round_layer(&session_id, &round_id, cursor.as_deref(), limit)
            .await
        {
            Ok(layer) => Handled::ok(Reply::RoundLayer(layer)),
            Err(error) => failed(error),
        },

        Request::RoundTrunkGet {
            session_id,
            round_id,
            trunk_index,
        } => match state
            .sessions
            .round_trunk(&session_id, &round_id, trunk_index)
            .await
        {
            Ok(trunk) => Handled::ok(Reply::RoundTrunk(trunk)),
            Err(error) => failed(error),
        },

        Request::BlobGet { session_id, blob } => {
            match state.sessions.blob(&session_id, &blob).await {
                Ok(blob) => Handled::ok(Reply::Blob(blob)),
                Err(error) => failed(error),
            }
        }

        Request::SessionSend {
            session_id,
            text,
            attachments,
            continues_round,
        } => {
            if text.trim().is_empty() && attachments.is_empty() {
                return Handled::err(ErrorCode::BadRequest, "there is nothing to send");
            }
            let providers = state.providers().await;
            match state
                .sessions
                .send(&session_id, text, attachments, &providers, continues_round)
                .await
            {
                Ok(_) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::SessionFork {
            session_id,
            turn_id,
        } => {
            let providers = state.providers().await;
            match state.sessions.fork(&session_id, &turn_id, &providers).await {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }

        Request::SessionInterrupt { session_id } => {
            match state.sessions.interrupt(&session_id).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::SessionClose { session_id } => match state.sessions.close(&session_id).await {
            Ok(()) => Handled::ok(Reply::Ack),
            Err(error) => failed(error),
        },

        Request::SessionArchive {
            session_id,
            archived,
        } => match state.sessions.archive(&session_id, archived).await {
            Ok(summary) => Handled::ok(Reply::Session(summary)),
            Err(error) => failed(error),
        },

        Request::SessionRename { session_id, title } => {
            match state.sessions.rename(&session_id, &title).await {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }

        Request::SessionDelete { session_id } => match state.sessions.delete(&session_id).await {
            Ok(()) => Handled::ok(Reply::Ack),
            Err(error) => failed(error),
        },

        Request::SessionSetModel {
            session_id,
            model_id,
        } => {
            let providers = state.providers().await;
            match state
                .sessions
                .set_model(&session_id, &model_id, &providers)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::SessionSetMode {
            session_id,
            mode_id,
        } => {
            let providers = state.providers().await;
            match state
                .sessions
                .set_mode(&session_id, &mode_id, &providers)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::SessionSetEffort {
            session_id,
            effort_id,
        } => {
            let providers = state.providers().await;
            match state
                .sessions
                .set_effort(&session_id, &effort_id, &providers)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::SessionRespondPermission {
            session_id,
            request_id,
            outcome,
        } => {
            let providers = state.providers().await;
            match state
                .sessions
                .respond_permission(&session_id, &request_id, outcome, &providers)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::SettingsGet => Handled::ok(Reply::Settings(state.settings().await)),

        Request::SettingsSetProvider {
            provider_id,
            api_key,
            base_url,
            label,
            dialect,
            models,
        } => match state
            .set_provider(&provider_id, api_key, base_url, label, dialect, models)
            .await
        {
            Ok(settings) => Handled::ok(Reply::Settings(settings)),
            Err(error) => failed(error),
        },

        Request::LogTail { name } => {
            let dir = state.paths.logs_dir();
            // The daemon's own log by default: nearly every error someone opens
            // this for is the daemon's or an agent's, and both land there.
            let name = name.unwrap_or_else(|| "daemon.log".to_string());
            match crate::logs::tail(&dir, &name, crate::logs::DEFAULT_TAIL_BYTES) {
                Ok(text) => Handled::ok(Reply::Log(genehub_proto::LogTail {
                    path: dir.join(&name).display().to_string(),
                    name,
                    text,
                    files: crate::logs::list(&dir)
                        .into_iter()
                        .map(|(name, bytes)| genehub_proto::LogEntry { name, bytes })
                        .collect(),
                })),
                Err(error) => failed(error),
            }
        }

        Request::UpdateCheck => automatic_update_refusal(),

        Request::UpdateDownload => automatic_update_refusal(),

        Request::UpdateDownloadState => Handled::ok(Reply::UpdateDownload(state.updates.state())),

        Request::UpdateDismiss => Handled::ok(Reply::UpdateDownload(state.updates.dismiss(state))),

        Request::SettingsForgetProvider { provider_id } => {
            match state.forget_provider(&provider_id).await {
                Ok(settings) => Handled::ok(Reply::Settings(settings)),
                Err(error) => failed(error),
            }
        }

        Request::HubStatus => match state.link.get() {
            Some(link) => Handled::ok(Reply::HubStatus(link.status().await)),
            None => Handled::ok(Reply::HubStatus(genehub_proto::HubStatus::Unpaired)),
        },

        Request::HubPair {
            hub_url,
            display_name,
        } => {
            let Some(link) = state.link.get() else {
                return Handled::err(ErrorCode::Internal, "the daemon is still starting up");
            };
            match link.pair(&hub_url, display_name).await {
                Ok(status) => Handled::ok(Reply::HubStatus(status)),
                Err(error) => {
                    // Being already paired is the user's situation to fix, not
                    // a fault, so it comes back as a conflict rather than a 500.
                    let message = format!("{error:#}");
                    let code = if message.contains("already paired") {
                        ErrorCode::Conflict
                    } else {
                        ErrorCode::Internal
                    };
                    Handled::err(code, message)
                }
            }
        }

        Request::HubTrial {
            hub_url,
            display_name,
        } => {
            let Some(link) = state.link.get() else {
                return Handled::err(ErrorCode::Internal, "the daemon is still starting up");
            };
            match link.trial(&hub_url, display_name).await {
                Ok((status, trial)) => Handled::ok(Reply::HubClaim {
                    status,
                    claim: trial,
                }),
                Err(error) => {
                    let message = format!("{error:#}");
                    let code = if message.contains("already paired") {
                        ErrorCode::Conflict
                    } else {
                        ErrorCode::Internal
                    };
                    Handled::err(code, message)
                }
            }
        }

        Request::HubClaimLink => {
            let Some(link) = state.link.get() else {
                return Handled::err(ErrorCode::Internal, "the daemon is still starting up");
            };
            match link.claim_link().await {
                Ok(trial) => Handled::ok(Reply::HubClaim {
                    status: link.status().await,
                    claim: trial,
                }),
                Err(error) => failed(error),
            }
        }

        Request::HubMachines => match state.link.get() {
            Some(link) => match link.machines().await {
                Ok(machines) => Handled::ok(Reply::HubMachines(machines)),
                Err(error) => failed(error),
            },
            // Still starting up is not "you have no machines", but a switcher
            // showing an error for the second it takes would be worse than one
            // that fills in a moment later.
            None => Handled::ok(Reply::HubMachines(Vec::new())),
        },

        Request::HubConnect { machine_id } => {
            let Some(link) = state.link.get() else {
                return Handled::err(ErrorCode::Internal, "the daemon is still starting up");
            };
            match link.connect(&machine_id).await {
                Ok(ticket) => Handled::ok(Reply::HubTicket(ticket)),
                Err(error) => failed(error),
            }
        }

        Request::HubUnpair => match state.link.get() {
            Some(link) => match link.unpair().await {
                Ok(()) => Handled::ok(Reply::HubStatus(genehub_proto::HubStatus::Unpaired)),
                Err(error) => failed(error),
            },
            None => Handled::ok(Reply::HubStatus(genehub_proto::HubStatus::Unpaired)),
        },

        Request::DeviceList => Handled::ok(Reply::Devices {
            devices: state.devices.list(),
            remote: remote_status(state).await,
        }),

        Request::DeviceInvite => {
            let mut invite = state.devices.invite();
            invite.rendezvous_url = remote_status(state).await.rendezvous_url;
            Handled::ok(Reply::Invite(invite))
        }

        // The protocol-v3 peer handshake authenticates an invitation before
        // this RPC exists. `handle_rpc` consumes the invitation on that narrow
        // bootstrap endpoint; an ordinary authenticated peer cannot claim one.
        Request::DeviceClaim { .. } => Handled::err(
            ErrorCode::Unauthorized,
            "配对邀请只能在对应的加密引导连接中兑换",
        ),

        Request::DeviceRevoke { device_id } => match state.devices.revoke(&device_id) {
            Ok(_) => Handled::ok(Reply::Devices {
                devices: state.devices.list(),
                remote: remote_status(state).await,
            }),
            Err(error) => failed(error),
        },

        Request::DeviceRemoteAttach {
            relay_url,
            join_token,
        } => {
            let Some(remote) = state.remote.get() else {
                return Handled::err(ErrorCode::Internal, "the daemon is still starting up");
            };
            match remote.set(&relay_url, join_token).await {
                Ok(status) => Handled::ok(Reply::RemoteAccess(status)),
                Err(error) => Handled::err(ErrorCode::BadRequest, format!("{error:#}")),
            }
        }

        Request::DeviceRemoteDetach => match state.remote.get() {
            Some(remote) => match remote.clear().await {
                Ok(status) => Handled::ok(Reply::RemoteAccess(status)),
                Err(error) => failed(error),
            },
            None => Handled::ok(Reply::RemoteAccess(genehub_proto::RemoteAccess {
                relay_url: None,
                rendezvous_url: None,
                online: false,
            })),
        },

        Request::WorkspaceList => Handled::ok(Reply::Workspaces(state.workspaces.list().await)),

        Request::WorkspaceOpen { root } => {
            match state.workspaces.open(Path::new(&root), None).await {
                Ok(workspace) => Handled::ok(Reply::Workspace(workspace)),
                Err(error) => failed(error),
            }
        }

        Request::WorkspaceCreate { root, name } => {
            let path = Path::new(&root);
            if let Err(error) = std::fs::create_dir_all(path) {
                return Handled::err(
                    ErrorCode::BadRequest,
                    format!("could not create {root}: {error}"),
                );
            }
            match state.workspaces.open(path, Some(name)).await {
                Ok(workspace) => Handled::ok(Reply::Workspace(workspace)),
                Err(error) => failed(error),
            }
        }

        Request::WorkspaceRename { workspace_id, name } => {
            match state.workspaces.rename(&workspace_id, &name).await {
                Ok(workspace) => Handled::ok(Reply::Workspace(workspace)),
                Err(error) => Handled::err(ErrorCode::BadRequest, format!("{error:#}")),
            }
        }

        Request::DirectoryList { path } => {
            match crate::workspace::list_directory(path.as_deref().map(Path::new)) {
                Ok(listing) => Handled::ok(Reply::Directory(listing)),
                Err(error) => failed(error),
            }
        }

        Request::FileTree {
            workspace_id,
            path,
            depth,
        } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            let target = match state
                .workspaces
                .resolve(&workspace_id, path.as_deref().unwrap_or("."))
                .await
            {
                Ok(target) => target,
                Err(error) => return failed(error),
            };
            match files::tree(&workspace.root, &target, depth.unwrap_or(2).min(8)) {
                Ok(tree) => Handled::ok(Reply::FileTree(tree)),
                Err(error) => failed(error),
            }
        }

        Request::FileWrite {
            workspace_id,
            path,
            content,
        } => {
            let target = match state.workspaces.resolve(&workspace_id, &path).await {
                Ok(target) => target,
                Err(error) => return failed(error),
            };
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match files::write(&workspace.root, &target, &content) {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::GitStatus { workspace_id } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match git::status(&workspace.root).await {
                Ok(status) => Handled::ok(Reply::GitStatus(status)),
                Err(error) => failed(error),
            }
        }

        Request::GitDiff { workspace_id, path } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match git::diff(&workspace.root, path.as_deref()).await {
                Ok(diff) => Handled::ok(Reply::GitDiff { diff }),
                Err(error) => failed(error),
            }
        }

        Request::GitCommit {
            workspace_id,
            message,
            paths,
        } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match git::commit(&workspace.root, &message, &paths).await {
                Ok(commit) => Handled::ok(Reply::GitCommit { commit }),
                Err(error) => failed(error),
            }
        }

        Request::PtyOpen {
            workspace_id,
            cols,
            rows,
        } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match state
                .terminals
                .open(&workspace.root, cols.unwrap_or(80), rows.unwrap_or(24))
                .await
            {
                Ok(pty_id) => Handled::ok(Reply::Pty { pty_id }),
                Err(error) => failed(error),
            }
        }

        Request::PtyWrite { pty_id, data } => match state.terminals.write(&pty_id, &data).await {
            Ok(()) => Handled::ok(Reply::Ack),
            Err(error) => failed(error),
        },

        Request::PtyResize { pty_id, cols, rows } => {
            match state.terminals.resize(&pty_id, cols, rows).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::PtyClose { pty_id } => match state.terminals.close(&pty_id).await {
            Ok(()) => Handled::ok(Reply::Ack),
            Err(error) => failed(error),
        },
    }
}

/// Integrity metadata delivered beside a binary is not an authenticity root.
/// Until releases have an independently pinned signing key, no protocol caller
/// may make this machine fetch or execute an update.
fn automatic_update_refusal() -> Handled {
    Handled::err(
        ErrorCode::Unsupported,
        "自动更新尚未启用：请从官方发布页手动下载，并核对 SHA256SUMS",
    )
}

async fn remote_status(state: &Shared) -> genehub_proto::RemoteAccess {
    match state.remote.get() {
        Some(remote) => remote.status().await,
        None => genehub_proto::RemoteAccess {
            relay_url: None,
            rendezvous_url: None,
            online: false,
        },
    }
}

pub fn transport_for(remote: Option<std::net::IpAddr>) -> TransportKind {
    match remote {
        Some(ip) if ip.is_loopback() => TransportKind::Loopback,
        Some(_) => TransportKind::Lan,
        None => TransportKind::Forwarded,
    }
}

pub type SharedState = Arc<crate::state::AppState>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn loopback_and_lan_addresses_are_distinguished() {
        assert_eq!(
            transport_for(Some(IpAddr::V4(Ipv4Addr::LOCALHOST))),
            TransportKind::Loopback
        );
        assert_eq!(
            transport_for(Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5)))),
            TransportKind::Lan
        );
        assert_eq!(transport_for(None), TransportKind::Forwarded);
    }

    #[test]
    fn workspace_escapes_are_reported_as_forbidden_not_internal() {
        let handled = failed(anyhow::anyhow!("path escapes the workspace"));
        match handled.reply {
            Err(error) => assert_eq!(error.code, ErrorCode::Forbidden),
            Ok(_) => panic!("expected an error"),
        }
    }

    #[test]
    fn a_missing_entity_is_reported_as_not_found() {
        let handled = failed(anyhow::anyhow!("no such session: s1"));
        match handled.reply {
            Err(error) => assert_eq!(error.code, ErrorCode::NotFound),
            Ok(_) => panic!("expected an error"),
        }
    }

    #[test]
    fn unsigned_update_entry_points_fail_closed() {
        let handled = automatic_update_refusal();
        match handled.reply {
            Err(error) => {
                assert_eq!(error.code, ErrorCode::Unsupported);
                assert!(error.message.contains("手动下载"));
                assert!(error.message.contains("SHA256SUMS"));
            }
            Ok(_) => panic!("an unsigned updater entry point was enabled"),
        }
    }
}
