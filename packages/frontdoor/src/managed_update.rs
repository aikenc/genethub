//! Durable machine-lifecycle receipts shared by the native updater and guest.
//! Request, worker progress and continuation have separate writers.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIdentity {
    pub channel: String,
    pub instance_id: String,
    pub pid: u32,
    pub app_version: String,
    pub component_version: String,
    pub component_sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppTarget {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub schema: String,
    pub request_id: String,
    pub channel: String,
    pub kind: String,
    pub created_at_ms: u64,
    pub cli: PathBuf,
    pub host: PathBuf,
    pub component: PathBuf,
    pub from: RuntimeIdentity,
    pub resume_session: Option<String>,
    pub app: Option<AppTarget>,
    pub live: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub state: String,
    pub phase: String,
    pub updated_at_ms: u64,
    pub worker_pid: Option<u32>,
    pub running: Option<RuntimeIdentity>,
    pub error: Option<String>,
    pub rollback: Option<String>,
    pub app_applied: bool,
    pub live_applied: bool,
}
impl Progress {
    pub fn accepted() -> Self {
        Self {
            state: "accepted".into(),
            phase: "handoff".into(),
            updated_at_ms: now_ms(),
            worker_pid: None,
            running: None,
            error: None,
            rollback: None,
            app_applied: false,
            live_applied: false,
        }
    }
    pub fn terminal(&self) -> bool {
        matches!(
            self.state.as_str(),
            "succeeded" | "failed" | "interrupted" | "partial"
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Continuation {
    pub request_id: String,
    pub session_id: String,
    pub state: String,
    pub error: Option<String>,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn valid_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        || id == "."
        || id == ".."
    {
        bail!("request/session id must contain 1–128 letters, digits, '-', '_' or '.'");
    }
    Ok(())
}
pub fn root(data: &Path) -> PathBuf {
    data.join("updates")
}
pub fn job(data: &Path, id: &str) -> Result<PathBuf> {
    valid_id(id)?;
    Ok(root(data).join("requests").join(id))
}
pub fn session_file(data: &Path, id: &str) -> Result<PathBuf> {
    valid_id(id)?;
    Ok(root(data).join("sessions").join(format!("{id}.json")))
}
pub fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let file = std::fs::File::open(path).with_context(|| format!("reading {}", path.display()))?;
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        bail!("update record exceeds 1 MiB");
    }
    serde_json::from_slice(&bytes).with_context(|| format!("decoding {}", path.display()))
}
pub fn write<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    use std::io::Write;
    let parent = path.parent().context("update record has no parent")?;
    crate::perms::ensure_real_directory(parent)?;
    crate::perms::restrict_dir_to_owner(parent)?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        crate::perms::restrict_to_owner(&temp)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)?;
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}
pub fn receipt(data: &Path, id: &str) -> Result<Value> {
    let dir = job(data, id)?;
    let request: Request = read(&dir.join("request.json"))?;
    let progress: Progress = read(&dir.join("progress.json"))?;
    let continuation = read::<Continuation>(&dir.join("continuation.json")).ok();
    Ok(
        serde_json::json!({"requestId":request.request_id,"channel":request.channel,"kind":request.kind,
        "updateState":progress.state,"phase":progress.phase,"updatedAtMs":progress.updated_at_ms,
        "targetAppVersion":request.app.as_ref().map(|a|a.version.clone()),"targetComponentVersion":request.live.as_ref().and_then(|v|v.get("releaseVersion")),
        "installedAppVersion":if progress.app_applied {request.app.as_ref().map(|a|a.version.clone())} else if request.kind=="live" || progress.rollback.as_deref().is_some_and(|s|s.starts_with("restored")) || progress.state=="succeeded" {Some(request.from.app_version.clone())} else {None},
        "runningAppVersion":progress.running.as_ref().map(|r|r.app_version.clone()),
        "runningComponentVersion":progress.running.as_ref().map(|r|r.component_version.clone()),
        "running":progress.running,"error":progress.error,"rollback":progress.rollback,
        "appApplied":progress.app_applied,"liveApplied":progress.live_applied,
        "continuation":continuation.map(|c|serde_json::json!({"sessionId":c.session_id,"state":c.state,"error":c.error}))
            .unwrap_or_else(||serde_json::json!({"state":"notRequested"}))}),
    )
}

pub fn write_continuation(data: &Path, value: &Continuation) -> Result<()> {
    write(
        &job(data, &value.request_id)?.join("continuation.json"),
        value,
    )?;
    write(&session_file(data, &value.session_id)?, value)
}
