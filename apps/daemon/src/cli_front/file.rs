//! `genet file`: download one file from another machine to this one.
//!
//! The download is a daemon-owned task, not part of the CLI invocation that
//! asked for it. A caller that disconnects — including a `--machine … shell`
//! that started it on another machine and then hit its own timeout — does not
//! stop the transfer, and `file transfer status` finds it again.
//!
//! The receiver decides completion: bytes land in a partial file beside the
//! destination, the source's SHA-256 is compared with what was written, and
//! only then is the partial renamed into place. A transfer that loses its
//! connection retries from what is already on disk; one that outlives the
//! daemon is marked `interrupted` and resumes when the same download is asked
//! for again. A source that changes in between is refused, never spliced.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::output::{self, CliFailure};
use super::rpc::RpcError;
use super::target::Selection;
use super::{query, EXIT_FAILED, EXIT_OK};
use crate::transfer::wire::{FileIdentity, FileReadHead, FileReadRequest};

/// Consecutive failed connections before a transfer stops retrying on its own
/// and waits, `interrupted`, for someone to ask for it again.
const MAX_RETRIES: u32 = 6;
const PERSIST_EVERY_BYTES: u64 = 8 * 1024 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_secs(10);
const HASH_STEP_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferState {
    Running,
    Verifying,
    Completed,
    Failed,
    Canceled,
    Interrupted,
}

impl TransferState {
    fn active(self) -> bool {
        matches!(self, TransferState::Running | TransferState::Verifying)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub transfer_id: String,
    /// The machine the file comes from.
    pub from_machine_id: String,
    /// Absolute path on that machine.
    pub source: String,
    /// Absolute path on this machine.
    pub destination: String,
    /// Where bytes accumulate until verification passes.
    pub partial: String,
    pub overwrite: bool,
    pub state: TransferState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_identity: Option<FileIdentity>,
    pub received_bytes: u64,
    /// What was already on disk when the latest run of this transfer began.
    pub resumed_from: u64,
    pub retries: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
}

struct Live {
    record: Mutex<Transfer>,
    cancel: AtomicBool,
}

struct Registry {
    dir: PathBuf,
    live: Mutex<HashMap<String, Arc<Live>>>,
}

static REGISTRY: OnceLock<Registry> = OnceLock::new();

fn registry() -> Result<&'static Registry, CliFailure> {
    if let Some(registry) = REGISTRY.get() {
        return Ok(registry);
    }
    let state = super::local_state().map_err(CliFailure::protocol)?;
    Ok(REGISTRY.get_or_init(|| Registry {
        dir: state.paths.root.join("transfers"),
        live: Mutex::new(HashMap::new()),
    }))
}

fn now_ms() -> i64 {
    crate::session::store::now_ms()
}

fn persist(registry: &Registry, transfer: &Transfer) -> std::io::Result<()> {
    std::fs::create_dir_all(&registry.dir)?;
    let path = registry.dir.join(format!("{}.json", transfer.transfer_id));
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(transfer)?)?;
    std::fs::rename(temporary, path)
}

/// Every transfer this machine knows, newest first. A record left `running`
/// by a daemon that no longer exists is reported as what it is now:
/// interrupted, and resumable.
fn load_all(registry: &Registry) -> Vec<Transfer> {
    let live = registry.live.lock().expect("transfer registry").clone();
    let mut found: HashMap<String, Transfer> = live
        .iter()
        .map(|(id, live)| (id.clone(), live.record.lock().expect("transfer").clone()))
        .collect();
    if let Ok(entries) = std::fs::read_dir(&registry.dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(mut transfer) = serde_json::from_slice::<Transfer>(&bytes) else {
                continue;
            };
            if found.contains_key(&transfer.transfer_id) {
                continue;
            }
            if transfer.state.active() {
                transfer.state = TransferState::Interrupted;
                transfer.error = Some("the daemon stopped during this transfer".into());
                let _ = persist(registry, &transfer);
            }
            found.insert(transfer.transfer_id.clone(), transfer);
        }
    }
    let mut all: Vec<_> = found.into_values().collect();
    all.sort_by_key(|transfer| std::cmp::Reverse(transfer.started_at_ms));
    all
}

