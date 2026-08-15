use std::collections::{BTreeMap, HashMap};

use genehub_proto::{ErrorCode, ProtocolError, Reply, ServerFrame};
use genet_daemon_logic_api::{
    CapabilityEvent, CapabilityRequest, CapabilityValue, FileLocator, FileRoot, LogicOutcome,
    LogicOutput, PtyRequest, Publication,
};

use crate::capability::Client;
use crate::config::WorkspaceEntry;
use crate::CapabilityExecutor;

pub fn open(
    terminals: &mut HashMap<String, u64>,
    workspace: &WorkspaceEntry,
    cols: u16,
    rows: u16,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<String, ProtocolError> {
    let folder = workspace
        .folders
        .first()
        .ok_or_else(|| bad_request("workspace has no folders"))?;
    let mut client = Client::new(executor, next);
    let resource_id = match client.call(CapabilityRequest::Pty(PtyRequest::Open {
        cwd: FileLocator {
            root: FileRoot::Workspace {
                handle: folder.root_handle.clone(),
            },
            path: String::new(),
        },
        cols,
        rows,
        env: BTreeMap::new(),
    }))? {
        CapabilityValue::Resource { resource_id } => resource_id,
        _ => return Err(internal("PTY open returned the wrong value")),
    };
    let bytes = match client.call(CapabilityRequest::Random { bytes: 16 })? {
        CapabilityValue::Bytes(bytes) if bytes.len() == 16 => bytes,
        _ => return Err(internal("random capability returned the wrong value")),
    };
    let pty_id = format!(
        "pty_{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    terminals.insert(pty_id.clone(), resource_id);
    Ok(pty_id)
}

pub fn write(
    terminals: &HashMap<String, u64>,
    pty_id: &str,
    data: String,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    operation(
        terminals,
        pty_id,
        |resource_id| PtyRequest::Write {
            resource_id,
            bytes: data.into_bytes(),
        },
        executor,
        next,
    )
}

pub fn resize(
    terminals: &HashMap<String, u64>,
    pty_id: &str,
    cols: u16,
    rows: u16,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    operation(
        terminals,
        pty_id,
        |resource_id| PtyRequest::Resize {
            resource_id,
            cols,
            rows,
        },
        executor,
        next,
    )
}

pub fn close(
    terminals: &HashMap<String, u64>,
    pty_id: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    operation(
        terminals,
        pty_id,
        |resource_id| PtyRequest::Close { resource_id },
        executor,
        next,
    )
}

pub fn event(terminals: &mut HashMap<String, u64>, event: CapabilityEvent) -> LogicOutput {
    match event {
        CapabilityEvent::PtyOutput { resource_id, bytes } => {
            let Some(pty_id) = external_id(terminals, resource_id) else {
                return LogicOutput::default();
            };
            LogicOutput {
                publications: vec![Publication::Fanout(ServerFrame::PtyOutput {
                    pty_id,
                    data: String::from_utf8_lossy(&bytes).to_string(),
                })],
                ..LogicOutput::default()
            }
        }
        CapabilityEvent::PtyClosed { resource_id, code } => {
            let Some(pty_id) = external_id(terminals, resource_id) else {
                return LogicOutput::default();
            };
            terminals.remove(&pty_id);
            LogicOutput {
                publications: vec![Publication::Fanout(ServerFrame::PtyClosed {
                    pty_id,
                    exit_code: code,
                })],
                ..LogicOutput::default()
            }
        }
        _ => LogicOutput::default(),
    }
}

pub fn reply(result: Result<(), ProtocolError>) -> LogicOutcome {
    match result {
        Ok(()) => LogicOutcome::Reply(Box::new(Reply::Ack)),
        Err(error) => LogicOutcome::Error(error),
    }
}

fn operation(
    terminals: &HashMap<String, u64>,
    pty_id: &str,
    request: impl FnOnce(u64) -> PtyRequest,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let resource_id = terminals
        .get(pty_id)
        .copied()
        .ok_or_else(|| not_found(format!("no such terminal: {pty_id}")))?;
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::Pty(request(resource_id)))? {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal("PTY operation returned the wrong value")),
    }
}

fn external_id(terminals: &HashMap<String, u64>, resource_id: u64) -> Option<String> {
    terminals
        .iter()
        .find(|(_, resource)| **resource == resource_id)
        .map(|(id, _)| id.clone())
}

fn bad_request(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::BadRequest,
        message: message.into(),
    }
}

fn not_found(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::NotFound,
        message: message.into(),
    }
}

fn internal(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Internal,
        message: message.into(),
    }
}
