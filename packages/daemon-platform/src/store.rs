#[cfg(windows)]
use std::fs::OpenOptions;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

use crate::artifact::{ArtifactVerifier, SignedArtifact, VerifiedArtifact};
use crate::error::{PlatformError, Result};

const STATE_FORMAT_VERSION: u32 = 1;
const MAX_ENVELOPE_BYTES: usize = 16 * 1024;
const MAX_STATE_BYTES: usize = 16 * 1024;

pub(crate) struct ArtifactStore {
    root: PathBuf,
    artifacts: PathBuf,
    envelopes: PathBuf,
    states: PathBuf,
    verifier: ArtifactVerifier,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SlotState {
    pub format_version: u32,
    pub generation: u64,
    pub active_artifact_id: String,
    pub previous_artifact_id: Option<String>,
}

impl ArtifactStore {
    pub fn open(root: impl Into<PathBuf>, verifier: ArtifactVerifier) -> Result<Self> {
        let root = root.into();
        let artifacts = root.join("artifacts");
        let envelopes = root.join("envelopes");
        let states = root.join("states");
        fs::create_dir_all(&artifacts)?;
        fs::create_dir_all(&envelopes)?;
        fs::create_dir_all(&states)?;
        sync_directory(&root)?;
        Ok(Self {
            root,
            artifacts,
            envelopes,
            states,
            verifier,
        })
    }

    pub fn persist(&self, artifact: &VerifiedArtifact) -> Result<()> {
        let digest = artifact.digest();
        ensure_digest(digest)?;
        persist_content_addressed(&self.artifact_path(digest), &artifact.component)?;
        let envelope = serde_json::to_vec(&artifact.envelope)?;
        if envelope.len() > MAX_ENVELOPE_BYTES {
            return Err(PlatformError::State(
                "artifact envelope exceeds its storage limit".to_string(),
            ));
        }
        persist_content_addressed(&self.envelope_path(artifact.artifact_id()), &envelope)?;
        sync_directory(&self.artifacts)?;
        sync_directory(&self.envelopes)?;
        sync_directory(&self.root)?;
        Ok(())
    }

    pub fn load(&self, artifact_id: &str) -> Result<VerifiedArtifact> {
        ensure_digest(artifact_id)?;
        let envelope_bytes = read_limited(&self.envelope_path(artifact_id), MAX_ENVELOPE_BYTES)?;
        let envelope: crate::artifact::ArtifactEnvelope = serde_json::from_slice(&envelope_bytes)?;
        let component = read_limited(
            &self.artifact_path(envelope.sha256()),
            self.verifier.max_artifact_bytes(),
        )?;
        let verified = self
            .verifier
            .verify(&SignedArtifact::new(envelope, component))?;
        if verified.artifact_id() != artifact_id {
            return Err(PlatformError::State(
                "envelope filename does not match its verified artifact identity".to_string(),
            ));
        }
        Ok(verified)
    }

    pub fn latest_state(&self) -> Result<Option<SlotState>> {
        let mut candidates = self.state_files()?;
        candidates.sort_unstable_by_key(|candidate| std::cmp::Reverse(candidate.0));
        for (generation, path) in candidates {
            let bytes = match read_limited(&path, MAX_STATE_BYTES) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            let state: SlotState = match serde_json::from_slice(&bytes) {
                Ok(state) => state,
                Err(_) => continue,
            };
            if state.format_version != STATE_FORMAT_VERSION || state.generation != generation {
                continue;
            }
            if ensure_digest(&state.active_artifact_id).is_err()
                || state
                    .previous_artifact_id
                    .as_deref()
                    .is_some_and(|artifact_id| ensure_digest(artifact_id).is_err())
            {
                continue;
            }
            return Ok(Some(state));
        }
        Ok(None)
    }