fn update(registry: &Registry, live: &Live, change: impl FnOnce(&mut Transfer)) -> Transfer {
    let snapshot = {
        let mut record = live.record.lock().expect("transfer");
        change(&mut record);
        record.updated_at_ms = now_ms();
        record.clone()
    };
    // The in-memory record stays authoritative for this daemon; a record that
    // failed to persist is recovered on the next run by checking the
    // destination itself (see `run`), so it is reported rather than fatal.
    if let Err(error) = persist(registry, &snapshot) {
        tracing::warn!(transfer = %snapshot.transfer_id, %error, "transfer record not persisted");
    }
    snapshot
}

/// The verified file is already in place but its completion was never
/// recorded: the daemon stopped between the final rename and the receipt.
fn already_published(transfer: &Transfer) -> bool {
    transfer.source_identity.is_some()
        && !Path::new(&transfer.partial).exists()
        && Path::new(&transfer.destination).is_file()
}

struct Ask {
    from: String,
    source: String,
    destination: PathBuf,
    overwrite: bool,
}

fn start(ask: Ask) -> Result<Transfer, CliFailure> {
    let registry = registry()?;
    if ask.destination.is_dir() {
        return Err(CliFailure::invalid_args(
            "the destination is a directory; name the file to create",
        ));
    }
    let parent = ask
        .destination
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| CliFailure::invalid_args("the destination's directory does not exist"))?;
    let destination = ask.destination.to_string_lossy().into_owned();
    let resumable = load_all(registry).into_iter().find(|transfer| {
        transfer.from_machine_id == ask.from
            && transfer.source == ask.source
            && transfer.destination == destination
            && matches!(
                transfer.state,
                TransferState::Running | TransferState::Verifying | TransferState::Interrupted
            )
    });
    let recovering = resumable.as_ref().is_some_and(already_published);
    if ask.destination.exists() && !ask.overwrite && !recovering {
        return Err(CliFailure::business(
            "destinationExists",
            format!("{destination} already exists; pass --overwrite to replace it"),
            Some(json!({"destination": destination})),
        ));
    }
    let mut live_map = registry.live.lock().expect("transfer registry");
    if let Some(existing) = &resumable {
        if let Some(live) = live_map.get(&existing.transfer_id) {
            let current = live.record.lock().expect("transfer").clone();
            if current.state.active() {
                return Ok(current);
            }
        }
    }
    // One destination has one writer at a time; checked under the registry
    // lock so two downloads cannot both pass it.
    let resumed_id = resumable
        .as_ref()
        .map(|transfer| transfer.transfer_id.clone());
    if let Some(busy) = live_map.values().find_map(|live| {
        let record = live.record.lock().expect("transfer");
        (record.state.active()
            && record.destination == destination
            && Some(&record.transfer_id) != resumed_id.as_ref())
        .then(|| record.transfer_id.clone())
    }) {
        return Err(CliFailure::business(
            "destinationBusy",
            format!("transfer {busy} is already writing {destination}"),
            Some(json!({"destination": destination, "transferId": busy})),
        ));
    }
    let transfer = match resumable {
        Some(mut transfer) => {
            let on_disk = std::fs::metadata(&transfer.partial)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            transfer.state = TransferState::Running;
            transfer.error = None;
            transfer.overwrite = ask.overwrite;
            transfer.received_bytes = on_disk;
            transfer.resumed_from = on_disk;
            transfer.retries = 0;
            transfer.updated_at_ms = now_ms();
            transfer
        }
        None => {
            let transfer_id = format!("tr_{}", uuid::Uuid::new_v4().simple());
            let name = ask
                .destination
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "download".into());
            let partial = parent.join(format!(".{name}.genet-partial-{transfer_id}"));
            let now = now_ms();
            Transfer {
                transfer_id,
                from_machine_id: ask.from,
                source: ask.source,
                destination,
                partial: partial.to_string_lossy().into_owned(),
                overwrite: ask.overwrite,
                state: TransferState::Running,
                source_identity: None,
                received_bytes: 0,
                resumed_from: 0,
                retries: 0,
                sha256: None,
                error: None,
                started_at_ms: now,
                updated_at_ms: now,
            }
        }
    };
    persist(registry, &transfer).map_err(|error| {
        CliFailure::business(
            "transferStateUnwritable",
            format!("cannot record the transfer: {error}"),
            None,
        )
    })?;
    let live = Arc::new(Live {
        record: Mutex::new(transfer.clone()),
        cancel: AtomicBool::new(false),
    });
    live_map.insert(transfer.transfer_id.clone(), live.clone());
    drop(live_map);
    super::spawn_detached(run(registry, live));
    Ok(transfer)
}

