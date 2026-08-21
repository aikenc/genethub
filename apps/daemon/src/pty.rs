//! Terminal sessions.

#[cfg(not(target_family = "wasm"))]
#[path = "pty_host.rs"]
mod host;

#[cfg(not(target_family = "wasm"))]
pub use host::*;

/// The same terminals, with the fork/exec half moved out to the shell.
///
/// What changes here is only where the blocking lives. Native parks a thread
/// per terminal on a blocking read; the guest has no threads to park and could
/// not afford to park one anyway — a blocking import suspends the whole
/// instance — so the shell keeps the threads and this side polls on a timer
/// (v2 proposal §6.10).
#[cfg(target_family = "wasm")]
mod guest {
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::Arc;

    use anyhow::{anyhow, Result};
    use genet_wasi::pty::Session;
    use tokio::sync::{mpsc, Mutex};

    const PTY_EVENT_QUEUE: usize = 1024;
    const MAX_TERMINALS: usize = 32;
    const MAX_DIMENSION: u16 = 1000;
    const MAX_INPUT_BYTES: usize = 1024 * 1024;
    const CHUNK: u32 = 8192;
    /// How often an idle terminal is asked whether anything arrived. Fast
    /// enough that typing feels immediate, slow enough that thirty-two idle
    /// terminals are not a busy loop.
    const POLL: std::time::Duration = std::time::Duration::from_millis(10);

    pub enum PtyMessage {
        Output { pty_id: String, data: String },
        Closed { pty_id: String, exit_code: Option<i32> },
    }

    pub struct Terminals {
        sessions: Mutex<HashMap<String, Arc<Session>>>,
        outbound: mpsc::Sender<PtyMessage>,
    }

    impl Terminals {
        pub fn new() -> (Arc<Self>, mpsc::Receiver<PtyMessage>) {
            let (outbound, inbound) = mpsc::channel(PTY_EVENT_QUEUE);
            (
                Arc::new(Terminals {
                    sessions: Mutex::new(HashMap::new()),
                    outbound,
                }),
                inbound,
            )
        }

        pub async fn open(
            &self,
            cwd: &Path,
            cols: u16,
            rows: u16,
            confinement: Option<crate::isolation::Policy>,
        ) -> Result<String> {
            validate_dimensions(cols, rows)?;
            let mut sessions = self.sessions.lock().await;
            if sessions.len() >= MAX_TERMINALS {
                return Err(anyhow!("too many terminals are already open"));
            }

            let argv = crate::process::launch_argv(&default_shell(), confinement.as_ref())?;
            let argv: Vec<String> = argv
                .iter()
                .map(|part| part.to_string_lossy().into_owned())
                .collect();
            let session = Arc::new(Session::open(
                &argv,
                &cwd.to_string_lossy(),
                // Without this many tools emit escape sequences xterm.js
                // cannot render.
                &[("TERM".to_owned(), "xterm-256color".to_owned())],
                cols,
                rows,
            )?);

            let id = format!("pty_{}", uuid::Uuid::new_v4().simple());
            sessions.insert(id.clone(), session.clone());
            drop(sessions);


            let outbound = self.outbound.clone();
            let reader_id = id.clone();
            // Weak on purpose: closing a terminal is removing it from the map,
            // and that only hangs the session up if nothing else is still
            // holding it. A reader with a strong claim would keep the master
            // open and the shell would never see the hangup.
            let reader = Arc::downgrade(&session);
            drop(session);
            tokio::spawn(async move {
                let exit_code = loop {
                    let Some(session) = reader.upgrade() else { return };
                    match session.read(CHUNK) {
                        Err(_) | Ok(None) => break session.exit_code(),
                        Ok(Some(chunk)) if chunk.is_empty() => {
                            drop(session);
                            tokio::time::sleep(POLL).await;
                        }
                        Ok(Some(chunk)) => {
                            let data = String::from_utf8_lossy(&chunk).into_owned();
                            drop(session);
                            // The fixed queue is the memory bound, and sending
                            // is what applies it: dropping bytes would leave
                            // the display corrupted with no way to recover.
                            let message = PtyMessage::Output {
                                pty_id: reader_id.clone(),
                                data,
                            };
                            if outbound.send(message).await.is_err() {
                                return;
                            }
                        }
                    }
                };
                let _ = outbound
                    .send(PtyMessage::Closed {
                        pty_id: reader_id,
                        exit_code,
                    })
                    .await;
            });

            Ok(id)
        }

        pub async fn write(&self, pty_id: &str, data: &str) -> Result<()> {
            if data.len() > MAX_INPUT_BYTES {
                return Err(anyhow!("terminal input is too large"));
            }
            let session = self.get(pty_id).await?;
            let mut rest = data.as_bytes();
            while !rest.is_empty() {
                let written = session.write(rest)?;
                if written == 0 {
                    tokio::time::sleep(POLL).await;
                    continue;
                }
                rest = &rest[written..];
            }
            Ok(())
        }

        pub async fn resize(&self, pty_id: &str, cols: u16, rows: u16) -> Result<()> {
            validate_dimensions(cols, rows)?;
            self.get(pty_id).await?.resize(cols, rows)?;
            Ok(())
        }

        /// Hangs the terminal up by letting go of it, and no harder than that.
        /// A command stops with everything it started; a terminal does not.
        pub async fn close(&self, pty_id: &str) -> Result<()> {
            self.sessions.lock().await.remove(pty_id);
            Ok(())
        }

        pub async fn close_all(&self) {
            self.sessions.lock().await.clear();
        }

        async fn get(&self, pty_id: &str) -> Result<Arc<Session>> {
            let mut sessions = self.sessions.lock().await;
            let session = sessions.get(pty_id).cloned();
            if session
                .as_ref()
                .is_some_and(|session| session.exit_code().is_some())
            {
                sessions.remove(pty_id);
                return Err(anyhow!("no such terminal: {pty_id}"));
            }
            session.ok_or_else(|| anyhow!("no such terminal: {pty_id}"))
        }
    }

    fn validate_dimensions(cols: u16, rows: u16) -> Result<()> {
        if cols == 0 || rows == 0 || cols > MAX_DIMENSION || rows > MAX_DIMENSION {
            return Err(anyhow!(
                "terminal dimensions must be between 1 and {MAX_DIMENSION}"
            ));
        }
        Ok(())
    }

    fn default_shell() -> String {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

#[cfg(target_family = "wasm")]
pub use guest::*;
