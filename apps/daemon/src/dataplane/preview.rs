use std::io::Read;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use genehub_proto::{
    AssetPreviewError, AssetPreviewRequest, ExchangeResponseHead, WorkspaceFileSourceKind,
};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use super::endpoint::{PeerServices, ServerStream, WriteTimings};
use crate::files::{PreviewFailure, PreviewFile};

static PREVIEW_SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
const PREVIEW_IO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// On-demand preview loading fetches many small sub-resources in parallel;
/// two slots serialized whole sites behind each other.
const PREVIEW_WORKERS: usize = 8;
const PREVIEW_SEND_STEP_BYTES: usize = 64 * 1024;

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

    let worker_started = Instant::now();
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
    let worker_wait_us = worker_started.elapsed().as_micros() as u64;
    let root = resolved.root;
    let path = resolved.relative.to_string_lossy().replace('\\', "/");
    let scan_started = Instant::now();
    let read = crate::files::preview(&root, &path);
    let file = match tokio::time::timeout(PREVIEW_IO_TIMEOUT, read).await {
        Ok(Ok(file)) => file,
        Ok(Err(failure)) => return failure_response(stream, failure).await,
        Err(_) => return preview_error(stream, 408, AssetPreviewError::SourceChanged, None).await,
    };
    let scan_us = scan_started.elapsed().as_micros() as u64;
    // The bounded worker permit covers both the metadata scan and the actual
    // source read; streaming must not turn one retained Vec into hundreds of
    // concurrent disk readers.
    let _slot = slot;
    let send_started = Instant::now();
    let stats = send_file(stream, file).await?;
    tracing::debug!(
        event = "preview_stage_timing",
        request_id = super::endpoint::diagnostic_id(&stream.head.metadata),
        transport = services.carrier_kind.as_str(),
        source_mode = if stats.snapshot { "snapshot" } else { "file" },
        source_bytes = stats.source_bytes,
        worker_wait_us,
        scan_us,
        send_us = send_started.elapsed().as_micros() as u64,
        read_us = stats.read_us,
        hash_us = stats.hash_us,
        write_us = stats.write_us,
        write_credit_us = stats.write_timings.credit_us,
        write_budget_us = stats.write_timings.budget_us,
        write_enqueue_us = stats.write_timings.enqueue_us,
        write_completion_us = stats.write_timings.completion_us,
        write_frames = stats.write_timings.frames,
        yield_us = stats.yield_us,
        finish_us = stats.finish_us,
        chunks = stats.chunks,
        "preview completed"
    );
    Ok(())
}

#[derive(Default)]
struct PreviewSendStats {
    source_bytes: u64,
    snapshot: bool,
    read_us: u64,
    hash_us: u64,
    write_us: u64,
    yield_us: u64,
    finish_us: u64,
    chunks: u64,
    write_timings: WriteTimings,
}

async fn send_file(stream: &mut ServerStream, file: PreviewFile) -> Result<PreviewSendStats> {
    let (metadata, mut source, expected_digest) = file.into_parts();
    let snapshot = source.is_snapshot();
    let expected_bytes = metadata.source_bytes;
    let mut stats = PreviewSendStats {
        source_bytes: expected_bytes,
        snapshot,
        ..Default::default()
    };
    let measure_write = tracing::enabled!(tracing::Level::DEBUG);
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
    let mut step = vec![0u8; PREVIEW_SEND_STEP_BYTES];
    loop {
        let began = Instant::now();
        let read = source
            .read(&mut step)
            .map_err(|error| anyhow!("preview source read failed: {error}"))?;
        stats.read_us += began.elapsed().as_micros() as u64;
        if read == 0 {
            break;
        }
        stats.chunks += 1;
        sent = sent
            .checked_add(read as u64)
            .ok_or_else(|| anyhow!("preview source length overflow"))?;
        if sent > expected_bytes {
            return Err(anyhow!("preview source changed while it was streamed"));
        }
        let began = Instant::now();
        if !snapshot {
            hasher.update(&step[..read]);
        }
        stats.hash_us += began.elapsed().as_micros() as u64;
        let began = Instant::now();
        if measure_write {
            stream
                .write_measured(&step[..read], &mut stats.write_timings)
                .await?;
        } else {
            stream.write(&step[..read]).await?;
        }
        stats.write_us += began.elapsed().as_micros() as u64;
        let began = Instant::now();
        crate::blocking::breathe().await;
        stats.yield_us += began.elapsed().as_micros() as u64;
    }
    let streamed_digest: [u8; 32] = hasher.finalize().into();
    if sent != expected_bytes || (!snapshot && streamed_digest != expected_digest) {
        return Err(anyhow!("preview source changed while it was streamed"));
    }
    let began = Instant::now();
    stream.finish().await?;
    stats.finish_us = began.elapsed().as_micros() as u64;
    Ok(stats)
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