enum Stop {
    Retry(String),
    Fatal(String),
    SourceChanged,
    Canceled,
}

fn classify(error: RpcError) -> Stop {
    match error {
        RpcError::Remote(error) if error.message.starts_with("sourceChanged") => {
            Stop::SourceChanged
        }
        RpcError::Remote(error)
            if matches!(
                error.code,
                genehub_proto::ErrorCode::NotFound
                    | genehub_proto::ErrorCode::Forbidden
                    | genehub_proto::ErrorCode::BadRequest
                    | genehub_proto::ErrorCode::Unauthorized
            ) =>
        {
            Stop::Fatal(error.message)
        }
        other => Stop::Retry(other.to_string()),
    }
}

async fn canceled(live: &Live) {
    while !live.cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn local(error: std::io::Error) -> Stop {
    Stop::Fatal(format!("writing on this machine failed: {error}"))
}

/// The connection is returned with the stream: dropping it would close the
/// endpoint the stream's bytes arrive on.
struct Opened {
    head: FileReadHead,
    stream: crate::dataplane::client::ClientStream,
    _connection: super::rpc::Rpc,
}

async fn open(from: &str, request: &FileReadRequest) -> Result<Opened, Stop> {
    let rpc = query::connect_selected(&Selection {
        machine: Some(from.to_string()),
        cwd: None,
    })
    .await
    .map_err(|error| Stop::Retry(error.message))?;
    let metadata = serde_json::to_value(request).map_err(|error| Stop::Fatal(error.to_string()))?;
    let (head, stream) = rpc
        .open_data_stream("file.read", metadata)
        .await
        .map_err(classify)?;
    if head.status != 200 {
        return Err(Stop::Retry(format!(
            "the source answered file.read with status {}",
            head.status
        )));
    }
    let parsed = serde_json::from_value(head.metadata)
        .map_err(|error| Stop::Fatal(format!("unreadable file.read answer: {error}")))?;
    Ok(Opened {
        head: parsed,
        stream,
        _connection: rpc,
    })
}

async fn receive(registry: &Registry, live: &Live) -> Result<(), Stop> {
    let (from, source, partial, expected) = {
        let record = live.record.lock().expect("transfer");
        (
            record.from_machine_id.clone(),
            record.source.clone(),
            PathBuf::from(&record.partial),
            record.source_identity.clone(),
        )
    };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&partial)
        .map_err(local)?;
    let mut offset = file.metadata().map_err(local)?.len();
    // Bytes of unknown provenance are not a starting point.
    if expected
        .as_ref()
        .is_none_or(|identity| offset > identity.size)
    {
        file.set_len(0).map_err(local)?;
        offset = 0;
    }
    let request = FileReadRequest {
        path: source,
        offset,
        expect: expected.clone(),
        digest: false,
    };
    let Opened {
        head,
        mut stream,
        _connection,
    } = open(&from, &request).await?;
    if expected
        .as_ref()
        .is_some_and(|identity| *identity != head.identity)
    {
        return Err(Stop::SourceChanged);
    }
    let total = head.identity.size;
    update(registry, live, |record| {
        record.source_identity = Some(head.identity.clone());
        record.received_bytes = offset;
    });
    file.seek(SeekFrom::Start(offset)).map_err(local)?;
    let mut received = offset;
    let mut persisted = offset;
    while received < total {
        if live.cancel.load(Ordering::SeqCst) {
            return Err(Stop::Canceled);
        }
        // A stalled stream must not keep a cancel waiting for its next byte.
        let next = tokio::select! {
            next = stream.next_chunk() => next,
            () = canceled(live) => return Err(Stop::Canceled),
        };
        let bytes = match next {
            Some(Ok(bytes)) => bytes,
            Some(Err(error)) => return Err(Stop::Retry(format!("{error:#}"))),
            None => {
                return Err(Stop::Retry(format!(
                    "the connection ended after {received} of {total} bytes"
                )))
            }
        };
        received += bytes.len() as u64;
        if received > total {
            return Err(Stop::SourceChanged);
        }
        file.write_all(&bytes).map_err(local)?;
        if received - persisted >= PERSIST_EVERY_BYTES {
            file.flush().map_err(local)?;
            persisted = received;
            update(registry, live, |record| record.received_bytes = received);
        } else {
            live.record.lock().expect("transfer").received_bytes = received;
        }
    }
    file.sync_all().map_err(local)?;
    update(registry, live, |record| record.received_bytes = received);
    Ok(())
}

