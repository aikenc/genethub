//! In-process RPC used by `cli_front` verbs.
//!
//! Local calls go through `router::handle` on this daemon. They never open a
//! second loopback WebSocket. Remote calls (`--machine`, Hub ticket, pairing)
//! stay on the native fabric client; the wasm guest reports that fabric is
//! unavailable instead of silently running the command here.

use genehub_proto::{
    Confinement, HelloResult, HubTicket, ProtocolError, Reply, Request, SequencedEvent, ShellFrame,
    ShellRunRequest, TransportKind,
};
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::authz::Principal;
use crate::router::{self, SideEffect};
use crate::state::Shared;

use super::machines::PairedMachine;
use super::{fail, EXIT_UNREACHABLE};

#[cfg(not(target_family = "wasm"))]
use super::rpc_wire;

const FABRIC_UNAVAILABLE: &str =
    "guest fabric is not available in this build; --machine cannot reach another host until the wasm fabric uplink is connected";

#[derive(Debug, Clone, PartialEq)]
pub enum RpcError {
    Remote(ProtocolError),
    Transport(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Remote(error) => write!(
                formatter,
                "{}: {}",
                error_code_name(error.code),
                error.message
            ),
            RpcError::Transport(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for RpcError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Offline,
    Credential,
    Busy,
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConnectError {
    Unavailable(String),
    Refused { reason: Refusal, message: String },
    Rejected(ProtocolError),
    Protocol(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::Unavailable(message)
            | ConnectError::Protocol(message)
            | ConnectError::Refused { message, .. } => formatter.write_str(message),
            ConnectError::Rejected(error) => write!(
                formatter,
                "{}: {}",
                error_code_name(error.code),
                error.message
            ),
        }
    }
}

impl std::error::Error for ConnectError {}

fn fabric_unavailable() -> ConnectError {
    ConnectError::Unavailable(FABRIC_UNAVAILABLE.into())
}

/// What arrives on the event stream that a conversation cares about.
#[derive(Debug, Clone, PartialEq)]
pub enum Payload {
    Event(SequencedEvent),
    Desync { session_id: String, missed: u64 },
}

pub struct Rpc {
    inner: Inner,
}

enum Inner {
    Local(Local),
    #[cfg(not(target_family = "wasm"))]
    Remote(rpc_wire::Rpc),
}

struct Local {
    state: Shared,
    hello: HelloResult,
    events: Mutex<mpsc::UnboundedReceiver<Payload>>,
    event_tx: mpsc::UnboundedSender<Payload>,
}

impl Rpc {
    pub async fn connect_or_exit() -> Result<Self, i32> {
        match Self::connect().await {
            Ok(rpc) => Ok(rpc),
            Err(error) => Err(fail(
                "daemon_unreachable",
                &format!(
                    "{error}; run `{} daemon start`",
                    crate::channel::CLI_BINARY
                ),
                EXIT_UNREACHABLE,
            )),
        }
    }

    pub async fn connect() -> Result<Self, ConnectError> {
        let state = super::local_state().map_err(ConnectError::Unavailable)?;
        let handled = tokio::spawn({
            let state = state.clone();
            async move {
                router::handle(
                    &state,
                    TransportKind::Loopback,
                    &Principal::LocalUser,
                    Request::ConnectionIdentity,
                )
                .await
            }
        })
        .await
        .map_err(|error| ConnectError::Unavailable(format!("identity task failed: {error}")))?;
        let hello = match handled.reply {
            Ok(Reply::Hello(hello)) => hello,
            Ok(other) => {
                return Err(ConnectError::Protocol(format!(
                    "unexpected identity reply: {other:?}"
                )))
            }
            Err(error) => return Err(ConnectError::Rejected(error)),
        };
        let (event_tx, events) = mpsc::unbounded_channel();
        Ok(Self {
            inner: Inner::Local(Local {
                state,
                hello,
                events: Mutex::new(events),
                event_tx,
            }),
        })
    }

    pub async fn connect_remote(machine: &PairedMachine) -> Result<Self, ConnectError> {
        #[cfg(target_family = "wasm")]
        {
            let _ = machine;
            return Err(fabric_unavailable());
        }
        #[cfg(not(target_family = "wasm"))]
        {
            let machine = machine.clone();
            match tokio::spawn(async move { rpc_wire::Rpc::connect_remote(&machine).await }).await {
                Ok(Ok(remote)) => Ok(Self {
                    inner: Inner::Remote(remote),
                }),
                Ok(Err(error)) => Err(error.into()),
                Err(join) => Err(ConnectError::Unavailable(format!(
                    "remote connect task failed: {join}"
                ))),
            }
        }
    }

    pub async fn connect_hosted(ticket: &HubTicket) -> Result<Self, ConnectError> {
        #[cfg(target_family = "wasm")]
        {
            let _ = ticket;
            return Err(fabric_unavailable());
        }
        #[cfg(not(target_family = "wasm"))]
        {
            let ticket = ticket.clone();
            match tokio::spawn(async move { rpc_wire::Rpc::connect_hosted(&ticket).await }).await {
                Ok(Ok(remote)) => Ok(Self {
                    inner: Inner::Remote(remote),
                }),
                Ok(Err(error)) => Err(error.into()),
                Err(join) => Err(ConnectError::Unavailable(format!(
                    "remote connect task failed: {join}"
                ))),
            }
        }
    }

    pub fn hello(&self) -> &HelloResult {
        match &self.inner {
            Inner::Local(local) => &local.hello,
            #[cfg(not(target_family = "wasm"))]
            Inner::Remote(remote) => remote.hello(),
        }
    }

    pub async fn call(&self, request: Request) -> Result<Reply, RpcError> {
        match &self.inner {
            Inner::Local(local) => {
                let state = local.state.clone();
                let handled = tokio::spawn(async move {
                    router::handle(
                        &state,
                        TransportKind::Loopback,
                        &Principal::LocalUser,
                        request,
                    )
                    .await
                })
                .await
                .map_err(|error| RpcError::Transport(format!("rpc task failed: {error}")))?;
                if let SideEffect::Subscribe {
                    session_id,
                    receiver,
                } = handled.effect
                {
                    pump_subscription(session_id, receiver, local.event_tx.clone());
                }
                handled.reply.map_err(RpcError::Remote)
            }
            #[cfg(not(target_family = "wasm"))]
            Inner::Remote(remote) => Ok(remote.call(request).await?),
        }
    }

    pub async fn watch_events(&self) -> Result<(), RpcError> {
        match &self.inner {
            Inner::Local(_) => Ok(()),
            #[cfg(not(target_family = "wasm"))]
            Inner::Remote(remote) => Ok(remote.watch_events().await?),
        }
    }

    pub async fn next_event(&self) -> Option<Payload> {
        match &self.inner {
            Inner::Local(local) => local.events.lock().await.recv().await,
            #[cfg(not(target_family = "wasm"))]
            Inner::Remote(remote) => remote.next_event().await.map(wire_payload),
        }
    }

    pub async fn run_command(
        &self,
        request: &ShellRunRequest,
        stdin: Vec<u8>,
    ) -> Result<Running, RpcError> {
        match &self.inner {
            Inner::Local(local) => {
                let started = crate::dataplane::exec::start(
                    &local.state,
                    &Principal::LocalUser,
                    request.clone(),
                    stdin,
                )
                .await
                .map_err(start_error)?;
                Ok(Running {
                    confinement: started.confinement,
                    inner: RunningInner::Local {
                        frames: started.frames,
                    },
                })
            }
            #[cfg(not(target_family = "wasm"))]
            Inner::Remote(remote) => {
                let running = remote.run_command(request, stdin).await?;
                Ok(Running {
                    confinement: running.confinement.clone(),
                    inner: RunningInner::Remote(running),
                })
            }
        }
    }
}

fn pump_subscription(
    session_id: String,
    mut receiver: broadcast::Receiver<SequencedEvent>,
    events: mpsc::UnboundedSender<Payload>,
) {
    tokio::spawn(async move {
        loop {
            let payload = match receiver.recv().await {
                Ok(event) => Payload::Event(event),
                Err(broadcast::error::RecvError::Lagged(missed)) => Payload::Desync {
                    session_id: session_id.clone(),
                    missed,
                },
                Err(broadcast::error::RecvError::Closed) => return,
            };
            if events.send(payload).is_err() {
                return;
            }
        }
    });
}

fn start_error(error: crate::dataplane::exec::StartError) -> RpcError {
    use crate::dataplane::exec::StartError;
    match error {
        StartError::Protocol(error) => RpcError::Remote(error),
        StartError::Transport(message) => RpcError::Transport(message),
    }
}

pub struct Running {
    pub confinement: Option<Confinement>,
    inner: RunningInner,
}

enum RunningInner {
    Local {
        frames: mpsc::Receiver<ShellFrame>,
    },
    #[cfg(not(target_family = "wasm"))]
    Remote(rpc_wire::Running),
}

impl Running {
    pub async fn next(&mut self) -> Option<ShellFrame> {
        match &mut self.inner {
            RunningInner::Local { frames } => frames.recv().await,
            #[cfg(not(target_family = "wasm"))]
            RunningInner::Remote(running) => running.next().await,
        }
    }
}

pub struct Pairing {
    #[cfg(not(target_family = "wasm"))]
    inner: rpc_wire::Pairing,
}

impl Pairing {
    pub async fn open(endpoint: &str, invite_id: &str, secret: &str) -> Result<Self, ConnectError> {
        #[cfg(target_family = "wasm")]
        {
            let _ = (endpoint, invite_id, secret);
            return Err(fabric_unavailable());
        }
        #[cfg(not(target_family = "wasm"))]
        {
            Ok(Self {
                inner: rpc_wire::Pairing::open(endpoint, invite_id, secret).await?,
            })
        }
    }

    pub async fn claim(
        &self,
        invite_id: &str,
        device_name: &str,
    ) -> Result<genehub_proto::DeviceCredential, RpcError> {
        #[cfg(target_family = "wasm")]
        {
            let _ = (self, invite_id, device_name);
            Err(RpcError::Transport(FABRIC_UNAVAILABLE.into()))
        }
        #[cfg(not(target_family = "wasm"))]
        {
            Ok(self.inner.claim(invite_id, device_name).await?)
        }
    }
}

#[cfg(not(target_family = "wasm"))]
fn wire_payload(payload: rpc_wire::Payload) -> Payload {
    match payload {
        rpc_wire::Payload::Event(event) => Payload::Event(event),
        rpc_wire::Payload::Desync { session_id, missed } => Payload::Desync { session_id, missed },
    }
}

#[cfg(not(target_family = "wasm"))]
impl From<rpc_wire::ConnectError> for ConnectError {
    fn from(error: rpc_wire::ConnectError) -> Self {
        match error {
            rpc_wire::ConnectError::Unavailable(message) => Self::Unavailable(message),
            rpc_wire::ConnectError::Refused { reason, message } => Self::Refused {
                reason: match reason {
                    rpc_wire::Refusal::Offline => Refusal::Offline,
                    rpc_wire::Refusal::Credential => Refusal::Credential,
                    rpc_wire::Refusal::Busy => Refusal::Busy,
                    rpc_wire::Refusal::Other => Refusal::Other,
                },
                message,
            },
            rpc_wire::ConnectError::Rejected(error) => Self::Rejected(error),
            rpc_wire::ConnectError::Protocol(message) => Self::Protocol(message),
        }
    }
}

#[cfg(not(target_family = "wasm"))]
impl From<rpc_wire::RpcError> for RpcError {
    fn from(error: rpc_wire::RpcError) -> Self {
        match error {
            rpc_wire::RpcError::Remote(error) => Self::Remote(error),
            rpc_wire::RpcError::Transport(message) => Self::Transport(message),
        }
    }
}

fn error_code_name(code: genehub_proto::ErrorCode) -> &'static str {
    use genehub_proto::ErrorCode::*;
    match code {
        BadRequest => "bad_request",
        Unauthorized => "unauthorized",
        NotFound => "not_found",
        Conflict => "conflict",
        Unsupported => "unsupported",
        Forbidden => "forbidden",
        Internal => "internal",
        ProtocolVersion => "protocol_mismatch",
        IsolationUnavailable => "isolation_unavailable",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_failure_names_fabric() {
        let message = fabric_unavailable().to_string();
        assert!(
            message.contains("fabric"),
            "honest unavailability must name fabric: {message}"
        );
    }
}
