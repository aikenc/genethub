//! What an agent left running, and whose it is.
//!
//! An agent is a thing that runs commands, so by the end of a turn it has
//! usually started and finished dozens. Some do not finish: `npm run dev`,
//! `cargo watch`, a test server the model started in order to curl it once.
//! Nobody decided those should keep running — the turn simply ended while they
//! were still going, and on a machine people leave running they stay up until
//! somebody notices a port is taken.
//!
//! Noticing is the entire feature. This does not stop anything on its own; it
//! answers "what is still running, and which conversation started it" so that
//! a person can see it and decide. That ordering is deliberate — the right to
//! let a process outlive its turn is worth having only once there is a way to
//! see it and end it.
//!
//! **Whose is it.** We do not run the commands; the agent CLI does, inside its
//! own process. So ownership is inferred from the operating system rather than
//! recorded at spawn, by two rules that cover each other's gaps:
//!
//! - Still in the agent's **process group**. The agent is started in a group of
//!   its own (`crate::adapter::owned_child`), and children inherit it. This
//!   still finds a process whose parent has died and which init has adopted.
//! - Still **descended** from the agent. This finds a process that left the
//!   group by starting a session of its own, which is what a well-behaved
//!   runner of commands does to its children.
//!
//! What escapes both has detached twice over, and a process that has done that
//! has said as clearly as POSIX allows that it intends to outlive whoever
//! started it.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use genehub_proto::BackgroundProcess;
use tokio::sync::RwLock;

/// How long to let the operating system be asked. A machine under load can be
/// slow to answer; a machine that never answers must not hold a request open.
const CENSUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// The agent whose descendants are being watched, for one session.
#[derive(Debug, Clone, Copy)]
struct Agent {
    pid: u32,
    group: u32,
    /// When this pid was learned, so that it can be told apart from a later
    /// process wearing the same number.
    watched_at: std::time::Instant,
}

/// Persisted before stopping the adapter, so a daemon restart cannot mistake
/// forgotten in-memory ownership for proof that cleanup succeeded.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReceipt {
    captured_at_ms: i64,
    processes: Vec<CleanupIdentity>,
    error: Option<String>,
    pub completed: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupIdentity {
    pid: u32,
    group: u32,
    running_for_seconds: u64,
}

/// How much disagreement to allow between our clock and `ps` rounding its
/// answer down to whole seconds.
const CLOCK_SLACK: u64 = 5;

/// Which session each running agent belongs to.
///
/// Deliberately thin: it holds the two numbers needed to ask the operating
/// system a question, and nothing that could disagree with the operating
/// system's answer.
#[derive(Default)]
pub struct Processes {
    agents: RwLock<HashMap<String, Agent>>,
    /// Set once the transport exists, which is after this does.
    announce: std::sync::OnceLock<tokio::sync::broadcast::Sender<genehub_proto::ServerFrame>>,
}

impl Processes {
    pub fn new() -> Arc<Self> {
        Arc::new(Processes::default())
    }

    /// Where to say what is running.
    pub fn announce_to(&self, fanout: tokio::sync::broadcast::Sender<genehub_proto::ServerFrame>) {
        let _ = self.announce.set(fanout);
    }

    /// Tells every connected client what is still running.
    ///
    /// Said at the end of a turn, because that is when the answer changes
    /// meaning: while the agent is working, everything it started is supposed
    /// to be running, and only afterwards is anything still going a thing
    /// somebody might want to know about.
    pub async fn announce_now(&self) {
        let Some(fanout) = self.announce.get() else {
            return;
        };
        let processes = self.list().await;
        if !processes.is_empty() {
            // At info, because this is the whole question the feature exists to
            // answer, and after release the log is where we find out whether
            // agents leave things running rarely or constantly.
            tracing::info!(
                count = processes.len(),
                oldest_seconds = processes.first().map(|first| first.running_for_seconds),
                "a turn ended with processes still running"
            );
        }
        let _ = fanout.send(genehub_proto::ServerFrame::BackgroundProcesses { processes });
    }

    /// Records that this session's agent is running as `pid`.
    ///
    /// The group is the pid: the agent was started as a session leader, so it
    /// is the group it leads. Reading it back from the operating system would
    /// be the same number and one more thing that can fail.
    pub async fn watch(&self, session_id: &str, pid: u32) {
        tracing::debug!(session = %session_id, pid, "watching an agent for what it leaves running");
        self.agents.write().await.insert(
            session_id.to_string(),
            Agent {
                pid,
                group: pid,
                watched_at: std::time::Instant::now(),
            },
        );
    }

