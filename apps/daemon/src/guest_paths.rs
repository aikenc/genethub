//! Windows host paths as this daemon can actually open them.
//!
//! The daemon ships as one wasm32-wasip2 component for every OS, so
//! `cfg(windows)` is never true in this build and `std::path` is POSIX end to
//! end. On a Windows host the shell preopens each volume as `/c`, `/d`, …
//! (`apps/host/src/guest_paths.rs`), and that preopen namespace is the only
//! filesystem the guest has. Paths in the host's own spelling still arrive
//! from three directions: configs written by a pre-component (native) daemon,
//! the native CLI front door, and text a user types into the picker's input
//! instead of clicking through it.
//!
//! Everything inbound is normalized here, once, at the boundary. Outbound
//! payloads deliberately stay in guest form: `/f/dev/project` is what every
//! later filesystem call needs, and translating each reply back would spread
//! host knowledge across the wire protocol. One exception: a payload consumed
//! by a *native* agent process (its `cwd`, a spilled attachment it must open)
//! names host files, so those spots go through `host_form`/`host_path` —
//! fb_M5CQD86STboK was a native codex resolving `/e/dev` as `E:\e\dev`.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// One mounted Windows volume, in both spellings the picker needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Volume {
    /// Uppercase drive letter for display (`F`).
    pub letter: char,
    /// The guest-side mount point (`/f`).
    pub guest: String,
}

/// The volumes a Windows host preopened for this component.
///
/// Preopens are fixed when the Store is built and cannot join later, so the
/// probe runs once and is cached. On any non-wasm build there is no preopen
/// namespace to probe: native Windows keeps its own drive-letter code paths
/// and Unix answers the plain `/` root.
pub(crate) fn windows_volumes() -> &'static [Volume] {
    static VOLUMES: OnceLock<Vec<Volume>> = OnceLock::new();
    VOLUMES.get_or_init(|| {
        if !cfg!(target_family = "wasm") {
            return Vec::new();
        }
        (b'a'..=b'z')
            .filter_map(|letter| {
                let guest = format!("/{}", letter as char);
                if !Path::new(&guest).is_dir() {
                    return None;
                }
                Some(Volume {
                    letter: (letter as char).to_ascii_uppercase(),
                    guest,
                })
            })
            .collect()
    })
}

/// Whether the machine behind this daemon speaks Windows paths.
///
/// Compile-time `cfg!(windows)` answers for native builds; the component has
/// to ask the preopen namespace instead.
pub(crate) fn windows_host() -> bool {
    cfg!(windows) || !windows_volumes().is_empty()
}

/// One path in the guest's spelling, however the caller spelled it.
///
/// Only the component build translates: a native Windows daemon already
/// speaks `F:\dir`, and rewriting it would break every native caller. In the
/// component, accepts the forms that leak in from a Windows host: `F:\dir`,
/// `F:/dir`, the verbatim `\\?\F:\dir` a native `canonicalize` produces, and
/// the bare drive root `F:`. Everything else — guest paths, Unix paths,
/// relative paths, UNC shares (which no preopen covers) — passes through
/// untouched.
pub(crate) fn guest_form(raw: &str) -> Cow<'_, str> {
    if cfg!(target_family = "wasm") {
        wasm_guest_form(raw)
    } else {
        Cow::Borrowed(raw)
    }
}

/// The translation itself, unconditional so tests can reach it from native
/// builds. Callers go through `guest_form`.
fn wasm_guest_form(raw: &str) -> Cow<'_, str> {
    let stripped = raw
        .strip_prefix(r"\\?\")
        .or_else(|| raw.strip_prefix("//?/"))
        .unwrap_or(raw);
    let bytes = stripped.as_bytes();
    if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return Cow::Borrowed(raw);
    }
    let drive = (bytes[0] as char).to_ascii_lowercase();
    let rest = &stripped[2..];
    // `F:dir` is drive-relative on Windows (resolved against the drive's
    // current directory). The guest has no such notion; nobody typing a path
    // into a picker means it, so the volume root is the only sane anchor.
    let rest = rest.strip_prefix(['\\', '/']).unwrap_or(rest);
    if rest.is_empty() {
        return Cow::Owned(format!("/{drive}"));
    }
    Cow::Owned(format!("/{drive}/{}", rest.replace('\\', "/")))
}

/// `guest_form` for a `Path` that arrived over the wire or from config.
pub(crate) fn guest_path(raw: &Path) -> PathBuf {
    match guest_form(&raw.to_string_lossy()) {
        Cow::Borrowed(_) => raw.to_path_buf(),
        Cow::Owned(translated) => PathBuf::from(translated),
    }
}

/// One path spelled as a native child process must see it.
///
/// The spawn import translates `argv[0]`, `current_dir`, and env values, but
/// anything embedded in a protocol payload — a JSON-RPC `cwd`, a `localImage`
/// path, a `?directory=` query — crosses verbatim, and a native agent on
/// Windows resolves `/e/dev` against its own drive as `E:\e\dev`. Protocol
/// consumers that share this component's preopen namespace (the wasm
/// `agent-serve` child) must keep guest form; callers decide per spawn target.
///
/// Like `guest_form`, only the component build translates, and only behind a
/// Windows host: on wasm-on-Unix `/c/...` can be a real directory.
pub(crate) fn host_form(raw: &str) -> Cow<'_, str> {
    if cfg!(target_family = "wasm") && windows_host() {
        match wasm_host_form(raw) {
            Some(translated) => Cow::Owned(translated),
            None => Cow::Borrowed(raw),
        }
    } else {
        Cow::Borrowed(raw)
    }
}

