//! Keeps one bulk response from filling the shared Fabric uplink.
//!
//! A preview receive window of 3MiB lets that much sit in front of every other
//! stream on the same daemon socket. Only Fabric previews are paced; direct
//! and RTC peers do not share that socket. The cap starts at 640KiB and follows the
//! rate implied by client acks, about 200ms of that rate. One completed window
//! of at least half the start size that returns within 900ms opens straight to
//! the protocol ceiling, including a fast loopback drain. The opened cap stays
//! for the next transfer on the same daemon. A drain slower than 900ms stays at
//! the start so a 5Mbps first RPC is not stuck behind a larger window.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Notify;

const START_BYTES: u64 = 640 * 1024;
const RATE_TARGET: Duration = Duration::from_millis(200);
/// A full start window on a 5Mbps uplink takes about a second. Anything slower
/// than this stays at the start so the first RPC is not stuck behind a megabyte.
const OPEN_DRAIN_MAX: Duration = Duration::from_millis(900);

pub struct UplinkPace {
    outstanding: Mutex<u64>,
    cap: AtomicU64,
    notify: Notify,
    control: Mutex<Control>,
}

struct Control {
    filled_at: Option<Instant>,
    acked_since_fill: u64,
    cap_at_fill: u64,
    sample_bytes: u64,
    sample_started: Option<Instant>,
}

impl UplinkPace {
    pub fn new(ceiling: u64) -> Self {
        let floor = START_BYTES.min(ceiling);
        Self {
            outstanding: Mutex::new(0),
            cap: AtomicU64::new(floor),
            notify: Notify::new(),
            control: Mutex::new(Control {
                filled_at: None,
                acked_since_fill: 0,
                cap_at_fill: floor,
                sample_bytes: 0,
                sample_started: None,
            }),
        }
    }

    pub fn cap(&self) -> u64 {
        self.cap.load(Ordering::Relaxed)
    }

    pub async fn reserve(&self, bytes: u64) {
        loop {
            let notified = self.notify.notified();
            {
                let mut outstanding = self.outstanding.lock().unwrap();
                let cap = self.cap.load(Ordering::Relaxed);
                if bytes > cap || outstanding.saturating_add(bytes) <= cap {
                    *outstanding = outstanding.saturating_add(bytes);
                    self.note_filled(*outstanding, cap);
                    return;
                }
            }
            notified.await;
        }
    }

    fn note_filled(&self, outstanding: u64, cap: u64) {
        let mut control = self.control.lock().unwrap();
        if control.filled_at.is_none() && outstanding >= cap && cap > 0 {
            control.filled_at = Some(Instant::now());
            control.acked_since_fill = 0;
            control.cap_at_fill = cap;
        }
    }

    pub fn release(&self, bytes: u64, ceiling: u64) {
        if bytes == 0 {
            return;
        }
        let idle = {
            let mut outstanding = self.outstanding.lock().unwrap();
            *outstanding = outstanding.saturating_sub(bytes);
            *outstanding == 0
        };
        self.observe(bytes, ceiling, idle);
        self.notify.notify_waiters();
    }

