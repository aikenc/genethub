use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use tempfile::{NamedTempFile, TempPath};

use crate::artifact::{ArtifactVerifier, SignedArtifact, VerifiedArtifact};
use crate::error::{PlatformError, Result};

const ACTIVE_FILE: &str = "active.wasm";
const CANDIDATE_FILE: &str = "candidate.wasm";
const HIGH_WATER_FILE: &str = "highest-revision";
const MAX_HIGH_WATER_BYTES: usize = 32;
const MAX_ENVELOPE_BYTES: usize = 16 * 1024;

/// The complete durable update state: one active artifact, one staged
/// candidate and one monotonic anti-replay scalar.
///
/// There is deliberately no slot history or previous artifact. The App ships
/// the recovery baseline; an activated defect is fixed by a higher revision.
pub(crate) struct ArtifactStore {
    root: PathBuf,
    active: PathBuf,
    candidate: PathBuf,
    high_water: PathBuf,
    verifier: ArtifactVerifier,
}

impl ArtifactStore {
    pub fn open(root: impl Into<PathBuf>, verifier: ArtifactVerifier) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        reject_non_file_if_present(&root.join(ACTIVE_FILE))?;
        reject_non_file_if_present(&root.join(CANDIDATE_FILE))?;
        reject_non_file_if_present(&root.join(HIGH_WATER_FILE))?;
        sync_directory(&root)?;
        Ok(Self {
            active: root.join(ACTIVE_FILE),
            candidate: root.join(CANDIDATE_FILE),
            high_water: root.join(HIGH_WATER_FILE),
            root,
            verifier,
        })
    }

    pub fn highest_revision(&self) -> Result<u64> {
        let bytes = match read_limited(&self.high_water, MAX_HIGH_WATER_BYTES) {
            Ok(bytes) => bytes,
            Err(PlatformError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(0)
            }
            Err(error) => return Err(error),
        };
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| PlatformError::State("highest revision is not UTF-8".to_string()))?;
        let number = text.strip_suffix('\n').unwrap_or(text);
        if number.is_empty()
            || !number.bytes().all(|byte| byte.is_ascii_digit())
            || (number.len() > 1 && number.starts_with('0'))
            || text != format!("{number}\n")
        {
            return Err(PlatformError::State(
                "highest revision is not a canonical decimal line".to_string(),
            ));
        }
        number
            .parse::<u64>()
            .map_err(|_| PlatformError::State("highest revision does not fit in u64".to_string()))
    }

    /// Advances the anti-replay fence before a staged candidate can become
    /// active. Repeating the same revision is allowed to repair a missing or
    /// corrupted active file; lowering the fence is never allowed.
    pub fn advance_high_water(&self, revision: u64) -> Result<()> {
        if revision == 0 {
            return Err(PlatformError::State(
                "logic revision must be positive".to_string(),
            ));
        }
        let current = self.highest_revision()?;
        if revision < current {
            return Err(PlatformError::RevisionReplay {
                candidate: revision,
                highest: current,
            });
        }
        if revision == current {
            return Ok(());
        }
        replace_bytes(&self.high_water, format!("{revision}\n").as_bytes())?;
        sync_directory(&self.root)
    }

    pub fn load_active(&self) -> Result<Option<VerifiedArtifact>> {
        self.load_optional(&self.active)
    }

    pub fn load_candidate(&self) -> Result<Option<VerifiedArtifact>> {
        self.load_optional(&self.candidate)
    }

    pub fn stage(&self, artifact: &VerifiedArtifact) -> Result<()> {
        let file = SignedArtifact::new(artifact.envelope.clone(), artifact.component.to_vec())
            .to_single_file()?;
        replace_bytes(&self.candidate, &file)?;
        sync_directory(&self.root)
    }

    /// Publishes the already-fenced candidate as the sole downloaded active.
    pub fn commit_candidate(&self, revision: u64) -> Result<()> {
        let highest = self.highest_revision()?;
        if revision != highest {
            return Err(PlatformError::State(format!(
                "candidate revision {revision} does not match highest revision {highest}"
            )));
        }
        let candidate = self
            .load_candidate()?
            .ok_or_else(|| PlatformError::State("staged candidate is missing".to_string()))?;
        if candidate.envelope().logic_revision() != revision {
            return Err(PlatformError::State(format!(
                "staged candidate revision {} does not match highest revision {revision}",
                candidate.envelope().logic_revision()
            )));
        }
        atomic_replace(&self.candidate, &self.active)?;
        sync_directory(&self.root)
    }

    /// Completes the only recoverable crash point: the high-water mark was
    /// durable but candidate -> active had not yet become visible.
    pub fn recover_candidate(&self) -> Result<bool> {
        let Some(candidate) = self.load_candidate()? else {
            return Ok(false);
        };
        if candidate.envelope().logic_revision() != self.highest_revision()? {
            self.discard_candidate()?;
            return Ok(false);
        }
        self.commit_candidate(candidate.envelope().logic_revision())?;
        Ok(true)
    }

    pub fn discard_active(&self) -> Result<()> {
        remove_if_present(&self.active)?;
        sync_directory(&self.root)
    }

    pub fn discard_candidate(&self) -> Result<()> {
        remove_if_present(&self.candidate)?;
        sync_directory(&self.root)
    }

    fn load_optional(&self, path: &Path) -> Result<Option<VerifiedArtifact>> {
        let limit = self
            .verifier
            .max_artifact_bytes()
            .checked_add(MAX_ENVELOPE_BYTES)
            .ok_or_else(|| PlatformError::State("artifact storage limit overflow".to_string()))?;
        let bytes = match read_limited(path, limit) {
            Ok(bytes) => bytes,
            Err(PlatformError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None)
            }
            Err(error) => return Err(error),
        };
        let artifact = SignedArtifact::from_single_file(&bytes)?;
        self.verifier.verify(&artifact).map(Some)
    }
}

fn reject_non_file_if_present(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => Err(PlatformError::State(format!(
            "update state {} is not a regular file",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn replace_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| PlatformError::State("update path has no parent".to_string()))?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.as_file_mut().write_all(bytes)?;
    temporary.as_file_mut().sync_all()?;
    let temporary = temporary.into_temp_path();
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn remove_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn read_limited(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(PlatformError::State(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
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

fn atomic_replace(source: &Path, destination: &Path) -> Result<()> {
    // TempPath provides the same overwrite-by-rename operation on Unix and
    // Windows without putting platform FFI in the trust kernel. This path is
    // an already durable staged candidate, not a disposable tempfile, so a
    // failed persist must leave it available for the next recovery attempt.
    let mut source = TempPath::try_from_path(source.to_path_buf())?;
    source.disable_cleanup(true);
    source.persist(destination).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(any(windows, not(any(unix, windows))))]
fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}
