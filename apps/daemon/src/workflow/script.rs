//! The `pack.script` capability: a Workflow node that runs a script the
//! package ships, under a host contract the platform owns.
//!
//! This is how a project teaches the platform an action it never had a name
//! for — committing to a repository, publishing a directory, asking a
//! licence server — without the kernel growing a concept for any of them.
//! The platform's side of the bargain is deliberately small and fixed:
//!
//! - the script is addressed by a path inside the package, so what runs is
//!   whatever the approved `source_digest` covered;
//! - arguments are an argv array, never a shell string, so nothing in the
//!   input can become a second command;
//! - the working directory is the Run's own task directory;
//! - output is bounded, the process is killed as a group on timeout, and
//!   stdout must parse as one JSON object.
//!
//! Everything above is mechanism the platform must enforce itself. What the
//! script is *allowed to reach* — network, paths outside the workspace — is
//! not decided here: the package declares it and a human approves it at
//! build time, because a platform-wide answer would be either too tight for
//! some projects or too loose for the rest.
//!
//! `pack.script` produces facts. It never judges them: its output becomes
//! node evidence, and a registered pure verifier decides whether that
//! evidence is acceptable. Keeping produce and judge apart is what lets
//! anyone re-run the judgment from a Run record without re-running a side
//! effect.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Ceilings the platform applies to every script, whatever the package says.
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_TIMEOUT_SECONDS: u64 = 15 * 60;
const DEFAULT_TIMEOUT_SECONDS: u64 = 120;

/// What a node declares in `with`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScriptDefinition {
    /// Package-relative path, e.g. `scripts/git-commit.mjs`.
    pub(crate) script: String,
    /// Passed to the script as one JSON object on stdin. The platform does
    /// not interpret it; it only bounds its size.
    #[serde(default)]
    pub(crate) input: serde_json::Value,
    #[serde(default)]
    pub(crate) timeout_seconds: Option<u64>,
}

/// What the script must print on stdout.
///
/// `ok` is the script's own report, not a verdict about the Workflow: a
/// script that correctly observes a failure still exits `ok: true` and says
/// so in `evidence`. The distinction matters because the platform retries on
/// transport-shaped failures and never on business ones.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScriptResult {
    pub(crate) ok: bool,
    /// Key/value facts submitted as the node's evidence, judged afterwards
    /// by the ordinary verifier registry.
    #[serde(default)]
    pub(crate) evidence: BTreeMap<String, String>,
    /// An opaque revision or receipt the package understands. The platform
    /// stores and compares it byte-for-byte and never parses it.
    #[serde(default)]
    pub(crate) revision: Option<String>,
    #[serde(default)]
    pub(crate) message: Option<String>,
}

/// Resolves the script path inside the package directory.
///
/// Refuses anything that could leave the package: an absolute path, a
/// traversal component, or a symlink pointing elsewhere. The package is the
/// unit a human approved, so reaching outside it would run code that
/// approval never covered.
pub(crate) fn resolve_script(package_root: &Path, declared: &str) -> Result<PathBuf> {
    if declared.is_empty() || declared.len() > 256 {
        bail!("pack.script 的 script 必须是 1..256 字符的包内相对路径");
    }
    let relative = Path::new(declared);
    if relative.is_absolute() {
        bail!("pack.script 的 script 必须是相对路径：{declared}");
    }
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        bail!("pack.script 的 script 不能包含 . 或 .. 片段：{declared}");
    }
    let target = package_root.join(relative);
    let metadata = crate::config::sensitive_metadata(&target)
        .with_context(|| format!("读取 pack.script 脚本：{declared}"))?;
    crate::config::reject_link_or_reparse(&target, &metadata)?;
    if !metadata.is_file() {
        bail!("pack.script 的 script 必须是普通文件：{declared}");
    }
    let canonical = target
        .canonicalize()
        .with_context(|| format!("读取 pack.script 脚本：{declared}"))?;
    let package_root = package_root
        .canonicalize()
        .context("读取 Workflow 包目录")?;
    if !canonical.starts_with(&package_root) {
        bail!("pack.script 的 script 越出 Workflow 包目录：{declared}");
    }
    Ok(canonical)
}

