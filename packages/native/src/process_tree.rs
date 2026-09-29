//! Descendant-tree cleanup, distinct from signalling an owned process group.
//! The root shell remains in the Agent group so background process discovery works.
#[cfg(target_os = "linux")]
pub fn kill_descendants(pid: u32) {
    let mut victims = vec![pid];
    let mut seen = std::collections::HashSet::from([pid]);
    let mut index = 0;
    while index < victims.len() {
        let parent = victims[index];
        index += 1;
        let Ok(entries) = std::fs::read_dir("/proc") else {
            break;
        };
        for entry in entries.flatten() {
            let Ok(id) = entry.file_name().to_string_lossy().parse::<u32>() else {
                continue;
            };
            if !seen.insert(id) {
                continue;
            }
            let Ok(status) = std::fs::read_to_string(format!("/proc/{id}/status")) else {
                seen.remove(&id);
                continue;
            };
            let child = status.lines().any(|line| {
                line.strip_prefix("PPid:")
                    .is_some_and(|rest| rest.trim() == parent.to_string())
            });
            if child {
                victims.push(id);
            } else {
                seen.remove(&id);
            }
        }
    }
    for id in victims.into_iter().rev() {
        unsafe {
            libc::kill(id as libc::pid_t, libc::SIGKILL);
        }
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
pub fn kill_descendants(pid: u32) {
    // BSD/macOS have no /proc. Discover descendants without creating or killing
    // the Agent's group. Recheck parentage before signalling each captured PID.
    fn parents() -> std::collections::HashMap<u32, u32> {
        std::process::Command::new("ps")
            .args(["-axo", "pid=,ppid="])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .filter_map(|line| {
                        let mut words = line.split_whitespace();
                        Some((words.next()?.parse().ok()?, words.next()?.parse().ok()?))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    let found = parents();
    let mut victims = vec![pid];
    let mut seen = std::collections::HashSet::from([pid]);
    let mut i = 0;
    while i < victims.len() {
        let parent = victims[i];
        i += 1;
        for (&child, &ppid) in &found {
            if ppid == parent && seen.insert(child) {
                victims.push(child);
            }
        }
    }
    let current = parents();
    for child in victims.into_iter().rev() {
        if child == pid
            || current
                .get(&child)
                .is_some_and(|parent| found.get(&child) == Some(parent))
        {
            unsafe {
                libc::kill(child as libc::pid_t, libc::SIGKILL);
            }
        }
    }
}