    /// Stops attributing anything to a session, without stopping anything.
    ///
    /// Ending the agent is the caller's business and has already happened by
    /// the time this is called; what is left after that is left on purpose or
    /// has detached on its own, and either way is no longer anybody's to
    /// report.
    pub async fn forget(&self, session_id: &str) {
        self.agents.write().await.remove(session_id);
    }

    pub(crate) async fn prepare_cleanup(&self, session_id: &str) -> CleanupReceipt {
        let mut receipt = CleanupReceipt {
            captured_at_ms: chrono::Utc::now().timestamp_millis(),
            processes: Vec::new(),
            error: None,
            completed: false,
        };
        let Some(agent) = self.agents.read().await.get(session_id).copied() else {
            return receipt;
        };
        let Some(rows) = census().await else {
            receipt.error = Some("process census unavailable before shutdown; descendant cleanup remains unconfirmed".into());
            return receipt;
        };
        let mut owned = claimed_by(&rows, agent, agent.watched_at.elapsed().as_secs());
        if let Some(parent) = rows.iter().find(|row| {
            row.pid == agent.pid
                && row.running_for_seconds + CLOCK_SLACK >= agent.watched_at.elapsed().as_secs()
        }) {
            owned.push(parent);
        }
        if owned.len() > 4096 {
            receipt.error =
                Some("process cleanup exceeds the 4096-process observation bound".into());
        }
        receipt.processes = owned
            .into_iter()
            .take(4096)
            .map(|row| CleanupIdentity {
                pid: row.pid,
                group: row.group,
                running_for_seconds: row.running_for_seconds,
            })
            .collect();
        receipt
    }

    pub(crate) async fn verify_cleanup(&self, receipt: &CleanupReceipt) -> anyhow::Result<()> {
        if let Some(error) = &receipt.error {
            anyhow::bail!("{error}");
        }
        if receipt.processes.is_empty() {
            return Ok(());
        }
        let rows = census()
            .await
            .ok_or_else(|| anyhow::anyhow!("process cleanup could not be verified"))?;
        let elapsed = chrono::Utc::now()
            .timestamp_millis()
            .saturating_sub(receipt.captured_at_ms)
            .max(0) as u64
            / 1000;
        let remaining = receipt
            .processes
            .iter()
            .filter(|old| {
                rows.iter().any(|now| {
                    old.pid == now.pid
                        && old.group == now.group
                        && now.running_for_seconds.saturating_add(CLOCK_SLACK)
                            >= old.running_for_seconds.saturating_add(elapsed)
                })
            })
            .map(|old| old.pid)
            .collect::<Vec<_>>();
        if !remaining.is_empty() {
            anyhow::bail!("recorded session processes still exist; cleanup requires reconciliation: {remaining:?}");
        }
        Ok(())
    }

    /// Everything still running that some session's agent started.
    pub async fn list(&self) -> Vec<BackgroundProcess> {
        let agents = self.agents.read().await.clone();
        if agents.is_empty() {
            return Vec::new();
        }
        let Some(census) = census().await else {
            return Vec::new();
        };
        let mut found = Vec::new();
        for (session_id, agent) in agents {
            for row in claimed_by(&census, agent, agent.watched_at.elapsed().as_secs()) {
                found.push(BackgroundProcess {
                    workspace_id: None,
                    service: None,
                    session_id: session_id.clone(),
                    pid: row.pid,
                    parent_pid: row.parent,
                    command: row.command.clone(),
                    running_for_seconds: row.running_for_seconds,
                });
            }
        }
        // Oldest first: the one that has been running longest is the one most
        // likely to have been forgotten.
        found.sort_by(|left, right| {
            right
                .running_for_seconds
                .cmp(&left.running_for_seconds)
                .then(left.pid.cmp(&right.pid))
        });
        found
    }