    pub fn commit(
        &self,
        active_artifact_id: &str,
        previous_artifact_id: Option<&str>,
    ) -> Result<SlotState> {
        ensure_digest(active_artifact_id)?;
        if let Some(previous) = previous_artifact_id {
            ensure_digest(previous)?;
        }
        let generation = self
            .highest_generation()?
            .checked_add(1)
            .ok_or_else(|| PlatformError::State("slot generation overflow".to_string()))?;
        let state = SlotState {
            format_version: STATE_FORMAT_VERSION,
            generation,
            active_artifact_id: active_artifact_id.to_string(),
            previous_artifact_id: previous_artifact_id.map(ToOwned::to_owned),
        };
        let bytes = serde_json::to_vec(&state)?;
        let path = self.state_path(generation);
        persist_immutable(&path, &bytes)?;
        sync_directory(&self.states)?;
        sync_directory(&self.root)?;
        Ok(state)
    }

    fn highest_generation(&self) -> Result<u64> {
        Ok(self
            .state_files()?
            .into_iter()
            .map(|(generation, _)| generation)
            .max()
            .unwrap_or(0))
    }

    fn state_files(&self) -> Result<Vec<(u64, PathBuf)>> {
        let mut states = Vec::new();
        for entry in fs::read_dir(&self.states)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let Some(number) = name
                .strip_prefix("state-")
                .and_then(|name| name.strip_suffix(".json"))
            else {
                continue;
            };
            if number.len() != 20 || !number.bytes().all(|byte| byte.is_ascii_digit()) {
                continue;
            }
            if let Ok(generation) = number.parse() {
                states.push((generation, entry.path()));
            }
        }
        Ok(states)
    }

    fn artifact_path(&self, digest: &str) -> PathBuf {
        self.artifacts.join(format!("{digest}.wasm"))
    }

    fn envelope_path(&self, artifact_id: &str) -> PathBuf {
        self.envelopes.join(format!("{artifact_id}.json"))
    }

    fn state_path(&self, generation: u64) -> PathBuf {
        self.states.join(format!("state-{generation:020}.json"))
    }
}

fn persist_immutable(path: &Path, bytes: &[u8]) -> Result<()> {
    if path.exists() {
        let existing = read_limited(path, bytes.len().saturating_add(1))?;
        if existing == bytes {
            return Ok(());
        }
        return Err(PlatformError::State(format!(
            "immutable file {} already exists with different contents",
            path.display()
        )));
    }

    let parent = path
        .parent()
        .ok_or_else(|| PlatformError::State("immutable path has no parent".to_string()))?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.as_file_mut().write_all(bytes)?;
    temporary.as_file_mut().sync_all()?;
    match temporary.persist_noclobber(path) {
        Ok(file) => {
            file.sync_all()?;
            sync_directory(parent)?;
            Ok(())
        }
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = read_limited(path, bytes.len().saturating_add(1))?;
            if existing == bytes {
                Ok(())
            } else {
                Err(PlatformError::State(format!(
                    "immutable file {} raced with different contents",
                    path.display()
                )))
            }
        }
        Err(error) => Err(PlatformError::Io(error.error)),
    }
}

/// Writes bytes whose expected identity is already encoded by `path`.
///
/// A mismatch cannot be a competing valid value: callers only use this for a
/// verified component digest or signed artifact identity. Replacing it repairs
/// local corruption while preserving atomic visibility for concurrent readers.
fn persist_content_addressed(path: &Path, bytes: &[u8]) -> Result<()> {
    if path.exists()
        && read_limited(path, bytes.len().saturating_add(1)).is_ok_and(|existing| existing == bytes)
    {
        return Ok(());
    }

    let parent = path
        .parent()
        .ok_or_else(|| PlatformError::State("content path has no parent".to_string()))?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.as_file_mut().write_all(bytes)?;
    temporary.as_file_mut().sync_all()?;
    let file = temporary
        .persist(path)
        .map_err(|error| PlatformError::Io(error.error))?;
    file.sync_all()?;
    sync_directory(parent)?;
    Ok(())
}

fn read_limited(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > limit as u64 {
        return Err(PlatformError::State(format!(
            "{} exceeds its {} byte storage limit",
            path.display(),
            limit
        )));
    }
    let file = File::open(path)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(PlatformError::State(format!(
            "{} grew beyond its storage limit while being read",
            path.display()
        )));
    }
    Ok(bytes)
}

fn ensure_digest(digest: &str) -> Result<()> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(PlatformError::State(
            "slot digest is not canonical lowercase SHA-256".to_string(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(windows)]
fn sync_directory(path: &Path) -> Result<()> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?
        .sync_all()?;
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}
