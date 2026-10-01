//! Keeps one bulk response from filling the shared Fabric uplink.
//!
//! A preview receive window of 3MiB lets that much sit in front of every other
//! stream on the same daemon socket. Only Fabric previews are paced; direct
//! and RTC peers do not share that socket. The cap starts at 640KiB and follows
//! the rate implied by client acks, about 200ms of that rate. One completed
//! window of at least half the start size that returns within 900ms opens
//! straight to the protocol ceiling, including a fast loopback drain. The
//! opened cap is retained only while its physical uplink is busy. A full window
//! still unacked after 900ms shrinks the cap to what drained in 900ms, never
//! below the start. An idle path starts conservatively again; already sent
//! bytes cannot be recalled if capacity falls during an active transmission.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const START_BYTES: u64 = 640 * 1024;
const RATE_TARGET: Duration = Duration::from_millis(200);
/// A full start window on a 5Mbps uplink takes about a second. Anything slower
/// than this stays at the start so the first RPC is not stuck behind a megabyte.
const OPEN_DRAIN_MAX: Duration = Duration::from_millis(900);
// Every admitted physical peer may keep at most one record in flight even
// when another peer owns the shared window. The Fabric admission limit bounds
// the extra occupancy; a stalled downstream cannot take this progress share.
const PEER_PROGRESS_BYTES: u64 = genehub_proto::MAX_DATA_FRAME_BYTES as u64;

pub struct UplinkPace {
    ceiling: u64,
    changes: tokio::sync::watch::Sender<()>,
    outstanding: Mutex<u64>,
    cap: AtomicU64,
    control: Mutex<Control>,
}

struct Control {
    filled_at: Option<Instant>,
    acked_since_fill: u64,
    cap_at_fill: u64,
    sample_bytes: u64,
    sample_started: Option<Instant>,
    idle_since: Option<Instant>,
}

impl UplinkPace {
    pub fn new(ceiling: u64) -> Self {
        let floor = START_BYTES.min(ceiling);
        Self {
            ceiling,
            changes: tokio::sync::watch::channel(()).0,
            outstanding: Mutex::new(0),
            cap: AtomicU64::new(floor),
            control: Mutex::new(Control {
                filled_at: None,
                acked_since_fill: 0,
                cap_at_fill: floor,
                sample_bytes: 0,
                sample_started: None,
                idle_since: None,
            }),
        }
    }

    pub fn cap(&self) -> u64 {
        self.cap.load(Ordering::Relaxed)
    }

    pub(crate) fn peer(self: &Arc<Self>) -> Arc<PeerPace> {
        Arc::new(PeerPace {
            shared: self.clone(),
            outstanding: Mutex::new(0),
        })
    }

    #[cfg(test)]
    pub async fn reserve(&self, bytes: u64) {
        let mut changes = self.changes();
        loop {
            if self.try_reserve(bytes) {
                return;
            }
            // watch retains a release between the failed reservation and the
            // first poll. Notify::notify_waiters does not retain that wake.
            let _ = changes.changed().await;
        }
    }

    pub(crate) fn can_reserve(&self, bytes: u64) -> bool {
        let outstanding = *self.outstanding.lock().unwrap();
        let available = outstanding.saturating_add(bytes) <= self.cap();
        if !available {
            self.note_filled(outstanding, outstanding);
        }
        available
    }

    #[cfg(test)]
    fn try_reserve(&self, bytes: u64) -> bool {
        self.try_reserve_progress(bytes, false)
    }

    fn try_reserve_progress(&self, bytes: u64, progress: bool) -> bool {
        let mut outstanding = self.outstanding.lock().unwrap();
        if *outstanding == 0 {
            let mut control = self.control.lock().unwrap();
            if control
                .idle_since
                .take()
                .is_some_and(|at| at.elapsed() >= Duration::from_millis(100))
            {
                self.cap
                    .store(START_BYTES.min(self.ceiling), Ordering::Relaxed);
            }
        }
        let cap = self.cap.load(Ordering::Relaxed);
        if progress || bytes > cap || outstanding.saturating_add(bytes) <= cap {
            *outstanding = outstanding.saturating_add(bytes);
            self.note_filled(*outstanding, cap);
            return true;
        }
        self.note_filled(*outstanding, *outstanding);
        false
    }

