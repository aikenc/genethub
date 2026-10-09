//! `<data>/agents`: where script Agents live and which directory wins.
//!
//! ```text
//! agents/
//!   builtin/<id>/   compiled into this daemon, rewritten on every start
//!   user/<id>/      user or Agent edits; replaces builtin/<id> as a whole
//!   state/<id>/     the script's own state; survives reset
//!   sdk/            boot.py + genehub_agent/
//!   runtime/        Python install scripts and the Python they install
//! ```
//!
//! The daemon reads manifests and fingerprints code for durable decisions;
//! everything an Agent does is the
//! script's business (`docs/agent-serve-protocol.md`).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use genehub_proto::AgentSource;
use sha2::{Digest, Sha256};

struct BuiltinFile {
    relative_path: &'static str,
    contents: &'static [u8],
}

include!(concat!(env!("OUT_DIR"), "/builtin_agents.rs"));

pub const PROTOCOL: u32 = 1;
/// Icons travel in every Agent list push; keep them small.
const ICON_LIMIT: u64 = 32 * 1024;

#[derive(Debug, Clone)]
pub struct Layout {
    root: PathBuf,
}

/// The directory an Agent id currently resolves to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub dir: PathBuf,
    pub source: AgentSource,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct Manifest {
    pub protocol: u32,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_entry")]
    pub entry: String,
    #[serde(default)]
    pub icon: Option<String>,
}

fn default_entry() -> String {
    "agent.py".into()
}

