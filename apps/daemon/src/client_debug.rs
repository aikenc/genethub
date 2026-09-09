//! Volatile rendezvous on a user-selected machine. The relay never interprets
//! these messages. Browser execution consent is enforced again by the client.
use genehub_proto::{
    ClientDebugCommand, ClientDebugGrant, ClientDebugInfo, ClientDebugPoll,
    ClientDebugRequest as R, ClientDebugResponse, ClientDebugValue as V, ErrorCode, ProtocolError,
};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct Broker(Mutex<HashMap<String, Entry>>);
struct Entry {
    owner: String,
    label: String,
    url: String,
    user_agent: String,
    seen: Instant,
    grant: Option<Grant>,
    queue: VecDeque<(ClientDebugCommand, Instant)>,
    running: Option<(String, Instant)>,
    results: HashMap<String, Value>,
    result_bytes: usize,
}
struct Grant {
    key: String,
    label: String,
    until: Instant,
    approved: bool,
}
fn key() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
fn error(code: ErrorCode, message: &str) -> ProtocolError {
    ProtocolError {
        code,
        message: message.into(),
    }
}
fn denied() -> ProtocolError {
    error(
        ErrorCode::Forbidden,
        "Client debug permission missing or expired; request authorization on this client again",
    )
}
fn status(name: &str) -> V {
    V::Status {
        status: name.into(),
        remaining_ms: None,
        seconds: None,
    }
}
impl Entry {
    fn clear(&mut self) {
        self.grant = None;
        self.queue.clear();
        self.running = None;
        self.results.clear();
        self.result_bytes = 0;
    }
    fn session(&self, key: &str) -> Result<&Grant, ProtocolError> {
        self.grant
            .as_ref()
            .filter(|g| g.key == key && g.until > Instant::now())
            .ok_or_else(denied)
    }
    fn owner(&self, owner: &str) -> Result<(), ProtocolError> {
        if self.owner == owner {
            Ok(())
        } else {
            Err(denied())
        }
    }
}
impl Broker {
    pub async fn handle(&self, request: R) -> Result<ClientDebugResponse, ProtocolError> {
        let mut clients = self.0.lock().await;
        let now = Instant::now();
        // Presence is not consent: a suspended phone keeps its original grant.
        clients.retain(|_, e| {
            now.duration_since(e.seen) < Duration::from_secs(90)
                || e.grant.as_ref().is_some_and(|g| g.approved && g.until > now)
        });
        for e in clients.values_mut() {
            if e.grant.as_ref().is_some_and(|g| g.until <= now) {
                e.clear();
            }
            while e.queue.front().is_some_and(|(_, until)| *until <= now) {
                let (command, _) = e.queue.pop_front().expect("checked queued command");
                let result = serde_json::json!({"ok":false,"error":"Client command expired before delivery; it was not executed. Submit a new operation if still needed."});
                e.result_bytes += result.to_string().len();
                e.results.insert(command.command_id, result);
            }
            if e.running.as_ref().is_some_and(|(_, until)| *until <= now) {
                let (id, _) = e.running.take().expect("checked running command");
                let result = serde_json::json!({"ok":false,"error":"Client command delivery or execution timed out; it may have run. No automatic retry."});
                e.result_bytes += result.to_string().len();
                e.results.insert(id, result);
            }
        }
        let result_budget =
            15_800_000usize.saturating_sub(clients.values().map(|e| e.result_bytes).sum());
        let value = match request {
            R::Register {
                label,
                url,
                user_agent,
            } => {
                if clients.len() >= 64
                    || label.len() > 256
                    || url.len() > 2048
                    || user_agent.len() > 1024
                {
                    return Err(error(
                        ErrorCode::BadRequest,
                        "Client registration limit exceeded",
                    ));
                }
                let id = format!("cl_{}", key());
                let owner = key();
                clients.insert(
                    id.clone(),
                    Entry {
                        owner: owner.clone(),
                        label,
                        url,
                        user_agent,
                        seen: now,
                        grant: None,
                        queue: VecDeque::new(),
                        running: None,
                        results: HashMap::new(),
                        result_bytes: 0,
                    },
                );
                V::Registered {
                    client_id: id,
                    owner,
                }
            }
            R::List => V::Clients(
                clients
                    .iter()
                    .map(|(id, e)| ClientDebugInfo {
                        client_id: id.clone(),
                        label: e.label.clone(),
                        url: e.url.clone(),
                        user_agent: e.user_agent.clone(),
                        authorized: e.grant.as_ref().is_some_and(|g| g.approved),
                        online: Some(now.duration_since(e.seen) < Duration::from_secs(45)),
                    })
                    .collect(),
            ),
            other => {
                let id = match &other {
                    R::Poll { client_id, .. }
                    | R::Decide { client_id, .. }
                    | R::Complete { client_id, .. }
                    | R::Attach { client_id, .. }
                    | R::Status { client_id, .. }
                    | R::Execute { client_id, .. }
                    | R::Result { client_id, .. }
                    | R::Revoke { client_id, .. } => client_id,
                    _ => unreachable!(),
                };
                let e = clients.get_mut(id).ok_or_else(|| {
                    error(
                        ErrorCode::NotFound,
                        "Client offline; open its debugging panel and reconnect",
                    )
                })?;
                match other {
                    R::Poll { owner, .. } => {
                        e.owner(&owner)?;
                        e.seen = now;
                        let command = if e.grant.as_ref().is_some_and(|g| g.approved)
                            && e.running.is_none()
                        {
                            e.queue.pop_front().map(|(command, _)| {
                                e.running = Some((
                                    command.command_id.clone(),
                                    now + Duration::from_secs(30),
                                ));
                                command
                            })
                        } else {
                            None
                        };
                        V::Poll(ClientDebugPoll {
                            grant: e.grant.as_ref().map(|g| ClientDebugGrant {
                                session: g.key.clone(),
                                label: g.label.clone(),
                                approved: g.approved,
                                remaining_ms: g.until.saturating_duration_since(now).as_millis()
                                    as u64,
                            }),
                            command,
                        })
                    }
                    R::Attach { label, .. } => {
                        if label.is_empty() || label.len() > 256 {
                            return Err(error(
                                ErrorCode::BadRequest,
                                "Operator label must be 1–256 bytes",
                            ));
                        }
                        if e.grant.is_some() {
                            return Err(error(ErrorCode::Conflict,"Client already has a pending or active operator; revoke it on the client first"));
                        }
                        let session = key();
                        e.grant = Some(Grant {
                            key: session.clone(),
                            label,
                            until: now + Duration::from_secs(120),
                            approved: false,
                        });
                        V::Attached {
                            session,
                            status: "pending".into(),
                            authorization_timeout_seconds: 120,
                        }
                    }
                    R::Decide {
                        owner,
                        session,
                        seconds,
                        ..
                    } => {
                        e.owner(&owner)?;
                        if e.session(&session)?.approved {
                            return Err(error(
                                ErrorCode::Conflict,
                                "An existing authorization cannot be extended",
                            ));
                        }
                        if seconds == 0 {
                            e.clear();
                            status("denied")
                        } else {
                            if ![1800, 3600, 18000, 86400].contains(&seconds) {
                                return Err(error(
                                    ErrorCode::BadRequest,
                                    "Unsupported authorization duration",
                                ));
                            }
                            let g = e.grant.as_mut().expect("checked grant");
                            g.approved = true;
                            g.until = now + Duration::from_secs(seconds.into());
                            V::Status {
                                status: "authorized".into(),
                                seconds: Some(seconds),
                                remaining_ms: None,
                            }
                        }
                    }
                    R::Status { session, .. } => {
                        let g = e.session(&session)?;
                        V::Status {
                            status: if g.approved { "authorized" } else { "pending" }.into(),
                            remaining_ms: Some(
                                g.until.saturating_duration_since(now).as_millis() as u64
                            ),
                            seconds: None,
                        }
                    }
                    R::Execute {
                        session, action, ..
                    } => {
                        if !e.session(&session)?.approved {
                            return Err(denied());
                        }
                        if now.duration_since(e.seen) >= Duration::from_secs(45) {
                            return Err(error(ErrorCode::Conflict, "Client offline; authorization is retained until its original deadline. Wait for reconnection before submitting an operation."));
                        }
                        if e.queue.len() + e.results.len() + usize::from(e.running.is_some()) >= 8 {
                            return Err(error(
                                ErrorCode::Conflict,
                                "Client command capacity exhausted; collect results or revoke",
                            ));
                        }
                        if serde_json::to_vec(&action).map_or(true, |v| v.len() > 128 * 1024) {
                            return Err(error(
                                ErrorCode::BadRequest,
                                "Client action exceeds 128 KiB",
                            ));
                        }
                        let id = key();
                        e.queue.push_back((ClientDebugCommand {
                            command_id: id.clone(),
                            action,
                        }, now + Duration::from_secs(30)));
                        V::Queued { command_id: id }
                    }
                    R::Complete {
                        owner,
                        command_id,
                        result,
                        ..
                    } => {
                        e.owner(&owner)?;
                        if !e.grant.as_ref().is_some_and(|g| g.approved)
                            || e.running.as_ref().map(|(id, _)| id) != Some(&command_id)
                        {
                            return Err(denied());
                        }
                        let bytes = serde_json::to_vec(&result).map_or(usize::MAX, |v| v.len());
                        if bytes > 2_000_000 || bytes > result_budget {
                            return Err(error(ErrorCode::BadRequest,"Client result capacity exceeded; collect outstanding results or revoke"));
                        }
                        e.result_bytes += bytes;
                        e.running = None;
                        e.results.insert(command_id, result);
                        status("accepted")
                    }
                    R::Result {
                        session,
                        command_id,
                        ..
                    } => {
                        if !e.session(&session)?.approved {
                            return Err(denied());
                        }
                        if let Some(result) = e.results.remove(&command_id) {
                            e.result_bytes = e
                                .result_bytes
                                .saturating_sub(serde_json::to_vec(&result).map_or(0, |v| v.len()));
                            V::Completed {
                                status: "complete".into(),
                                result,
                            }
                        } else if e.running.as_ref().map(|(id, _)| id) == Some(&command_id)
                            || e.queue
                                .iter()
                                .any(|(command, _)| command.command_id == command_id)
                        {
                            status("pending")
                        } else {
                            return Err(error(
                                ErrorCode::NotFound,
                                "Unknown or already collected client command",
                            ));
                        }
                    }
                    R::Revoke { key, .. } => {
                        if e.owner != key {
                            e.session(&key)?;
                        }
                        e.clear();
                        status("revoked")
                    }
                    _ => unreachable!(),
                }
            }
        };
        Ok(ClientDebugResponse { value })
    }
}
