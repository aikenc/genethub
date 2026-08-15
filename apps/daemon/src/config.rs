//! Configuration and the on-disk layout.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

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
        let root = match std::env::var(crate::channel::ENV_DATA_DIR) {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => dirs::data_dir()
                .context("no platform data directory")?
                .join(crate::channel::DATA_DIR_NAME),
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

    /// Native VM state and signed logic slots. Business data remains in the
    /// daemon's ordinary configuration and session stores.
    pub fn logic_dir(&self) -> PathBuf {
        self.root.join("logic")
    }

    /// Private persistence owned by the portable Wasm application.
    ///
    /// This must not be the daemon data root: that root also contains the
    /// endpoint credential, device enrollment and trusted logic slots. The
    /// guest receives this directory as its `FileRoot::Private` capability and
    /// cannot name any of those platform-owned siblings.
    pub fn portable_dir(&self) -> PathBuf {
        self.root.join("portable")
    }

    pub fn ensure(&self) -> Result<()> {
        ensure_real_directory(&self.root)
            .with_context(|| format!("creating data directory {}", self.root.display()))?;
        // Tighten the parent before creating sensitive children. On a custom
        // data path with a permissive inherited ACL, the opposite order leaves
        // a first-start window in which another local account can traverse the
        // newly created directories.
        restrict_dir_to_owner(&self.root)?;
        ensure_real_directory(&self.logs_dir())?;
        restrict_dir_to_owner(&self.logs_dir())?;
        ensure_real_directory(&self.logic_dir())?;
        restrict_dir_to_owner(&self.logic_dir())?;
        ensure_real_directory(&self.portable_dir())?;
        restrict_dir_to_owner(&self.portable_dir())?;
        migrate_portable_config(self)?;
        restrict_existing_sensitive_tree(&self.logs_dir())?;
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
            match fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    reject_link_or_reparse(&path, &metadata)?;
                    if !metadata.is_file() {
                        anyhow::bail!("sensitive path is not a file: {}", path.display());
                    }
                    restrict_to_owner(&path)?;
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

/// Seeds the portable application's configuration from installations created
/// before the native/Wasm split. It is deliberately copy-once: after the
/// split the guest owns provider/workspace policy, while native startup keeps
/// reading only the bootstrap fields it still needs from the legacy file.
fn migrate_portable_config(paths: &Paths) -> Result<()> {
    let source = paths.config_file();
    let target = paths.portable_dir().join("config.json");
    if target.exists() || !source.exists() {
        return Ok(());
    }
    let bytes =
        fs::read(&source).with_context(|| format!("reading legacy config {}", source.display()))?;
    save_private(&target, &bytes)
        .with_context(|| format!("seeding portable config {}", target.display()))?;
    Ok(())
}

/// The workspace override named by this channel, else a folder in the user's
/// home named after it.
///
/// It sits in the home directory rather than somewhere hidden because the user
/// is expected to open it, drop files in it, and point their own editor at it.
fn default_workspace() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var(crate::channel::ENV_WORKSPACE_DIR) {
        return Ok(PathBuf::from(dir));
    }
    let home = dirs::home_dir().context("no home directory")?;
    Ok(home.join(crate::channel::WORKSPACE_DIR_NAME))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// 0 asks the OS for an ephemeral loopback port.
    pub port: u16,
    /// Retained solely so native startup can reject insecure legacy LAN mode.
    pub lan_enabled: bool,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        match fs::read_to_string(path) {
            Ok(raw) => serde_json::from_str(&raw)
                .with_context(|| format!("parsing config at {}", path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => {
                Err(error).with_context(|| format!("reading config at {}", path.display()))
            }
        }
    }
}

/// Native identity and transport enrollment that must survive restarts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineState {
    pub machine_id: String,
    pub secret: String,
    /// Set once the machine is enrolled with a Hub.
    #[serde(default)]
    pub enrollment: Option<Enrollment>,
    /// Set once the owner points this machine at a relay to be reachable from
    /// outside. Independent of `enrollment`: self-hosting needs no Hub.
    #[serde(default)]
    pub rendezvous: Option<Rendezvous>,
}

/// A relay this machine waits at, and the token it needs to hang there.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendezvous {
    pub relay_url: String,
    #[serde(default)]
    pub join_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrollment {
    pub hub_url: String,
    /// The Hub's id for this machine, shown in the owner's list.
    pub machine_id: String,
    pub daemon_id: String,
    /// Presented only to the Hub HTTPS boundary to mint short-lived uplink
    /// admissions. Only its hash is persisted by the Hub, and the reusable
    /// value must never be sent to a Relay.
    pub secret: String,
    /// Last workspace catalogue generation durably acknowledged by this Hub.
    ///
    /// This lives beside the enrollment rather than in `config.json`: if the
    /// local workspace registry is recreated, the daemon must still be able to
    /// name the generation it is replacing. Without that compare-and-swap an
    /// old process could overwrite a newer registry snapshot.
    #[serde(default)]
    pub workspace_catalog_generation: Option<String>,
}

impl MachineState {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("reading machine state at {}", path.display()))?;
        serde_json::from_str(&raw)
            .with_context(|| format!("parsing machine state at {}", path.display()))
    }

    pub fn load_or_create(path: &Path) -> Result<Self> {
        if path.exists() {
            return Self::load(path);
        }
        let state = MachineState {
            machine_id: format!("m_{}", uuid::Uuid::new_v4().simple()),
            secret: uuid::Uuid::new_v4().simple().to_string(),
            enrollment: None,
            rendezvous: None,
        };
        state.save(path)?;
        Ok(state)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        save_private(path, serde_json::to_string_pretty(self)?.as_bytes())
    }

    /// Short, readable form of the machine identity for out-of-band comparison
    /// between the desktop tray and a browser that just connected.
    pub fn fingerprint(&self) -> String {
        let digest = simple_digest(format!("{}:{}", self.machine_id, self.secret).as_bytes());
        digest
            .chunks(2)
            .take(4)
            .map(|pair| format!("{:02X}{:02X}", pair[0], pair[1]))
            .collect::<Vec<_>>()
            .join("-")
    }
}

