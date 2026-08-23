//! Windows host paths as the guest can actually open them.
//!
//! WASI preopens are POSIX. `std::path` on `wasm32` is POSIX too. A Windows
//! data directory such as `C:\Users\...\Temp\.tmpXXX` is therefore not under
//! the `/` preopen — Wasmtime answers `EPERM` (os error 63) and first start
//! dies. GitHub's Windows runners make this worse: the checkout is on `D:`
//! while `tempfile` lands on `C:`.
//!
//! Each existing volume is preopened as `/c`, `/d`, … and *single* host
//! paths in the environment are rewritten to that shape. A Windows `PATH`
//! (`C:\Windows;D:\a\...`) is not one path — rewriting the prefix would
//! hand native children a POSIX string they cannot search. Host imports
//! that take a path from the guest translate back before touching the
//! real filesystem. On Unix the helpers are identity.

#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;

use anyhow::{Context, Result};
use wasmtime_wasi::{FsPerms, WasiCtxBuilder};

/// Give the guest a POSIX view of every mounted Windows volume.
pub fn preopen_host_filesystem(wasi: &mut WasiCtxBuilder) -> Result<()> {
    #[cfg(windows)]
    {
        preopen_windows_volumes(wasi)?;
    }
    #[cfg(not(windows))]
    {
        wasi.preopened_dir("/", "/", FsPerms::ReadWrite)
            .map_err(anyhow::Error::from)
            .context("preopen host root")?;
    }
    Ok(())
}

#[cfg(windows)]
fn preopen_windows_volumes(wasi: &mut WasiCtxBuilder) -> Result<()> {
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        if !Path::new(&root).exists() {
            continue;
        }
        let guest = format!("/{}", (letter as char).to_ascii_lowercase());
        wasi.preopened_dir(&root, guest.as_str(), FsPerms::ReadWrite)
            .map_err(anyhow::Error::from)
            .with_context(|| format!("preopen {root} as {guest}"))?;
    }
    Ok(())
}

/// Env values the host already has, rewritten so the guest can open them.
pub fn env_value_for_guest(value: impl AsRef<str>) -> String {
    #[cfg(windows)]
    {
        host_to_guest(value.as_ref())
    }
    #[cfg(not(windows))]
    {
        value.as_ref().to_string()
    }
}

/// Env values the guest hands a native child, as the host names them.
pub fn env_value_for_host(value: impl AsRef<str>) -> String {
    let value = value.as_ref();
    #[cfg(windows)]
    {
        if value.contains(';') {
            return value
                .split(';')
                .map(host_segment_from_guest)
                .collect::<Vec<_>>()
                .join(";");
        }
        host_segment_from_guest(value)
    }
    #[cfg(not(windows))]
    {
        value.to_string()
    }
}

/// A path the guest handed back, as the host filesystem names it.
pub fn host_path_from_guest(path: impl AsRef<str>) -> PathBuf {
    let path = path.as_ref();
    #[cfg(windows)]
    {
        guest_to_host(path).unwrap_or_else(|| PathBuf::from(path))
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(path)
    }
}

fn host_to_guest(value: &str) -> String {
    // `PATH` and friends are lists. Only a single drive path is rewritten.
    if value.contains(';') {
        return value.to_string();
    }
    let bytes = value.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = value[3..].replace('\\', "/");
        return format!("/{drive}/{rest}");
    }
    value.to_string()
}

#[cfg(windows)]
fn host_segment_from_guest(value: &str) -> String {
    guest_to_host(value)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| value.to_string())
}

fn guest_to_host(path: &str) -> Option<PathBuf> {
    if path.len() >= 3 && path.as_bytes()[1] == b':' {
        return Some(PathBuf::from(path));
    }
    let rest = path.strip_prefix('/')?;
    let (drive, tail) = rest.split_once('/').unwrap_or((rest, ""));
    if drive.len() != 1 || !drive.as_bytes()[0].is_ascii_alphabetic() {
        return None;
    }
    let letter = (drive.as_bytes()[0] as char).to_ascii_uppercase();
    let tail = tail.replace('/', "\\");
    Some(PathBuf::from(if tail.is_empty() {
        format!("{letter}:\\")
    } else {
        format!("{letter}:\\{tail}")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_temp_on_c_becomes_a_posix_path_under_c() {
        assert_eq!(
            host_to_guest(r"C:\Users\RUNNER~1\AppData\Local\Temp\.tmp8MctaG"),
            "/c/Users/RUNNER~1/AppData/Local/Temp/.tmp8MctaG"
        );
    }

    #[test]
    fn windows_checkout_on_d_does_not_collapse_onto_c() {
        assert_eq!(
            host_to_guest(r"D:\a\genethub\genethub\target\debug\genet-dev.exe"),
            "/d/a/genethub/genethub/target/debug/genet-dev.exe"
        );
    }

    #[test]
    fn guest_posix_volume_paths_round_trip_to_windows() {
        assert_eq!(
            guest_to_host("/c/Users/RUNNER~1/AppData/Local/Temp/.tmp8MctaG").unwrap(),
            PathBuf::from(r"C:\Users\RUNNER~1\AppData\Local\Temp\.tmp8MctaG")
        );
        assert_eq!(
            guest_to_host("/d/a/genethub/genethub").unwrap(),
            PathBuf::from(r"D:\a\genethub\genethub")
        );
    }

    #[test]
    fn already_windows_paths_pass_through_on_the_host_side() {
        assert_eq!(
            guest_to_host(r"C:\Users\someone\GeneHub").unwrap(),
            PathBuf::from(r"C:\Users\someone\GeneHub")
        );
    }

    #[test]
    fn posix_paths_without_a_volume_prefix_are_unchanged() {
        assert_eq!(
            host_to_guest("/var/folders/xx/data"),
            "/var/folders/xx/data"
        );
        assert_eq!(guest_to_host("/var/folders/xx/data"), None);
        assert_eq!(
            host_path_from_guest("/var/folders/xx/data"),
            PathBuf::from("/var/folders/xx/data")
        );
    }

    #[test]
    fn windows_path_lists_are_not_treated_as_one_volume_path() {
        let path = r"C:\Windows\system32;C:\Windows;D:\a\genethub";
        assert_eq!(host_to_guest(path), path);
    }

    #[cfg(windows)]
    #[test]
    fn windows_wrappers_rewrite_a_single_volume_path() {
        assert_eq!(
            env_value_for_guest(r"C:\Users\someone\GeneHub"),
            "/c/Users/someone/GeneHub"
        );
        assert_eq!(
            host_path_from_guest("/c/Users/someone/GeneHub"),
            PathBuf::from(r"C:\Users\someone\GeneHub")
        );
        assert_eq!(
            env_value_for_host("/c/Users/someone/GeneHub"),
            r"C:\Users\someone\GeneHub"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_wrappers_do_not_invent_windows_paths() {
        assert_eq!(
            env_value_for_guest("/c/Users/someone/GeneHub"),
            "/c/Users/someone/GeneHub"
        );
        assert_eq!(
            host_path_from_guest("/c/Users/someone/GeneHub"),
            PathBuf::from("/c/Users/someone/GeneHub")
        );
        assert_eq!(
            env_value_for_host("/c/Users/someone/GeneHub"),
            "/c/Users/someone/GeneHub"
        );
    }
}
