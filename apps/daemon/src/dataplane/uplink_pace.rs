//! Keeps one bulk response from filling the shared Fabric uplink.
//!
//! A preview receive window of 3MiB lets that much sit in front of every other
//! stream on the same daemon socket. The wait is that many bytes divided by
//! the uplink rate. This pace holds bulk bytes in flight to about 200ms of the
//! rate observed from client window updates, and never below 256KiB or above
//! the protocol window.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Notify;

const FLOOR_BYTES: u64 = 256 * 1024;
const TARGET: Duration = Duration::from_millis(200);

pub struct UplinkPace {
    outstanding: Mutex<u64>,
    cap: AtomicU64,
    notify: Notify,
    sample: Mutex<Sample>,
}

struct Sample {
    bytes: u64,
    started: Instant,
}

impl UplinkPace {
    pub fn new(ceiling: u64) -> Self {
        Self {
            outstanding: Mutex::new(0),
            cap: AtomicU64::new(FLOOR_BYTES.min(ceiling)),
            notify: Notify::new(),
            sample: Mutex::new(Sample {
                bytes: 0,
                started: Instant::now(),
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
                    return;
                }
            }
            notified.await;
        }
    }

    pub fn release(&self, bytes: u64, ceiling: u64) {
        if bytes == 0 {
            return;
        }
        {
            let mut outstanding = self.outstanding.lock().unwrap();
            *outstanding = outstanding.saturating_sub(bytes);
        }
        self.observe(bytes, ceiling);
        self.notify.notify_waiters();
    }

    fn observe(&self, bytes: u64, ceiling: u64) {
        let mut sample = self.sample.lock().unwrap();
        sample.bytes = sample.bytes.saturating_add(bytes);
        let elapsed = sample.started.elapsed();
        if elapsed < Duration::from_millis(50) || sample.bytes < 32 * 1024 {
            return;
        }
        let per_sec = (sample.bytes as f64 / elapsed.as_secs_f64().max(0.001)) as u64;
        let window = per_sec.saturating_mul(TARGET.as_millis() as u64) / 1_000;
        let window = window.clamp(FLOOR_BYTES.min(ceiling), ceiling);
        self.cap.store(window, Ordering::Relaxed);
        *sample = Sample {
            bytes: 0,
            started: Instant::now(),
        };
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