    /// Ends one process and everything below it.
    ///
    /// The pid is checked against the session that claims it first. A pid is
    /// not a capability — it is a small integer that the caller may have
    /// guessed, may have read somewhere else, or may have learned before the
    /// process exited and the number was reused. Only a pid this session's
    /// agent is currently answerable for may be ended through here.
    pub async fn stop(&self, session_id: &str, pid: u32) -> Stopped {
        let Some(agent) = self.agents.read().await.get(session_id).copied() else {
            return Stopped::NotThisSession;
        };
        let Some(census) = census().await else {
            tracing::warn!(session = %session_id, pid, "cannot end a process: the operating system did not answer");
            return Stopped::Unknown;
        };
        let claimed = claimed_by(&census, agent, agent.watched_at.elapsed().as_secs());
        let Some(row) = claimed.iter().find(|row| row.pid == pid) else {
            tracing::warn!(session = %session_id, pid, "refused to end a process this session does not own");
            return Stopped::NotThisSession;
        };
        tracing::info!(session = %session_id, pid, command = %row.command, "ending a process left running");
        let mut ids = HashSet::from([row.pid]);
        loop {
            let before = ids.len();
            for child in &claimed {
                if ids.contains(&child.parent) {
                    ids.insert(child.pid);
                }
            }
            if ids.len() == before {
                break;
            }
        }
        let owned: Vec<Row> = claimed
            .into_iter()
            .filter(|p| ids.contains(&p.pid))
            .cloned()
            .collect();
        if terminate_snapshot(&owned).await {
            Stopped::Yes
        } else {
            Stopped::Unknown
        }
    }

    /// Cancellation must distinguish an empty census from an unavailable one.
    pub(crate) async fn stop_all_checked(&self, session_id: &str) -> anyhow::Result<usize> {
        let Some(agent) = self.agents.read().await.get(session_id).copied() else {
            return Ok(0);
        };
        let before = census()
            .await
            .ok_or_else(|| anyhow::anyhow!("process census unavailable; cleanup is unconfirmed"))?;
        let claimed = claimed_by(&before, agent, agent.watched_at.elapsed().as_secs());
        let mut ending = tokio::task::JoinSet::new();
        for row in &claimed {
            ending.spawn(end_observed((*row).clone()));
        }
        ending.join_all().await;
        let after = census()
            .await
            .ok_or_else(|| anyhow::anyhow!("process cleanup could not be verified"))?;
        let remaining = claimed_by(&after, agent, agent.watched_at.elapsed().as_secs());
        let known_remaining = claimed
            .iter()
            .filter(|old| after.iter().any(|now| same_process(old, now)))
            .count();
        if !remaining.is_empty() || known_remaining > 0 {
            anyhow::bail!(
                "{} session processes have not stopped",
                remaining.len().max(known_remaining)
            );
        }
        Ok(claimed.len())
    }

