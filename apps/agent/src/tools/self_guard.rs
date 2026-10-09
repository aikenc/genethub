//! The bash tool's refusal to end the agent running it (proposal §6.3).
//!
//! fb_IXUzjtBuA4wt: `ps aux | grep -E "dev-0.*(server|…)" | awk … | kill`
//! matched the agent's own command line, and the session ended with exit -1
//! and nothing said. A command cannot be understood in general, and this does
//! not try: it catches `kill` given a pid that is this agent, the daemon, or an
//! ancestor of either, plus `$PPID` — the shell's parent is this agent. The
//! rest is the prompt's rule (find targets by pid file or port), and §6.2's
//! note for the next process when even that fails.

use std::collections::BTreeSet;

/// The pid an agent's children are told to spare. Native: our own. Wasm: the
/// shell's, which is the process the daemon started and the one a `kill` hits.
pub fn agent_pid() -> Option<u32> {
    #[cfg(target_family = "wasm")]
    return std::env::var(crate::channel::ENV_HOST_PID)
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|pid| *pid != 0);
    #[cfg(not(target_family = "wasm"))]
    Some(std::process::id())
}

/// This agent, the daemon that started it, and every ancestor of both that
/// can be found. pid 1 is left out: no command here could end it anyway.
pub fn protected() -> BTreeSet<u32> {
    let mut pids = BTreeSet::new();
    let host = std::env::var("GENEHUB_HOST_PID")
        .ok()
        .and_then(|value| value.parse::<u32>().ok());
    for start in [agent_pid(), host].into_iter().flatten() {
        let mut pid = start;
        // Bounded: a cycle in a racing /proc read must not hang the tool.
        for _ in 0..64 {
            if pid <= 1 || !pids.insert(pid) {
                break;
            }
            match parent_of(pid) {
                Some(parent) => pid = parent,
                None => break,
            }
        }
    }
    pids
}

/// `/proc/<pid>/stat` field 4. Linux only; elsewhere the chain stops at the
/// pids the environment names, which are the two that matter most.
fn parent_of(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name is in parentheses and may itself contain ") ".
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// Why `command` would end a protected process, or `None` to let it run.
pub fn refuses(command: &str, protected: &BTreeSet<u32>) -> Option<String> {
    for segment in command.split([';', '&', '|', '\n', '(', ')', '`']) {
        let mut words = segment
            .split_whitespace()
            .map(|word| word.trim_matches(['"', '\'']));
        // Skip `VAR=value`, `sudo`, `exec`, `command` before the verb.
        let verb = words.by_ref().find(|word| {
            !word.contains('=')
                && !matches!(*word, "sudo" | "exec" | "command" | "builtin" | "nohup")
        });
        let Some(verb) = verb else { continue };
        if verb.rsplit('/').next() != Some("kill") {
            continue;
        }
        let mut options_done = false;
        for word in words {
            if word == "--" {
                options_done = true;
                continue;
            }
            if matches!(word, "$PPID" | "${PPID}") {
                return Some(refusal(word));
            }
            // `-9`, `-KILL`, `-s TERM` are signals; after `--`, `-123` is a
            // process group, which for a group leader is the same pid.
            let number = match word.strip_prefix('-') {
                Some(rest) if options_done => rest,
                Some(_) => continue,
                None => word,
            };
            if let Ok(pid) = number.parse::<u32>() {
                if protected.contains(&pid) {
                    return Some(refusal(word));
                }
            }
        }
    }
    None
}

fn refusal(target: &str) -> String {
    format!(
        "Refused: `kill {target}` would end the GeneHub Agent running this command \
(or the daemon or an ancestor of either; see $GENEHUB_AGENT_PID and $GENEHUB_HOST_PID). \
Find the process you mean by its pid file or listening port, and exclude these pids before killing anything."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guarded() -> BTreeSet<u32> {
        BTreeSet::from([4242, 777])
    }

    #[test]
    fn a_kill_aimed_at_the_agent_is_refused() {
        let pids = guarded();
        assert!(refuses("kill 4242", &pids).is_some());
        assert!(refuses("kill -9 4242", &pids).is_some());
        assert!(refuses("sleep 1; /bin/kill -s TERM 123 777", &pids).is_some());
        assert!(refuses("kill -- -4242", &pids).is_some());
        assert!(refuses("kill $PPID", &pids).is_some());
        assert!(refuses("sudo kill \"4242\"", &pids).is_some());
    }

    #[test]
    fn other_kills_and_other_commands_run() {
        let pids = guarded();
        assert!(refuses("kill 1234", &pids).is_none());
        assert!(refuses("kill -9 1234 5678", &pids).is_none());
        // `-777` before `--` is a signal number, not a group.
        assert!(refuses("kill -777 1234", &pids).is_none());
        assert!(refuses("echo 4242", &pids).is_none());
        assert!(refuses("grep kill 4242.log", &pids).is_none());
        assert!(refuses("pkill -f vite", &pids).is_none());
    }

    #[test]
    fn the_agent_and_its_ancestors_are_protected() {
        let pids = protected();
        assert!(pids.contains(&std::process::id()));
        #[cfg(target_os = "linux")]
        assert!(
            pids.len() > 1,
            "the test runner's parent should be found too: {pids:?}"
        );
    }
}
