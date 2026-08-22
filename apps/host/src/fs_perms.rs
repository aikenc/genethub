//! The `fs-perms` import: owner-only permissions, which WASI does not model.
//!
//! The guest decides *which* paths are sensitive — it is the one that knows
//! `state.json` holds a bearer token and `logs/` holds transcripts. It cannot
//! act on that, because `wasi:filesystem` has no permission bits, so the shell
//! performs what the guest names. See the v2 proposal §6.9.

use crate::bindings::genehub::host::fs_perms as wit;

impl wit::Host for crate::load::Host {
    async fn restrict_to_owner(&mut self, path: String) -> Result<(), String> {
        restrict(&path).map_err(|error| format!("{path}: {error}"))
    }
}

#[cfg(unix)]
fn restrict(path: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "refusing to restrict a symbolic link",
        ));
    }
    // Directories need the execute bit to be enterable at all, which is why
    // this is not one constant.
    let mode = if metadata.is_dir() { 0o700 } else { 0o600 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

#[cfg(windows)]
fn restrict(path: &str) -> std::io::Result<()> {
    windows_acl::restrict_to_current_user(std::path::Path::new(path))
}

#[cfg(not(any(unix, windows)))]
fn restrict(path: &str) -> std::io::Result<()> {
    let _ = path;
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "owner-only permissions are not implemented on this platform",
    ))
}

#[cfg(windows)]
mod windows_acl {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};

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
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    struct Token(HANDLE);

    impl Drop for Token {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    fn last_error(operation: &str) -> std::io::Error {
        std::io::Error::new(
            std::io::Error::last_os_error().kind(),
            format!("{operation}: {}", std::io::Error::last_os_error()),
        )
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    pub(super) fn restrict_to_current_user(path: &Path) -> std::io::Result<()> {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

        let metadata = std::fs::symlink_metadata(path)?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "refusing to restrict a reparse point",
            ));
        }
        let inheritance = if metadata.is_dir() {
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
        } else {
            0
        };
        let wide_path = wide(path);

        unsafe {
            let mut raw_token: HANDLE = null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) == 0 {
                return Err(last_error("opening the current process token"));
            }
            let token = Token(raw_token);

            let mut token_bytes = 0;
            let first = GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut token_bytes);
            if first != 0 || token_bytes == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER {
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
            let sid = (*token_storage.as_ptr().cast::<TOKEN_USER>()).User.Sid;
            let sid_bytes = GetLengthSid(sid);
            if sid_bytes == 0 {
                return Err(last_error("reading the current user SID"));
            }

            let acl_bytes = size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>()
                + sid_bytes as usize;
            let mut acl_storage = vec![0usize; acl_bytes.div_ceil(word)];
            let acl = acl_storage.as_mut_ptr().cast::<ACL>();
            if InitializeAcl(acl, acl_bytes as u32, ACL_REVISION) == 0 {
                return Err(last_error("initializing an owner-only DACL"));
            }
            if AddAccessAllowedAceEx(acl, ACL_REVISION, inheritance, FILE_ALL_ACCESS, sid) == 0 {
                return Err(last_error("adding the owner DACL entry"));
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
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!(
                        "installing the owner-only DACL: {}",
                        std::io::Error::from_raw_os_error(status as i32)
                    ),
                ));
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn verify_owner_only(path: &Path) -> std::io::Result<()> {
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
                return Err(std::io::Error::other("DACL still inherits access entries"));
            }

            let mut present = 0;
            let mut defaulted = 0;
            let mut acl: *mut ACL = null_mut();
            if GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted) == 0 {
                return Err(last_error("reading the protected DACL"));
            }
            if present == 0 || acl.is_null() || (*acl).AceCount != 1 {
                return Err(std::io::Error::other(
                    "DACL must contain exactly one explicit access entry",
                ));
            }
            let mut raw_ace: *mut c_void = null_mut();
            if GetAce(acl, 0, &mut raw_ace) == 0 {
                return Err(last_error("reading the owner DACL entry"));
            }
            let ace = &*raw_ace.cast::<ACCESS_ALLOWED_ACE>();
            const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
            if ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE || ace.Mask != FILE_ALL_ACCESS {
                return Err(std::io::Error::other(
                    "DACL contains a non-owner or partial access entry",
                ));
            }
            let expected_flags = if std::fs::symlink_metadata(path)?.is_dir() {
                (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8
            } else {
                0
            };
            if ace.Header.AceFlags != expected_flags {
                return Err(std::io::Error::other("unexpected DACL inheritance flags"));
            }
            let ace_sid = (&ace.SidStart as *const u32).cast_mut().cast::<c_void>();
            if EqualSid(ace_sid, user_sid) == 0 {
                return Err(std::io::Error::other(
                    "DACL grants access to a principal other than the current user",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn restricts_files_and_directories_to_the_current_user() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("private");
        let file = root.path().join("secret.json");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(&file, b"secret").unwrap();

        restrict(directory.to_str().unwrap()).unwrap();
        restrict(file.to_str().unwrap()).unwrap();

        windows_acl::verify_owner_only(&directory).unwrap();
        windows_acl::verify_owner_only(&file).unwrap();
    }
}
