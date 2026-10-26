//! Keeps response DATA from filling the shared Fabric uplink.
//!
//! A preview receive window of 3MiB lets that much sit in front of every other
//! stream on the same daemon socket. Direct WebSockets use a separate budget
//! per physical socket; RTC retains its transport policy. The ordinary floor is
//! 32KiB. An authenticated handshake gives a bounded initial path estimate;
//! the first delivered full window can refine it using the small-control RTT.
//! Complete windows within 400ms grow at most fourfold when serialization is
//! below 100ms (or total delay below 250ms without an RTT baseline), otherwise
//! twice. A real drain under 50ms opens to the 3MiB ceiling. Delayed ACKs keep
//! their original send ages across accounting resets; 900ms drains shrink the
//! cap, and idle paths lose their old capacity estimate.
//! Already transmitted bytes cannot be recalled after a live capacity drop.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const START_BYTES: u64 = 32 * 1024;
const RATE_TARGET: Duration = Duration::from_millis(200);
const GROW_DRAIN_MAX: Duration = Duration::from_millis(400);
/// Slow drains cannot justify a larger queue on a constrained uplink.
const OPEN_DRAIN_MAX: Duration = Duration::from_millis(900);
// Every admitted peer starts with one guaranteed record; a proven fast peer
// may earn four. The 32-peer admission bound limits this extra occupancy; a
// stalled downstream cannot take another peer's progress share.
const PEER_PROGRESS_BYTES: u64 = genehub_proto::MAX_DATA_FRAME_BYTES as u64;
// Only a peer that actually ACKs a complete record quickly earns four records.
// With the existing 32-peer admission bound this adds at most 2 MiB total.
const FAST_PEER_PROGRESS_BYTES: u64 = 4 * PEER_PROGRESS_BYTES;

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
    sample_ack_age: Duration,
    filled_ack_age: Duration,
    idle_since: Option<Instant>,
    initial_seed_until: Option<Instant>,
    initial_seed_bytes: u64,
    baseline_rtt: Option<Duration>,
    initial_delivery_sample: Option<Instant>,
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
                sample_ack_age: Duration::ZERO,
                filled_ack_age: Duration::ZERO,
                idle_since: None,
                initial_seed_until: None,
                initial_seed_bytes: 0,
                baseline_rtt: None,
                initial_delivery_sample: None,
            }),
        }
    }

    pub fn cap(&self) -> u64 {
        self.cap.load(Ordering::Relaxed)
    }

    fn observe_initial_path(&self, bytes: usize, large: Duration, baseline: Duration) {
        // The large and small authenticated possession proofs cross the same path.
        // A positive serialization sample estimates a latency-bound path;
        // unresolved timing only admits a bounded 64KiB probe. Local fast
        // paths retain ordinary ACK-driven discovery.
        // Retain the small authenticated RTT even when the large proof pair was
        // too noisy. The first delivered full DATA window supplies a larger
        // serialization sample without adding a handshake round trip.
        let outstanding = self.outstanding.lock().unwrap();
        if *outstanding != 0 {
            return;
        }
        let mut control = self.control.lock().unwrap();
        control.baseline_rtt = (baseline >= Duration::from_millis(50)).then_some(baseline);
        control.initial_delivery_sample = control
            .baseline_rtt
            .map(|_| Instant::now() + Duration::from_secs(2));
        drop(control);
        if baseline < Duration::from_millis(50) || bytes == 0 {
            return;
        }
        let floor = START_BYTES.min(self.ceiling);
        let estimate = if large <= baseline {
            // No positive serialization signal: never infer a multi-MiB
            // path from noise. One bounded 64KiB probe gives the first real
            // delivery sample more bytes than the control's timing jitter.
            u128::from(floor.saturating_mul(2))
        } else {
            let serialization_us = (large - baseline).as_micros().max(1_000);
            (bytes as u128)
                .saturating_mul(baseline.as_micros())
                .saturating_mul(2)
                / serialization_us
        };
        let estimate = (estimate.min(u128::from(self.ceiling)) as u64).max(floor);
        let mut control = self.control.lock().unwrap();
        control.initial_seed_until = Some(Instant::now() + Duration::from_secs(2));
        control.initial_seed_bytes = 0;
        control.idle_since = None;
        self.cap.store(estimate, Ordering::Relaxed);
        tracing::info!(
            event = "uplink_initial_sample",
            cap_bytes = estimate,
            sample_rtt_us = large.as_micros() as u64,
            baseline_rtt_us = baseline.as_micros() as u64,
            sample_bytes = bytes,
            "bounded initial uplink sample"
        );
    }

    pub(crate) fn peer(self: &Arc<Self>) -> Arc<PeerPace> {
        Arc::new(PeerPace {
            shared: self.clone(),
            outstanding: Mutex::new(0),
            initial: Mutex::new(None),
            progress: Mutex::new(PeerProgress {
                cap: PEER_PROGRESS_BYTES,
                started: None,
                acked: 0,
            }),
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
            let expired = control
                .initial_seed_until
                .is_some_and(|until| Instant::now() >= until);
            if expired {
                control.initial_seed_until = None;
                control.initial_delivery_sample = None;
            }
            if expired
                || (control.initial_seed_until.is_none()
                    && control
                        .idle_since
                        .take()
                        .is_some_and(|at| at.elapsed() >= Duration::from_millis(100)))
            {
                self.cap
                    .store(START_BYTES.min(self.ceiling), Ordering::Relaxed);
            }
        }
        let cap = self.cap.load(Ordering::Relaxed);
        if progress || bytes > cap || outstanding.saturating_add(bytes) <= cap {
            *outstanding = outstanding.saturating_add(bytes);
            {
                let mut control = self.control.lock().unwrap();
                if control.initial_seed_until.is_some() {
                    control.initial_seed_bytes = control.initial_seed_bytes.saturating_add(bytes);
                    if control.initial_seed_bytes >= START_BYTES {
                        control.initial_seed_until = None;
                    }
                }
            }
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
            sent_at: Instant::now(),
        })
    }

    fn note_filled(&self, outstanding: u64, cap: u64) {
        let mut control = self.control.lock().unwrap();
        if control.filled_at.is_none() && outstanding >= cap && cap > 0 {
            control.filled_at = Some(Instant::now());
            control.acked_since_fill = 0;
            control.cap_at_fill = cap;
            control.filled_ack_age = Duration::ZERO;
        }
    }

    fn release_aged(&self, bytes: u64, ceiling: u64, ack_age: Duration) {
        if bytes == 0 {
            return;
        }
        let idle = {
            let mut outstanding = self.outstanding.lock().unwrap();
            *outstanding = outstanding.saturating_sub(bytes);
            *outstanding == 0
        };
        self.observe(bytes, ceiling, idle, ack_age);
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
        control.sample_ack_age = Duration::ZERO;
        control.filled_ack_age = Duration::ZERO;
        if *outstanding == 0 {
            control.idle_since = Some(Instant::now());
        }
        drop(control);
        drop(outstanding);
        self.changes.send_replace(());
    }

    fn observe(&self, bytes: u64, ceiling: u64, idle: bool, ack_age: Duration) {
        let mut control = self.control.lock().unwrap();
        let floor = START_BYTES.min(ceiling);
        let current = self.cap.load(Ordering::Relaxed);
        if control.sample_started.is_none() {
            control.sample_started = Some(Instant::now());
        }
        control.sample_bytes = control.sample_bytes.saturating_add(bytes);
        control.sample_ack_age = control.sample_ack_age.max(ack_age);
        if control.filled_at.is_some() {
            control.filled_ack_age = control.filled_ack_age.max(ack_age);
        }
        let mut drain = None;
        let mut overrun = None;
        if let Some(filled_at) = control.filled_at {
            // A full window still unacked past the open band means the uplink
            // cannot clear it in time. Keep only what it cleared in that band,
            // then drop the timer so the next full window is measured afresh.
            let waited = filled_at.elapsed().max(control.filled_ack_age);
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
                drain = Some((
                    filled_at.elapsed().max(control.filled_ack_age),
                    control.cap_at_fill,
                ));
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
            .unwrap_or(elapsed)
            .max(control.sample_ack_age);
        let short_drain =
            drain.is_some_and(|(drain_elapsed, _)| drain_elapsed < Duration::from_millis(50));
        let rate_window = if (elapsed >= Duration::from_millis(50) || short_drain)
            && control.sample_bytes >= 32 * 1024
        {
            let per_sec = (control.sample_bytes as f64 / elapsed.as_secs_f64().max(0.001)) as u64;
            let window = per_sec.saturating_mul(RATE_TARGET.as_millis() as u64) / 1_000;
            control.sample_bytes = 0;
            control.sample_started = Some(Instant::now());
            control.sample_ack_age = Duration::ZERO;
            Some(window.clamp(floor, ceiling))
        } else {
            None
        };

        let rate_grew = rate_window.is_some_and(|window| window > current);
        // Bound discovery to one fourfold probe per completed window, with a
        // tighter drain limit so narrow links do not justify a large queue.
        // Keep the fast-LAN shortcut without promoting a small weak-link sample
        // directly to a multi-MiB queue.
        let delay_bound = drain.is_some_and(|(elapsed, probed)| {
            probed >= floor / 2 && elapsed <= GROW_DRAIN_MAX && current < ceiling
        });
        // A completed window contains both propagation and serialization.
        // The authenticated small controls give a propagation baseline; use
        // the remaining time to target one BDP plus 200ms of queued bytes.
        // A 32KiB sample on a 200ms fast path can then discover capacity in
        // one delivery round, without repeatedly doubling across that RTT.
        let initial_sample = if drain.is_some_and(|(_, probed)| probed >= floor / 2) {
            control.initial_delivery_sample.take()
        } else {
            None
        };
        let path_window = drain.and_then(|(elapsed, probed)| {
            initial_sample.filter(|until| Instant::now() <= *until)?;
            let baseline = control.baseline_rtt?;
            // Bootstrap only. Later windows overlap earlier delivery and ACK
            // batches, so subtracting propagation there would invent rate.
            if probed < floor / 2 || elapsed > OPEN_DRAIN_MAX {
                return None;
            }
            let serial_us = elapsed.saturating_sub(baseline).as_micros().max(1_000);
            let window = u128::from(probed) * (baseline + RATE_TARGET).as_micros() / serial_us;
            Some((window.min(u128::from(ceiling)) as u64).max(floor))
        });
        let next = if let Some(fits) = overrun.filter(|fits| *fits < current) {
            fits
        } else if let Some(window) = path_window {
            window
        } else if delay_bound {
            if short_drain {
                ceiling
            } else {
                let factor = if drain.is_some_and(|(elapsed, _)| {
                    control
                        .baseline_rtt
                        .map_or(elapsed <= Duration::from_millis(250), |rtt| {
                            elapsed.saturating_sub(rtt) <= Duration::from_millis(100)
                        })
                }) {
                    4
                } else {
                    2
                };
                current.saturating_mul(factor).min(ceiling)
            }
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
            control.sample_ack_age = Duration::ZERO;
            control.filled_ack_age = Duration::ZERO;
        }
    }
}

