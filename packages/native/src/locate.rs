//! Where a program is installed on this machine.
//!
//! The daemon offers whichever agent CLIs are present, so it asks this about
//! `claude`, `codex`, `cursor-agent` and the rest before it offers them. Every
//! part of the answer is native: the separator `PATH` is written with, what
//! `PATHEXT` says counts as a program, and whether the file is there at all.
//! A wasm guest cannot work any of it out — `std::env::split_paths` is
//! `panic!("unsupported")` on WASI — so it asks the shell, and the shell
//! answers from here.

use std::path::{Path, PathBuf};

/// Finds an executable on `PATH`, honouring `PATHEXT` on Windows.
pub fn find_executable(name: &str) -> Option<PathBuf> {
    find_executable_in(name, &[])
}

/// `PATH` first, then extra directories. Extra dirs use the same `PATHEXT`
/// walk as `PATH` — we do not guess `.exe` vs `.cmd` vs `.bat`.
pub fn find_executable_in(name: &str, extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    if name.contains(std::path::MAIN_SEPARATOR) {
        let direct = PathBuf::from(name);
        return direct.is_file().then_some(direct);
    }
    let extensions = executable_extensions();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if let Some(found) = look_in_dir(&dir, name, &extensions) {
                return Some(found);
            }
        }
    }
    extra_dirs
        .iter()
        .find_map(|dir| look_in_dir(dir, name, &extensions))
}

fn executable_extensions() -> Vec<String> {
    if cfg!(windows) {
        let mut extensions: Vec<String> = std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|e| e.to_lowercase())
            .filter(|e| !e.is_empty())
            .collect();
        // Git Bash / `curl | bash` leaves an unsuffixed shim. PATHEXT never
        // lists that, so we try it last rather than instead of `.cmd`.
        extensions.push(String::new());
        extensions
    } else {
        vec![String::new()]
    }
}

fn look_in_dir(dir: &Path, name: &str, extensions: &[String]) -> Option<PathBuf> {
    for extension in extensions {
        let candidate = dir.join(format!("{name}{extension}"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Windows decides what counts as a program from `PATHEXT`, and an extra
    /// directory is searched the same way `PATH` is. Guessing `.exe` over
    /// `.cmd` would miss every npm-installed CLI, which is most of them.
    #[test]
    fn a_directory_is_searched_by_pathext_and_not_by_a_guessed_suffix() {
        let dir = std::env::temp_dir().join(format!("genet-locate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a temporary directory");
        let bat = dir.join("genet-locate-probe.bat");
        std::fs::write(&bat, b"").expect("a file to find");

        assert_eq!(
            look_in_dir(
                &dir,
                "genet-locate-probe",
                &[".exe".into(), ".cmd".into(), ".bat".into()],
            ),
            Some(bat)
        );
        assert!(
            look_in_dir(&dir, "genet-locate-probe", &[".exe".into(), ".cmd".into()],).is_none()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Official Windows installers write `.cmd`. The Linux install script,
    /// and Agents that follow it, write a suffixless file into `~/.local/bin`.
    #[test]
    fn extra_dirs_see_an_extensionless_file_after_pathext_misses() {
        let dir = std::env::temp_dir().join(format!("genet-locate-bare-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a temporary directory");
        let bare = dir.join("genet-locate-bare");
        std::fs::write(&bare, b"").expect("a suffixless shim");

        assert!(look_in_dir(
            &dir,
            "genet-locate-bare",
            &[".exe".into(), ".cmd".into(), ".bat".into()],
        )
        .is_none());
        assert_eq!(
            look_in_dir(
                &dir,
                "genet-locate-bare",
                &[".exe".into(), ".cmd".into(), ".bat".into(), "".into()],
            ),
            Some(bare.clone())
        );
        assert_eq!(
            find_executable_in("genet-locate-bare", std::slice::from_ref(&dir)),
            Some(bare)
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
