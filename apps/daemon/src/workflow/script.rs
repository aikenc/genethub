//! The `pack.script` capability: a Workflow node that runs a program the
//! package names.
//!
//! This is how a project teaches the platform an action it never had a name
//! for — committing to a repository, publishing a build, driving a render
//! farm, asking a licence server — without the kernel growing a concept for
//! any of them.
//!
//! **The platform does not sandbox this.** A script runs with the same reach
//! as the account the daemon runs as, which is the same reach the Agent in
//! the next node already has: an Agent can run any shell command it likes,
//! so confining the declared, digest-anchored path while leaving the
//! undeclared one open would buy nothing and cost every script that needs a
//! credential in `$HOME`, a tool in `/opt`, or the network. Isolation is a
//! deployment decision — run GeneHub in a VM or a container if this machine
//! should not be fully reachable — and deciding it here would be the
//! platform choosing a policy on the user's behalf, which is exactly what
//! this layer is not for.
//!
//! What the platform still owns is mechanism, not permission:
//!
//! - the Run gets its result back, so output is read with a ceiling and the
//!   process is killed as a group when its deadline passes. That bounds the
//!   *daemon's* exposure to a script that hangs or never stops writing; it
//!   does not bound what the script may do.
//! - arguments are passed as argv rather than pasted into a shell string, so
//!   a node's `input` cannot silently become a second command. That is
//!   injection-safety for the caller, not a restriction on the callee — the
//!   script is free to spawn a shell itself.
//!
//! Trust comes from `source_digest`: `workflow build --apply` puts the
//! package source in front of a human, and execution is anchored to the
//! digest they approved, so a `git pull` that changes what runs invalidates
//! the grant (J2).
//!
//! `pack.script` produces facts. It never judges them: its output becomes
//! node evidence, and a registered pure verifier decides whether that
//! evidence is acceptable. Keeping produce and judge apart is what lets
//! anyone re-run the judgment from a Run record without re-running a side
//! effect.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

/// How much of a script's output the daemon will hold in memory, and how long
/// it waits before reclaiming the process group.
///
/// These bound what one misbehaving script can take from the daemon, not what
/// a script is permitted to do. A package that needs longer says so in
/// `timeoutSeconds`; there is no ceiling on that, because a render or a build
/// legitimately runs for hours and the platform has no basis for picking a
/// number on the project's behalf.
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const DEFAULT_TIMEOUT_SECONDS: u64 = 120;

/// What a node declares in `with`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScriptDefinition {
    /// What to run. A package-relative path (`scripts/publish.sh`) or a
    /// program on `PATH` (`bash`, `blender`, `docker`) — the platform does
    /// not care which, and does not check the extension. A package that
    /// ships a Go binary, a shell script or a Makefile target is as
    /// first-class as one that ships JavaScript.
    pub(crate) script: String,
    /// Arguments, passed as argv. Not a shell string: the package can invoke
    /// a shell itself if it wants one, but nothing in a node's declaration
    /// turns into a command by accident.
    #[serde(default)]
    pub(crate) args: Vec<String>,
    /// The interpreter to run `script` under, when the package wants one
    /// (`python3`, `node`, `bash`). Omit it to execute `script` directly.
    #[serde(default)]
    pub(crate) interpreter: Option<String>,
    /// Extra environment for this node. Merged over the daemon's own, so a
    /// script can be told where a licence server or an output root is.
    #[serde(default)]
    pub(crate) env: BTreeMap<String, String>,
    /// Working directory, relative to the Run's task directory. Defaults to
    /// the task directory itself; an absolute path is honoured as given.
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    /// Passed to the script as one JSON object on stdin. The platform does
    /// not interpret it.
    #[serde(default)]
    pub(crate) input: serde_json::Value,
    /// Seconds before the process group is reclaimed. No ceiling — a build
    /// or a render legitimately runs for hours.
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

/// Resolves what to run.
///
/// A path that exists inside the package wins, so the ordinary case — a
/// script the package ships, covered by the digest a human approved — needs
/// no ceremony. Anything else is handed through untouched for the OS to
/// resolve on `PATH`, because a package that drives `blender`, `ffmpeg` or
/// `docker` is doing the thing this capability exists for.
///
/// This resolves; it does not restrict. A script that reaches outside the
/// package is not a hole to close here: the Agent in the next node can run
/// any command on this machine already, so the meaningful boundary is the
/// human approval anchored to `source_digest`, not a path check.
pub(crate) fn resolve_script(package_root: &Path, declared: &str) -> Result<PathBuf> {
    if declared.is_empty() {
        bail!("pack.script 的 script 不能为空");
    }
    let candidate = package_root.join(declared);
    match candidate.canonicalize() {
        Ok(path) if path.is_file() => Ok(path),
        // Not a file in the package: a program name, an absolute path, or
        // something the OS will fail to find in a moment with a better
        // message than any guess made here.
        _ => Ok(PathBuf::from(declared)),
    }
}