/// Compares the file at `received` with the source's SHA-256.
async fn verify(live: &Live, received: &Path) -> Result<String, Stop> {
    let (from, source, identity) = {
        let record = live.record.lock().expect("transfer");
        (
            record.from_machine_id.clone(),
            record.source.clone(),
            record.source_identity.clone(),
        )
    };
    let request = FileReadRequest {
        path: source,
        offset: 0,
        expect: identity,
        digest: true,
    };
    let opened = open(&from, &request).await?;
    let remote = opened
        .head
        .sha256
        .ok_or_else(|| Stop::Fatal("the source did not report a digest".into()))?;
    let local_digest = hash(received).await.map_err(local)?;
    if local_digest != remote {
        return Err(Stop::Fatal(format!(
            "integrityMismatch: received sha256 {local_digest} but the source has {remote}"
        )));
    }
    Ok(remote)
}

async fn hash(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut step = vec![0u8; HASH_STEP_BYTES];
    loop {
        let read = file.read(&mut step)?;
        if read == 0 {
            break;
        }
        hasher.update(&step[..read]);
        tokio::task::yield_now().await;
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn discard_partial(live: &Live) {
    let partial = live.record.lock().expect("transfer").partial.clone();
    let _ = std::fs::remove_file(partial);
}

async fn run(registry: &'static Registry, live: Arc<Live>) {
    let (partial, destination, overwrite, published) = {
        let record = live.record.lock().expect("transfer");
        (
            PathBuf::from(&record.partial),
            PathBuf::from(&record.destination),
            record.overwrite,
            already_published(&record),
        )
    };
    if !published {
        if let Err(stop) = receive_with_retries(registry, &live).await {
            settle(registry, &live, stop);
            return;
        }
    }
    if live.cancel.load(Ordering::SeqCst) {
        settle(registry, &live, Stop::Canceled);
        return;
    }
    update(registry, &live, |record| {
        record.state = TransferState::Verifying;
        record.error = None;
    });
    let received = if published { &destination } else { &partial };
    let digest = match verify(&live, received).await {
        Ok(digest) => digest,
        Err(stop) => {
            let mismatch = matches!(stop, Stop::Fatal(ref message) if message.starts_with("integrityMismatch"));
            // A published file that fails verification is not ours to delete.
            if mismatch && !published {
                discard_partial(&live);
            }
            settle(registry, &live, stop);
            return;
        }
    };
    if !published {
        if live.cancel.load(Ordering::SeqCst) {
            settle(registry, &live, Stop::Canceled);
            return;
        }
        if let Err(stop) = publish(&partial, &destination, overwrite) {
            settle(registry, &live, stop);
            return;
        }
    }
    update(registry, &live, |record| {
        record.state = TransferState::Completed;
        record.sha256 = Some(digest);
        record.error = None;
    });
}

async fn receive_with_retries(registry: &Registry, live: &Live) -> Result<(), Stop> {
    let mut failures = 0u32;
    loop {
        match receive(registry, live).await {
            Ok(()) => return Ok(()),
            Err(Stop::Retry(message)) => {
                failures += 1;
                if failures > MAX_RETRIES {
                    return Err(Stop::Retry(message));
                }
                update(registry, live, |record| {
                    record.retries += 1;
                    record.error = Some(message);
                });
                let resume_at =
                    tokio::time::Instant::now() + Duration::from_secs(1 << failures.min(5));
                while tokio::time::Instant::now() < resume_at {
                    if live.cancel.load(Ordering::SeqCst) {
                        return Err(Stop::Canceled);
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
            Err(other) => return Err(other),
        }
    }
}

/// Moves the verified partial into place. Without `overwrite` the destination
/// is claimed with an exclusive create first, so a file that appeared in the
/// meantime is refused instead of replaced.
fn publish(partial: &Path, destination: &Path, overwrite: bool) -> Result<(), Stop> {
    if !overwrite {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
        {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(Stop::Fatal(format!(
                    "destinationExists: {} appeared during the transfer",
                    destination.display()
                )))
            }
            Err(error) => return Err(local(error)),
        }
    }
    std::fs::rename(partial, destination).map_err(|error| {
        if !overwrite {
            let _ = std::fs::remove_file(destination);
        }
        local(error)
    })
}

fn settle(registry: &Registry, live: &Live, stop: Stop) {
    let (state, error) = match stop {
        Stop::Canceled => {
            discard_partial(live);
            (TransferState::Canceled, None)
        }
        Stop::SourceChanged => {
            discard_partial(live);
            (
                TransferState::Failed,
                Some(
                    "sourceChanged: the source file changed during the transfer; start again"
                        .into(),
                ),
            )
        }
        Stop::Fatal(message) => (TransferState::Failed, Some(message)),
        Stop::Retry(message) => (TransferState::Interrupted, Some(message)),
    };
    update(registry, live, |record| {
        record.state = state;
        record.error = error;
    });
}

// ---------------------------------------------------------------- verbs

pub async fn file(args: &[String], selection: &Selection) -> i32 {
    if selection.machine.is_some() {
        return output::fail(CliFailure::invalid_args(
            "`file` runs on the receiving machine; to receive elsewhere, run it there (for example with `--machine <id> shell -- genet file download …`)",
        ));
    }
    match args.first().map(String::as_str) {
        Some("download") => download(&args[1..]).await,
        Some("transfer") => match args.get(1).map(String::as_str) {
            Some("status") => status(&args[2..]),
            Some("cancel") => cancel(&args[2..]),
            _ => output::fail(CliFailure::invalid_args(
                "usage: genet file transfer status [<transferId>] | genet file transfer cancel <transferId>",
            )),
        },
        _ => output::fail(CliFailure::invalid_args(
            "usage: genet file download --from <machineId> <source> <destination> [--overwrite] [--no-wait] [--timeout <s>]",
        )),
    }
}

struct DownloadArgs {
    ask: Ask,
    wait: bool,
    timeout: Option<Duration>,
}

fn parse_download(args: &[String]) -> Result<DownloadArgs, CliFailure> {
    let mut from = None;
    let mut overwrite = false;
    let mut wait = true;
    let mut timeout = None;
    let mut positional = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let argument = args[index].as_str();
        let mut value = || {
            index += 1;
            args.get(index)
                .filter(|value| !value.trim().is_empty())
                .cloned()
                .ok_or_else(|| CliFailure::invalid_args(format!("{argument} needs a value")))
        };
        match argument {
            "--from" => from = Some(value()?),
            "--overwrite" => overwrite = true,
            "--no-wait" => wait = false,
            "--wait" => wait = true,
            "--timeout" => {
                let seconds: u64 = value()?
                    .parse()
                    .map_err(|_| CliFailure::invalid_args("--timeout takes whole seconds"))?;
                timeout = Some(Duration::from_secs(seconds));
            }
            other if other.starts_with('-') => {
                return Err(CliFailure::invalid_args(format!("unknown option: {other}")))
            }
            other => positional.push(other.to_string()),
        }
        index += 1;
    }
    let from = from.ok_or_else(|| {
        CliFailure::invalid_args("--from <machineId> names the machine the file is on")
    })?;
    let [source, destination] = <[String; 2]>::try_from(positional).map_err(|_| {
        CliFailure::invalid_args("give exactly a source path and a destination path")
    })?;
    if crate::guest_paths::inbound_absolute(&source).is_none() {
        return Err(CliFailure::invalid_args(
            "the source must be an absolute path on the source machine",
        ));
    }
    let destination = match crate::guest_paths::inbound_absolute(&destination) {
        Some(path) => path,
        None => super::caller_cwd().join(destination),
    };
    Ok(DownloadArgs {
        ask: Ask {
            from,
            source,
            destination,
            overwrite,
        },
        wait,
        timeout,
    })
}

async fn download(args: &[String]) -> i32 {
    let parsed = match parse_download(args) {
        Ok(parsed) => parsed,
        Err(error) => return output::fail(error),
    };
    let started = match start(parsed.ask) {
        Ok(transfer) => transfer,
        Err(error) => return output::fail(error),
    };
    let id = started.transfer_id.clone();
    super::emit_stdout(output::envelope("transfer.started", json!(started)).to_string());
    if !parsed.wait {
        return EXIT_OK;
    }
    let deadline = parsed
        .timeout
        .map(|timeout| tokio::time::Instant::now() + timeout);
    let mut next_progress = tokio::time::Instant::now() + PROGRESS_EVERY;
    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let Some(current) = find(&id) else {
            return output::fail(CliFailure::protocol("the transfer record disappeared"));
        };
        if !current.state.active() {
            return finish(current);
        }
        let now = tokio::time::Instant::now();
        if deadline.is_some_and(|deadline| now >= deadline) {
            return output::succeed(
                "transfer.result",
                json!({"transfer": current, "waited": false}),
            );
        }
        if now >= next_progress {
            next_progress = now + PROGRESS_EVERY;
            super::emit_stdout(output::envelope("transfer.progress", json!(current)).to_string());
        }
    }
}

fn finish(transfer: Transfer) -> i32 {
    if transfer.state == TransferState::Completed {
        return output::succeed(
            "transfer.result",
            json!({"transfer": transfer, "waited": true}),
        );
    }
    let code = match transfer.state {
        TransferState::Canceled => "transferCanceled",
        TransferState::Interrupted => "transferInterrupted",
        _ => "transferFailed",
    };
    let message = transfer
        .error
        .clone()
        .unwrap_or_else(|| format!("the transfer ended {:?}", transfer.state));
    let mut failure = CliFailure::business(code, message, Some(json!({"transfer": transfer})));
    failure.exit = EXIT_FAILED;
    output::fail(failure)
}

fn find(id: &str) -> Option<Transfer> {
    let registry = registry().ok()?;
    load_all(registry)
        .into_iter()
        .find(|transfer| transfer.transfer_id == id)
}

fn status(args: &[String]) -> i32 {
    let registry = match registry() {
        Ok(registry) => registry,
        Err(error) => return output::fail(error),
    };
    match args.first() {
        Some(id) => match find(id) {
            Some(transfer) => output::succeed("transfer", json!(transfer)),
            None => output::fail(CliFailure::target_not_found("transfer", id)),
        },
        None => output::succeed("transfers", json!({"transfers": load_all(registry)})),
    }
}

fn cancel(args: &[String]) -> i32 {
    let Some(id) = args.first() else {
        return output::fail(CliFailure::invalid_args("name the transfer to cancel"));
    };
    let registry = match registry() {
        Ok(registry) => registry,
        Err(error) => return output::fail(error),
    };
    let live = registry
        .live
        .lock()
        .expect("transfer registry")
        .get(id.as_str())
        .cloned();
    match live {
        Some(live) if live.record.lock().expect("transfer").state.active() => {
            live.cancel.store(true, Ordering::SeqCst);
            output::succeed(
                "transfer.cancel",
                json!({"transferId": id, "requested": true}),
            )
        }
        // Known to this daemon but no longer moving: settle it here, where
        // `status` reads it, rather than only on disk.
        Some(live) if live.record.lock().expect("transfer").state == TransferState::Interrupted => {
            settle(registry, &live, Stop::Canceled);
            output::succeed(
                "transfer.cancel",
                json!({"transferId": id, "requested": true}),
            )
        }
        _ => match find(id) {
            Some(mut transfer) if transfer.state == TransferState::Interrupted => {
                let _ = std::fs::remove_file(&transfer.partial);
                transfer.state = TransferState::Canceled;
                transfer.updated_at_ms = now_ms();
                let _ = persist(registry, &transfer);
                output::succeed(
                    "transfer.cancel",
                    json!({"transferId": id, "requested": true}),
                )
            }
            Some(transfer) => output::fail(CliFailure::business(
                "transferNotActive",
                format!("the transfer already ended {:?}", transfer.state),
                Some(json!({"transfer": transfer})),
            )),
            None => output::fail(CliFailure::target_not_found("transfer", id)),
        },
    }
}