    pub(crate) fn changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.changes.subscribe()
    }

    #[cfg(test)]
    pub(crate) fn try_acquire(self: &Arc<Self>, bytes: u64) -> Option<Charge> {
        self.try_reserve(bytes).then(|| Charge {
            pace: self.clone(),
            peer: None,
            bytes,
        })
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
        self.changes.send_replace(());
    }

    /// Release abandoned occupancy without inventing delivery or rate samples.
    pub fn discard(&self, bytes: u64) {
        if bytes == 0 {
            return;
        }
        let mut outstanding = self.outstanding.lock().unwrap();
        *outstanding = outstanding.saturating_sub(bytes);
        let mut control = self.control.lock().unwrap();
        control.filled_at = None;
        control.acked_since_fill = 0;
        control.sample_bytes = 0;
        control.sample_started = None;
        if *outstanding == 0 {
            control.idle_since = Some(Instant::now());
        }
        drop(control);
        drop(outstanding);
        self.changes.send_replace(());
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
        let mut overrun = None;
        if let Some(filled_at) = control.filled_at {
            // A full window still unacked past the open band means the uplink
            // cannot clear it in time. Keep only what it cleared in that band,
            // then drop the timer so the next full window is measured afresh.
            let waited = filled_at.elapsed();
            if waited > OPEN_DRAIN_MAX && control.acked_since_fill < control.cap_at_fill {
                let drained = control.acked_since_fill.saturating_add(bytes) as u128;
                let fits = drained * OPEN_DRAIN_MAX.as_micros() / waited.as_micros().max(1);
                overrun = Some((fits as u64).clamp(floor, ceiling));
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
        } else if let Some(fits) = overrun.filter(|fits| *fits < current) {
            fits
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
                overrun_fits_bytes = overrun.unwrap_or(0),
                "preview pace window"
            );
            self.cap.store(next, Ordering::Relaxed);
        }
        // A finished preview must not leave its fill timer running. The next
        // profile on this daemon would otherwise see a multi-second drain and
        // pin the cap at the floor.
        if idle {
            control.idle_since = Some(Instant::now());
            control.filled_at = None;
            control.acked_since_fill = 0;
            control.sample_bytes = 0;
            control.sample_started = None;
        }
    }
}

/// One actual transmission on one physical uplink. Only a validated ACK for
/// its active logical epoch is delivery; replacing a channel abandons its debit.
pub(crate) struct Charge {
    pace: Arc<UplinkPace>,
    peer: Option<Arc<PeerPace>>,
    bytes: u64,
}
impl Charge {
    pub(crate) fn acknowledge(mut self) {
        if let Some(peer) = &self.peer {
            peer.relinquish(self.bytes);
        }
        self.pace.release(self.bytes, self.pace.ceiling);
        self.bytes = 0;
    }
}
impl Drop for Charge {
    fn drop(&mut self) {
        if let Some(peer) = &self.peer {
            peer.relinquish(self.bytes);
        }
        self.pace.discard(self.bytes);
    }
}

/// Custody belongs to a physical peer, including while it is retained as a
/// standby. Reattaching or cancelling drops charges without manufacturing ACKs.
pub(crate) struct PeerPace {
    shared: Arc<UplinkPace>,
    outstanding: Mutex<u64>,
}

impl PeerPace {
    pub(crate) fn changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.shared.changes()
    }

    pub(crate) fn can_reserve(&self, bytes: u64) -> bool {
        self.outstanding.lock().unwrap().saturating_add(bytes) <= PEER_PROGRESS_BYTES
            || self.shared.can_reserve(bytes)
    }

    fn try_reserve(&self, bytes: u64) -> bool {
        let mut outstanding = self.outstanding.lock().unwrap();
        let progress = outstanding.saturating_add(bytes) <= PEER_PROGRESS_BYTES;
        if !self.shared.try_reserve_progress(bytes, progress) {
            return false;
        }
        *outstanding = outstanding.saturating_add(bytes);
        true
    }

    fn relinquish(&self, bytes: u64) {
        let mut outstanding = self.outstanding.lock().unwrap();
        *outstanding = outstanding.saturating_sub(bytes);
    }

    async fn reserve(&self, bytes: u64) {
        let mut changes = self.changes();
        while !self.try_reserve(bytes) {
            let _ = changes.changed().await;
        }
    }

    pub(crate) fn try_acquire(self: &Arc<Self>, bytes: u64) -> Option<Charge> {
        self.try_reserve(bytes).then(|| Charge {
            pace: self.shared.clone(),
            peer: Some(self.clone()),
            bytes,
        })
    }
}

