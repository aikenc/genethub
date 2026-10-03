//! `file.read`: one file's bytes on this machine, from an offset, for a peer
//! that is downloading it.
//!
//! The receiver drives the transfer, so this side stays stateless: it answers
//! "what is this file now" and "give me the bytes from here", and refuses to
//! continue a transfer whose source changed underneath it rather than letting
//! the receiver splice two versions together.

use std::io::{Read, Seek, SeekFrom};

use anyhow::Result;
use genehub_proto::{ErrorCode, ExchangeResponseHead};
use sha2::{Digest, Sha256};

use super::endpoint::{send_error, PeerServices, ServerStream};
use crate::authz::{Capability, Principal};
use crate::transfer::wire::{FileIdentity, FileReadHead, FileReadRequest};

const READ_STEP_BYTES: usize = 256 * 1024;

pub(super) async fn handle(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    if !stream.read_body(0).await?.is_empty() {
        anyhow::bail!("file.read accepts no request body");
    }
    let request: FileReadRequest = match serde_json::from_value(stream.head.metadata.clone()) {
        Ok(request) => request,
        Err(error) => {
            return send_error(
                stream,
                400,
                ErrorCode::BadRequest,
                format!("invalid file.read: {error}"),
            )
            .await
        }
    };
    let Some(path) = crate::guest_paths::inbound_absolute(&request.path) else {
        return send_error(
            stream,
            400,
            ErrorCode::BadRequest,
            "the source path must be absolute",
        )
        .await;
    };
    // A paired device keeps exactly what it was granted: reading anywhere on
    // the machine is what an unconfined terminal could do, so a device that
    // was only given workspace files still only reads workspace files.
    let caller = Principal::of(&services.state, &services.access);
    if matches!(caller, Principal::Device { .. })
        && !caller.allows(Capability::PtyUnconfined)
        && !inside_a_workspace(services, &path).await
    {
        return send_error(
            stream,
            403,
            ErrorCode::Forbidden,
            "this device may read workspace files only; reading elsewhere needs `pty:unconfined`",
        )
        .await;
    }
    let mut file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return send_error(
                stream,
                404,
                ErrorCode::NotFound,
                "the source file does not exist",
            )
            .await
        }
        Err(error) => {
            return send_error(
                stream,
                403,
                ErrorCode::Forbidden,
                format!("cannot open the source: {error}"),
            )
            .await
        }
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return send_error(
            stream,
            400,
            ErrorCode::BadRequest,
            "the source is not a regular file",
        )
        .await;
    }
    let identity = FileIdentity::of(&metadata);
    if request
        .expect
        .as_ref()
        .is_some_and(|expected| *expected != identity)
    {
        return send_error(
            stream,
            409,
            ErrorCode::Conflict,
            "sourceChanged: the source file changed since this transfer began",
        )
        .await;
    }

    if request.digest {
        let mut hasher = Sha256::new();
        let mut step = vec![0u8; READ_STEP_BYTES];
        let mut total = 0u64;
        loop {
            let read = file.read(&mut step)?;
            if read == 0 {
                break;
            }
            total += read as u64;
            hasher.update(&step[..read]);
            // A multi-GB hash must not hold the runtime for its whole length.
            tokio::task::yield_now().await;
        }
        let after = FileIdentity::of(&file.metadata()?);
        if total != identity.size || after != identity {
            return send_error(
                stream,
                409,
                ErrorCode::Conflict,
                "sourceChanged: the source file changed while it was hashed",
            )
            .await;
        }
        let head = FileReadHead {
            identity,
            sha256: Some(hex(&hasher.finalize())),
        };
        stream
            .respond(&ExchangeResponseHead {
                status: 200,
                metadata: serde_json::to_value(&head)?,
                body_length: Some(0),
                error: None,
            })
            .await?;
        return stream.finish().await;
    }

    if request.offset > identity.size {
        return send_error(
            stream,
            416,
            ErrorCode::BadRequest,
            "the requested offset is past the end of the source",
        )
        .await;
    }
    let remaining = identity.size - request.offset;
    file.seek(SeekFrom::Start(request.offset))?;
    stream
        .respond(&ExchangeResponseHead {
            status: 200,
            metadata: serde_json::to_value(&FileReadHead {
                identity: identity.clone(),
                sha256: None,
            })?,
            body_length: Some(remaining),
            error: None,
        })
        .await?;
    let mut step = vec![0u8; READ_STEP_BYTES];
    let mut sent = 0u64;
    while sent < remaining {
        let want = usize::try_from(remaining - sent)
            .unwrap_or(usize::MAX)
            .min(READ_STEP_BYTES);
        let read = file.read(&mut step[..want])?;
        if read == 0 {
            anyhow::bail!("the source file shrank while it was streamed");
        }
        stream.write(&step[..read]).await?;
        sent += read as u64;
    }
    stream.finish().await
}

async fn inside_a_workspace(services: &PeerServices, path: &std::path::Path) -> bool {
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    for workspace in services.state.workspaces.list().await {
        let roots = std::iter::once(workspace.root.clone())
            .chain(workspace.folders.iter().map(|folder| folder.root.clone()));
        for root in roots {
            let Some(root) = crate::guest_paths::inbound_absolute(&root) else {
                continue;
            };
            if root
                .canonicalize()
                .is_ok_and(|root| path.starts_with(&root))
            {
                return true;
            }
        }
    }
    false
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