/** Writes secrets without a world-readable creation window and survives crashes. */
pub(crate) fn save_private(path: &Path, body: &[u8]) -> Result<()> {
    #[cfg(test)]
    if take_injected_save_failure(path) {
        anyhow::bail!("injected private-save failure for {}", path.display());
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    ensure_real_directory(parent)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("private");
    let tmp = parent.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut cleanup = PrivateTemp::new(tmp.clone());
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp)?;
    restrict_to_owner(&tmp)?;
    file.write_all(body)?;
    file.sync_all()?;
    drop(file);
    replace_private(&tmp, path)?;
    cleanup.disarm();
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("inspecting published private file {}", path.display()))?;
    reject_link_or_reparse(path, &metadata)?;
    if !metadata.is_file() {
        anyhow::bail!("published private path is not a file: {}", path.display());
    }
    // Do not rely on rename ACL preservation; a failed protection step fails
    // the save closed even when the destination existed before this write.
    restrict_to_owner(path)?;
    // Persist the rename where the platform supports syncing directories.
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

#[cfg(test)]
static PRIVATE_SAVE_FAILURES: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashSet<PathBuf>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
pub(crate) fn fail_next_private_save(path: &Path) {
    use std::collections::HashSet;
    use std::sync::Mutex;

    PRIVATE_SAVE_FAILURES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap()
        .insert(path.to_path_buf());
}

#[cfg(test)]
fn take_injected_save_failure(path: &Path) -> bool {
    use std::collections::HashSet;
    use std::sync::Mutex;

    PRIVATE_SAVE_FAILURES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap()
        .remove(path)
}

struct PrivateTemp(Option<PathBuf>);

impl PrivateTemp {
    fn new(path: PathBuf) -> Self {
        Self(Some(path))
    }

    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for PrivateTemp {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn ensure_real_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            reject_link_or_reparse(path, &metadata)?;
            if !metadata.is_dir() {
                anyhow::bail!("expected a directory at {}", path.display());
            }
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| format!("inspecting directory {}", path.display()))
        }
    }
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("inspecting created directory {}", path.display()))?;
    reject_link_or_reparse(path, &metadata)?;
    if !metadata.is_dir() {
        anyhow::bail!("expected a directory at {}", path.display());
    }
    Ok(())
}

#[cfg(unix)]
fn reject_link_or_reparse(path: &Path, metadata: &fs::Metadata) -> Result<()> {
    if metadata.file_type().is_symlink() {
        anyhow::bail!(
            "refusing symbolic link in sensitive data: {}",
            path.display()
        );
    }
    Ok(())
}

