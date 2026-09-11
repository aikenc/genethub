//! Authenticated loopback run adapter. Registry secrets never enter a workspace
//! preview or browser. Every socket proves the current run before application bytes.
use super::endpoint::{PeerServices, ServerStream, StreamInput};
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use genehub_proto::ExchangeResponseHead;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};

const MAX_PACKET: usize = 256 * 1024;
static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    workspace_handle: String,
    entry_path: String,
    #[serde(default)]
    run_id: Option<String>,
    operation: String,
    #[serde(default)]
    allow_turn: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    version: u32,
    #[serde(default)]
    pid: u32,
    #[serde(default)]
    control: bool,
    entry: String,
    run_id: String,
    secret: String,
    port: u16,
    name: String,
    routes: Value,
    media: Value,
    #[serde(default)]
    ice_servers: Vec<Value>,
    #[serde(default)]
    data_policy: String,
}
fn signed(secret: &str, text: &str) -> Result<Vec<u8>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())?;
    mac.update(text.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn control(value: Value) -> Vec<u8> {
    let mut b = vec![0];
    b.extend(serde_json::to_vec(&value).unwrap());
    b
}
async fn recv(socket: &mut crate::transport::ws::Socket) -> Result<Vec<u8>> {
    loop {
        match socket.next().await.context("service run closed")?? {
            Message::Binary(bytes) if !bytes.is_empty() && bytes.len() <= MAX_PACKET => {
                return Ok(bytes)
            }
            Message::Ping(_) | Message::Pong(_) => continue,
            _ => return Err(anyhow!("invalid service run packet")),
        }
    }
}
async fn connect(run: &Run) -> Result<crate::transport::ws::Socket> {
    let config = WebSocketConfig {
        max_message_size: Some(MAX_PACKET),
        max_frame_size: Some(MAX_PACKET),
        ..Default::default()
    };
    let mut socket =
        crate::transport::ws::connect(&format!("ws://127.0.0.1:{}/", run.port), config).await?;
    let nonce = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    socket
        .send(Message::Binary(control(json!({"nonce":nonce}))))
        .await?;
    let answer = recv(&mut socket).await?;
    if answer[0] != 0 {
        anyhow::bail!("invalid service proof");
    }
    let value: Value = serde_json::from_slice(&answer[1..])?;
    let actual = value["proof"].as_str().context("missing run proof")?;
    let expected = hex(&signed(
        &run.secret,
        &format!("server:{nonce}:{}", run.run_id),
    )?);
    // Compare through HMAC verification rather than an early-exit string comparison.
    let mut verifier = Hmac::<Sha256>::new_from_slice(run.secret.as_bytes())?;
    verifier.update(actual.as_bytes());
    let tag = signed(&run.secret, &expected)?;
    verifier
        .verify_slice(&tag)
        .map_err(|_| anyhow!("service run identity changed"))?;
    socket
        .send(Message::Binary(control(
            json!({"proof":hex(&signed(&run.secret,&format!("client:{nonce}:{}",run.run_id))?)}),
        )))
        .await?;
    let ready = recv(&mut socket).await?;
    if ready[0] != 0 || serde_json::from_slice::<Value>(&ready[1..])?["kind"] != "ready" {
        anyhow::bail!("run not ready");
    }
    Ok(socket)
}
async fn load(services: &PeerServices, req: &Request) -> Result<Option<Run>> {
    let access = &services.access;
    let workspace_id = match access.workspace_id.as_deref() {
        Some(id) => {
            if req.workspace_handle != access.workspace_handle.as_deref().unwrap_or(id) {
                anyhow::bail!("workspace denied");
            }
            id
        }
        None => &req.workspace_handle,
    };
    load_entry(&services.state, workspace_id, &req.entry_path).await
}
async fn load_entry(
    state: &crate::state::Shared,
    workspace_id: &str,
    entry_path: &str,
) -> Result<Option<Run>> {
    let resolved = state.workspaces.resolve(workspace_id, entry_path).await?;
    let entry = std::fs::canonicalize(resolved.absolute)?;
    let native = crate::guest_paths::host_form(&entry.to_string_lossy()).into_owned();
    let entry_identity = if crate::guest_paths::windows_host() {
        native
            .strip_prefix(r"\\?\")
            .unwrap_or(&native)
            .replace("\\", "/")
    } else {
        native.clone()
    };
    let key = hex(&Sha256::digest(entry_identity.as_bytes()));
    let directory = state.paths.root.join("service-previews");
    if !directory.exists() {
        return Ok(None);
    }
    crate::config::reject_link_or_reparse(
        &directory,
        &crate::config::sensitive_metadata(&directory)?,
    )?;
    crate::config::restrict_dir_to_owner(&directory)?;
    let path = directory.join(format!("{key}.json"));
    let metadata = match crate::config::sensitive_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    crate::config::reject_link_or_reparse(&path, &metadata)?;
    if metadata.len() > 16 * 1024 || !metadata.is_file() {
        anyhow::bail!("invalid service registration");
    }
    crate::config::restrict_to_owner(&path)?;
    let run: Run = serde_json::from_slice(&std::fs::read(path)?)?;
    if run.version != 1
        || (if crate::guest_paths::windows_host() {
            run.entry.replace("\\", "/")
        } else {
            run.entry.clone()
        }) != entry_identity
        || run.port == 0
        || run.secret.len() != 64
        || run.run_id.len() != 32
    {
        anyhow::bail!("invalid service registration");
    }
    Ok(Some(run))
}
pub(super) async fn handle(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    let req: Request = serde_json::from_value(stream.head.metadata.clone())?;
    if req.operation != "describe" && req.operation != "connect" && req.operation != "ice" {
        anyhow::bail!("unknown preview operation");
    }
    let Some(run) = load(services, &req).await? else {
        stream
            .respond(&ExchangeResponseHead {
                status: 404,
                metadata: Value::Null,
                body_length: Some(0),
                error: None,
            })
            .await?;
        return stream.finish().await;
    };
    if req.run_id.as_ref().is_some_and(|id| id != &run.run_id) {
        anyhow::bail!("service run changed; reopen preview");
    }
    if req.operation == "ice" {
        stream.read_body(0).await?;
        if req.run_id.as_deref() != Some(&run.run_id) {
            anyhow::bail!("run identity required");
        }
        let mut socket = tokio::time::timeout(Duration::from_secs(5), connect(&run)).await??;
        socket.close(None).await?;
        let value = if req.allow_turn {
            let link = services
                .state
                .link
                .get()
                .context("TURN requires a configured Channel")?;
            tokio::time::timeout(Duration::from_secs(5), link.rtc_config(Some(&run.run_id)))
                .await??
        } else if !run.ice_servers.is_empty() {
            json!({"version":1,"iceServers":run.ice_servers})
        } else {
            super::rtc::ice_config(&services.state).await
        };
        let body = serde_json::to_vec(&value)?;
        stream
            .respond(&ExchangeResponseHead {
                status: 200,
                metadata: Value::Null,
                body_length: Some(body.len() as u64),
                error: None,
            })
            .await?;
        stream.write(&body).await?;
        return stream.finish().await;
    }
    if req.operation == "describe" {
        if !stream.read_body(0).await?.is_empty() {
            anyhow::bail!("describe has no body");
        }
        let mut socket = tokio::time::timeout(Duration::from_secs(5), connect(&run)).await??;
        socket.close(None).await?;
        let body = serde_json::to_vec(
            &json!({"version":1,"runId":run.run_id,"name":run.name,"routes":run.routes,"media":run.media,"iceServers":run.ice_servers,"dataPolicy":run.data_policy}),
        )?;
        stream
            .respond(&ExchangeResponseHead {
                status: 200,
                metadata: Value::Null,
                body_length: Some(body.len() as u64),
                error: None,
            })
            .await?;
        stream.write(&body).await?;
        return stream.finish().await;
    }
    if req.run_id.as_deref() != Some(&run.run_id) {
        anyhow::bail!("run identity required");
    }
    if run.data_policy == "direct-only"
        && !matches!(services.carrier_kind, super::endpoint::CarrierKind::Rtc)
        && services.access.transport != genehub_proto::TransportKind::Loopback
    {
        anyhow::bail!("service requires direct transport");
    }
    let _slot = SLOTS
        .get_or_init(|| Arc::new(Semaphore::new(32)))
        .clone()
        .try_acquire_owned()?;
    let mut socket = tokio::time::timeout(Duration::from_secs(5), connect(&run)).await??;
    stream
        .respond(&ExchangeResponseHead {
            status: 200,
            metadata: Value::Null,
            body_length: None,
            error: None,
        })
        .await?;
    let mut pending = Vec::new();
    let lifetime = tokio::time::sleep(Duration::from_secs(3600));
    tokio::pin!(lifetime);
    loop {
        tokio::select! {
            _ = &mut lifetime => { return Err(anyhow!("preview session expired")); }
            input = stream.next_input() => match input? {
                StreamInput::Chunk(bytes) => {
                    pending.extend(bytes);
                    if pending.len() > MAX_PACKET + 4 + 16*1024 { anyhow::bail!("service packet exceeds limit"); }
                    while pending.len() >= 4 {
                        let size=u32::from_be_bytes(pending[..4].try_into().unwrap()) as usize;
                        if size==0 || size>MAX_PACKET { anyhow::bail!("invalid service packet length"); }
                        if pending.len()<size+4 {break;}
                        let packet=pending[4..size+4].to_vec(); pending.drain(..size+4);
                        tokio::time::timeout(Duration::from_secs(30), socket.send(Message::Binary(packet))).await??;
                    }
                },
                StreamInput::Fin | StreamInput::Reset(_) => { let _=socket.close(None).await; return stream.finish().await; }
            },
            packet = recv(&mut socket) => {
                let packet=packet?;
                let mut framed=(packet.len() as u32).to_be_bytes().to_vec(); framed.extend(&packet);
                // Credit remains bounded at the browser stream. ACK only after downstream write.
                tokio::time::timeout(Duration::from_secs(30),stream.write(&framed)).await??;
                tokio::time::timeout(Duration::from_secs(30), socket.send(Message::Binary(vec![2]))).await??;
                if packet[0]==0 {
                    let value:Value=serde_json::from_slice(&packet[1..])?;
                    if value["kind"]=="end" || value["kind"]=="close" { return stream.finish().await; }
                }
            }
        }
    }
}

/// Enrich the existing process snapshot. Private registration material never leaves the daemon.
pub(crate) async fn process_snapshot(
    state: &crate::state::Shared,
    caller: &crate::authz::Principal,
    workspace: Option<&str>,
) -> Result<Vec<genehub_proto::BackgroundProcess>> {
    if let Some(id) = workspace {
        state.workspaces.get(id).await?;
    }
    let mut rows = state.processes.list().await;
    let sessions = state.sessions.list(None, true).await?;
    for row in &mut rows {
        row.workspace_id = sessions
            .iter()
            .find(|s| s.id == row.session_id)
            .map(|s| s.workspace_id.clone());
    }
    rows.retain(|r| workspace.is_none_or(|w| r.workspace_id.as_deref() == Some(w)));
    if !caller.allows(crate::authz::Capability::Services) {
        return Ok(rows);
    }
    let directory = state.paths.root.join("service-previews");
    if !directory.exists() {
        return Ok(rows);
    }
    crate::config::reject_link_or_reparse(
        &directory,
        &crate::config::sensitive_metadata(&directory)?,
    )?;
    crate::config::restrict_dir_to_owner(&directory)?;
    let mut registrations = Vec::new();
    for item in std::fs::read_dir(&directory)?.take(128) {
        let path = item?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(metadata) = crate::config::sensitive_metadata(&path) else {
            continue;
        };
        if !metadata.is_file()
            || metadata.len() > 16384
            || crate::config::reject_link_or_reparse(&path, &metadata).is_err()
        {
            continue;
        }
        crate::config::restrict_to_owner(&path)?;
        let Ok(run) = serde_json::from_slice::<Run>(&std::fs::read(path)?) else {
            continue;
        };
        if run.pid > 0 {
            registrations.push(run);
        }
    }
    let mut candidates = Vec::new();
    for info in state.workspaces.list().await {
        if workspace.is_some_and(|w| w != info.id) {
            continue;
        }
        let entry = state.workspaces.get(&info.id).await?;
        for run in &registrations {
            let Ok(absolute) = std::fs::canonicalize(crate::guest_paths::guest_path(
                std::path::Path::new(&run.entry),
            )) else {
                continue;
            };
            for folder in &entry.folders {
                let Ok(root) = std::fs::canonicalize(&folder.root) else {
                    continue;
                };
                let Ok(relative) = absolute.strip_prefix(root) else {
                    continue;
                };
                let path = format!(
                    "{}/{}",
                    folder.root_handle,
                    relative.to_string_lossy().replace('\\', "/")
                );
                if let Ok(Some(verified)) = load_entry(state, &info.id, &path).await {
                    candidates.push((info.id.clone(), path, verified));
                }
                break;
            }
        }
    }
    let mut probes = futures_util::stream::iter(candidates.into_iter().map(
        |(workspace_id, entry_path, run)| async move {
            let reachable = tokio::time::timeout(Duration::from_secs(1), async {
                let mut socket = connect(&run).await?;
                socket.close(None).await?;
                anyhow::Ok(())
            })
            .await
            .is_ok_and(|r| r.is_ok());
            (workspace_id, entry_path, run, reachable)
        },
    ))
    .buffer_unordered(8);
    let mut completed = Vec::new();
    while let Some(result) = probes.next().await {
        completed.push(result);
    }
    let roots: Vec<u32> = completed.iter().filter(|r| r.3).map(|r| r.2.pid).collect();
    let trees = crate::processes::registered_trees(&roots).await;
    for (workspace_id, entry_path, run, reachable) in completed {
        if reachable {
            for process in trees.get(&run.pid).into_iter().flatten() {
                if !rows.iter().any(|r| {
                    r.pid == process.pid && r.workspace_id.as_deref() == Some(&workspace_id)
                }) {
                    let mut process = process.clone();
                    process.workspace_id = Some(workspace_id.clone());
                    rows.push(process);
                }
            }
        }
        let service = genehub_proto::BackgroundService {
            name: run.name.chars().take(120).collect(),
            run_id: run.run_id,
            entry_path,
            reachable,
            can_stop: run.control && reachable,
        };
        if let Some(row) = rows.iter_mut().find(|r| {
            r.pid == run.pid
                && r.workspace_id.as_deref() == Some(&workspace_id)
                && r.service.is_none()
        }) {
            row.service = Some(service);
        } else {
            rows.push(genehub_proto::BackgroundProcess {
                workspace_id: Some(workspace_id),
                service: Some(service),
                session_id: String::new(),
                pid: run.pid,
                parent_pid: 0,
                command: String::new(),
                running_for_seconds: 0,
            });
        }
    }
    Ok(rows)
}

pub(crate) async fn stop_registered(
    state: &crate::state::Shared,
    workspace: &str,
    entry: &str,
    run_id: &str,
) -> Result<()> {
    let run = load_entry(state, workspace, entry)
        .await?
        .context("服务登记不存在")?;
    if run.run_id != run_id {
        anyhow::bail!("运行已经变化，请刷新后重试");
    }
    if !run.control {
        anyhow::bail!("该服务不允许停止应用");
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut socket = connect(&run).await?;
        socket
            .send(Message::Binary(control(json!({"kind":"shutdown"}))))
            .await?;
        let response = recv(&mut socket).await?;
        if response[0] != 0
            || serde_json::from_slice::<Value>(&response[1..])?["kind"] != "stopping"
        {
            anyhow::bail!("应用未确认停止");
        }
        anyhow::Ok(())
    })
    .await??;
    Ok(())
}