/// Fixed-owner bootstrap streams do not have a replay journal.
pub struct PaceShare {
    pace: Arc<PeerPace>,
    ceiling: u64,
    outstanding: AtomicU64,
}
impl PaceShare {
    pub(crate) fn new(pace: Arc<PeerPace>, ceiling: u64) -> Self {
        Self {
            pace,
            ceiling,
            outstanding: AtomicU64::new(0),
        }
    }
    pub async fn reserve(&self, bytes: u64) {
        self.pace.reserve(bytes).await;
        self.outstanding.fetch_add(bytes, Ordering::Relaxed);
    }
    pub fn release(&self, bytes: u64) {
        let previous = self
            .outstanding
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                Some(n.saturating_sub(bytes))
            })
            .unwrap();
        let released = bytes.min(previous);
        self.pace.relinquish(released);
        self.pace.shared.release(released, self.ceiling);
    }
}
impl Drop for PaceShare {
    fn drop(&mut self) {
        let abandoned = self.outstanding.load(Ordering::Relaxed);
        self.pace.relinquish(abandoned);
        self.pace.shared.discard(abandoned);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_is_bounded_per_peer_and_cancellation_returns_both_debits() {
        let pace = Arc::new(UplinkPace::new(START_BYTES));
        let stalled = pace.peer();
        let occupied = stalled.try_acquire(START_BYTES).unwrap();
        let peers: Vec<_> = (0..32).map(|_| pace.peer()).collect();
        let mut charges = Vec::new();
        for peer in &peers {
            charges.push(peer.try_acquire(PEER_PROGRESS_BYTES).unwrap());
            assert!(!peer.can_reserve(1));
            assert!(peer.try_acquire(1).is_none());
        }
        assert_eq!(
            *pace.outstanding.lock().unwrap(),
            START_BYTES + 32 * PEER_PROGRESS_BYTES
        );
        drop(charges);
        assert_eq!(*pace.outstanding.lock().unwrap(), START_BYTES);
        for peer in &peers {
            assert_eq!(*peer.outstanding.lock().unwrap(), 0);
            peer.try_acquire(PEER_PROGRESS_BYTES).unwrap().acknowledge();
            assert_eq!(*peer.outstanding.lock().unwrap(), 0);
        }
        drop(occupied);
        assert_eq!(*pace.outstanding.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn bulk_waits_once_the_floor_is_full_and_resumes_on_ack() {
        let pace = Arc::new(UplinkPace::new(3 * 1024 * 1024));
        let share = PaceShare::new(pace.peer(), 3 * 1024 * 1024);
        share.reserve(500 * 1024).await;
        let second = share.reserve(500 * 1024);
        tokio::pin!(second);
        tokio::select! {
            _ = &mut second => panic!("reserved past the 640KiB start"),
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
        share.release(500 * 1024);
        tokio::time::timeout(Duration::from_secs(1), second)
            .await
            .expect("ack should let the next chunk through");
    }

    #[tokio::test]
    async fn cancelling_a_waiter_does_not_consume_the_next_release() {
        let pace = Arc::new(UplinkPace::new(START_BYTES));
        pace.reserve(START_BYTES).await;
        let mut cancelled = Box::pin(pace.reserve(START_BYTES));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut cancelled)
                .await
                .is_err()
        );
        // Two blocked callers must observe the same release; dropping one
        // waiter cannot steal it or reserve bytes on behalf of that caller.
        let mut survivor = Box::pin(pace.reserve(START_BYTES));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut survivor)
                .await
                .is_err()
        );
        drop(cancelled);
        pace.discard(START_BYTES);
        tokio::time::timeout(Duration::from_secs(1), &mut survivor)
            .await
            .unwrap();
        assert_eq!(*pace.outstanding.lock().unwrap(), START_BYTES);
        pace.discard(START_BYTES);
    }

    #[tokio::test]
    async fn a_delay_bound_window_opens_to_the_ceiling() {
        let ceiling = 3 * 1024 * 1024;
        let pace = Arc::new(UplinkPace::new(ceiling));
        let share = PaceShare::new(pace.peer(), ceiling);
        share.reserve(START_BYTES).await;
        tokio::time::sleep(Duration::from_millis(220)).await;
        share.release(START_BYTES);
        assert_eq!(pace.cap(), ceiling);
    }

    #[tokio::test]
    async fn a_slow_full_window_stays_at_the_floor() {
        let pace = Arc::new(UplinkPace::new(3 * 1024 * 1024));
        let share = PaceShare::new(pace.peer(), 3 * 1024 * 1024);
        share.reserve(START_BYTES).await;
        tokio::time::sleep(Duration::from_millis(1_100)).await;
        share.release(START_BYTES);
        assert_eq!(pace.cap(), START_BYTES);
    }

    #[tokio::test]
    async fn a_very_fast_full_window_still_opens_to_the_ceiling() {
        let ceiling = 3 * 1024 * 1024;
        let pace = Arc::new(UplinkPace::new(ceiling));
        let share = PaceShare::new(pace.peer(), ceiling);
        share.reserve(START_BYTES).await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        share.release(START_BYTES);
        assert_eq!(pace.cap(), ceiling);
    }

