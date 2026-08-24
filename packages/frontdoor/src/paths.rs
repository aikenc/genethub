//! Where everything the daemon owns lives.
//!
//! Shared with the native front door because `genet daemon start|stop|status`
//! has to find the same lock file, endpoint file and log directory the daemon
//! writes — and has to create them to the same standard. Two definitions of
//! this layout would be two products sharing a name.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::channel;
use crate::perms;

/// Where everything the daemon owns lives.
///
/// One root keeps uninstall honest: removing it removes every trace, which is
/// an explicit item on the install self-check in `docs/testing.md` §7. The
/// folder the agent works in is deliberately *not* under it — that one holds
/// the user's own files and must survive an uninstall.
#[derive(Debug, Clone)]
pub struct Paths {
    pub root: PathBuf,
    /// Where the agent works until the user points it somewhere else.
    ///
    /// `None` means do not invent one, which is what a test wants: an empty
    /// machine that registers exactly the directories the test asked for.
    pub default_workspace: Option<PathBuf>,
}

impl Paths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Paths {
            root: root.into(),
            default_workspace: None,
        }
    }

    /// The data-dir override named by this channel, else the platform data
    /// directory.
    ///
    /// The override exists so every test can run against its own directory;
    /// shared state between tests costs far more to debug than it saves.
    pub fn discover() -> Result<Self> {
        let root = match std::env::var(channel::ENV_DATA_DIR) {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => dirs::data_dir()
                .context("no platform data directory")?
                .join(channel::DATA_DIR_NAME),
        };
        Ok(Paths {
            root,
            default_workspace: Some(default_workspace()?),
        })
    }

    pub fn config_file(&self) -> PathBuf {
        self.root.join("config.json")
    }

    pub fn state_file(&self) -> PathBuf {
        self.root.join("state.json")
    }

    pub fn lock_file(&self) -> PathBuf {
        self.root.join("daemon.lock")
    }

    /// Holds the loopback port and token for same-machine clients.
    pub fn endpoint_file(&self) -> PathBuf {
        self.root.join("endpoint.json")
    }

    /// Who is allowed to reach this machine from outside.
    pub fn devices_file(&self) -> PathBuf {
        self.root.join("devices.json")
    }

    /// The other machines this installation has paired with, and the secrets
    /// it proves itself with. The mirror image of `devices_file`: that one is
    /// who may call in, this one is who this may call out to.
    pub fn machines_file(&self) -> PathBuf {
        self.root.join("machines.json")
    }

    /// One directory for everything anyone would ask for when something is
    /// wrong: the daemon's log, and whatever the desktop shell writes.
    ///
    /// Its own directory rather than files loose in the data dir, because the
    /// thing the tray opens has to be a place a person can look at without
    /// picking their way past session state and a lock file.
    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn log_file(&self) -> PathBuf {
        self.logs_dir().join("daemon.log")
    }

    /// Where a downloaded installer waits for someone to run it.
    ///
    /// Under the same root as everything else, so an uninstall that removes the
    /// root does not leave a hundred megabytes behind. The desktop shell knows
    /// this path too — it is the only directory it will open an executable from.
    pub fn updates_dir(&self) -> PathBuf {
        self.root.join("updates")
    }

    pub fn ensure(&self) -> Result<()> {
        perms::ensure_real_directory(&self.root)
            .with_context(|| format!("creating data directory {}", self.root.display()))?;
        // Tighten the parent before creating sensitive children. On a custom
        // data path with a permissive inherited ACL, the opposite order leaves
        // a first-start window in which another local account can traverse the
        // newly created directories.
        perms::restrict_dir_to_owner(&self.root)?;
        perms::ensure_real_directory(&self.logs_dir())?;
        perms::restrict_dir_to_owner(&self.logs_dir())?;
        perms::restrict_existing_sensitive_tree(&self.logs_dir())?;
        // Protect existing sensitive children too. Tightening a Windows parent
        // DACL does not retroactively rewrite ACLs inherited in older releases.
        for path in [
            self.config_file(),
            self.state_file(),
            self.lock_file(),
            self.endpoint_file(),
            self.devices_file(),
            self.log_file(),
        ] {
            match perms::sensitive_metadata(&path) {
                Ok(metadata) => {
                    perms::reject_link_or_reparse(&path, &metadata)?;
                    if !metadata.is_file() {
                        anyhow::bail!("sensitive path is not a file: {}", path.display());
                    }
                    perms::restrict_to_owner(&path)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("inspecting sensitive file {}", path.display()))
                }
            }
        }
        Ok(())
    }
}

/// `dirs::home_dir`, with a WASI answer: the `dirs` crate has no wasi sys
/// implementation and returns `None` in the guest, while the guest does have
/// the user's env — HOME comes through the shell like any other variable.
pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir().or_else(|| {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    })
}

pub fn default_workspace() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var(channel::ENV_WORKSPACE_DIR) {
        return Ok(PathBuf::from(dir));
    }
    let home = home_dir().context("no home directory")?;
    Ok(home.join(channel::WORKSPACE_DIR_NAME))
}

/// Whether a path is inside the data root, for callers that must refuse to
/// treat product state as user content.
pub fn is_inside(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_working_folder_is_never_inside_the_data_folder() {
        // The data root is removed by an uninstall. A default workspace under
        // it would take the user's own files with it.
        let paths = Paths::discover().expect("a platform data directory");
        let workspace = paths.default_workspace.expect("a default workspace");
        assert!(
            !is_inside(&paths.root, &workspace),
            "{} is inside {}",
            workspace.display(),
            paths.root.display()
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_data_root_and_its_log_directory_end_up_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().join("data"));
        paths.ensure().unwrap();

        for path in [paths.root.clone(), paths.logs_dir()] {
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{} is not owner-only", path.display());
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_sensitive_file_is_tightened_rather_than_left_as_found() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().join("data"));
        std::fs::create_dir_all(&paths.root).unwrap();
        std::fs::write(paths.config_file(), "{}").unwrap();
        std::fs::set_permissions(paths.config_file(), std::fs::Permissions::from_mode(0o644))
            .unwrap();

        paths.ensure().unwrap();

        let mode = std::fs::metadata(paths.config_file())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "an inherited-permission config was left readable");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_where_sensitive_state_belongs_is_refused() {
        // Following it would write the daemon's secrets wherever it points.
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        std::fs::write(&outside, "not ours").unwrap();
        let root = dir.path().join("data");
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("config.json")).unwrap();

        let error = Paths::new(&root).ensure().unwrap_err();

        assert!(
            format!("{error:#}").contains("symbolic link"),
            "unexpected error: {error:#}"
        );
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "not ours");
    }
}