/// One actual transmission on one physical uplink. Only a validated ACK for
/// its active logical epoch is delivery; replacing a channel abandons its debit.
pub(crate) struct Charge {
    pace: Arc<UplinkPace>,
    peer: Option<Arc<PeerPace>>,
    bytes: u64,
    sent_at: Instant,
}
impl Charge {
    pub(crate) fn acknowledge(mut self) {
        if let Some(peer) = &self.peer {
            peer.relinquish(self.bytes, true);
        }
        self.pace
            .release_aged(self.bytes, self.pace.ceiling, self.sent_at.elapsed());
        self.bytes = 0;
    }
}
impl Drop for Charge {
    fn drop(&mut self) {
        if let Some(peer) = &self.peer {
            peer.relinquish(self.bytes, false);
        }
        self.pace.discard(self.bytes);
    }
}

/// Custody belongs to a physical peer, including while it is retained as a
/// standby. Reattaching or cancelling drops charges without manufacturing ACKs.
struct PeerProgress {
    cap: u64,
    started: Option<Instant>,
    acked: u64,
}
pub(crate) struct PeerPace {
    shared: Arc<UplinkPace>,
    outstanding: Mutex<u64>,
    progress: Mutex<PeerProgress>,
    initial: Mutex<Option<(Instant, usize, Duration, Duration)>>,
}

