//! Terminal sessions.
//!
//! PTY output never enters the session event stream: it is high frequency, it
//! is not part of the conversation, and routing it through the replay buffer
//! would evict real timeline events (`docs/web-workbench.md` §6).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tokio::sync::{mpsc, Mutex};

pub enum PtyMessage {
    Output {
        pty_id: String,
        data: String,
    },
    Closed {
        pty_id: String,
        exit_code: Option<i32>,
    },
}

struct Terminal {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
}

pub struct Terminals {
    sessions: Mutex<HashMap<String, Arc<Terminal>>>,
    outbound: mpsc::UnboundedSender<PtyMessage>,
}

impl Terminals {
    pub fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<PtyMessage>) {
        let (outbound, inbound) = mpsc::unbounded_channel();
        (
            Arc::new(Terminals {
                sessions: Mutex::new(HashMap::new()),
                outbound,
            }),
            inbound,
        )
    }

    pub async fn open(&self, cwd: &Path, cols: u16, rows: u16) -> Result<String> {
        let system = NativePtySystem::default();
        let pair = system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("allocating a pty")?;

        let mut command = CommandBuilder::new(default_shell());
        command.cwd(cwd);
        // Without this many tools emit escape sequences xterm.js cannot render.
        command.env("TERM", "xterm-256color");

        let mut child = pair
            .slave
            .spawn_command(command)
            .context("starting the shell")?;
        drop(pair.slave);

        let id = format!("pty_{}", uuid::Uuid::new_v4().simple());
        let writer = pair.master.take_writer()?;
        let mut reader = pair.master.try_clone_reader()?;

        self.sessions.lock().await.insert(
            id.clone(),
            Arc::new(Terminal {
                writer: Mutex::new(writer),
                master: Mutex::new(pair.master),
            }),
        );

        let output = self.outbound.clone();
        let reader_id = id.clone();
        // Blocking reads on a dedicated thread: the pty reader has no async
        // form, and parking it on the runtime would stall other tasks.
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let data = String::from_utf8_lossy(&buffer[..count]).to_string();
                        if output
                            .send(PtyMessage::Output {
                                pty_id: reader_id.clone(),
                                data,
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        });

        let closed = self.outbound.clone();
        let child_id = id.clone();
        // A shell can exit while this process still owns the PTY master. On
        // some platforms that means the reader does not observe EOF until the
        // master is dropped, so waiting for EOF before waiting for the child
        // deadlocks the close notification. The process handle is the source
        // of truth for exit and gets its own blocking waiter.
        std::thread::spawn(move || {
            let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
            let _ = closed.send(PtyMessage::Closed {
                pty_id: child_id,
                exit_code,
            });
        });

        Ok(id)
    }

    pub async fn write(&self, pty_id: &str, data: &str) -> Result<()> {
        let terminal = self.get(pty_id).await?;
        let mut writer = terminal.writer.lock().await;
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    pub async fn resize(&self, pty_id: &str, cols: u16, rows: u16) -> Result<()> {
        let terminal = self.get(pty_id).await?;
        terminal.master.lock().await.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub async fn close(&self, pty_id: &str) -> Result<()> {
        // Dropping the master closes the pty, which ends the reader thread and
        // sends the shell a hangup.
        self.sessions.lock().await.remove(pty_id);
        Ok(())
    }

    pub async fn close_all(&self) {
        self.sessions.lock().await.clear();
    }

    async fn get(&self, pty_id: &str) -> Result<Arc<Terminal>> {
        self.sessions
            .lock()
            .await
            .get(pty_id)
            .cloned()
            .ok_or_else(|| anyhow!("no such terminal: {pty_id}"))
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    async fn collect_output(
        inbound: &mut mpsc::UnboundedReceiver<PtyMessage>,
        needle: &str,
    ) -> String {
        let mut seen = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(500), inbound.recv()).await {
                Ok(Some(PtyMessage::Output { data, .. })) => {
                    seen.push_str(&data);
                    if seen.contains(needle) {
                        return seen;
                    }
                }
                Ok(Some(PtyMessage::Closed { .. })) | Ok(None) => break,
                Err(_) => continue,
            }
        }
        seen
    }

    /// Waits until the shell has printed its startup prompt and gone idle.
    ///
    /// Interactive startup files can query the terminal and consume input sent
    /// before the prompt exists. A real person cannot press Enter before the
    /// terminal is visible; tests must honor that same boundary.
    async fn wait_until_ready(inbound: &mut mpsc::UnboundedReceiver<PtyMessage>) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut output = String::new();
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(500), inbound.recv()).await {
                Ok(Some(PtyMessage::Output { data, .. })) => {
                    output.push_str(&data);
                    if ["# ", "$ ", "> ", "% "]
                        .iter()
                        .any(|prompt| output.ends_with(prompt))
                    {
                        return;
                    }
                }
                Ok(Some(PtyMessage::Closed { .. })) | Ok(None) => break,
                Err(_) => continue,
            }
        }
        panic!("the shell never printed its startup prompt; output: {output:?}");
    }

    #[tokio::test]
    async fn a_terminal_echoes_what_it_is_given() {
        let dir = tempfile::tempdir().unwrap();
        let (terminals, mut inbound) = Terminals::new();
        let id = terminals.open(dir.path(), 80, 24).await.unwrap();

        wait_until_ready(&mut inbound).await;
        terminals.write(&id, "echo genehub-marker\r").await.unwrap();
        let output = collect_output(&mut inbound, "genehub-marker").await;
        assert!(output.contains("genehub-marker"), "got: {output:?}");

        terminals.close(&id).await.unwrap();
    }

    #[tokio::test]
    async fn a_closed_terminal_reports_it_and_stops_accepting_writes() {
        let dir = tempfile::tempdir().unwrap();
        let (terminals, mut inbound) = Terminals::new();
        let id = terminals.open(dir.path(), 80, 24).await.unwrap();
        wait_until_ready(&mut inbound).await;
        // xterm sends carriage return for Enter. A bare line feed is output
        // translation on a terminal, not the key that submits the command.
        terminals.write(&id, "exit\r").await.unwrap();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut closed = false;
        let mut output = String::new();
        while tokio::time::Instant::now() < deadline && !closed {
            match tokio::time::timeout(Duration::from_millis(500), inbound.recv()).await {
                Ok(Some(PtyMessage::Closed { pty_id, .. })) => {
                    assert_eq!(pty_id, id);
                    closed = true;
                }
                Ok(Some(PtyMessage::Output { data, .. })) => output.push_str(&data),
                Ok(None) | Err(_) => {}
            }
        }
        assert!(
            closed,
            "the shell exiting must be reported; output: {output:?}"
        );

        terminals.close(&id).await.unwrap();
        assert!(terminals.write(&id, "x").await.is_err());
    }

    #[tokio::test]
    async fn resizing_an_open_terminal_succeeds_and_an_unknown_one_fails() {
        let dir = tempfile::tempdir().unwrap();
        let (terminals, _inbound) = Terminals::new();
        let id = terminals.open(dir.path(), 80, 24).await.unwrap();
        assert!(terminals.resize(&id, 120, 40).await.is_ok());
        assert!(terminals.resize("nope", 120, 40).await.is_err());
    }
}