#[cfg(windows)]
fn reject_link_or_reparse(path: &Path, metadata: &fs::Metadata) -> Result<()> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        anyhow::bail!(
            "refusing reparse point in sensitive data: {}",
            path.display()
        );
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn reject_link_or_reparse(path: &Path, metadata: &fs::Metadata) -> Result<()> {
    if metadata.file_type().is_symlink() {
        anyhow::bail!(
            "refusing symbolic link in sensitive data: {}",
            path.display()
        );
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn replace_private(source: &Path, destination: &Path) -> Result<()> {
    fs::rename(source, destination)?;
    Ok(())
}

#[cfg(windows)]
pub(crate) fn replace_private(source: &Path, destination: &Path) -> Result<()> {
    windows_acl::replace_file(source, destination)
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn replace_private(_source: &Path, _destination: &Path) -> Result<()> {
    anyhow::bail!("atomic private-file replacement is unsupported on this platform")
}

/// A small non-cryptographic digest used only for display fingerprints.
///
/// Deliberately not used for anything that needs collision resistance; the
/// authentication path uses random secrets compared in full.
fn simple_digest(input: &[u8]) -> [u8; 16] {
    let mut out = [0u8; 16];
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for (i, byte) in input.iter().enumerate() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
        out[i % 16] ^= (hash >> ((i % 8) * 8)) as u8;
    }
    out
}

#[cfg(unix)]
pub fn restrict_to_owner(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o600);
    fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(windows)]
pub fn restrict_to_owner(path: &Path) -> Result<()> {
    windows_acl::restrict_to_current_user(path, false)
}

#[cfg(unix)]
pub(crate) fn restrict_dir_to_owner(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(windows)]
pub(crate) fn restrict_dir_to_owner(path: &Path) -> Result<()> {
    windows_acl::restrict_to_current_user(path, true)
}

#[cfg(windows)]
fn restrict_existing_sensitive_tree(root: &Path) -> Result<()> {
    const MAX_MIGRATION_ENTRIES: usize = 100_000;
    let mut pending = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .with_context(|| format!("reading sensitive directory {}", directory.display()))?
        {
            let entry =
                entry.with_context(|| format!("reading an entry under {}", directory.display()))?;
            visited = visited
                .checked_add(1)
                .context("sensitive ACL migration entry count overflowed")?;
            if visited > MAX_MIGRATION_ENTRIES {
                anyhow::bail!(
                    "refusing to migrate more than {MAX_MIGRATION_ENTRIES} sensitive files"
                );
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .with_context(|| format!("inspecting sensitive path {}", path.display()))?;
            reject_link_or_reparse(&path, &metadata)?;
            if metadata.is_dir() {
                restrict_dir_to_owner(&path)?;
                pending.push(path);
            } else if metadata.is_file() {
                restrict_to_owner(&path)?;
            } else {
                anyhow::bail!("unsupported sensitive data entry: {}", path.display());
            }
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn restrict_existing_sensitive_tree(_root: &Path) -> Result<()> {
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub fn restrict_to_owner(_path: &Path) -> Result<()> {
    anyhow::bail!("owner-only file permissions are unsupported on this platform")
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn restrict_dir_to_owner(_path: &Path) -> Result<()> {
    anyhow::bail!("owner-only directory permissions are unsupported on this platform")
}

#[cfg(windows)]
mod windows_acl {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};

    use anyhow::{bail, Context, Result};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HANDLE,
    };
    use windows_sys::Win32::Security::Authorization::{SetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        AddAccessAllowedAceEx, GetLengthSid, GetTokenInformation, InitializeAcl, TokenUser,
        ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION,
        OBJECT_INHERIT_ACE, PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    struct Token(HANDLE);

    impl Drop for Token {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn last_error(operation: &str) -> anyhow::Error {
        anyhow::Error::new(std::io::Error::last_os_error()).context(operation.to_owned())
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    pub(super) fn replace_file(source: &Path, destination: &Path) -> Result<()> {
        let source_wide = wide(source);
        let destination_wide = wide(destination);
        let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
        if unsafe { MoveFileExW(source_wide.as_ptr(), destination_wide.as_ptr(), flags) } == 0 {
            return Err(last_error("atomically replacing a private file")).with_context(|| {
                format!(
                    "publishing {} as {}",
                    source.display(),
                    destination.display()
                )
            });
        }
        Ok(())
    }

    pub(super) fn restrict_to_current_user(path: &Path, directory: bool) -> Result<()> {
        let wide_path = wide(path);

        unsafe {
            let mut raw_token: HANDLE = null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) == 0 {
                return Err(last_error("opening the current process token"))
                    .with_context(|| format!("protecting {}", path.display()));
            }
            let token = Token(raw_token);

            let mut token_bytes = 0;
            let first = GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut token_bytes);
            if first != 0 || token_bytes == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER {
                return Err(last_error("sizing the current user token"))
                    .with_context(|| format!("protecting {}", path.display()));
            }

            // usize storage gives TOKEN_USER and SID their required alignment.
            let word = size_of::<usize>();
            let mut token_storage = vec![0usize; (token_bytes as usize).div_ceil(word)];
            if GetTokenInformation(
                token.0,
                TokenUser,
                token_storage.as_mut_ptr().cast::<c_void>(),
                token_bytes,
                &mut token_bytes,
            ) == 0
            {
                return Err(last_error("reading the current user token"))
                    .with_context(|| format!("protecting {}", path.display()));
            }
            let user = &*token_storage.as_ptr().cast::<TOKEN_USER>();
            let sid = user.User.Sid;
            let sid_bytes = GetLengthSid(sid);
            if sid_bytes == 0 {
                return Err(last_error("reading the current user SID"))
                    .with_context(|| format!("protecting {}", path.display()));
            }

            let acl_bytes = size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>()
                + sid_bytes as usize;
            let mut acl_storage = vec![0usize; acl_bytes.div_ceil(word)];
            let acl = acl_storage.as_mut_ptr().cast::<ACL>();
            if InitializeAcl(acl, acl_bytes as u32, ACL_REVISION) == 0 {
                return Err(last_error("initializing an owner-only DACL"))
                    .with_context(|| format!("protecting {}", path.display()));
            }
            let inheritance = if directory {
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
            } else {
                0
            };
            if AddAccessAllowedAceEx(acl, ACL_REVISION, inheritance, FILE_ALL_ACCESS, sid) == 0 {
                return Err(last_error("adding the owner DACL entry"))
                    .with_context(|| format!("protecting {}", path.display()));
            }

            let status = SetNamedSecurityInfoW(
                wide_path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null(),
            );
            if status != ERROR_SUCCESS {
                bail!(
                    "protecting {} with an owner-only DACL failed: {}",
                    path.display(),
                    std::io::Error::from_raw_os_error(status as i32)
                );
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn verify_owner_only(path: &Path, directory: bool) -> Result<()> {
        use windows_sys::Win32::Security::{
            EqualSid, GetAce, GetFileSecurityW, GetSecurityDescriptorControl,
            GetSecurityDescriptorDacl, SE_DACL_PROTECTED,
        };

        let wide_path = wide(path);

        unsafe {
            let mut raw_token: HANDLE = null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) == 0 {
                return Err(last_error("opening the current process token"));
            }
            let token = Token(raw_token);
            let mut token_bytes = 0;
            let _ = GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut token_bytes);
            if token_bytes == 0 {
                return Err(last_error("sizing the current user token"));
            }
            let word = size_of::<usize>();
            let mut token_storage = vec![0usize; (token_bytes as usize).div_ceil(word)];
            if GetTokenInformation(
                token.0,
                TokenUser,
                token_storage.as_mut_ptr().cast::<c_void>(),
                token_bytes,
                &mut token_bytes,
            ) == 0
            {
                return Err(last_error("reading the current user token"));
            }
            let user_sid = (*token_storage.as_ptr().cast::<TOKEN_USER>()).User.Sid;

            let mut descriptor_bytes = 0;
            let _ = GetFileSecurityW(
                wide_path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                null_mut(),
                0,
                &mut descriptor_bytes,
            );
            if descriptor_bytes == 0 {
                return Err(last_error("sizing the file security descriptor"));
            }
            let mut descriptor_storage = vec![0usize; (descriptor_bytes as usize).div_ceil(word)];
            let descriptor = descriptor_storage.as_mut_ptr().cast::<c_void>();
            if GetFileSecurityW(
                wide_path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                descriptor,
                descriptor_bytes,
                &mut descriptor_bytes,
            ) == 0
            {
                return Err(last_error("reading the file security descriptor"));
            }

            let mut control = 0;
            let mut revision = 0;
            if GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) == 0 {
                return Err(last_error("reading security descriptor control flags"));
            }
            if control & SE_DACL_PROTECTED == 0 {
                bail!("{} DACL still inherits access entries", path.display());
            }

            let mut present = 0;
            let mut defaulted = 0;
            let mut acl: *mut ACL = null_mut();
            if GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted) == 0 {
                return Err(last_error("reading the protected DACL"));
            }
            if present == 0 || acl.is_null() || (*acl).AceCount != 1 {
                bail!(
                    "{} must have exactly one explicit access entry",
                    path.display()
                );
            }

            let mut raw_ace: *mut c_void = null_mut();
            if GetAce(acl, 0, &mut raw_ace) == 0 {
                return Err(last_error("reading the owner DACL entry"));
            }
            let ace = &*raw_ace.cast::<ACCESS_ALLOWED_ACE>();
            const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
            if ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE || ace.Mask != FILE_ALL_ACCESS {
                bail!("{} has a non-owner or partial access entry", path.display());
            }
            let expected_flags = if directory {
                (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8
            } else {
                0
            };
            if ace.Header.AceFlags != expected_flags {
                bail!("{} has unexpected DACL inheritance flags", path.display());
            }
            let ace_sid = (&ace.SidStart as *const u32).cast_mut().cast::<c_void>();
            if EqualSid(ace_sid, user_sid) == 0 {
                bail!(
                    "{} grants access to a principal other than its owner",
                    path.display()
                );
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn make_unprotected_for_test(path: &Path) -> Result<()> {
        use windows_sys::Win32::Security::UNPROTECTED_DACL_SECURITY_INFORMATION;

        let wide_path = wide(path);
        let status = unsafe {
            SetNamedSecurityInfoW(
                wide_path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null(),
                null(),
            )
        };
        if status != ERROR_SUCCESS {
            bail!(
                "making {} deliberately permissive for a test failed: {}",
                path.display(),
                std::io::Error::from_raw_os_error(status as i32)
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_and_legacy_configs_expose_only_platform_bootstrap_fields() {
        let dir = tempfile::tempdir().unwrap();
        let missing = Config::load(&dir.path().join("missing.json")).unwrap();
        assert_eq!(missing.port, 0);
        assert!(!missing.lan_enabled);

        let path = dir.path().join("config.json");
        fs::write(
            &path,
            r#"{
                "port": 4242,
                "lanEnabled": false,
                "agents": {"providers": {"secret": {"apiKey": "sk-private"}}},
                "workspaces": [{"id": "business-state"}]
            }"#,
        )
        .unwrap();
        let loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.port, 4242);
        assert!(!loaded.lan_enabled);
    }

    #[test]
    fn paths_seed_legacy_business_config_once_into_guest_private_storage() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path());
        fs::create_dir_all(&paths.root).unwrap();
        fs::write(
            paths.config_file(),
            br#"{"port":7,"workspaces":[{"id":"w"}]}"#,
        )
        .unwrap();
        paths.ensure().unwrap();
        let portable = paths.portable_dir().join("config.json");
        assert_eq!(
            fs::read(&portable).unwrap(),
            br#"{"port":7,"workspaces":[{"id":"w"}]}"#
        );
        fs::write(paths.config_file(), br#"{"port":8}"#).unwrap();
        paths.ensure().unwrap();
        assert_eq!(
            fs::read(&portable).unwrap(),
            br#"{"port":7,"workspaces":[{"id":"w"}]}"#
        );
    }

    #[test]
    fn machine_identity_is_private_durable_and_fingerprinted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let first = MachineState::load_or_create(&path).unwrap();
        let second = MachineState::load_or_create(&path).unwrap();
        assert_eq!(first.machine_id, second.machine_id);
        assert_eq!(first.secret, second.secret);
        assert_eq!(first.fingerprint(), second.fingerprint());
        assert_eq!(first.fingerprint().split('-').count(), 4);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn sensitive_roots_reject_symbolic_links() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let victim = tempfile::tempdir().unwrap();
        let root = dir.path().join("data");
        symlink(victim.path(), &root).unwrap();
        assert!(Paths::new(root).ensure().is_err());
    }
}
