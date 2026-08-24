//! Keeping the data directory to its owner.
//!
//! Part of the layout, not a decoration on it: the daemon's root holds provider
//! keys, device credentials and the endpoint bearer, so "where the files are"
//! and "who can read them" are one question. That is why this sits beside
//! [`crate::paths`] rather than in whatever module happened to write a file.
//!
//! Three platforms, three different answers. Unix has mode bits. Windows has a
//! DACL that must be *protected*, or an inherited entry from the parent grants
//! access the mode-bit mental model says was removed. WASI has neither, so the
//! guest names the path and the shell performs the change — which is also why
//! deciding *which* paths are sensitive stays on the guest side, the side that
//! knows what is in them.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};

pub fn ensure_real_directory(path: &Path) -> Result<()> {
    match sensitive_metadata(path) {
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
    let metadata = sensitive_metadata(path)
        .with_context(|| format!("inspecting created directory {}", path.display()))?;
    reject_link_or_reparse(path, &metadata)?;
    if !metadata.is_dir() {
        anyhow::bail!("expected a directory at {}", path.display());
    }
    Ok(())
}

/// WASI on a Windows host cannot perform a no-follow metadata lookup and
/// returns `ENOTSUP` before the native ACL import gets a chance to inspect the
/// path. The import is the fail-closed no-follow boundary there; ordinary
/// metadata remains useful to distinguish files and directories in the guest.
#[cfg(target_family = "wasm")]
pub fn sensitive_metadata(path: &Path) -> std::io::Result<fs::Metadata> {
    fs::metadata(path)
}

#[cfg(not(target_family = "wasm"))]
pub fn sensitive_metadata(path: &Path) -> std::io::Result<fs::Metadata> {
    fs::symlink_metadata(path)
}

#[cfg(unix)]
pub fn reject_link_or_reparse(path: &Path, metadata: &fs::Metadata) -> Result<()> {
    if metadata.file_type().is_symlink() {
        anyhow::bail!(
            "refusing symbolic link in sensitive data: {}",
            path.display()
        );
    }
    Ok(())
}

#[cfg(windows)]
pub fn reject_link_or_reparse(path: &Path, metadata: &fs::Metadata) -> Result<()> {
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
pub fn reject_link_or_reparse(path: &Path, metadata: &fs::Metadata) -> Result<()> {
    if metadata.file_type().is_symlink() {
        anyhow::bail!(
            "refusing symbolic link in sensitive data: {}",
            path.display()
        );
    }
    Ok(())
}

#[cfg(unix)]
pub fn replace_private(source: &Path, destination: &Path) -> Result<()> {
    fs::rename(source, destination)?;
    Ok(())
}

#[cfg(windows)]
pub fn replace_private(source: &Path, destination: &Path) -> Result<()> {
    windows_acl::replace_file(source, destination)
}

/// `wasi:filesystem` has rename but no permission bits. The shell owns the data
/// directory's owner-only hardening; see the v2 proposal §5.1.6.
#[cfg(target_family = "wasm")]
pub fn replace_private(source: &Path, destination: &Path) -> Result<()> {
    fs::rename(source, destination)?;
    Ok(())
}

#[cfg(not(any(unix, windows, target_family = "wasm")))]
pub fn replace_private(_source: &Path, _destination: &Path) -> Result<()> {
    anyhow::bail!("atomic private-file replacement is unsupported on this platform")
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

/// WASI exposes no permission bits, so the shell performs what the guest names.
/// Which paths are sensitive stays a guest decision — it is the side that knows
/// what is in them. See the v2 proposal §6.9.
#[cfg(target_family = "wasm")]
pub fn restrict_to_owner(path: &Path) -> Result<()> {
    genet_wasi::wit::genehub::host::fs_perms::restrict_to_owner(&path.to_string_lossy())
        .map_err(|error| anyhow::anyhow!("{error}"))
}

#[cfg(not(any(unix, windows, target_family = "wasm")))]
pub fn restrict_to_owner(_path: &Path) -> Result<()> {
    anyhow::bail!("owner-only file permissions are unsupported on this platform")
}

#[cfg(unix)]
pub fn restrict_dir_to_owner(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(windows)]
pub fn restrict_dir_to_owner(path: &Path) -> Result<()> {
    windows_acl::restrict_to_current_user(path, true)
}

/// The shell reads the path's own type, so a directory gets `0o700` and a file
/// `0o600` without the guest having to say which it is.
#[cfg(target_family = "wasm")]
pub fn restrict_dir_to_owner(path: &Path) -> Result<()> {
    restrict_to_owner(path)
}

#[cfg(not(any(unix, windows, target_family = "wasm")))]
pub fn restrict_dir_to_owner(_path: &Path) -> Result<()> {
    anyhow::bail!("owner-only directory permissions are unsupported on this platform")
}

#[cfg(windows)]
pub fn restrict_existing_sensitive_tree(root: &Path) -> Result<()> {
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
pub fn restrict_existing_sensitive_tree(_root: &Path) -> Result<()> {
    Ok(())
}

/// Opens a log-style file to append to it.
///
/// wasip2 silently drops O_APPEND: an append handle there writes at offset 0
/// every time, so guest code that appends this way overwrites the file from
/// the top (seen as self-erasing daemon.log/chat.jsonl in the wasm shell).
/// The guest instead opens read+write and positions at the end itself; the
/// files this is used for have a single writer at a time. Native keeps
/// O_APPEND, which is atomic across processes.
#[cfg(not(target_family = "wasm"))]
pub fn open_append(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    // Readable too: callers dedupe against what is already there before they
    // append. O_APPEND still owns where writes land.
    options.read(true).create(true).append(true);
    // Every caller restricts the file to its owner right after opening;
    // creating with the final mode closes the window in between.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(target_family = "wasm")]
pub fn open_append(path: &Path) -> std::io::Result<std::fs::File> {
    use std::io::Seek;
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(path)?;
    file.seek(std::io::SeekFrom::End(0))?;
    Ok(file)
}

#[cfg(windows)]
pub mod windows_acl {
    //! `verify_owner_only` and `make_unprotected_for_test` are `pub` rather than
    //! `#[cfg(test)]` because the tests that need them live in the crate that
    //! writes the sensitive files, and a `cfg(test)` item is invisible across a
    //! crate boundary. They read and weaken a DACL and nothing else; neither is
    //! reachable from a product path.

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

    pub fn replace_file(source: &Path, destination: &Path) -> Result<()> {
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

    pub fn restrict_to_current_user(path: &Path, directory: bool) -> Result<()> {
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

    pub fn verify_owner_only(path: &Path, directory: bool) -> Result<()> {
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

    pub fn make_unprotected_for_test(path: &Path) -> Result<()> {
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