/// The interpreter a script is run with, chosen by extension.
///
/// A closed table rather than a package-declared command: letting a package
/// name its own interpreter would let it name any program on the machine,
/// which is a different and much larger grant than "run this file".
fn interpreter(script: &Path) -> Result<&'static str> {
    match script.extension().and_then(|value| value.to_str()) {
        Some("mjs" | "js" | "cjs") => Ok("node"),
        Some("py") => Ok("python3"),
        other => bail!(
            "pack.script 暂不支持扩展名 {:?}；目前支持 .mjs/.js/.cjs 与 .py",
            other.unwrap_or("(none)")
        ),
    }
}

/// Runs one script and returns its parsed result.
///
/// `task_cwd` is the Run's own working directory and `confinement` the policy
/// already derived for it, so this adds no authority of its own.
pub(crate) async fn run(
    script: &Path,
    task_cwd: &Path,
    confinement: Option<&genet_native::confine::Policy>,
    definition: &ScriptDefinition,
) -> Result<ScriptResult> {
    let stdin = serde_json::to_vec(&definition.input)?;
    if stdin.len() > MAX_OUTPUT_BYTES {
        bail!("pack.script 的 input 超过 {MAX_OUTPUT_BYTES} 字节");
    }
    let timeout = definition
        .timeout_seconds
        .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
        .clamp(1, MAX_TIMEOUT_SECONDS);

    let program = interpreter(script)?;
    let argv = crate::process::launch_argv(program, confinement)
        .with_context(|| format!("准备 pack.script 运行器：{program}"))?;
    let mut command = crate::process::command(
        &argv,
        std::slice::from_ref(&script.display().to_string()),
        task_cwd,
    );
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = crate::process::Group::spawn(&mut command)
        .with_context(|| format!("启动 pack.script：{}", script.display()))?;
    if let Some(mut sink) = child.stdin() {
        use tokio::io::AsyncWriteExt;
        let _ = sink.write_all(&stdin).await;
        let _ = sink.shutdown().await;
    }
    let stdout = read_bounded(child.stdout());
    let stderr = read_bounded(child.stderr());
    let waited = tokio::time::timeout(
        std::time::Duration::from_secs(timeout),
        async { tokio::join!(stdout, stderr, child.wait()) },
    )
    .await;
    let (stdout, stderr, status) = match waited {
        Ok(joined) => joined,
        Err(_) => {
            // The whole process group goes, so a script that spawned helpers
            // does not leave them holding the task directory.
            child.end().await;
            bail!("pack.script 超过 {timeout}s 未结束：{}", script.display());
        }
    };
    let status = status.context("等待 pack.script 结束")?;
    let stdout = stdout?;
    let stderr = stderr?;
    if !status.success() {
        bail!(
            "pack.script 退出码 {:?}：{}",
            status.code(),
            tail(&stderr)
        );
    }
    parse(&stdout).with_context(|| {
        format!(
            "pack.script 的 stdout 必须是一个有界 JSON 对象；stderr：{}",
            tail(&stderr)
        )
    })
}

fn parse(stdout: &[u8]) -> Result<ScriptResult> {
    let text = std::str::from_utf8(stdout).context("stdout 不是 UTF-8")?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        bail!("stdout 为空");
    }
    serde_json::from_str(trimmed).map_err(|error| anyhow!("{error}"))
}

/// Reads at most `MAX_OUTPUT_BYTES`, so a runaway script cannot exhaust the
/// daemon's memory before the timeout notices it.
async fn read_bounded<R>(source: Option<R>) -> Result<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let Some(source) = source else {
        return Ok(Vec::new());
    };
    let mut buffer = Vec::new();
    source
        .take(MAX_OUTPUT_BYTES as u64 + 1)
        .read_to_end(&mut buffer)
        .await?;
    if buffer.len() > MAX_OUTPUT_BYTES {
        bail!("pack.script 输出超过 {MAX_OUTPUT_BYTES} 字节");
    }
    Ok(buffer)
}

