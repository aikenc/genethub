//! Agent child ownership, environment and diagnostic pipes.
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader, Lines};
use tokio::sync::Mutex;
use tokio::time::Instant;

use super::{Chatter, SessionConfig};
use crate::os_process::{Child, ChildStdin, ChildStdout, Command};

#[derive(Clone)]
pub(super) struct AgentProcess {
    pub child: Arc<Mutex<Option<Child>>>,
    pub chatter: Arc<Chatter>,
}

pub(super) struct ProcessIo {
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
}

impl AgentProcess {
    pub async fn spawn(
        command: &mut Command,
        label: &'static str,
        config: &SessionConfig,
    ) -> Result<(Self, ProcessIo)> {
        super::apply_session_environment(command, config);
        super::owned_child(command);
        let mut child = command
            .spawn()
            .with_context(|| format!("spawning {label}"))?;
        let io = ProcessIo {
            stdin: child.stdin.take(),
            stdout: child.stdout.take(),
        };
        let chatter = Arc::new(Chatter::default());
        chatter.watch(label, child.stderr.take()).await;
        Ok((
            Self {
                child: Arc::new(Mutex::new(Some(child))),
                chatter,
            },
            io,
        ))
    }

    pub async fn close(&self) -> Result<()> {
        super::close_child(&self.child).await
    }

    pub async fn pid(&self) -> Option<u32> {
        self.child.lock().await.as_ref().and_then(Child::id)
    }

    pub async fn failure_message(&self, label: &str) -> String {
        super::stopped(label, &self.child, &self.chatter).await
    }
}

/// EOF is insufficient: a descendant may retain stdout after its parent dies.
/// Allow already-written terminal frames to drain, then end the reader even
/// when the inherited pipe stays open. The drain deadline is never extended.
pub(super) struct ProcessLines {
    lines: Lines<BufReader<ChildStdout>>,
    child: Arc<Mutex<Option<Child>>>,
    drain_until: Option<Instant>,
    exited_group: Option<u32>,
    poll: tokio::time::Interval,
}

impl ProcessLines {
    pub fn new(stdout: ChildStdout, child: Arc<Mutex<Option<Child>>>) -> Self {
        let mut poll = tokio::time::interval(Duration::from_millis(500));
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        Self {
            lines: BufReader::new(stdout).lines(),
            child,
            drain_until: None,
            exited_group: None,
            poll,
        }
    }

    pub async fn next_line(&mut self) -> std::io::Result<Option<String>> {
        loop {
            if let Some(deadline) = self.drain_until {
                return tokio::time::timeout_at(deadline, self.lines.next_line())
                    .await
                    .unwrap_or(Ok(None));
            }
            tokio::select! {
                biased;
                _ = self.poll.tick() => {
                    if let Ok(mut child) = self.child.try_lock() {
                        let gone = match child.as_mut() {
                            None => true,
                            Some(child) => {
                                let pid = child.id();
                                match child.try_wait() {
                                Ok(Some(_)) => { self.exited_group = pid; true },
                                Ok(None) => false,
                                Err(error) => { tracing::warn!(%error, "reading agent exit status"); true }
                                }
                            },
                        };
                        if gone { self.drain_until = Some(Instant::now() + Duration::from_millis(200)); }
                    }
                }
                line = self.lines.next_line() => return line,
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[tokio::test]
    async fn parent_exit_drains_terminal_frames_without_waiting_for_descendant_eof() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 5 & printf 'terminal\\n'"])
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        super::super::owned_child(&mut command);
        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let child = Arc::new(Mutex::new(Some(child)));
        let mut lines = ProcessLines::new(stdout, child.clone());
        assert_eq!(
            lines.next_line().await.unwrap().as_deref(),
            Some("terminal")
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(2), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .is_none()
        );
        super::super::close_child(&child).await.unwrap();
    }
}

impl Drop for ProcessLines {
    fn drop(&mut self) {
        // try_wait reaps the leader and Child::id then becomes None. Retain
        // the exited leader's group until the reader is dropped so inherited
        // pipes cannot also leave its descendants behind during cleanup.
        if let Some(pid) = self.exited_group.take() {
            crate::process::stop_owned_group(pid);
        }
    }
}
