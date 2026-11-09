//! Noticing that a file or directory changed without reading it.
//!
//! A [`Stamp`] is what one `stat` says: modification time, creation time,
//! length and kind. Two stamps are only ever compared for equality, never for
//! order, and never across machines, so clock skew cannot make a change look
//! old. Creation time stands in for file identity: GeneHub and most tools
//! replace files by writing a temporary file and renaming it, which creates a
//! new file even when the modification time is copied back. In the guest,
//! Wasmtime reports the host's creation time where a status-change time would
//! be, so this costs no second call.
//!
//! A directory's stamp changes when an entry is added, removed or renamed,
//! not when a file inside it is rewritten in place.
//!
//! Timestamps are coarse on some filesystems (FAT 2s, HFS+ 1s). A stamp taken
//! within [`SETTLE`] of its modification time is unsettled: a second write in
//! the same tick could leave the stamp unchanged, so an unsettled path is
//! looked at again on every pass until it settles.

use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

pub const SETTLE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Stamp {
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    len: u64,
    dir: bool,
}

impl Stamp {
    pub fn of(meta: &std::fs::Metadata) -> Self {
        Stamp {
            modified: meta.modified().ok(),
            created: meta.created().ok(),
            len: meta.len(),
            dir: meta.is_dir(),
        }
    }

    /// Follows symbolic links. `None` when the path is not there or cannot be
    /// examined, which is itself a state to compare against.
    pub fn read(path: &Path) -> Option<Self> {
        std::fs::metadata(path).ok().map(|meta| Self::of(&meta))
    }

    /// Does not follow a final symbolic link.
    pub fn read_link(path: &Path) -> Option<Self> {
        std::fs::symlink_metadata(path)
            .ok()
            .map(|meta| Self::of(&meta))
    }

    /// Whether another write could still land without changing this stamp.
    /// A modification time in the future (clock skew, network mounts) is
    /// never settled.
    pub fn settled(&self) -> bool {
        self.modified.is_none_or(|modified| {
            SystemTime::now()
                .duration_since(modified)
                .is_ok_and(|age| age >= SETTLE)
        })
    }

    pub fn is_dir(&self) -> bool {
        self.dir
    }
}

pub fn settled(stamp: Option<&Stamp>) -> bool {
    stamp.is_none_or(Stamp::settled)
}

/// How often a watched path is looked at: every pass while it is hot, and at
/// least once per `cold` otherwise. A path is hot while unsettled and for
/// `hot_for` after it last changed.
#[derive(Debug, Clone, Copy)]
pub struct Cadence {
    pub hot: Duration,
    pub cold: Duration,
    pub hot_for: Duration,
}

/// When one watched path is next due. Spreading first looks over the cold
/// period keeps a large set from coming due in the same pass forever after.
#[derive(Debug, Clone)]
pub struct Watch {
    changed: Option<Instant>,
    due: Instant,
}

impl Watch {
    /// A path seen for the first time, just looked at with `stamp`.
    pub fn first(path: &Path, stamp: Option<&Stamp>, now: Instant, cadence: Cadence) -> Self {
        let mut watch = Watch {
            changed: None,
            due: now,
        };
        watch.due = if settled(stamp) {
            now + spread(path, cadence.cold)
        } else {
            now + cadence.hot
        };
        watch
    }

    /// A path that has to be looked at on the next pass.
    pub fn now(now: Instant) -> Self {
        Watch {
            changed: Some(now),
            due: now,
        }
    }

    pub fn due(&self, now: Instant) -> bool {
        self.due <= now
    }

    /// Records a look. `changed` says whether the stamp differed from the
    /// previous one.
    pub fn looked(&mut self, stamp: Option<&Stamp>, changed: bool, now: Instant, cadence: Cadence) {
        if changed {
            self.changed = Some(now);
        }
        let hot = !settled(stamp)
            || self
                .changed
                .is_some_and(|at| now.saturating_duration_since(at) < cadence.hot_for);
        self.due = now + if hot { cadence.hot } else { cadence.cold };
    }

    /// GeneHub itself just wrote this path: keep looking at it for a while.
    pub fn wrote(&mut self, now: Instant, cadence: Cadence) {
        self.changed = Some(now);
        self.due = now + cadence.hot;
    }

    /// Look at this path on the next pass.
    pub fn hurry(&mut self, now: Instant) {
        self.due = self.due.min(now);
    }

    #[cfg(test)]
    pub fn next_due(&self) -> Instant {
        self.due
    }
}

/// A stable offset in `[0, period)` for one path, so first looks are spread
/// evenly without randomness.
fn spread(path: &Path, period: Duration) -> Duration {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    let millis = period.as_millis().max(1) as u64;
    Duration::from_millis(hasher.finish() % millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CADENCE: Cadence = Cadence {
        hot: Duration::from_secs(2),
        cold: Duration::from_secs(30),
        hot_for: Duration::from_secs(600),
    };

    #[test]
    fn an_atomic_replace_changes_the_stamp_even_with_the_same_length_and_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meta.json");
        std::fs::write(&path, b"{\"a\":1}").unwrap();
        let before = Stamp::read(&path).unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        // File times come from a coarse kernel clock.
        std::thread::sleep(Duration::from_millis(30));
        let temporary = dir.path().join(".meta.tmp");
        std::fs::write(&temporary, b"{\"a\":2}").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&temporary)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        std::fs::rename(&temporary, &path).unwrap();
        let after = Stamp::read(&path).unwrap();
        if std::fs::metadata(&path).unwrap().created().is_ok() {
            assert_ne!(before, after);
        }
    }

    #[test]
    fn a_directory_stamp_changes_when_an_entry_is_added() {
        let dir = tempfile::tempdir().unwrap();
        let before = Stamp::read(dir.path()).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::create_dir(dir.path().join("s_new")).unwrap();
        assert_ne!(before, Stamp::read(dir.path()).unwrap());
    }

    #[test]
    fn a_fresh_write_is_unsettled_and_stays_hot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f");
        std::fs::write(&path, b"x").unwrap();
        let stamp = Stamp::read(&path).unwrap();
        assert!(!stamp.settled());
        let now = Instant::now();
        let watch = Watch::first(&path, Some(&stamp), now, CADENCE);
        assert!(!watch.due(now));
        assert!(watch.due(now + CADENCE.hot));
    }

    #[test]
    fn a_settled_path_is_looked_at_within_the_cold_period_and_first_looks_spread() {
        let now = Instant::now();
        let mut dues = std::collections::HashSet::new();
        for index in 0..50 {
            let path = std::path::PathBuf::from(format!("/spaces/s_{index}/meta.json"));
            let watch = Watch::first(&path, None, now, CADENCE);
            assert!(watch.due(now + CADENCE.cold));
            dues.insert(watch.due);
        }
        assert!(dues.len() > 40);
    }

    #[test]
    fn a_change_keeps_a_path_hot_then_it_cools() {
        let now = Instant::now();
        let mut watch = Watch::first(Path::new("/x"), None, now, CADENCE);
        watch.looked(None, true, now, CADENCE);
        assert!(watch.due(now + CADENCE.hot));
        let later = now + CADENCE.hot_for;
        watch.looked(None, false, later, CADENCE);
        assert!(!watch.due(later + CADENCE.hot));
        assert!(watch.due(later + CADENCE.cold));
    }
}
