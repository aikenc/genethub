use std::collections::VecDeque;
use std::io::Read;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use genehub_proto::{
    AssetPreviewError, AssetPreviewKind, AssetPreviewMetadata, AssetPreviewRepresentation,
    AssetPreviewRequest, ExchangeResponseHead,
};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use super::endpoint::{PeerServices, ServerStream, WriteTimings};
use crate::files::{PreviewFailure, PreviewFile};

static PREVIEW_SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
static IMAGE_SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
static IMAGE_QUEUE_SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
static IMAGE_CACHE: OnceLock<std::sync::Mutex<VecDeque<CachedImage>>> = OnceLock::new();
const PREVIEW_IO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const IMAGE_CACHE_BYTES: usize = 128 * 1024 * 1024;
/// On-demand preview loading fetches many small sub-resources in parallel;
/// two slots serialized whole sites behind each other.
const PREVIEW_WORKERS: usize = 8;
// Whole resume payloads avoid a tiny fifth record after each 64KiB source
// read, reducing per-record crypto/actor handoffs without enlarging buffers.
const PREVIEW_SEND_STEP_BYTES: usize = 4 * genehub_proto::resume::MAX_PAYLOAD;

pub(super) async fn handle(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    if !stream.read_body(0).await?.is_empty() {
        anyhow::bail!("asset.preview accepts no request body");
    }
    let request: AssetPreviewRequest = serde_json::from_value(stream.head.metadata.clone())
        .context("invalid asset.preview metadata")?;
    if matches!(
        request.source,
        genehub_proto::WorkspaceFileSource::MachineFile { .. }
    ) && !crate::file_access::machine_files_supported()
    {
        return preview_error(stream, 415, AssetPreviewError::Unsupported, None).await;
    }
    let authorized =
        match crate::file_access::authorize(&services.state, &services.access, &request.source)
            .await
        {
            Ok(file) => file,
            Err(_) => return preview_error(stream, 403, AssetPreviewError::Forbidden, None).await,
        };
    let resolved = &authorized.resolved;

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
    let root = &resolved.root;
    let path = resolved.relative.to_string_lossy().replace('\\', "/");
    let scan_started = Instant::now();
    let read = crate::files::preview(root, &path);
    let mut file = match tokio::time::timeout(PREVIEW_IO_TIMEOUT, read).await {
        Ok(Ok(file)) => file,
        Ok(Err(failure)) => return failure_response(stream, failure).await,
        Err(_) => return preview_error(stream, 408, AssetPreviewError::SourceChanged, None).await,
    };
    authorized
        .recheck(&services.state, &services.access)
        .await?;
    // Shares deliberately keep their narrow, path-free public v2 metadata.
    if !matches!(
        crate::authz::Principal::of(&services.state, &services.access),
        crate::authz::Principal::PreviewShare { .. }
    ) {
        file.metadata.absolute_path = Some(crate::file_access::display(&resolved.absolute));
    }
    file.metadata.storage_scope = Some(format!(
        "{:x}",
        Sha256::digest(services.access.principal.as_bytes())
    ));
    let scan_us = scan_started.elapsed().as_micros() as u64;
    if let Some(
        representation @ (AssetPreviewRepresentation::Image128
        | AssetPreviewRepresentation::Image1024),
    ) = request.representation
    {
        drop(slot);
        return send_image_representation(stream, file, representation, services, &authorized)
            .await;
    }
    // The bounded worker permit covers both the metadata scan and the actual
    // source read; streaming must not turn one retained Vec into hundreds of
    // concurrent disk readers.
    let _slot = slot;
    let scan = file.scan_timings;
    let send_started = Instant::now();
    let stats = send_file(stream, file, services, &authorized).await?;
    tracing::debug!(
        event = "preview_stage_timing",
        request_id = super::endpoint::diagnostic_id(&stream.head.metadata),
        transport = services.carrier_kind.as_str(),
        source_mode = if stats.snapshot { "snapshot" } else { "file" },
        source_bytes = stats.source_bytes,
        worker_wait_us,
        scan_us,
        scan_open_us = scan.open_us,
        scan_read_us = scan.read_us,
        scan_hash_us = scan.hash_us,
        scan_probe_us = scan.probe_us,
        scan_snapshot_us = scan.snapshot_us,
        scan_yield_us = scan.yield_us,
        scan_steps = scan.steps,
        send_us = send_started.elapsed().as_micros() as u64,
        read_us = stats.read_us,
        hash_us = stats.hash_us,
        write_us = stats.write_us,
        write_credit_us = stats.write_timings.credit_us,
        write_budget_us = stats.write_timings.budget_us,
        write_enqueue_us = stats.write_timings.enqueue_us,
        write_completion_us = stats.write_timings.completion_us,
        write_actor_queue_us = stats.write_timings.actor_queue_us,
        write_actor_send_us = stats.write_timings.actor_send_us,
        write_wake_us = stats.write_timings.wake_us,
        write_frames = stats.write_timings.frames,
        finish_us = stats.finish_us,
        chunks = stats.chunks,
        "preview completed"
    );
    Ok(())
}