    #[tokio::test]
    async fn an_opened_window_stays_for_the_next_transfer() {
        let ceiling = 3 * 1024 * 1024;
        let pace = Arc::new(UplinkPace::new(ceiling));
        let share = PaceShare::new(pace.peer(), ceiling);
        share.reserve(START_BYTES).await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        share.release(START_BYTES);
        assert_eq!(pace.cap(), ceiling, "a fast window still opens");
        tokio::time::sleep(Duration::from_millis(50)).await;
        share.reserve(1024).await;
        assert_eq!(
            pace.cap(),
            ceiling,
            "the opened window stays for the next transfer on this daemon"
        );
        share.release(1024);
    }

    #[tokio::test]
    async fn an_opened_window_shrinks_when_the_uplink_slows_down() {
        let ceiling = 3 * 1024 * 1024;
        let pace = Arc::new(UplinkPace::new(ceiling));
        let share = PaceShare::new(pace.peer(), ceiling);
        share.reserve(START_BYTES).await;
        share.release(START_BYTES);
        assert_eq!(pace.cap(), ceiling);

        share.reserve(ceiling).await;
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        share.release(2 * 1024 * 1024);
        let cap = pace.cap();
        assert!(
            cap < ceiling && cap >= START_BYTES,
            "a window the uplink cannot clear in 900ms must shrink, got {cap}"
        );
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        share.release(ceiling - 2 * 1024 * 1024);
        assert!(pace.cap() <= cap, "a slow drain must not reopen the window");
    }

    #[tokio::test]
    async fn a_slow_uplink_shrinks_no_further_than_the_start() {
        let ceiling = 3 * 1024 * 1024;
        let pace = Arc::new(UplinkPace::new(ceiling));
        let share = PaceShare::new(pace.peer(), ceiling);
        share.reserve(START_BYTES).await;
        share.release(START_BYTES);
        share.reserve(ceiling).await;
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        share.release(64 * 1024);
        assert_eq!(pace.cap(), START_BYTES);
        share.release(ceiling - 64 * 1024);
    }
    #[tokio::test]
    async fn cancellation_frees_budget_without_training_the_path() {
        let pace = Arc::new(UplinkPace::new(3 * 1024 * 1024));
        {
            let share = PaceShare::new(pace.peer(), 3 * 1024 * 1024);
            share.reserve(START_BYTES).await;
        }
        assert_eq!(pace.cap(), START_BYTES);
        assert_eq!(*pace.outstanding.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn abandoned_old_channel_cannot_train_or_release_a_new_channel() {
        let ceiling = 3 * 1024 * 1024;
        let old = Arc::new(UplinkPace::new(ceiling));
        let new = Arc::new(UplinkPace::new(ceiling));
        let old_charge = old.try_acquire(START_BYTES).unwrap();
        let new_charge = new.try_acquire(START_BYTES).unwrap();
        drop(old_charge);
        assert_eq!(*old.outstanding.lock().unwrap(), 0);
        assert_eq!(old.cap(), START_BYTES);
        assert_eq!(*new.outstanding.lock().unwrap(), START_BYTES);
        assert_eq!(new.cap(), START_BYTES);
        drop(new_charge);
        assert_eq!(*new.outstanding.lock().unwrap(), 0);
        assert_eq!(new.cap(), START_BYTES);
    }

    #[tokio::test]
    async fn an_unaligned_cap_observes_blocking_and_can_shrink() {
        let pace = Arc::new(UplinkPace::new(3 * 1024 * 1024));
        pace.cap.store(START_BYTES + 17, Ordering::Relaxed);
        pace.reserve(START_BYTES).await;
        assert!(pace.try_acquire(4096).is_none());
        tokio::time::sleep(Duration::from_millis(1000)).await;
        pace.release(32 * 1024, pace.ceiling);
        assert_eq!(pace.cap(), START_BYTES);
        pace.discard(START_BYTES - 32 * 1024);
    }
    #[tokio::test]
    async fn an_idle_path_reprobes_instead_of_inheriting_an_old_fast_window() {
        let pace = Arc::new(UplinkPace::new(3 * 1024 * 1024));
        pace.reserve(START_BYTES).await;
        pace.release(START_BYTES, pace.ceiling);
        assert_eq!(pace.cap(), pace.ceiling);
        pace.control.lock().unwrap().idle_since = Some(Instant::now() - Duration::from_secs(1));
        pace.reserve(1024).await;
        assert_eq!(pace.cap(), START_BYTES);
        pace.discard(1024);
    }
}