impl PeerPace {
    pub(crate) fn observe_initial_path(&self, bytes: usize, large: Duration, baseline: Duration) {
        *self.initial.lock().unwrap() = Some((Instant::now(), bytes, large, baseline));
    }
    pub(crate) fn changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.shared.changes()
    }

    pub(crate) fn can_reserve(&self, bytes: u64) -> bool {
        self.outstanding.lock().unwrap().saturating_add(bytes) <= self.progress.lock().unwrap().cap
            || self.shared.can_reserve(bytes)
    }

    fn try_reserve(&self, bytes: u64) -> bool {
        // Apply this peer's proof when it actually sends, after any preceding
        // peer's tail ACK. An old high cap must not suppress the fresh sample.
        if let Some((at, size, large, baseline)) = self.initial.lock().unwrap().take() {
            if at.elapsed() <= Duration::from_secs(2) {
                self.shared.observe_initial_path(size, large, baseline);
            }
        }
        let mut outstanding = self.outstanding.lock().unwrap();
        let progress = outstanding.saturating_add(bytes) <= self.progress.lock().unwrap().cap;
        if !self.shared.try_reserve_progress(bytes, progress) {
            return false;
        }
        if *outstanding == 0 {
            let mut sample = self.progress.lock().unwrap();
            sample.started = Some(Instant::now());
            sample.acked = 0;
        }
        *outstanding = outstanding.saturating_add(bytes);
        true
    }

    fn relinquish(&self, bytes: u64, delivered: bool) {
        let mut outstanding = self.outstanding.lock().unwrap();
        *outstanding = outstanding.saturating_sub(bytes);
        let mut sample = self.progress.lock().unwrap();
        if !delivered {
            sample.started = None;
            sample.acked = 0;
            return;
        }
        sample.acked = sample.acked.saturating_add(bytes);
        if let Some(at) = sample.started {
            if at.elapsed() > OPEN_DRAIN_MAX {
                sample.cap = PEER_PROGRESS_BYTES;
            } else if at.elapsed() < Duration::from_millis(50)
                && sample.acked >= PEER_PROGRESS_BYTES
            {
                sample.cap = FAST_PEER_PROGRESS_BYTES;
            }
        }
        if *outstanding == 0 {
            sample.started = None;
            sample.acked = 0;
        }
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
            sent_at: Instant::now(),
        })
    }
}