/// Runs one script and returns its parsed result.
///
/// `task_cwd` is the Run's own working directory. Nothing here confines the
/// process: it inherits the daemon's account and environment, exactly as a
/// command the Agent in the next node would have run.
pub(crate) async fn run(
    script: &Path,
    task_cwd: &Path,
    definition: &ScriptDefinition,
) -> Result<ScriptResult> {
    let stdin = serde_json::to_vec(&definition.input)?;
    let timeout = definition
        .timeout_seconds
        .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
        .max(1);

    // An explicit interpreter runs the script as its first argument;
    // otherwise the script is the program. Either way the package's own
    // `args` follow.
    let (program, mut arguments) = match definition.interpreter.as_deref() {
        Some(interpreter) => (
            PathBuf::from(interpreter),
            vec![script.display().to_string()],
        ),
        None => (script.to_path_buf(), Vec::new()),
    };
    arguments.extend(definition.args.iter().cloned());

    let cwd = match definition.cwd.as_deref() {
        Some(relative) => {
            let path = Path::new(relative);
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                task_cwd.join(path)
            }
        }
        None => task_cwd.to_path_buf(),
    };

    let mut command = crate::process::command(
        std::slice::from_ref(&program),
        &arguments,
        &cwd,
    );
    command
        .envs(&definition.env)
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
/// daemon's memory before the timeout notices it. A bound on what the daemon
/// holds, not on what the script may write elsewhere.
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

    /// A node that runs `script` under `interpreter` and declares nothing
    /// else, so each test states only what it is about.
    fn node(script: &str, interpreter: &str) -> ScriptDefinition {
        ScriptDefinition {
            script: script.into(),
            args: Vec::new(),
            interpreter: Some(interpreter.into()),
            env: BTreeMap::new(),
            cwd: None,
            input: serde_json::Value::Null,
            timeout_seconds: Some(30),
        }
    }

    /// Resolution prefers what the package ships, and passes anything else
    /// through for the OS to find. Reaching outside the package is not an
    /// escape to be refused here: the point of this capability is to run the
    /// tools a project actually uses.
    #[test]
    fn a_shipped_file_wins_and_anything_else_is_left_to_the_os() {
        let root = tempfile::tempdir().unwrap();
        let package = package(root.path());
        std::fs::write(package.join("scripts/ok.mjs"), "").unwrap();

        assert_eq!(
            resolve_script(&package, "scripts/ok.mjs").unwrap(),
            package.join("scripts/ok.mjs").canonicalize().unwrap(),
        );
        // A program name stays a program name, for `PATH` to resolve.
        assert_eq!(resolve_script(&package, "blender").unwrap(), PathBuf::from("blender"));
        assert_eq!(resolve_script(&package, "/usr/bin/env").unwrap(), PathBuf::from("/usr/bin/env"));
        assert!(resolve_script(&package, "").is_err());
    }

    /// A package names its own interpreter, including a shell, and the file
    /// extension means nothing. The previous closed table rejected `.sh`
    /// outright while happily running a `.py` that shells out on its first
    /// line, so it never was the boundary it looked like.
    #[tokio::test]
    async fn a_package_names_its_own_interpreter_including_a_shell() {
        let root = tempfile::tempdir().unwrap();
        let package = package(root.path());
        std::fs::write(
            package.join("scripts/publish.sh"),
            "printf '{\"ok\":true,\"evidence\":{\"shell\":\"%s\"}}' \"$1\"\n",
        )
        .unwrap();

        let script = resolve_script(&package, "scripts/publish.sh").unwrap();
        let result = run(
            &script,
            root.path(),
            &ScriptDefinition {
                script: "scripts/publish.sh".into(),
                args: vec!["ran".into()],
                interpreter: Some("bash".into()),
                env: BTreeMap::new(),
                cwd: None,
                input: serde_json::Value::Null,
                timeout_seconds: Some(30),
            },
        )
        .await
        .unwrap();

        assert!(result.ok);
        assert_eq!(result.evidence.get("shell").map(String::as_str), Some("ran"));
    }

    /// Environment and working directory come from the node, and the
    /// process is not confined: it reads a path outside the package and
    /// outside its own working directory, which the old sandbox forbade.
    #[tokio::test]
    async fn a_script_receives_its_declared_environment_and_is_not_confined() {
        let root = tempfile::tempdir().unwrap();
        let package = package(root.path());
        let elsewhere = root.path().join("outside");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("secret.txt"), "reachable").unwrap();
        let work = root.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(
            package.join("scripts/probe.sh"),
            "printf '{\"ok\":true,\"evidence\":{\"seen\":\"%s\",\"cwd\":\"%s\",\"read\":\"%s\"}}' \
             \"$DEPOT\" \"$(basename \"$PWD\")\" \"$(cat \"$DEPOT/secret.txt\")\"\n",
        )
        .unwrap();

        let script = resolve_script(&package, "scripts/probe.sh").unwrap();
        let result = run(
            &script,
            root.path(),
            &ScriptDefinition {
                script: "scripts/probe.sh".into(),
                args: Vec::new(),
                interpreter: Some("bash".into()),
                env: BTreeMap::from([("DEPOT".into(), elsewhere.display().to_string())]),
                cwd: Some("work".into()),
                input: serde_json::Value::Null,
                timeout_seconds: Some(30),
            },
        )
        .await
        .unwrap();

        assert_eq!(result.evidence.get("cwd").map(String::as_str), Some("work"));
        assert_eq!(
            result.evidence.get("read").map(String::as_str),
            Some("reachable"),
            "a package script must be able to reach the machine it runs on",
        );
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
            input: serde_json::json!({ "verdict": "approved" }),
            ..node("scripts/echo.mjs", "node")
        };
        let result = run(&script, &task, &definition).await.unwrap();

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
            input: serde_json::json!({
                "source": "build",
                "destination": "public",
                "expectedFiles": 2,
            }),
            timeout_seconds: Some(60),
            ..node("scripts/publish-directory.mjs", "node")
        };
        let result = run(&script, &task, &definition).await.unwrap();

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
            timeout_seconds: Some(1),
            ..node("scripts/hang.mjs", "node")
        };
        let error = run(&script, root.path(), &definition)
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
        let definition = node("scripts/boom.mjs", "node");
        let error = run(&script, root.path(), &definition)
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
