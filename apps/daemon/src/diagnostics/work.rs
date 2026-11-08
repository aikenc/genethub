//! Opt-in wall-time attribution for the single-threaded guest. This observes
//! work; it neither schedules it nor adds a second state/cache authority.
//! Enable `genet_daemon::diagnostics::work=debug` in the ordinary log filter.
//! Only compile-time spawn locations and fixed operation names are retained.

use std::cell::RefCell;
use std::panic::Location;
use std::time::{Duration, Instant};

const MAX_SOURCES: usize = 64;

#[derive(Clone, Default)]
struct Counter {
    calls: u64,
    micros: u64,
}

#[derive(Clone)]
struct Task {
    file: &'static str,
    line: u32,
    counter: Counter,
}

#[derive(Default)]
struct Work {
    tasks: Vec<Task>,
    active: Option<(usize, Instant)>,
    files: [Counter; 4],
}

thread_local! {
    static WORK: RefCell<Work> = RefCell::new(Work::default());
}

pub fn enabled() -> bool {
    tracing::enabled!(target: "genet_daemon::diagnostics::work", tracing::Level::DEBUG)
}

/// Called only by the guest's daemon runtime, never by an Agent runtime.
pub fn before_poll(source: &'static Location<'static>) {
    if !enabled() {
        return;
    }
    WORK.with(|slot| {
        let mut work = slot.borrow_mut();
        let index = work
            .tasks
            .iter()
            .position(|task| task.file == source.file() && task.line == source.line())
            .unwrap_or_else(|| {
                if work.tasks.len() >= MAX_SOURCES {
                    return MAX_SOURCES;
                }
                let index = work.tasks.len();
                work.tasks.push(Task {
                    file: source.file(),
                    line: source.line(),
                    counter: Counter::default(),
                });
                index
            });
        // The last bounded row accounts for new sources after the limit.
        if index == MAX_SOURCES && work.tasks.len() == MAX_SOURCES {
            work.tasks.push(Task {
                file: "other",
                line: 0,
                counter: Counter::default(),
            });
        }
        work.tasks[index].counter.calls += 1;
        work.active = Some((index, Instant::now()));
    });
}

pub fn after_poll() {
    if !enabled() {
        return;
    }
    WORK.with(|slot| {
        let mut work = slot.borrow_mut();
        if let Some((index, started)) = work.active.take() {
            work.tasks[index].counter.micros += started.elapsed().as_micros() as u64;
        }
    });
}

#[derive(Clone, Copy)]
pub(crate) enum FileWork {
    SpaceDescriptor,
    UpdateContinuation,
    CatalogDirectory,
    CatalogEntry,
}

impl FileWork {
    fn name(self) -> &'static str {
        match self {
            Self::SpaceDescriptor => "space_descriptor",
            Self::UpdateContinuation => "update_continuation",
            Self::CatalogDirectory => "catalog_directory",
            Self::CatalogEntry => "catalog_entry",
        }
    }
}

/// A synchronous section only. Never retain this across an await: its time
/// includes Host waits inside synchronous WASI calls, but not other tasks.
pub(crate) struct FileScope(Option<(FileWork, Instant)>);

impl FileScope {
    pub(crate) fn new(kind: FileWork) -> Self {
        Self(enabled().then(|| (kind, Instant::now())))
    }
}

impl Drop for FileScope {
    fn drop(&mut self) {
        if let Some((kind, started)) = self.0 {
            WORK.with(|slot| {
                let mut work = slot.borrow_mut();
                let counter = &mut work.files[kind as usize];
                counter.calls += 1;
                counter.micros += started.elapsed().as_micros() as u64;
            });
        }
    }
}

#[derive(Clone)]
struct Snapshot {
    tasks: Vec<Task>,
    files: [Counter; 4],
}

fn snapshot() -> Snapshot {
    WORK.with(|slot| {
        let work = slot.borrow();
        let mut tasks = work.tasks.clone();
        // Include the partial poll containing the scan boundary. Otherwise a
        // scan started/finished inside a task would lose its own inline work.
        if let Some((index, started)) = work.active {
            tasks[index].counter.micros += started.elapsed().as_micros() as u64;
        }
        Snapshot {
            tasks,
            files: work.files.clone(),
        }
    })
}

/// Cumulative counters are subtracted at both boundaries of this scan, so the
/// report describes this interval rather than a neighboring periodic window.
pub(crate) struct Window(Option<Snapshot>);

impl Window {
    pub(crate) fn start() -> Self {
        Self(enabled().then(snapshot))
    }

    pub(crate) fn report(self, elapsed: Duration, yield_wait: Duration) {
        let Some(before) = self.0 else { return };
        let after = snapshot();
        let mut tasks = Vec::new();
        let mut observed_us = 0u64;
        for (index, task) in after.tasks.iter().enumerate() {
            let prior = before.tasks.get(index).map(|task| &task.counter);
            let micros = task
                .counter
                .micros
                .saturating_sub(prior.map_or(0, |v| v.micros));
            let calls = task
                .counter
                .calls
                .saturating_sub(prior.map_or(0, |v| v.calls));
            observed_us += micros;
            if micros > 0 {
                tasks.push((
                    micros,
                    serde_json::json!({
                        "source": task.file, "line": task.line,
                        "polls": calls, "wallUs": micros,
                    }),
                ));
            }
        }
        tasks.sort_by_key(|row| std::cmp::Reverse(row.0));
        let other_us: u64 = tasks.iter().skip(8).map(|row| row.0).sum();
        let tasks: Vec<_> = tasks.into_iter().take(8).map(|row| row.1).collect();
        let files: Vec<_> = [
            FileWork::SpaceDescriptor,
            FileWork::UpdateContinuation,
            FileWork::CatalogDirectory,
            FileWork::CatalogEntry,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, kind)| {
            serde_json::json!({
                "operation": kind.name(),
                "calls": after.files[index].calls.saturating_sub(before.files[index].calls),
                "wallUs": after.files[index].micros.saturating_sub(before.files[index].micros),
            })
        })
        .collect();
        tracing::warn!(
            event = "session_catalog_work",
            elapsed_ms = elapsed.as_millis() as u64,
            yield_wait_ms = yield_wait.as_millis() as u64,
            task_poll_us = observed_us,
            outside_task_poll_us = (elapsed.as_micros() as u64).saturating_sub(observed_us),
            other_task_poll_us = other_us,
            tasks = %serde_json::Value::Array(tasks),
            file_work = %serde_json::Value::Array(files),
            "slow scan wall-time attribution; task and file times overlap, not CPU time"
        );
    }
}
