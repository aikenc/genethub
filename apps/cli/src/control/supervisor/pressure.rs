//! Read-only Linux memory observations and per-process OOM preference.
//! No cgroup creation, migration or limit changes belong to manual lifecycle.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

fn oom_priority(pid: u32) -> io::Result<i32> {
    fs::read_to_string(format!("/proc/{pid}/oom_score_adj"))?
        .trim()
        .parse()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// A launcher can have inherited a high adjustment from its own Host. Lower
/// only this tiny guardian, within the OS account's existing permission floor.
/// Binary search also handles inheritance of 1000 without hardcoding a host's
/// container-specific floor. Never request OOM immunity or extra privilege.
pub(super) fn protect_guardian() -> io::Result<()> {
    let pid = std::process::id();
    let inherited = oom_priority(pid)?;
    let (mut low, mut high) = (0, inherited.max(0));
    while low < high {
        let middle = low + (high - low) / 2;
        match fs::write("/proc/self/oom_score_adj", middle.to_string()) {
            Ok(()) => high = middle,
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => low = middle + 1,
            Err(e) => return Err(e),
        }
    }
    eprintln!(
        "daemon supervisor: OOM priority inherited={inherited} supervisor={}",
        oom_priority(pid)?
    );
    Ok(())
}

/// Called while the owning std::process::Child is unreaped, so this cannot
/// change a reused stranger's priority. Existing negative guardian priority
/// stays local; the Host and future work remain eligible OOM victims.
pub(super) fn prefer_host(pid: u32) -> io::Result<()> {
    fs::write(format!("/proc/{pid}/oom_score_adj"), "1000")
}

pub(super) fn restart_reserve() -> anyhow::Result<u64> {
    let mb = std::env::var("GENEHUB_DAEMON_RESTART_HEADROOM_MB")
        .unwrap_or_else(|_| "256".into())
        .parse::<u64>()?;
    mb.checked_mul(1024 * 1024)
        .ok_or_else(|| anyhow::anyhow!("GENEHUB_DAEMON_RESTART_HEADROOM_MB is too large"))
}

fn mount_path(value: &str) -> PathBuf {
    PathBuf::from(
        value
            .replace("\\040", " ")
            .replace("\\011", "\t")
            .replace("\\012", "\n")
            .replace("\\134", "\\"),
    )
}

/// Physical MemAvailable alone overestimates space in containers. Intersect
/// it with every visible applicable memory cgroup ancestor's remaining limit.
/// Mount roots may be the container cgroup itself; no writable controller is
/// needed. Missing cgroup controllers still leave the physical observation.
pub(super) fn available_memory() -> io::Result<u64> {
    let memory = fs::read_to_string("/proc/meminfo")?;
    let mut available = memory
        .lines()
        .find_map(|line| line.strip_prefix("MemAvailable:"))
        .and_then(|line| line.split_whitespace().next())
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|kb| kb.checked_mul(1024))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "MemAvailable is absent"))?;
    let groups = fs::read_to_string("/proc/self/cgroup")?;
    let mounts = fs::read_to_string("/proc/self/mountinfo")?;
    for line in mounts.lines() {
        let Some((before, after)) = line.split_once(" - ") else {
            continue;
        };
        let fields: Vec<_> = before.split_whitespace().collect();
        let details: Vec<_> = after.split_whitespace().collect();
        if fields.len() < 5 || details.len() < 3 {
            continue;
        }
        let unified = details[0] == "cgroup2";
        if !(unified || details[0] == "cgroup" && details[2].split(',').any(|v| v == "memory")) {
            continue;
        }
        let root = mount_path(fields[3]);
        let mount = mount_path(fields[4]);
        for group in groups.lines() {
            let parts: Vec<_> = group.splitn(3, ':').collect();
            if parts.len() != 3
                || !(unified && parts[1].is_empty()
                    || !unified && parts[1].split(',').any(|v| v == "memory"))
            {
                continue;
            }
            let group = Path::new(parts[2]);
            let relative = if group == Path::new("/") {
                Path::new("")
            } else if let Ok(relative) = group.strip_prefix(&root) {
                relative
            } else {
                continue;
            };
            let mut directory = mount.join(relative);
            while directory.starts_with(&mount) {
                let (limit, usage) = if unified {
                    ("memory.max", "memory.current")
                } else {
                    ("memory.limit_in_bytes", "memory.usage_in_bytes")
                };
                match fs::read_to_string(directory.join(limit)) {
                    Ok(limit) => {
                        if let Ok(limit) = limit.trim().parse::<u64>() {
                            let usage = fs::read_to_string(directory.join(usage))?
                                .trim()
                                .parse::<u64>()
                                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
                            // Inactive file cache is reclaimable, not a reason
                            // to strand recovery indefinitely after a build.
                            let key = if unified {
                                "inactive_file"
                            } else {
                                "total_inactive_file"
                            };
                            let reclaimable = fs::read_to_string(directory.join("memory.stat"))
                                .ok()
                                .and_then(|stat| {
                                    stat.lines().find_map(|line| {
                                        let (name, value) = line.split_once(' ')?;
                                        (name == key)
                                            .then(|| value.trim().parse::<u64>().ok())
                                            .flatten()
                                    })
                                })
                                .unwrap_or(0);
                            available = available
                                .min(limit.saturating_sub(usage.saturating_sub(reclaimable)));
                        }
                    }
                    // The v2 hierarchy root has no memory.max. A disabled
                    // controller can likewise be absent at an intermediate.
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
                if directory == mount || !directory.pop() {
                    break;
                }
            }
        }
    }
    Ok(available)
}

pub(super) fn host_rss(pid: u32) -> Option<u64> {
    fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?
        .checked_mul(1024)
}
