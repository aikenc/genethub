use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

fn genet() -> Command {
    Command::new(env!("CARGO_BIN_EXE_genet-dev"))
}

/// Exercises the public control surface against a real resident daemon. The
/// in-process daemon test proves router behavior; this one also proves endpoint
/// discovery, CLI serialization and process continuity.
#[test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM naming the signed real Rust guest"]
fn cli_reuses_the_authenticated_carrier_for_platform_patch_control() {
    let source = artifact_path();
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");

    let daemon = DaemonGuard::start(root.path(), &workspace, &source);
    let before = daemon.command(&["daemon", "status"]);
    assert_success(&before);
    let before: serde_json::Value = serde_json::from_slice(&before.stdout).unwrap();
    let pid = before["pid"].as_u64().expect("daemon pid");
    let port = before["port"].as_u64().expect("daemon port");

    let status = daemon.command(&["daemon", "patch", "check"]);
    assert_success(&status);
    let status: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(status["type"], "status");
    assert_eq!(status["availability"]["type"], "unconfigured");
    assert_same_process(&daemon, pid, port);
}

struct DaemonGuard {
    root: PathBuf,
    workspace: PathBuf,
    artifact: PathBuf,
}

impl DaemonGuard {
    fn start(root: &Path, workspace: &Path, artifact: &Path) -> Self {
        let guard = Self {
            root: root.to_path_buf(),
            workspace: workspace.to_path_buf(),
            artifact: artifact.to_path_buf(),
        };
        let output = guard.command(&["daemon", "start"]);
        assert!(
            output.status.success(),
            "daemon start failed\nstdout: {}\nstderr: {}\nstartup log: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
            std::fs::read_to_string(guard.root.join("logs/cli-start.log"))
                .unwrap_or_else(|error| format!("<unavailable: {error}>"))
        );
        guard
    }

    fn command(&self, arguments: &[&str]) -> Output {
        self.try_command(arguments)
            .unwrap_or_else(|error| panic!("{error}"))
    }

    fn try_command(&self, arguments: &[&str]) -> Result<Output, String> {
        let label = arguments.join(" ");
        // A resident Windows child can keep an inherited anonymous-pipe handle
        // open after the short-lived CLI parent exits. Capturing into ordinary
        // files makes completion depend on the CLI process, not pipe EOF from
        // every descendant in its process tree.
        let mut stdout = tempfile::tempfile()
            .map_err(|error| format!("could not create stdout for `genet {label}`: {error}"))?;
        let mut stderr = tempfile::tempfile()
            .map_err(|error| format!("could not create stderr for `genet {label}`: {error}"))?;
        let child_stdout = stdout
            .try_clone()
            .map_err(|error| format!("could not clone stdout for `genet {label}`: {error}"))?;
        let child_stderr = stderr
            .try_clone()
            .map_err(|error| format!("could not clone stderr for `genet {label}`: {error}"))?;
        let mut child = genet()
            .args(arguments)
            .env("GENEHUB_DEV_DATA_DIR", &self.root)
            .env("GENEHUB_DEV_WORKSPACE_DIR", &self.workspace)
            .env("GENET_DAEMON_LOGIC_WASM", &self.artifact)
            .stdout(Stdio::from(child_stdout))
            .stderr(Stdio::from(child_stderr))
            .spawn()
            .map_err(|error| format!("could not start `genet {label}`: {error}"))?;
        let deadline = Instant::now() + COMMAND_TIMEOUT;
        let (status, timed_out) = loop {
            match child.try_wait() {
                Ok(Some(status)) => break (status, false),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let status = child.wait().map_err(|error| {
                        format!("could not reap timed-out `genet {label}`: {error}")
                    })?;
                    break (status, true);
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("could not observe `genet {label}`: {error}"));
                }
            }
        };
        let output = Output {
            status,
            stdout: read_capture(&mut stdout, &label, "stdout")?,
            stderr: read_capture(&mut stderr, &label, "stderr")?,
        };
        if timed_out {
            return Err(format!(
                "`genet {label}` timed out after {}s\nstdout: {}\nstderr: {}",
                COMMAND_TIMEOUT.as_secs(),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(output)
    }
}

fn read_capture(file: &mut std::fs::File, label: &str, stream: &str) -> Result<Vec<u8>, String> {
    file.rewind()
        .map_err(|error| format!("could not rewind {stream} for `genet {label}`: {error}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("could not read {stream} for `genet {label}`: {error}"))?;
    Ok(bytes)
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        let _ = self.try_command(&["daemon", "stop"]);
    }
}

fn assert_same_process(daemon: &DaemonGuard, pid: u64, port: u64) {
    let status = daemon.command(&["daemon", "status"]);
    assert_success(&status);
    let value: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(value["pid"], pid);
    assert_eq!(value["port"], port);
}

fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "command failed\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn artifact_path() -> PathBuf {
    std::env::var_os("GENET_DAEMON_LOGIC_WASM")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .expect("GENET_DAEMON_LOGIC_WASM must name the signed real Rust guest")
}