    /// Ends everything a session left running, but not the agent itself.
    pub async fn stop_all(&self, session_id: &str) -> usize {
        let Some(agent) = self.agents.read().await.get(session_id).copied() else {
            return 0;
        };
        let Some(census) = census().await else {
            tracing::warn!(session = %session_id, "cannot end what a session left running: the operating system did not answer");
            return 0;
        };
        let claimed = claimed_by(&census, agent, agent.watched_at.elapsed().as_secs());
        let owned: Vec<Row> = claimed.into_iter().cloned().collect();
        if terminate_snapshot(&owned).await {
            owned.len()
        } else {
            0
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Stopped {
    Yes,
    /// No agent by that session, or that pid is not one of its own.
    NotThisSession,
    /// The operating system could not be asked.
    Unknown,
}

/// One line of the operating system's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Row {
    pid: u32,
    parent: u32,
    group: u32,
    running_for_seconds: u64,
    command: String,
}

fn same_process(before: &Row, after: &Row) -> bool {
    before.pid == after.pid
        && before.group == after.group
        && after.running_for_seconds + CLOCK_SLACK >= before.running_for_seconds
}

#[cfg(not(target_family = "wasm"))]
async fn end_observed(row: Row) {
    crate::process::end_tree(row.pid).await;
}

/// The guest uses the existing nonblocking process import. Numeric pids are
/// taken only from the ownership census; never signal an unverified group.
#[cfg(target_family = "wasm")]
async fn end_observed(row: Row) {
    let signal = |signal: &'static str, pid: u32| async move {
        let mut command = crate::os_process::Command::new("kill");
        command
            .args([signal, &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let _ = tokio::time::timeout(CENSUS_TIMEOUT, command.output()).await;
    };
    signal("-TERM", row.pid).await;
    let deadline = tokio::time::Instant::now() + crate::process::GRACE;
    while tokio::time::Instant::now() < deadline {
        let Some(current) = census().await else {
            return;
        };
        if !current.iter().any(|now| same_process(&row, now)) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let Some(current) = census().await else {
        return;
    };
    if current.iter().any(|now| same_process(&row, now)) {
        signal("-KILL", row.pid).await;
    }
}

/// The processes of a session's agent, excluding the agent.
///
/// The agent itself is not news: it is running because the session is open,
/// and reporting it would put a permanent "1" next to every conversation.
///
/// **Nothing is claimed unless the agent is still there to answer for it.** A
/// pid is a small integer the operating system hands out again, and an agent
/// that exited an hour ago may have had its number taken by something
/// unrelated. Claiming that thing's group would mean listing a stranger's
/// processes under somebody's conversation and offering a button that ends
/// them. The cost of the rule is that an agent which crashed takes the
/// visibility of its leftovers with it; the alternative cost is ending
/// processes that were never ours, which is not a trade.
fn claimed_by(census: &[Row], agent: Agent, watched_for: u64) -> Vec<&Row> {
    let still_the_agent = census
        .iter()
        .any(|row| row.pid == agent.pid && row.running_for_seconds + CLOCK_SLACK >= watched_for);
    if !still_the_agent {
        return Vec::new();
    }

    let mut descendants: HashSet<u32> = HashSet::from([agent.pid]);
    // A parent is always older than its children, so one pass in pid order is
    // not enough — pids wrap. Repeat until nothing new is found; the census is
    // small and this settles in a couple of passes.
    loop {
        let before = descendants.len();
        for row in census {
            if descendants.contains(&row.parent) {
                descendants.insert(row.pid);
            }
        }
        if descendants.len() == before {
            break;
        }
    }
    census
        .iter()
        .filter(|row| row.pid != agent.pid)
        .filter(|row| row.group == agent.group || descendants.contains(&row.pid))
        .collect()
}

/// Asks the operating system what is running.
///
/// Through `ps` rather than `/proc`, because the answer is needed on macOS as
/// well and one implementation that is exercised on both beats two of which
/// only one is ever run by a test. The fields chosen are the portable ones:
/// `etime` rather than `lstart`, and `args` last because it is the only one
/// that contains spaces.
async fn census() -> Option<Vec<Row>> {
    if crate::guest_paths::windows_host() {
        return windows_census().await;
    }
    let mut command = crate::os_process::Command::new("ps");
    command
        .args(["-eo", "pid=,ppid=,pgid=,etime=,args="])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    // Every failure below leaves the caller unable to answer, so each is worth
    // telling apart in a log we read after release: a machine where `ps` is
    // missing, one where it is too slow, and one where it refuses are three
    // different bug reports.
    let output = match tokio::time::timeout(CENSUS_TIMEOUT, command.output()).await {
        Err(_) => {
            tracing::warn!(
                seconds = CENSUS_TIMEOUT.as_secs(),
                "ps did not answer in time"
            );
            return None;
        }
        Ok(Err(error)) => {
            tracing::warn!(%error, "could not run ps to see what is running");
            return None;
        }
        Ok(Ok(output)) => output,
    };
    if !output.status.success() {
        tracing::warn!(status = %output.status, "ps refused to say what is running");
        return None;
    }
    Some(parse_census(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_census(text: &str) -> Vec<Row> {
    text.lines().filter_map(parse_row).collect()
}

/// `ps` pads its columns, so fields are separated by runs of spaces rather
/// than by single ones.
fn take_field<'a>(rest: &mut &'a str) -> Option<&'a str> {
    let end = rest.find(char::is_whitespace)?;
    let field = &rest[..end];
    *rest = rest[end..].trim_start();
    Some(field)
}

fn parse_row(line: &str) -> Option<Row> {
    let mut rest = line.trim_start();
    let pid = take_field(&mut rest)?.parse().ok()?;
    let parent = take_field(&mut rest)?.parse().ok()?;
    let group = take_field(&mut rest)?.parse().ok()?;
    let elapsed = parse_elapsed(take_field(&mut rest)?)?;
    let command = rest.trim().to_string();
    if command.is_empty() {
        return None;
    }
    Some(Row {
        pid,
        parent,
        group,
        running_for_seconds: elapsed,
        command,
    })
}

/// `[[days-]hours:]minutes:seconds`, which is what `etime` promises and the
/// only part of `ps` output whose shape has to be known here.
fn parse_elapsed(field: &str) -> Option<u64> {
    let (days, clock) = match field.split_once('-') {
        Some((days, rest)) => (days.parse::<u64>().ok()?, rest),
        None => (0, field),
    };
    let parts: Vec<&str> = clock.split(':').collect();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [minutes, seconds] => (
            0,
            minutes.parse::<u64>().ok()?,
            seconds.parse::<u64>().ok()?,
        ),
        [hours, minutes, seconds] => (
            hours.parse::<u64>().ok()?,
            minutes.parse::<u64>().ok()?,
            seconds.parse::<u64>().ok()?,
        ),
        _ => return None,
    };
    Some(((days * 24 + hours) * 60 + minutes) * 60 + seconds)
}

#[cfg(test)]
#[path = "processes_tests.rs"]
mod tests;

/// OS queries run through the existing host process import on WASM too.
async fn windows_census() -> Option<Vec<Row>> {
    let script = "$ErrorActionPreference='Stop'; $now=Get-Date; @(Get-CimInstance Win32_Process | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;group=0;running_for_seconds=[uint64][Math]::Max(0,($now-$_.CreationDate).TotalSeconds);command=[string]$_.Name} }) | ConvertTo-Json -Compress";
    let mut command = crate::os_process::Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .kill_on_drop(true);
    let output = tokio::time::timeout(CENSUS_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    #[derive(serde::Deserialize)]
    struct WindowsRow {
        pid: u32,
        parent: u32,
        group: u32,
        running_for_seconds: u64,
        command: String,
    }
    let rows: Vec<WindowsRow> = serde_json::from_slice(&output.stdout).ok()?;
    Some(
        rows.into_iter()
            .map(|r| Row {
                pid: r.pid,
                parent: r.parent,
                group: r.group,
                running_for_seconds: r.running_for_seconds,
                command: r.command,
            })
            .collect(),
    )
}

/// Only terminate members observed in an owned subtree; never kill the agent's whole group.
/// Recheck age and command before each signal so a recycled PID is not adopted.
async fn terminate_snapshot(owned: &[Row]) -> bool {
    let started = std::time::Instant::now();
    for force in [false, true] {
        let Some(current) = census().await else {
            return false;
        };
        for row in owned.iter().rev() {
            let matches = current.iter().any(|p| {
                p.pid == row.pid
                    && p.command == row.command
                    && p.running_for_seconds + CLOCK_SLACK
                        >= row.running_for_seconds + started.elapsed().as_secs()
                    && p.running_for_seconds
                        <= row.running_for_seconds + started.elapsed().as_secs() + CLOCK_SLACK
            });
            if !matches {
                continue;
            }
            let mut command = if crate::guest_paths::windows_host() {
                let mut c = crate::os_process::Command::new("taskkill.exe");
                c.args(["/PID", &row.pid.to_string()]);
                if force {
                    c.arg("/F");
                }
                c
            } else {
                let mut c = crate::os_process::Command::new("kill");
                c.args([
                    if force { "-KILL" } else { "-TERM" },
                    "--",
                    &row.pid.to_string(),
                ]);
                c
            };
            command.kill_on_drop(true);
            if tokio::time::timeout(CENSUS_TIMEOUT, command.output())
                .await
                .is_err()
            {
                return false;
            }
        }
        if !force {
            tokio::time::sleep(crate::process::GRACE).await;
        }
    }
    let Some(current) = census().await else {
        return false;
    };
    !owned.iter().any(|row| {
        current.iter().any(|p| {
            p.pid == row.pid
                && p.command == row.command
                && p.running_for_seconds + CLOCK_SLACK
                    >= row.running_for_seconds + started.elapsed().as_secs()
        })
    })
}

/// Diagnostic ancestry for explicitly authenticated application roots. These rows
/// confer no PID termination rights; application control remains authenticated.
pub(crate) async fn registered_trees(
    roots: &[u32],
) -> HashMap<u32, Vec<genehub_proto::BackgroundProcess>> {
    let Some(current) = census().await else {
        return HashMap::new();
    };
    roots
        .iter()
        .map(|&root| {
            let mut ids = HashSet::from([root]);
            loop {
                let before = ids.len();
                for row in &current {
                    if ids.contains(&row.parent) {
                        ids.insert(row.pid);
                    }
                }
                if before == ids.len() {
                    break;
                }
            }
            (
                root,
                current
                    .iter()
                    .filter(|r| ids.contains(&r.pid))
                    .map(|row| genehub_proto::BackgroundProcess {
                        workspace_id: None,
                        service: None,
                        session_id: String::new(),
                        pid: row.pid,
                        parent_pid: if row.pid == root { 0 } else { row.parent },
                        command: row.command.clone(),
                        running_for_seconds: row.running_for_seconds,
                    })
                    .collect(),
            )
        })
        .collect()
}