    fn observe(&self, bytes: u64, ceiling: u64, idle: bool) {
        let mut control = self.control.lock().unwrap();
        let floor = START_BYTES.min(ceiling);
        let current = self.cap.load(Ordering::Relaxed);
        if control.sample_started.is_none() {
            control.sample_started = Some(Instant::now());
        }
        control.sample_bytes = control.sample_bytes.saturating_add(bytes);
        let mut drain = None;
        if let Some(filled_at) = control.filled_at {
            // A timer that has already overrun the open band is not a slow
            // link. Drop it so the next full window can be measured on its own.
            if filled_at.elapsed() > OPEN_DRAIN_MAX
                && control.acked_since_fill < control.cap_at_fill
            {
                control.filled_at = None;
                control.acked_since_fill = 0;
            }
        }
        if let Some(filled_at) = control.filled_at {
            control.acked_since_fill = control.acked_since_fill.saturating_add(bytes);
            if control.acked_since_fill >= control.cap_at_fill && control.cap_at_fill > 0 {
                drain = Some((filled_at.elapsed(), control.cap_at_fill));
                control.filled_at = None;
                control.acked_since_fill = 0;
            }
        }
        let elapsed = control
            .sample_started
            .map(|started| started.elapsed())
            .unwrap_or(Duration::ZERO);
        // One window update can carry the whole floor. The fill timer is the
        // ack delay in that case; the sample clock has only just started.
        // A stale multi-second timer must not replace that short sample.
        let elapsed = drain
            .map(|(drain, _)| drain)
            .filter(|drain| elapsed < Duration::from_millis(50) && *drain <= OPEN_DRAIN_MAX)
            .unwrap_or(elapsed);
        let short_drain =
            drain.is_some_and(|(drain_elapsed, _)| drain_elapsed < Duration::from_millis(50));
        let rate_window = if (elapsed >= Duration::from_millis(50) || short_drain)
            && control.sample_bytes >= 32 * 1024
        {
            let per_sec = (control.sample_bytes as f64 / elapsed.as_secs_f64().max(0.001)) as u64;
            let window = per_sec.saturating_mul(RATE_TARGET.as_millis() as u64) / 1_000;
            control.sample_bytes = 0;
            control.sample_started = Some(Instant::now());
            Some(window.clamp(floor, ceiling))
        } else {
            None
        };

        let rate_grew = rate_window.is_some_and(|window| window > current);
        // A completed window of at least half the start size that returns
        // within the open band goes to the protocol ceiling, even when a
        // partial ack has already nudged the cap above the floor. A 10ms
        // loopback drain is included. Anything slower than the band stays put.
        let delay_bound = drain.is_some_and(|(elapsed, probed)| {
            probed >= floor / 2 && elapsed <= OPEN_DRAIN_MAX && current < ceiling
        });
        let next = if delay_bound {
            ceiling
        } else if rate_grew {
            rate_window.unwrap_or(current)
        } else {
            current
        };
        if next != current {
            tracing::info!(
                event = "uplink_pace",
                cap_bytes = next,
                previous_bytes = current,
                drain_ms = drain
                    .map(|(elapsed, _)| elapsed.as_millis() as u64)
                    .unwrap_or(0),
                probed_bytes = drain.map(|(_, probed)| probed).unwrap_or(0),
                "preview pace window"
            );
            self.cap.store(next, Ordering::Relaxed);
        }
        // A finished preview must not leave its fill timer running. The next
        // profile on this daemon would otherwise see a multi-second drain and
        // pin the cap at the floor.
        if idle {
            control.filled_at = None;
            control.acked_since_fill = 0;
            control.sample_bytes = 0;
            control.sample_started = None;
        }
    }
}

/// Outstanding bulk bytes of one preview, released if the stream disappears
/// before the client acknowledges them.
pub struct PaceShare {
    pace: Arc<UplinkPace>,
    ceiling: u64,
    outstanding: Mutex<u64>,
}

impl PaceShare {
    pub fn new(pace: Arc<UplinkPace>, ceiling: u64) -> Self {
        Self {
            pace,
            ceiling,
            outstanding: Mutex::new(0),
        }
    }

    pub async fn reserve(&self, bytes: u64) {
        self.pace.reserve(bytes).await;
        *self.outstanding.lock().unwrap() += bytes;
    }

    pub fn release(&self, bytes: u64) {
        let mut outstanding = self.outstanding.lock().unwrap();
        let bytes = bytes.min(*outstanding);
        *outstanding -= bytes;
        drop(outstanding);
        if bytes > 0 {
            self.pace.release(bytes, self.ceiling);
        }
    }
}

impl Drop for PaceShare {
    fn drop(&mut self) {
        let left = std::mem::take(&mut *self.outstanding.lock().unwrap());
        if left > 0 {
            self.pace.release(left, self.ceiling);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bulk_waits_once_the_floor_is_full_and_resumes_on_ack() {
        // Fix the ceiling to test Notify blocking independently of the default
        // network tuning. Both200KiB chunks fit alone, but not together.
        let pace = Arc::new(UplinkPace::new(256 * 1024));
        let share = PaceShare::new(pace.clone(), 256 * 1024);
        share.reserve(200 * 1024).await;
        let second = share.reserve(200 * 1024);
        tokio::pin!(second);
        tokio::select! {
            _ = &mut second => panic!("reserved past the 256KiB floor"),
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
        share.release(200 * 1024);
        tokio::time::timeout(Duration::from_secs(1), second)
            .await
            .expect("ack should let the next chunk through");
    }
}