pub fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (2..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

impl Layout {
    pub fn new(data_root: &Path) -> Self {
        Layout {
            root: data_root.join("agents"),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn builtin_dir(&self) -> PathBuf {
        self.root.join("builtin")
    }

    pub fn user_dir(&self) -> PathBuf {
        self.root.join("user")
    }

    pub fn sdk_dir(&self) -> PathBuf {
        self.root.join("sdk")
    }

    pub fn runtime_dir(&self) -> PathBuf {
        self.root.join("runtime")
    }

    pub fn state_dir(&self, id: &str) -> PathBuf {
        self.root.join("state").join(id)
    }

    /// Writes the compiled-in tree and removes files a previous build shipped
    /// that this one does not. `user/`, `state/` and the installed Python are
    /// never touched.
    pub fn materialize(&self) -> Result<()> {
        let mut expected = BTreeSet::new();
        for file in BUILTIN_AGENT_FILES {
            let Some(target) = self.target_of(file.relative_path) else {
                continue;
            };
            expected.insert(target.clone());
            if std::fs::read(&target).ok().as_deref() == Some(file.contents) {
                continue;
            }
            install_file(&target, file.contents)
                .with_context(|| format!("installing {}", target.display()))?;
        }
        for owned in [self.builtin_dir(), self.sdk_dir()] {
            prune(&owned, &expected);
        }
        for private in [self.user_dir(), self.root.join("state")] {
            std::fs::create_dir_all(&private)?;
            if let Err(error) = crate::config::restrict_to_owner(&private) {
                tracing::warn!(path = %private.display(), %error, "could not restrict Agent directory");
            }
        }
        Ok(())
    }

    fn target_of(&self, relative: &str) -> Option<PathBuf> {
        match relative.split_once('/') {
            Some(("agents", rest)) => Some(self.builtin_dir().join(rest)),
            Some(("sdk" | "runtime", _)) => Some(self.root.join(relative)),
            Some(_) => None,
            // Top-level files such as README.md sit next to the layers.
            None => Some(self.root.join(relative)),
        }
    }

    /// Every id with a directory in either layer, in a stable order.
    pub fn ids(&self) -> Vec<String> {
        let mut ids = BTreeSet::new();
        for layer in [self.builtin_dir(), self.user_dir()] {
            let Ok(entries) = std::fs::read_dir(&layer) else {
                continue;
            };
            for entry in entries.flatten() {
                if !entry.path().is_dir() {
                    continue;
                }
                if let Some(name) = entry.file_name().to_str() {
                    if valid_id(name) {
                        ids.insert(name.to_string());
                    }
                }
            }
        }
        ids.into_iter().collect()
    }

    /// `user/<id>` wins over `builtin/<id>` unless that override has been
    /// set aside after crashing.
    pub fn resolve(&self, id: &str, override_disabled: bool) -> Option<Resolved> {
        let user = self.user_dir().join(id);
        let builtin = self.builtin_dir().join(id);
        let has_builtin = builtin.join("agent.toml").is_file();
        if user.is_dir() && !(override_disabled && has_builtin) {
            return Some(Resolved {
                dir: user,
                source: if has_builtin {
                    AgentSource::Override
                } else {
                    AgentSource::User
                },
            });
        }
        has_builtin.then_some(Resolved {
            dir: builtin,
            source: AgentSource::Builtin,
        })
    }

    pub fn has_builtin(&self, id: &str) -> bool {
        self.builtin_dir().join(id).join("agent.toml").is_file()
    }

    /// Deletes `user/<id>`. The next start uses the built-in directory.
    pub fn reset(&self, id: &str) -> Result<bool> {
        let user = self.user_dir().join(id);
        if !user.exists() {
            return Ok(false);
        }
        std::fs::remove_dir_all(&user).with_context(|| format!("removing {}", user.display()))?;
        let _ = std::fs::remove_file(self.state_dir(id).join("override-base"));
        Ok(true)
    }

    /// A digest of what this daemon ships for `id`, so an override can be told
    /// apart from the built-in it was copied from.
    pub fn builtin_digest(&self, id: &str) -> Option<String> {
        let prefix = format!("agents/{id}/");
        let mut hasher = Sha256::new();
        let mut any = false;
        for file in BUILTIN_AGENT_FILES {
            if let Some(rest) = file.relative_path.strip_prefix(&prefix) {
                any = true;
                hasher.update(rest.as_bytes());
                hasher.update([0]);
                hasher.update(file.contents);
            }
        }
        any.then(|| hex(&hasher.finalize()))
    }

    /// Records which built-in an override was activated against, the first
    /// time it is activated.
    pub fn note_override_base(&self, id: &str) {
        let Some(digest) = self.builtin_digest(id) else {
            return;
        };
        let state = self.state_dir(id);
        let path = state.join("override-base");
        if path.exists() {
            return;
        }
        let _ = std::fs::create_dir_all(&state);
        let _ = std::fs::write(path, digest);
    }

    /// An override whose built-in base has since been replaced.
    pub fn override_stale(&self, id: &str) -> bool {
        let Some(current) = self.builtin_digest(id) else {
            return false;
        };
        match std::fs::read_to_string(self.state_dir(id).join("override-base")) {
            Ok(recorded) => recorded.trim() != current,
            Err(_) => false,
        }
    }
}

pub fn read_manifest(dir: &Path) -> Result<Manifest> {
    let path = dir.join("agent.toml");
    let raw =
        std::fs::read_to_string(&path).map_err(|error| anyhow!("读不到 agent.toml：{error}"))?;
    let manifest: Manifest =
        toml::from_str(&raw).map_err(|error| anyhow!("agent.toml 无效：{error}"))?;
    if manifest.protocol != PROTOCOL {
        anyhow::bail!(
            "agent.toml 的 protocol 是 {}，这个 GeneHub 只支持 {PROTOCOL}",
            manifest.protocol
        );
    }
    if manifest.label.trim().is_empty() {
        anyhow::bail!("agent.toml 的 label 不能为空");
    }
    let entry = Path::new(&manifest.entry);
    if entry.is_absolute()
        || entry
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        anyhow::bail!("agent.toml 的 entry 必须是目录内的相对路径");
    }
    if !dir.join(entry).is_file() {
        anyhow::bail!("找不到入口文件 {}", manifest.entry);
    }
    Ok(manifest)
}

/// The icon as a `data:` URL, when the manifest names a small svg or png
/// inside the directory.
pub fn icon_data_url(dir: &Path, manifest: &Manifest) -> Option<String> {
    let name = manifest.icon.as_deref()?;
    let relative = Path::new(name);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return None;
    }
    let mime = match relative.extension()?.to_str()? {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        _ => return None,
    };
    let path = dir.join(relative);
    if std::fs::metadata(&path).ok()?.len() > ICON_LIMIT {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn install_file(target: &Path, contents: &[u8]) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::other("built-in Agent file has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("builtin");
    let temporary = parent.join(format!(".{name}.{}.tmp", crate::host_pid::current()));
    std::fs::write(&temporary, contents)?;
    let installed = std::fs::rename(&temporary, target).or_else(|first| {
        if target.exists() {
            std::fs::remove_file(target)?;
            std::fs::rename(&temporary, target)
        } else {
            Err(first)
        }
    });
    if installed.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    installed
}

/// Removes every file under `root` that is not expected, then empty
/// directories. Best effort: a file in use stays until the next start.
fn prune(root: &Path, expected: &BTreeSet<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Never follow a link out of the tree; a link nobody shipped is
        // removed itself.
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            prune(&path, expected);
            let _ = std::fs::remove_dir(&path);
        } else if !expected.contains(&path) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Stable code revision for a Human decision. Mutable Agent state and Python
/// bytecode live elsewhere; bytecode caches never change the contract hash.
pub(super) fn script_revision(agent: &Path, sdk: &Path) -> Result<String> {
    fn walk(
        base: &Path,
        dir: &Path,
        depth: usize,
        hasher: &mut Sha256,
        budget: &mut (usize, usize),
    ) -> Result<()> {
        anyhow::ensure!(depth <= 12, "adapter code tree is too deep");
        let mut entries = std::fs::read_dir(dir)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name();
            if name == "__pycache__" || entry.path().extension().is_some_and(|e| e == "pyc") {
                continue;
            }
            let kind = entry.file_type()?;
            anyhow::ensure!(
                !kind.is_symlink(),
                "cannot bind a durable decision to symlinked adapter code"
            );
            if kind.is_dir() {
                walk(base, &entry.path(), depth + 1, hasher, budget)?;
            } else if kind.is_file() {
                budget.0 += 1;
                let length = usize::try_from(entry.metadata()?.len())?;
                budget.1 = budget
                    .1
                    .checked_add(length)
                    .ok_or_else(|| anyhow!("adapter code too large"))?;
                anyhow::ensure!(
                    budget.0 <= 4096 && budget.1 <= 32 * 1024 * 1024,
                    "adapter code tree exceeds revision budget"
                );
                let path = entry.path();
                let relative = path
                    .strip_prefix(base)?
                    .to_string_lossy()
                    .replace('\\', "/");
                hasher.update((relative.len() as u64).to_le_bytes());
                hasher.update(relative.as_bytes());
                let bytes = std::fs::read(path)?;
                anyhow::ensure!(
                    bytes.len() == length,
                    "adapter code changed during fingerprinting"
                );
                hasher.update((length as u64).to_le_bytes());
                hasher.update(bytes);
            }
        }
        Ok(())
    }
    let mut hasher = Sha256::new();
    let mut budget = (0, 0);
    hasher.update(b"agent\0");
    walk(agent, agent, 0, &mut hasher, &mut budget)?;
    hasher.update(b"sdk\0");
    walk(sdk, sdk, 0, &mut hasher, &mut budget)?;
    Ok(hex(&hasher.finalize()))
}