/// Fixed-owner bootstrap streams do not have a replay journal.
pub struct PaceShare {
    pace: Arc<PeerPace>,
    ceiling: u64,
    outstanding: AtomicU64,
    sent: Mutex<std::collections::VecDeque<(u64, Instant)>>,
}
impl PaceShare {
    pub(crate) fn new(pace: Arc<PeerPace>, ceiling: u64) -> Self {
        Self {
            pace,
            ceiling,
            outstanding: AtomicU64::new(0),
            sent: Mutex::new(std::collections::VecDeque::new()),
        }
    }
    pub async fn reserve(&self, bytes: u64) {
        if bytes == 0 {
            return;
        }
        self.pace.reserve(bytes).await;
        let mut sent = self.sent.lock().unwrap();
        if sent.len() >= 64 {
            // Merge into the oldest timestamp in the tail bucket: bounded
            // metadata and conservative timing, including tiny-record storms.
            sent.back_mut().unwrap().0 += bytes;
        } else {
            sent.push_back((bytes, Instant::now()));
        }
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
        self.pace.relinquish(released, true);
        let mut remaining = released;
        let mut deliveries = Vec::new();
        {
            let mut sent = self.sent.lock().unwrap();
            while remaining > 0 {
                let (size, at) = sent
                    .front_mut()
                    .expect("paced bytes retain their timestamp");
                let count = remaining.min(*size);
                deliveries.push((count, at.elapsed()));
                *size -= count;
                remaining -= count;
                if *size == 0 {
                    sent.pop_front();
                }
            }
        }
        for (bytes, age) in deliveries {
            self.pace.shared.release_aged(bytes, self.ceiling, age);
        }
    }
}
impl Drop for PaceShare {
    fn drop(&mut self) {
        let abandoned = self.outstanding.load(Ordering::Relaxed);
        self.pace.relinquish(abandoned, false);
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
        share.reserve(START_BYTES * 3 / 4).await;
        let second = share.reserve(START_BYTES * 3 / 4);
        tokio::pin!(second);
        tokio::select! {
            _ = &mut second => panic!("reserved past the initial window"),
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
        share.release(START_BYTES * 3 / 4);
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
    async fn a_delay_bound_window_grows_by_one_bounded_probe() {
        let ceiling = 3 * 1024 * 1024;
        let pace = Arc::new(UplinkPace::new(ceiling));
        let share = PaceShare::new(pace.peer(), ceiling);
        share.reserve(START_BYTES).await;
        tokio::time::sleep(Duration::from_millis(220)).await;
        share.release(START_BYTES);
        assert_eq!(pace.cap(), START_BYTES * 4);
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
        // A new quota check can restart the accounting timer while old bytes
        // still await delivery. A fresh peer's fast ACK must not make those
        // old bytes look like a newly transmitted fast window.
        let progress = PaceShare::new(pace.peer(), ceiling);
        progress.reserve(PEER_PROGRESS_BYTES).await;
        assert!(!pace.can_reserve(ceiling));
        share.release(ceiling - 2 * 1024 * 1024);
        tokio::time::sleep(Duration::from_millis(10)).await;
        progress.release(PEER_PROGRESS_BYTES);
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
        share.release(START_BYTES / 4);
        assert_eq!(pace.cap(), START_BYTES);
        share.release(ceiling - START_BYTES / 4);
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
        let sent = Instant::now();
        pace.reserve(START_BYTES).await;
        assert!(pace.try_acquire(4096).is_none());
        tokio::time::sleep(Duration::from_millis(1000)).await;
        pace.release_aged(32 * 1024, pace.ceiling, sent.elapsed());
        assert_eq!(pace.cap(), START_BYTES);
        pace.discard(START_BYTES - 32 * 1024);
    }
    #[tokio::test]
    async fn an_idle_path_reprobes_instead_of_inheriting_an_old_fast_window() {
        let pace = Arc::new(UplinkPace::new(3 * 1024 * 1024));
        let sent = Instant::now();
        pace.reserve(START_BYTES).await;
        pace.release_aged(START_BYTES, pace.ceiling, sent.elapsed());
        assert_eq!(pace.cap(), pace.ceiling);
        pace.control.lock().unwrap().idle_since = Some(Instant::now() - Duration::from_secs(1));
        pace.reserve(1024).await;
        assert_eq!(pace.cap(), START_BYTES);
        pace.discard(1024);
    }
}
