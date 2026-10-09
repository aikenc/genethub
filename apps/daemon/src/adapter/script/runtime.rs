//! Finding the Python every script Agent runs on.
//!
//! The daemon never installs it. The installers (and the dev tooling) run
//! `scripts/python-runtime/install-python.*`, which unpacks the pinned build
//! and records its interpreter in `<data>/agents/runtime/python.json`; this only
//! reads that record (`docs/agent-serve-protocol.md` §6).

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

pub struct Runtime {
    dir: PathBuf,
}

#[derive(Deserialize)]
struct Pointer {
    python: PathBuf,
}

impl Runtime {
    pub fn new(dir: PathBuf) -> Self {
        Runtime { dir }
    }

    /// The interpreter path, in the form the host spawns.
    pub fn python(&self) -> Result<PathBuf> {
        let file = self.dir.join("python.json");
        let raw = std::fs::read_to_string(&file).map_err(|_| {
            anyhow!("Python 运行时未安装：请重新运行 GeneHub 安装程序（开发环境运行 scripts/python-runtime 的安装脚本）")
        })?;
        let pointer: Pointer = serde_json::from_str(&raw)
            .with_context(|| format!("Python 运行时记录 {} 无法解析", file.display()))?;
        // The record is in the host's own spelling; the guest opens it by its
        // mount-point spelling.
        if !crate::guest_paths::guest_path(&pointer.python).exists() {
            return Err(anyhow!(
                "Python 运行时记录指向的解释器不存在：{}；请重新运行 GeneHub 安装程序",
                pointer.python.display()
            ));
        }
        Ok(pointer.python)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_in(dir: &std::path::Path) -> Runtime {
        Runtime::new(dir.to_path_buf())
    }

    #[test]
    fn a_missing_record_says_the_runtime_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let error = runtime_in(dir.path()).python().unwrap_err().to_string();
        assert!(error.contains("未安装"), "{error}");
    }

    #[test]
    fn a_record_for_an_interpreter_that_is_gone_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("python-gone").join("python3");
        std::fs::write(
            dir.path().join("python.json"),
            serde_json::json!({ "python": gone }).to_string(),
        )
        .unwrap();
        let error = runtime_in(dir.path()).python().unwrap_err().to_string();
        assert!(error.contains("不存在"), "{error}");
    }

    #[test]
    fn the_recorded_interpreter_is_returned() {
        let dir = tempfile::tempdir().unwrap();
        let python = dir.path().join("python3");
        std::fs::write(&python, "").unwrap();
        std::fs::write(
            dir.path().join("python.json"),
            serde_json::json!({ "python": python }).to_string(),
        )
        .unwrap();
        assert_eq!(runtime_in(dir.path()).python().unwrap(), python);
    }
}
