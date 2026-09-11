use std::io::Read;
use std::sync::{Arc, OnceLock};

use anyhow::{anyhow, Context, Result};
use genehub_proto::{
    AssetPreviewError, AssetPreviewRequest, ExchangeResponseHead, WorkspaceFileSourceKind,
};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use super::endpoint::{PeerServices, ServerStream};
use crate::files::{PreviewFailure, PreviewFile};

static PREVIEW_SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
const PREVIEW_IO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// On-demand preview loading fetches many small sub-resources in parallel;
/// two slots serialized whole sites behind each other.
const PREVIEW_WORKERS: usize = 8;

pub(super) async fn handle(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    if !stream.read_body(0).await?.is_empty() {
        anyhow::bail!("asset.preview accepts no request body");
    }
    let request: AssetPreviewRequest = serde_json::from_value(stream.head.metadata.clone())
        .context("invalid asset.preview metadata")?;
    if request.source.kind != WorkspaceFileSourceKind::WorkspaceFile {
        return preview_error(stream, 400, AssetPreviewError::Forbidden, None).await;
    }
    if crate::files::validate_preview_path(&request.source.path).is_err() {
        return preview_error(stream, 403, AssetPreviewError::Forbidden, None).await;
    }

    let (workspace_id, expected_handle) = match (
        services.access.workspace_id.as_deref(),
        services.access.workspace_handle.as_deref(),
    ) {
        (Some(id), Some(handle)) => (id, handle),
        (Some(id), None) => (id, id),
        (None, _) => (
            request.source.workspace_handle.as_str(),
            request.source.workspace_handle.as_str(),
        ),
    };
    if request.source.workspace_handle != expected_handle {
        return preview_error(stream, 403, AssetPreviewError::Forbidden, None).await;
    }
    if services.state.workspaces.get(workspace_id).await.is_err() {
        return preview_error(stream, 404, AssetPreviewError::NotFound, None).await;
    }
    let resolved = match services
        .state
        .workspaces
        .resolve(workspace_id, &request.source.path)
        .await
    {
        Ok(resolved) => resolved,
        Err(_) => return preview_error(stream, 403, AssetPreviewError::Forbidden, None).await,
    };

    let slot = match tokio::time::timeout(
        PREVIEW_IO_TIMEOUT,
        PREVIEW_SLOTS
            .get_or_init(|| Arc::new(Semaphore::new(PREVIEW_WORKERS)))
            .clone()
            .acquire_owned(),
    )
    .await
    {
        Ok(Ok(slot)) => slot,
        Ok(Err(_)) => return Err(anyhow!("preview worker pool stopped")),
        Err(_) => return preview_error(stream, 408, AssetPreviewError::SourceChanged, None).await,
    };
    let root = resolved.root;
    let path = resolved.relative.to_string_lossy().replace('\\', "/");
    let read = crate::files::preview(&root, &path);
    let file = match tokio::time::timeout(PREVIEW_IO_TIMEOUT, read).await {
        Ok(Ok(file)) => file,
        Ok(Err(failure)) => return failure_response(stream, failure).await,
        Err(_) => return preview_error(stream, 408, AssetPreviewError::SourceChanged, None).await,
    };
    // The bounded worker permit covers both the metadata scan and the actual
    // source read; streaming must not turn one retained Vec into hundreds of
    // concurrent disk readers.
    let _slot = slot;
    send_file(stream, file).await
}

async fn send_file(stream: &mut ServerStream, file: PreviewFile) -> Result<()> {
    let (metadata, mut source, expected_digest) = file.into_parts();
    let expected_bytes = metadata.source_bytes;
    stream
        .respond(&ExchangeResponseHead {
            status: 200,
            metadata: serde_json::to_value(&metadata)?,
            body_length: Some(expected_bytes),
            error: None,
        })
        .await?;
    let mut hasher = Sha256::new();
    let mut sent = 0u64;
    let mut step = vec![0u8; crate::files::PREVIEW_STEP_BYTES];
    loop {
        let read = source
            .read(&mut step)
            .map_err(|error| anyhow!("preview source read failed: {error}"))?;
        if read == 0 {
            break;
        }
        sent = sent
            .checked_add(read as u64)
            .ok_or_else(|| anyhow!("preview source length overflow"))?;
        if sent > expected_bytes {
            return Err(anyhow!("preview source changed while it was streamed"));
        }
        hasher.update(&step[..read]);
        stream.write(&step[..read]).await?;
        crate::blocking::breathe().await;
    }
    let streamed_digest: [u8; 32] = hasher.finalize().into();
    if sent != expected_bytes || streamed_digest != expected_digest {
        return Err(anyhow!("preview source changed while it was streamed"));
    }
    stream.finish().await
}

async fn failure_response(stream: &mut ServerStream, failure: PreviewFailure) -> Result<()> {
    match failure {
        PreviewFailure::NotFound => {
            preview_error(stream, 404, AssetPreviewError::NotFound, None).await
        }
        PreviewFailure::Forbidden => {
            preview_error(stream, 403, AssetPreviewError::Forbidden, None).await
        }
        PreviewFailure::Unsupported => {
            preview_error(stream, 415, AssetPreviewError::Unsupported, None).await
        }
        PreviewFailure::TooLarge { source_bytes } => {
            preview_error(stream, 413, AssetPreviewError::TooLarge, Some(source_bytes)).await
        }
        PreviewFailure::SourceChanged => {
            preview_error(stream, 409, AssetPreviewError::SourceChanged, None).await
        }
    }
}

async fn preview_error(
    stream: &mut ServerStream,
    status: u16,
    error: AssetPreviewError,
    source_bytes: Option<u64>,
) -> Result<()> {
    stream
        .respond(&ExchangeResponseHead {
            status,
            metadata: serde_json::json!({
                "error": error,
                "sourceBytes": source_bytes,
                "limitBytes": genehub_proto::MAX_PREVIEW_SOURCE_BYTES,
            }),
            body_length: Some(0),
            error: None,
        })
        .await?;
    stream.finish().await
}