/// The translation itself, unconditional so tests can reach it from native
/// builds. `None` where the host side would also pass the value through.
fn wasm_host_form(raw: &str) -> Option<String> {
    // Already host form (`E:\dev`, `E:/dev`, even the drive-relative `E:dev`
    // a user should never produce) — pass through untouched.
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return None;
    }
    let rest = raw.strip_prefix('/')?;
    let (drive, tail) = rest.split_once('/').unwrap_or((rest, ""));
    if drive.len() != 1 || !drive.as_bytes()[0].is_ascii_alphabetic() {
        return None;
    }
    let letter = (drive.as_bytes()[0] as char).to_ascii_uppercase();
    let tail = tail.replace('/', "\\");
    Some(if tail.is_empty() {
        format!("{letter}:\\")
    } else {
        format!("{letter}:\\{tail}")
    })
}

/// `host_form` for a `Path` about to be embedded in a native agent's payload.
pub(crate) fn host_path(raw: &Path) -> PathBuf {
    match host_form(&raw.to_string_lossy()) {
        Cow::Borrowed(_) => raw.to_path_buf(),
        Cow::Owned(translated) => PathBuf::from(translated),
    }
}

#[cfg(test)]
mod tests {
    // The gated `guest_form` is a no-op on the native test host; the tests
    // exercise the translation itself.
    use super::wasm_guest_form as guest_form;
    use super::{guest_path, wasm_host_form, Path, PathBuf};

    #[test]
    fn windows_drive_paths_become_guest_mounts() {
        assert_eq!(guest_form(r"F:\dev\pipespaces\x"), "/f/dev/pipespaces/x");
        assert_eq!(guest_form("F:/dev/pipespaces/x"), "/f/dev/pipespaces/x");
        assert_eq!(guest_form(r"f:\Dev"), "/f/Dev");
    }

    #[test]
    fn verbatim_paths_from_a_native_canonicalize_lose_the_prefix() {
        assert_eq!(
            guest_form(r"\\?\F:\dev\pipespaces-tikistar\pipespaces\tikistar-video2ani"),
            "/f/dev/pipespaces-tikistar/pipespaces/tikistar-video2ani"
        );
        assert_eq!(guest_form("//?/C:/Users/ronal"), "/c/Users/ronal");
    }

    #[test]
    fn bare_drive_letters_anchor_at_the_volume_root() {
        assert_eq!(guest_form("F:"), "/f");
        assert_eq!(guest_form(r"F:\"), "/f");
        assert_eq!(guest_form("F:/"), "/f");
        assert_eq!(guest_form("F:dir"), "/f/dir");
    }

    #[test]
    fn paths_without_a_drive_prefix_pass_through() {
        for raw in [
            "/f/dev/pipespaces/x",
            "/home/ubuntu/dev",
            "relative/dir",
            "",
            r"\\server\share\dir",
            r"\\?\UNC\server\share",
        ] {
            assert_eq!(guest_form(raw), raw, "{raw}");
        }
    }

    #[test]
    fn translation_is_idempotent() {
        let once = guest_form(r"\\?\F:\dev\x").into_owned();
        assert_eq!(guest_form(&once), once);
    }

    #[test]
    fn guest_volume_paths_become_windows_drive_paths() {
        assert_eq!(
            wasm_host_form("/e/dev/doubao"),
            Some(r"E:\dev\doubao".to_string())
        );
        assert_eq!(
            wasm_host_form("/c/Users/ronal/AppData"),
            Some(r"C:\Users\ronal\AppData".to_string())
        );
        assert_eq!(wasm_host_form("/f"), Some(r"F:\".to_string()));
    }

    #[test]
    fn already_windows_paths_are_left_alone() {
        assert_eq!(wasm_host_form(r"E:\dev"), None);
        assert_eq!(wasm_host_form("E:/dev"), None);
        assert_eq!(wasm_host_form("E:"), None);
    }

    #[test]
    fn paths_without_a_volume_prefix_are_left_alone() {
        for raw in [
            "/home/ubuntu/dev",
            "/tmp/x",
            "/var/folders/xx/data",
            "relative/dir",
            "",
            r"\\server\share\dir",
        ] {
            assert_eq!(wasm_host_form(raw), None, "{raw}");
        }
    }

    #[test]
    fn host_and_guest_forms_round_trip() {
        assert_eq!(
            wasm_host_form(&guest_form(r"E:\dev\x")).as_deref(),
            Some(r"E:\dev\x")
        );
        assert_eq!(
            wasm_host_form(&guest_form("F:/dev/pipespaces/x")).as_deref(),
            Some(r"F:\dev\pipespaces\x")
        );
    }

    #[test]
    fn guest_path_wraps_guest_form() {
        if cfg!(target_family = "wasm") {
            assert_eq!(
                guest_path(Path::new(r"F:\dev\x")),
                PathBuf::from("/f/dev/x")
            );
        }
        assert_eq!(
            guest_path(Path::new("/already/guest")),
            PathBuf::from("/already/guest")
        );
    }
}