fn tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let text = text.trim();
    match text.char_indices().nth_back(0) {
        _ if text.chars().count() <= 400 => text.to_string(),
        _ => text.chars().skip(text.chars().count() - 400).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(root: &Path) -> PathBuf {
        let package = root.join("pkg");
        std::fs::create_dir_all(package.join("scripts")).unwrap();
        package
    }

    #[test]
    fn a_script_path_cannot_leave_the_approved_package() {
        let root = tempfile::tempdir().unwrap();
        let package = package(root.path());
        std::fs::write(package.join("scripts/ok.mjs"), "").unwrap();
        std::fs::write(root.path().join("outside.mjs"), "").unwrap();

        assert!(resolve_script(&package, "scripts/ok.mjs").is_ok());
        for escape in ["../outside.mjs", "/etc/passwd", "scripts/../../outside.mjs"] {
            assert!(
                resolve_script(&package, escape).is_err(),
                "{escape} should be refused"
            );
        }
    }

    #[test]
    fn only_known_interpreters_run_and_a_package_cannot_name_its_own() {
        assert_eq!(interpreter(Path::new("a/b.mjs")).unwrap(), "node");
        assert_eq!(interpreter(Path::new("a/b.py")).unwrap(), "python3");
        assert!(interpreter(Path::new("a/b.sh")).is_err());
        assert!(interpreter(Path::new("a/b")).is_err());
    }

    /// The host contract end to end against a real interpreter: stdin
    /// carries the declared input, stdout is the only channel that counts,
    /// and the working directory is the one the platform chose.
    #[tokio::test]
    async fn a_script_reads_its_input_and_reports_through_stdout() {
        let root = tempfile::tempdir().unwrap();
        let package = package(root.path());
        std::fs::write(
            package.join("scripts/echo.mjs"),
            r#"
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const input = JSON.parse(raw || "{}");
  // stderr must not be mistaken for the result channel.
  process.stderr.write("diagnostics do not count\n");
  process.stdout.write(JSON.stringify({
    ok: true,
    evidence: { review: input.verdict },
    revision: "opaque/" + process.cwd().split("/").pop(),
  }));
});
"#,
        )
        .unwrap();
        let task = root.path().join("task-dir");
        std::fs::create_dir_all(&task).unwrap();

        let script = resolve_script(&package, "scripts/echo.mjs").unwrap();
        let definition = ScriptDefinition {
            script: "scripts/echo.mjs".into(),
            input: serde_json::json!({ "verdict": "approved" }),
            timeout_seconds: Some(30),
        };
        let result = run(&script, &task, None, &definition).await.unwrap();

        assert!(result.ok);
        assert_eq!(result.evidence.get("review").map(String::as_str), Some("approved"));
        assert_eq!(result.revision.as_deref(), Some("opaque/task-dir"));
    }

    /// The shipped reference implementation, run as a package would run it.
    ///
    /// It publishes a directory and uses no repository tooling at all,
    /// which is the property under test: the capability contract by which a
    /// package teaches the platform a new action must work for a project
    /// that is a plain folder, not only for one that is a checkout. The
    /// fixture therefore never initializes a repository.
    #[tokio::test]
    async fn the_reference_implementation_needs_no_repository_tooling() {
        let root = tempfile::tempdir().unwrap();
        // The real shipped package, not a fixture copy: a reference
        // implementation that drifted from what ships would prove nothing.
        let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("workflow-packages/game-delivery");
        let task = root.path().join("task-dir");
        std::fs::create_dir_all(task.join("build")).unwrap();
        std::fs::create_dir_all(task.join("build/nested")).unwrap();
        std::fs::write(task.join("build/index.html"), "<!doctype html>").unwrap();
        std::fs::write(task.join("build/nested/app.js"), "console.log(1)").unwrap();

        let script = resolve_script(&package, "scripts/publish-directory.mjs").unwrap();
        let definition = ScriptDefinition {
            script: "scripts/publish-directory.mjs".into(),
            input: serde_json::json!({
                "source": "build",
                "destination": "public",
                "expectedFiles": 2,
            }),
            timeout_seconds: Some(60),
        };
        let result = run(&script, &task, None, &definition).await.unwrap();

        assert!(result.ok);
        assert_eq!(result.evidence.get("published").map(String::as_str), Some("2"));
        assert_eq!(
            result.evidence.get("matchedExpectation").map(String::as_str),
            Some("true")
        );
        assert!(task.join("public/nested/app.js").is_file());
        // An opaque receipt: the platform stores it and never parses it.
        assert!(result.revision.is_some_and(|revision| revision.starts_with("dir:")));
        assert!(
            !task.join(".git").exists(),
            "the fixture must stay a plain directory for this test to mean anything"
        );

        // Produce and judge stay apart: the script reported a count, and it
        // is the platform's registered predicate that rules on it.
        let verdict = crate::workflow::verifier("value.equals").expect("registered");

        assert!((verdict.check)("2", Some("2")).is_ok());
        assert!((verdict.check)("2", Some("3")).is_err());
    }

    /// A script that never finishes must not hold the node forever, and its
    /// whole process group goes with it.
    #[tokio::test]
    async fn a_script_that_never_finishes_is_stopped() {
        let root = tempfile::tempdir().unwrap();
        let package = package(root.path());
        std::fs::write(
            package.join("scripts/hang.mjs"),
            "setInterval(() => {}, 1000);\n",
        )
        .unwrap();
        let script = resolve_script(&package, "scripts/hang.mjs").unwrap();
        let definition = ScriptDefinition {
            script: "scripts/hang.mjs".into(),
            input: serde_json::Value::Null,
            timeout_seconds: Some(1),
        };
        let error = run(&script, root.path(), None, &definition)
            .await
            .expect_err("a hanging script must be stopped")
            .to_string();
        assert!(error.contains("超过"), "{error}");
    }

    /// A non-zero exit is a failure of the node, not a silent empty result.
    #[tokio::test]
    async fn a_failing_interpreter_is_reported_rather_than_parsed() {
        let root = tempfile::tempdir().unwrap();
        let package = package(root.path());
        std::fs::write(
            package.join("scripts/boom.mjs"),
            "process.stderr.write('bad input'); process.exit(3);\n",
        )
        .unwrap();
        let script = resolve_script(&package, "scripts/boom.mjs").unwrap();
        let definition = ScriptDefinition {
            script: "scripts/boom.mjs".into(),
            input: serde_json::Value::Null,
            timeout_seconds: Some(30),
        };
        let error = run(&script, root.path(), None, &definition)
            .await
            .expect_err("a non-zero exit must fail the node")
            .to_string();
        assert!(error.contains("退出码"), "{error}");
        assert!(error.contains("bad input"), "{error}");
    }

    #[test]
    fn stdout_must_be_one_bounded_json_object() {
        let parsed = parse(br#"{"ok":true,"evidence":{"review":"approved"},"revision":"r1"}"#)
            .expect("a well formed result");
        assert!(parsed.ok);
        assert_eq!(parsed.evidence.get("review").map(String::as_str), Some("approved"));
        assert_eq!(parsed.revision.as_deref(), Some("r1"));

        assert!(parse(b"").is_err());
        assert!(parse(b"not json").is_err());
        // A revision stays opaque: no format is assumed or required.
        let opaque = parse(br#"{"ok":true,"revision":"changelist-8841/p4"}"#).unwrap();
        assert_eq!(opaque.revision.as_deref(), Some("changelist-8841/p4"));
    }
}