struct CachedImage {
    version: String,
    representation: AssetPreviewRepresentation,
    result: Arc<crate::image_preview::ImageResult>,
}

fn cached_image(
    version: &str,
    representation: AssetPreviewRepresentation,
) -> Option<Arc<crate::image_preview::ImageResult>> {
    IMAGE_CACHE
        .get_or_init(|| std::sync::Mutex::new(VecDeque::new()))
        .lock()
        .ok()?
        .iter()
        .find(|item| item.version == version && item.representation == representation)
        .map(|item| item.result.clone())
}

fn remember_image(
    version: String,
    representation: AssetPreviewRepresentation,
    result: Arc<crate::image_preview::ImageResult>,
) {
    let Ok(mut cache) = IMAGE_CACHE
        .get_or_init(|| std::sync::Mutex::new(VecDeque::new()))
        .lock()
    else {
        return;
    };
    cache.retain(|item| !(item.version == version && item.representation == representation));
    cache.push_back(CachedImage {
        version,
        representation,
        result,
    });
    while cache
        .iter()
        .map(|item| item.result.bytes.len())
        .sum::<usize>()
        > IMAGE_CACHE_BYTES
    {
        cache.pop_front();
    }
}

async fn send_image_representation(
    stream: &mut ServerStream,
    file: PreviewFile,
    representation: AssetPreviewRepresentation,
    services: &PeerServices,
    authorized: &crate::file_access::AuthorizedFile,
) -> Result<()> {
    if file.metadata.kind != AssetPreviewKind::Image {
        return preview_error(stream, 415, AssetPreviewError::Unsupported, None).await;
    }
    let edge = match representation {
        AssetPreviewRepresentation::Image128 => 128,
        AssetPreviewRepresentation::Image1024 => 1024,
        AssetPreviewRepresentation::Original => unreachable!(),
    };
    let (mut metadata, mut source, expected_digest) = file.into_parts();
    if let Some(result) = cached_image(&metadata.version, representation) {
        tracing::debug!(
            event = "preview_image_cache_hit",
            edge,
            source_bytes = metadata.source_bytes,
            output_bytes = result.bytes.len()
        );
        metadata.media_type = result.media_type.clone();
        metadata.representation = Some(representation);
        metadata.width = Some(result.width);
        metadata.height = Some(result.height);
        authorized
            .recheck(&services.state, &services.access)
            .await?;
        return send_image_bytes(stream, metadata, &result.bytes, services, authorized).await;
    }
    let _queue_slot = match IMAGE_QUEUE_SLOTS
        .get_or_init(|| Arc::new(Semaphore::new(8)))
        .clone()
        .try_acquire_owned()
    {
        Ok(slot) => slot,
        Err(_) => return preview_error(stream, 429, AssetPreviewError::Busy, None).await,
    };
    let image_slot = match tokio::select! {
        result = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            IMAGE_SLOTS
        .get_or_init(|| Arc::new(Semaphore::new(1)))
        .clone()
                .acquire_owned(),
        ) => result,
        _ = stream.next_input() => return Ok(()),
    } {
        Ok(Ok(slot)) => slot,
        _ => return preview_error(stream, 429, AssetPreviewError::Busy, None).await,
    };
    // The source was authenticated and its digest computed before the cache
    // lookup. A cache hit never bypasses path validation or version checking.
    let result = if let Some(result) = cached_image(&metadata.version, representation) {
        tracing::debug!(
            event = "preview_image_cache_hit_after_wait",
            edge,
            source_bytes = metadata.source_bytes,
            output_bytes = result.bytes.len()
        );
        result
    } else {
        let mut bytes = Vec::with_capacity(metadata.source_bytes as usize);
        let mut hasher = Sha256::new();
        let mut step = vec![0u8; crate::files::PREVIEW_STEP_BYTES];
        loop {
            let read = source
                .read(&mut step)
                .map_err(|error| anyhow!("preview source read failed: {error}"))?;
            if read == 0 {
                break;
            }
            if bytes.len() + read > metadata.source_bytes as usize {
                return preview_error(stream, 409, AssetPreviewError::SourceChanged, None).await;
            }
            hasher.update(&step[..read]);
            bytes.extend_from_slice(&step[..read]);
            crate::blocking::breathe().await;
        }
        if bytes.len() != metadata.source_bytes as usize
            || <[u8; 32]>::from(hasher.finalize()) != expected_digest
        {
            return preview_error(stream, 409, AssetPreviewError::SourceChanged, None).await;
        }
        let started = Instant::now();
        let resized = match tokio::select! {
            result = crate::image_preview::resize(bytes, edge) => result,
            _ = stream.next_input() => return Ok(()),
        } {
            Ok(result)
                if result.width > 0
                    && result.height > 0
                    && result.width.max(result.height) <= u32::from(edge)
                    && result.bytes.len() <= 12 * 1024 * 1024
                    && matches!(result.media_type.as_str(), "image/png" | "image/jpeg") =>
            {
                Arc::new(result)
            }
            _ => return preview_error(stream, 415, AssetPreviewError::Unsupported, None).await,
        };
        tracing::debug!(
            event = "preview_image_resize",
            source_bytes = metadata.source_bytes,
            output_bytes = resized.bytes.len(),
            edge,
            elapsed_us = started.elapsed().as_micros() as u64
        );
        remember_image(metadata.version.clone(), representation, resized.clone());
        resized
    };
    drop(image_slot);
    drop(source);
    metadata.media_type = result.media_type.clone();
    metadata.representation = Some(representation);
    metadata.width = Some(result.width);
    metadata.height = Some(result.height);
    authorized
        .recheck(&services.state, &services.access)
        .await?;
    send_image_bytes(stream, metadata, &result.bytes, services, authorized).await
}

