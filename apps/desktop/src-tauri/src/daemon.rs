//! The daemon process this app exists to host.
//!
//! The window is a convenience; the daemon is the product. So it starts before
//! anything is shown, survives the window being closed, and is stopped only
//! when the user quits from the tray — a background agent host with no visible
//! owner is exactly what we are trying not to leave behind.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// What the daemon prints once it is listening. The port is chosen by the OS,
/// so reading it back is the only way to know where to connect.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
    pub machine_id: String,
    pub fingerprint: String,
}

impl Endpoint {
    pub fn websocket_url(&self) -> String {
        format!("ws://127.0.0.1:{}/ws?token={}", self.port, self.token)
    }
}

pub struct Daemon {
    binary: PathBuf,
    data_dir: PathBuf,
    child: Mutex<Option<Child>>,
    endpoint: Mutex<Option<Endpoint>>,
}

impl Daemon {
    pub fn new(binary: PathBuf, data_dir: PathBuf) -> Self {
        Daemon {
            binary,
            data_dir,
            child: Mutex::new(None),
            endpoint: Mutex::new(None),
        }
    }

    pub fn endpoint(&self) -> Option<Endpoint> {
        self.endpoint.lock().expect("endpoint lock").clone()
    }

    /// Starts the daemon and waits for it to say where it is listening.
    ///
    /// Waiting matters: the window loads immediately after, and a window that
    /// opens before the endpoint exists shows "no machine found" on every cold
    /// start, which reads as a broken install.
    pub fn start(&self) -> Result<Endpoint, String> {
        let mut guard = self.child.lock().expect("daemon lock");
        if guard.is_some() {
            if let Some(endpoint) = self.endpoint() {
                return Ok(endpoint);
            }
        }

        std::fs::create_dir_all(&self.data_dir)
            .map_err(|error| format!("无法创建数据目录: {error}"))?;

        let mut command = Command::new(&self.binary);
        command
            .env("GENEHUB_DATA_DIR", &self.data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 daemon: {error}"))?;
        let stdout = child.stdout.take().ok_or("daemon 没有输出")?;

        // Read on a thread so a daemon that never prints cannot hang startup.
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(endpoint) = parse_endpoint(&line) {
                    let _ = tx.send(endpoint);
                    return;
                }
            }
        });

        match rx.recv_timeout(Duration::from_secs(20)) {
            Ok(endpoint) => {
                *guard = Some(child);
                *self.endpoint.lock().expect("endpoint lock") = Some(endpoint.clone());
                Ok(endpoint)
            }
            Err(_) => {
                let _ = child.kill();
                Err("daemon 启动超时".to_string())
            }
        }
    }

    pub fn is_running(&self) -> bool {
        let mut guard = self.child.lock().expect("daemon lock");
        match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(_)) => {
                    *guard = None;
                    *self.endpoint.lock().expect("endpoint lock") = None;
                    false
                }
                Ok(None) => true,
                Err(_) => false,
            },
            None => false,
        }
    }

    /// Asks the daemon to shut down, then insists.
    ///
    /// The polite signal gives it time to end sessions and let agents exit;
    /// killing straight away would orphan whatever they had spawned.
    pub fn stop(&self) {
        let mut guard = self.child.lock().expect("daemon lock");
        let Some(mut child) = guard.take() else {
            return;
        };
        *self.endpoint.lock().expect("endpoint lock") = None;

        terminate(&child);
        for _ in 0..40 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(unix)]
fn terminate(child: &Child) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    const SIGTERM: i32 = 15;
    unsafe {
        kill(child.id() as i32, SIGTERM);
    }
}

#[cfg(not(unix))]
fn terminate(_child: &Child) {
    // Windows has no polite equivalent that reaches a console-less child, so
    // the kill below is the whole story there.
}

fn parse_endpoint(line: &str) -> Option<Endpoint> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("event")?.as_str()? != "listening" {
        return None;
    }
    serde_json::from_value(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_listening_line_carries_everything_needed_to_connect() {
        let endpoint = parse_endpoint(
            r#"{"event":"listening","port":42123,"token":"abc","machineId":"m_1","fingerprint":"AB-CD"}"#,
        )
        .expect("a listening line should parse");
        assert_eq!(endpoint.port, 42123);
        assert_eq!(
            endpoint.websocket_url(),
            "ws://127.0.0.1:42123/ws?token=abc"
        );
    }

    #[test]
    fn other_output_is_ignored_rather_than_mistaken_for_an_endpoint() {
        assert!(parse_endpoint("starting up").is_none());
        assert!(parse_endpoint(r#"{"event":"something-else","port":1}"#).is_none());
    }
}