async fn send_image_bytes(
    stream: &mut ServerStream,
    metadata: AssetPreviewMetadata,
    bytes: &[u8],
    services: &PeerServices,
    authorized: &crate::file_access::AuthorizedFile,
) -> Result<()> {
    let started = Instant::now();
    let source_bytes = metadata.source_bytes;
    stream
        .respond(&ExchangeResponseHead {
            status: 200,
            metadata: serde_json::to_value(&metadata)?,
            body_length: Some(bytes.len() as u64),
            error: None,
        })
        .await?;
    for chunk in bytes.chunks(PREVIEW_SEND_STEP_BYTES) {
        authorized
            .recheck(&services.state, &services.access)
            .await?;
        stream.write(chunk).await?;
    }
    stream.finish().await?;
    tracing::debug!(
        event = "preview_image_send",
        source_bytes,
        output_bytes = bytes.len(),
        elapsed_us = started.elapsed().as_micros() as u64
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
    finish_us: u64,
    chunks: u64,
    write_timings: WriteTimings,
}

async fn send_file(
    stream: &mut ServerStream,
    file: PreviewFile,
    services: &PeerServices,
    authorized: &crate::file_access::AuthorizedFile,
) -> Result<PreviewSendStats> {
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
        authorized
            .recheck(&services.state, &services.access)
            .await?;
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
        if stats.chunks.is_multiple_of(64) {
            tracing::debug!(
                event = "preview_progress",
                sent,
                chunks = stats.chunks,
                read_us = stats.read_us,
                write_us = stats.write_us,
                credit_us = stats.write_timings.credit_us,
                budget_us = stats.write_timings.budget_us,
                enqueue_us = stats.write_timings.enqueue_us,
                completion_us = stats.write_timings.completion_us,
                actor_queue_us = stats.write_timings.actor_queue_us,
                actor_send_us = stats.write_timings.actor_send_us,
                wake_us = stats.write_timings.wake_us,
                frames = stats.write_timings.frames,
                carrier = services.carrier_kind.as_str()
            );
        }
        // `write` already waits on the socket, so another yield here only
        // inserts a scheduler hop between source chunks. On a 200ms high-BDP
        // link those hops dominate the transfer and the protocol window never
        // reaches the shaped rate.
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
