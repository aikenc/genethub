//! V4 ordered journal used by the authenticated logical connection actor.
//! Pure synchronous transactions, with explicit receive leases. Authentication,
//! epoch arbitration, timers and stream dispatch belong to the connection actor.
use std::collections::BTreeMap;

pub const HEADER_BYTES: usize = 36;
pub const MAX_PAYLOAD: usize = 16 * 1024 - 28 - HEADER_BYTES;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    ProtocolViolation,
    Backpressure,
    PolicyDenied,
    ResumeExpired,
    Closed,
    StateLost,
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    RelayAllowed,
    DirectOnly,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Path {
    Fabric,
    Rtc,
    Loopback,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub stream_id: u32,
    pub value: u32,
    pub payload: Vec<u8>,
}
impl Frame {
    fn progress(&self) -> bool {
        self.kind >= 4
    }
    fn validate(&self) -> Result<()> {
        if !(1..=6).contains(&self.kind)
            || self.stream_id == 0
            || (self.kind <= 2 && self.payload.len() > 8192)
            || self.payload.len() > MAX_PAYLOAD
            || (self.progress() && !self.payload.is_empty())
        {
            return Err(Error::ProtocolViolation);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payload {
    pub epoch: u64,
    pub seq: u64,
    pub frame: Frame,
}
impl Payload {
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.frame.validate()?;
        if self.epoch == 0 || self.seq == 0 {
            return Err(Error::ProtocolViolation);
        }
        let mut bytes = vec![0; HEADER_BYTES];
        bytes[0] = 4;
        bytes[1] = 1;
        bytes[4..12].copy_from_slice(&self.epoch.to_be_bytes());
        bytes[12..20].copy_from_slice(&self.seq.to_be_bytes());
        bytes[20] = self.frame.kind;
        bytes[24..28].copy_from_slice(&self.frame.stream_id.to_be_bytes());
        bytes[28..32].copy_from_slice(&self.frame.value.to_be_bytes());
        bytes[32..36].copy_from_slice(&(self.frame.payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&self.frame.payload);
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if !(HEADER_BYTES..=16 * 1024 - 28).contains(&bytes.len())
            || bytes[0] != 4
            || bytes[1] != 1
            || bytes[2..4] != [0, 0]
            || bytes[21..24] != [0, 0, 0]
        {
            return Err(Error::ProtocolViolation);
        }
        let length = u32::from_be_bytes(bytes[32..36].try_into().unwrap()) as usize;
        if length != bytes.len() - HEADER_BYTES {
            return Err(Error::ProtocolViolation);
        }
        let result = Self {
            epoch: u64::from_be_bytes(bytes[4..12].try_into().unwrap()),
            seq: u64::from_be_bytes(bytes[12..20].try_into().unwrap()),
            frame: Frame {
                kind: bytes[20],
                stream_id: u32::from_be_bytes(bytes[24..28].try_into().unwrap()),
                value: u32::from_be_bytes(bytes[28..32].try_into().unwrap()),
                payload: bytes[36..].to_vec(),
            },
        };
        result.frame.validate()?;
        if result.epoch == 0 || result.seq == 0 {
            return Err(Error::ProtocolViolation);
        }
        Ok(result)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Ack {
        epoch: u64,
        received: u64,
    },
    Budget {
        epoch: u64,
        data_grant: u64,
        progress_grant: u64,
    },
}
impl Control {
    pub fn epoch(&self) -> u64 {
        match *self {
            Self::Ack { epoch, .. } | Self::Budget { epoch, .. } => epoch,
        }
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        if self.epoch() == 0 {
            return Err(Error::ProtocolViolation);
        }
        let mut bytes = vec![4, 0, 0, 0];
        bytes.extend_from_slice(&self.epoch().to_be_bytes());
        match *self {
            Self::Ack { received, .. } => {
                bytes[1] = 2;
                bytes.extend_from_slice(&received.to_be_bytes());
            }
            Self::Budget {
                data_grant,
                progress_grant,
                ..
            } => {
                bytes[1] = 3;
                bytes.extend_from_slice(&data_grant.to_be_bytes());
                bytes.extend_from_slice(&progress_grant.to_be_bytes());
            }
        }
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 20
            || bytes[0] != 4
            || bytes[2..4] != [0, 0]
            || !((bytes[1] == 2 && bytes.len() == 20) || (bytes[1] == 3 && bytes.len() == 28))
        {
            return Err(Error::ProtocolViolation);
        }
        let epoch = u64::from_be_bytes(bytes[4..12].try_into().unwrap());
        if epoch == 0 {
            return Err(Error::ProtocolViolation);
        }
        let value = u64::from_be_bytes(bytes[12..20].try_into().unwrap());
        Ok(if bytes[1] == 2 {
            Self::Ack {
                epoch,
                received: value,
            }
        } else {
            Self::Budget {
                epoch,
                data_grant: value,
                progress_grant: u64::from_be_bytes(bytes[20..28].try_into().unwrap()),
            }
        })
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Watermark {
    pub received: u64,
    pub data_grant: u64,
    pub progress_grant: u64,
}
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub data_bytes: usize,
    pub progress_bytes: usize,
}
#[derive(Debug)]
struct Lane {
    capacity: u64,
    charged: u64,
    grant: u64,
    log_bytes: usize,
    received: u64,
    freed: u64,
}
#[derive(Debug)]
struct Entry {
    frame: Frame,
    size: usize,
    lane: usize,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Connecting,
    Ready,
    Recovering,
    Closed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub retained_frames: usize,
    pub receive_leases: usize,
    pub log_bytes: usize,
    pub receive_bytes: u64,
    pub epoch: u64,
}
#[derive(Debug)]
pub struct Journal {
    policy: Policy,
    ttl_ms: u64,
    last_now: u64,
    deadline: Option<u64>,
    terminal: Option<Error>,
    active: bool,
    epoch: u64,
    cursor: u64,
    allocated: u64,
    attempted: u64,
    acked: u64,
    received: u64,
    lanes: [Lane; 2],
    log: BTreeMap<u64, Entry>,
    leases: BTreeMap<u64, (usize, usize)>,
}
fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or(Error::ProtocolViolation)
}
impl Journal {
    /// Both peers must use the negotiated same directional capacities. The owner
    /// reserves these capacities against its global budget before construction.
    pub fn new(policy: Policy, limits: Limits, ttl_ms: u64) -> Result<Self> {
        let lane = |bytes: usize| -> Result<Lane> {
            if !(HEADER_BYTES..=128 * 1024 * 1024).contains(&bytes) {
                return Err(Error::ProtocolViolation);
            }
            Ok(Lane {
                capacity: bytes as u64,
                charged: 0,
                grant: bytes as u64,
                log_bytes: 0,
                received: 0,
                freed: 0,
            })
        };
        if ttl_ms == 0 || ttl_ms > 9_007_199_254_740_991 {
            return Err(Error::ProtocolViolation);
        }
        Ok(Self {
            policy,
            ttl_ms,
            last_now: 0,
            deadline: None,
            terminal: None,
            active: false,
            epoch: 0,
            cursor: 0,
            allocated: 0,
            attempted: 0,
            acked: 0,
            received: 0,
            lanes: [lane(limits.data_bytes)?, lane(limits.progress_bytes)?],
            log: BTreeMap::new(),
            leases: BTreeMap::new(),
        })
    }
    fn live(&self) -> Result<()> {
        match self.terminal {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
    pub fn state(&self) -> State {
        if self.terminal.is_some() {
            State::Closed
        } else if self.active {
            State::Ready
        } else if self.epoch > 0 {
            State::Recovering
        } else {
            State::Connecting
        }
    }
    pub fn watermark(&self) -> Result<Watermark> {
        Ok(Watermark {
            received: self.received,
            data_grant: add(self.lanes[0].capacity, self.lanes[0].freed)?,
            progress_grant: add(self.lanes[1].capacity, self.lanes[1].freed)?,
        })
    }
    pub fn stats(&self) -> Stats {
        Stats {
            retained_frames: self.log.len(),
            receive_leases: self.leases.len(),
            log_bytes: self.lanes.iter().map(|l| l.log_bytes).sum(),
            receive_bytes: self.lanes.iter().map(|l| l.received - l.freed).sum(),
            epoch: self.epoch,
        }
    }
    pub fn tick(&mut self, now: u64) -> Result<()> {
        self.live()?;
        if now < self.last_now || now > 9_007_199_254_740_991 {
            return Err(Error::ProtocolViolation);
        }
        self.last_now = now;
        if self.deadline.is_some_and(|d| now >= d) {
            self.close(Error::ResumeExpired);
            return Err(Error::ResumeExpired);
        }
        Ok(())
    }
    pub fn suspend(&mut self, now: u64) -> Result<()> {
        self.tick(now)?;
        if self.epoch == 0 {
            return Err(Error::ProtocolViolation);
        }
        if self.deadline.is_none() {
            let deadline = add(now, self.ttl_ms)?;
            if deadline > 9_007_199_254_740_991 {
                return Err(Error::ProtocolViolation);
            }
            self.deadline = Some(deadline);
        }
        self.active = false;
        Ok(())
    }
    pub fn activate(&mut self, path: Path, epoch: u64, peer: Watermark, now: u64) -> Result<()> {
        self.tick(now)?;
        if self.policy == Policy::DirectOnly && path == Path::Fabric {
            return Err(Error::PolicyDenied);
        }
        if epoch <= self.epoch {
            return Err(Error::ProtocolViolation);
        }
        if peer.received > self.attempted {
            return Err(Error::ProtocolViolation);
        }
        if peer.received < self.acked {
            return Err(Error::StateLost);
        }
        self.check_grants(peer.data_grant, peer.progress_grant)?;
        if peer.data_grant < self.lanes[0].grant || peer.progress_grant < self.lanes[1].grant {
            return Err(Error::StateLost);
        }
        self.acknowledge(peer.received)?;
        self.update_grants(peer.data_grant, peer.progress_grant)?;
        self.epoch = epoch;
        self.cursor = peer.received;
        self.active = true;
        self.deadline = None;
        Ok(())
    }
    pub fn enqueue(&mut self, frame: Frame) -> Result<u64> {
        self.live()?;
        frame.validate()?;
        let size = HEADER_BYTES + frame.payload.len();
        let lane = usize::from(frame.progress());
        let l = &mut self.lanes[lane];
        let charged = add(l.charged, size as u64)?;
        let seq = add(self.allocated, 1)?;
        if l.log_bytes + size > l.capacity as usize || charged > l.grant {
            return Err(Error::Backpressure);
        }
        self.log.insert(seq, Entry { frame, size, lane });
        self.allocated = seq;
        l.charged = charged;
        l.log_bytes += size;
        Ok(seq)
    }
    pub fn next_record(&mut self) -> Result<Option<Vec<u8>>> {
        self.live()?;
        if !self.active {
            return Ok(None);
        }
        let Some(seq) = self.cursor.checked_add(1) else {
            return Ok(None);
        };
        let Some(entry) = self.log.get(&seq) else {
            return Ok(None);
        };
        let bytes = Payload {
            epoch: self.epoch,
            seq,
            frame: entry.frame.clone(),
        }
        .encode()?;
        self.cursor = seq;
        self.attempted = self.attempted.max(seq);
        Ok(Some(bytes))
    }
    /// Returns a new delivery once. The owning actor keeps the frame until
    /// consumption/discard and releases its lease, including on RESET cleanup.
    pub fn receive(&mut self, bytes: &[u8]) -> Result<Option<(u64, Frame)>> {
        self.live()?;
        let packet = Payload::decode(bytes)?;
        if packet.epoch < self.epoch {
            return Ok(None);
        }
        if !self.active || packet.epoch != self.epoch {
            return Err(Error::ProtocolViolation);
        }
        if packet.seq <= self.received {
            return Ok(None);
        }
        if packet.seq != add(self.received, 1)? {
            return Err(Error::ProtocolViolation);
        }
        let lane = usize::from(packet.frame.progress());
        let l = &mut self.lanes[lane];
        let received = add(l.received, bytes.len() as u64)?;
        if received > add(l.capacity, l.freed)? {
            return Err(Error::ProtocolViolation);
        }
        self.leases.insert(packet.seq, (bytes.len(), lane));
        l.received = received;
        self.received = packet.seq;
        Ok(Some((packet.seq, packet.frame)))
    }
    pub fn release(&mut self, seq: u64) -> Result<()> {
        self.live()?;
        let &(size, lane) = self.leases.get(&seq).ok_or(Error::ProtocolViolation)?;
        let l = &mut self.lanes[lane];
        let freed = add(l.freed, size as u64)?;
        add(l.capacity, freed)?;
        l.freed = freed;
        self.leases.remove(&seq);
        Ok(())
    }
    pub fn receive_control(&mut self, bytes: &[u8]) -> Result<()> {
        self.live()?;
        let control = Control::decode(bytes)?;
        if control.epoch() < self.epoch {
            return Ok(());
        }
        if !self.active || control.epoch() != self.epoch {
            return Err(Error::ProtocolViolation);
        }
        match control {
            Control::Ack { received, .. } => self.acknowledge(received),
            Control::Budget {
                data_grant,
                progress_grant,
                ..
            } => self.update_grants(data_grant, progress_grant),
        }
    }
    /// Owner validates the ACK's authenticated channel and activation epoch.
    pub fn acknowledge(&mut self, seq: u64) -> Result<()> {
        self.live()?;
        if seq > self.attempted {
            return Err(Error::ProtocolViolation);
        }
        if seq <= self.acked {
            return Ok(());
        }
        while self.log.first_key_value().is_some_and(|(id, _)| *id <= seq) {
            let (_, entry) = self.log.pop_first().unwrap();
            self.lanes[entry.lane].log_bytes -= entry.size;
        }
        self.acked = seq;
        self.cursor = self.cursor.max(seq);
        Ok(())
    }
    fn check_grants(&self, data: u64, progress: u64) -> Result<()> {
        for (grant, l) in [data, progress].into_iter().zip(&self.lanes) {
            if grant > add(l.capacity, l.charged)? {
                return Err(Error::ProtocolViolation);
            }
        }
        Ok(())
    }
    pub fn update_grants(&mut self, data: u64, progress: u64) -> Result<()> {
        self.live()?;
        self.check_grants(data, progress)?;
        for (grant, l) in [data, progress].into_iter().zip(&mut self.lanes) {
            l.grant = l.grant.max(grant);
        }
        Ok(())
    }
    pub fn close(&mut self, reason: Error) {
        if self.terminal.is_some() {
            return;
        }
        self.terminal = Some(reason);
        self.active = false;
        self.log.clear();
        self.leases.clear();
        for l in &mut self.lanes {
            l.log_bytes = 0;
            l.freed = l.received;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(kind: u8) -> Frame {
        Frame {
            kind,
            stream_id: 1,
            value: 1,
            payload: if kind >= 4 { vec![] } else { vec![1, 2, 3] },
        }
    }
    fn pair(policy: Policy) -> (Journal, Journal) {
        let mut a = Journal::new(
            policy,
            Limits {
                data_bytes: 78,
                progress_bytes: 108,
            },
            60_000,
        )
        .unwrap();
        let mut b = Journal::new(
            policy,
            Limits {
                data_bytes: 78,
                progress_bytes: 108,
            },
            60_000,
        )
        .unwrap();
        a.activate(Path::Rtc, 1, b.watermark().unwrap(), 0).unwrap();
        b.activate(Path::Rtc, 1, a.watermark().unwrap(), 0).unwrap();
        (a, b)
    }
    fn deliver(a: &mut Journal, b: &mut Journal) -> (u64, Frame) {
        b.receive(&a.next_record().unwrap().unwrap())
            .unwrap()
            .unwrap()
    }
    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }
    #[test]
    fn independent_cross_language_golden_and_strict_lengths() {
        let vectors: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../fixtures/resume-payload.json")).unwrap();
        for v in vectors {
            let p = Payload {
                epoch: v["epoch"].as_str().unwrap().parse().unwrap(),
                seq: v["seq"].as_str().unwrap().parse().unwrap(),
                frame: Frame {
                    kind: v["kind"].as_u64().unwrap() as u8,
                    stream_id: v["streamId"].as_u64().unwrap() as u32,
                    value: v["value"].as_u64().unwrap() as u32,
                    payload: unhex(v["payload"].as_str().unwrap()),
                },
            };
            let bytes = unhex(v["wire"].as_str().unwrap());
            assert_eq!(p.encode().unwrap(), bytes);
            assert_eq!(Payload::decode(&bytes).unwrap(), p);
            for offset in [0, 1, 2, 3, 21, 22, 23, 32] {
                let mut bad = bytes.clone();
                bad[offset] ^= 128;
                assert_eq!(Payload::decode(&bad), Err(Error::ProtocolViolation));
            }
            for length in 0..bytes.len() {
                assert_eq!(
                    Payload::decode(&bytes[..length]),
                    Err(Error::ProtocolViolation)
                );
            }
        }
    }
    #[test]
    fn control_golden_and_old_epoch_fencing() {
        let vectors: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../fixtures/resume-control.json")).unwrap();
        for v in vectors {
            let epoch = v["epoch"].as_str().unwrap().parse().unwrap();
            let p = if v["kind"] == "ack" {
                Control::Ack {
                    epoch,
                    received: v["received"].as_str().unwrap().parse().unwrap(),
                }
            } else {
                Control::Budget {
                    epoch,
                    data_grant: v["dataGrant"].as_str().unwrap().parse().unwrap(),
                    progress_grant: v["progressGrant"].as_str().unwrap().parse().unwrap(),
                }
            };
            let bytes = unhex(v["wire"].as_str().unwrap());
            assert_eq!(p.encode().unwrap(), bytes);
            assert_eq!(Control::decode(&bytes), Ok(p));
            for length in 0..bytes.len() {
                assert_eq!(
                    Control::decode(&bytes[..length]),
                    Err(Error::ProtocolViolation)
                );
            }
        }
        let (mut a, b) = pair(Policy::RelayAllowed);
        a.enqueue(frame(3)).unwrap();
        a.next_record().unwrap();
        a.suspend(0).unwrap();
        a.activate(Path::Fabric, 2, b.watermark().unwrap(), 1)
            .unwrap();
        a.receive_control(
            &Control::Ack {
                epoch: 1,
                received: u64::MAX,
            }
            .encode()
            .unwrap(),
        )
        .unwrap();
        a.receive_control(
            &Control::Budget {
                epoch: 1,
                data_grant: 999,
                progress_grant: 999,
            }
            .encode()
            .unwrap(),
        )
        .unwrap();
        assert_eq!(a.stats().retained_frames, 1);
        assert_eq!(
            a.receive_control(
                &Control::Ack {
                    epoch: 3,
                    received: 0
                }
                .encode()
                .unwrap()
            ),
            Err(Error::ProtocolViolation)
        );
    }
    #[test]
    fn exact_record_budget_and_u64_exhaustion_never_wrap() {
        let mut p = Payload {
            epoch: 1,
            seq: u64::MAX,
            frame: Frame {
                payload: vec![0; MAX_PAYLOAD],
                ..frame(3)
            },
        };
        assert_eq!(p.encode().unwrap().len() + 28, 16384);
        p.frame.payload.push(0);
        assert_eq!(p.encode(), Err(Error::ProtocolViolation));
        let (mut a, _) = pair(Policy::RelayAllowed);
        a.allocated = u64::MAX;
        assert_eq!(a.enqueue(frame(1)), Err(Error::ProtocolViolation));
        assert_eq!(a.stats().retained_frames, 0);
        a.lanes[0].charged = u64::MAX;
        assert_eq!(
            a.update_grants(u64::MAX, 108),
            Err(Error::ProtocolViolation)
        );
    }
    #[test]
    fn lost_open_ack_keeps_one_receive_lease_across_resume() {
        let (mut a, mut b) = pair(Policy::RelayAllowed);
        a.enqueue(frame(1)).unwrap();
        let wire = a.next_record().unwrap().unwrap();
        let accepted = b.receive(&wire).unwrap().unwrap();
        assert!(b.receive(&wire).unwrap().is_none());
        assert_eq!(a.stats().retained_frames, 1);
        a.suspend(1).unwrap();
        b.suspend(1).unwrap();
        a.activate(Path::Fabric, 2, b.watermark().unwrap(), 30000)
            .unwrap();
        b.activate(Path::Fabric, 2, a.watermark().unwrap(), 30000)
            .unwrap();
        assert!(a.next_record().unwrap().is_none());
        assert!(b.receive(&wire).unwrap().is_none());
        assert_eq!(b.stats().receive_bytes, 39);
        assert_eq!(b.stats().receive_leases, 1);
        b.release(accepted.0).unwrap();
        assert_eq!(b.release(accepted.0), Err(Error::ProtocolViolation));
    }
    #[test]
    fn both_data_directions_full_still_allow_all_progress_kinds() {
        let (mut a, mut b) = pair(Policy::RelayAllowed);
        for _ in 0..2 {
            a.enqueue(frame(3)).unwrap();
            b.enqueue(frame(3)).unwrap();
        }
        assert_eq!(a.enqueue(frame(3)), Err(Error::Backpressure));
        for _ in 0..2 {
            deliver(&mut a, &mut b);
            deliver(&mut b, &mut a);
        }
        a.acknowledge(b.watermark().unwrap().received).unwrap();
        b.acknowledge(a.watermark().unwrap().received).unwrap();
        assert_eq!(a.enqueue(frame(3)), Err(Error::Backpressure)); // ACK is not consumption.
        assert_eq!(a.stats().receive_bytes, 78);
        for kind in 4..=6 {
            a.enqueue(frame(kind)).unwrap();
            b.enqueue(frame(kind)).unwrap();
        }
        for kind in 4..=6 {
            let at_b = deliver(&mut a, &mut b);
            let at_a = deliver(&mut b, &mut a);
            assert_eq!(at_b.1.kind, kind);
            a.release(at_a.0).unwrap();
            b.release(at_b.0).unwrap();
        }
        a.acknowledge(b.watermark().unwrap().received).unwrap();
        let w = b.watermark().unwrap();
        a.update_grants(w.data_grant, w.progress_grant).unwrap();
        assert_eq!(a.enqueue(frame(6)), Ok(6));
        b.release(1).unwrap();
        let w = b.watermark().unwrap();
        a.update_grants(w.data_grant, w.progress_grant).unwrap();
        assert_eq!(a.enqueue(frame(3)), Ok(7));
        assert_eq!(a.stats().log_bytes, 75);
    }
    #[test]
    fn gaps_ack_forgery_and_resume_state_loss_are_atomic() {
        let (mut a, mut b) = pair(Policy::RelayAllowed);
        a.enqueue(frame(3)).unwrap();
        assert_eq!(a.acknowledge(1), Err(Error::ProtocolViolation));
        assert_eq!(a.update_grants(118, 108), Err(Error::ProtocolViolation));
        let wire = a.next_record().unwrap().unwrap();
        let mut gap = Payload::decode(&wire).unwrap();
        gap.seq = 2;
        assert_eq!(
            b.receive(&gap.encode().unwrap()),
            Err(Error::ProtocolViolation)
        );
        assert_eq!(b.watermark().unwrap().received, 0);
        b.receive(&wire).unwrap();
        a.acknowledge(1).unwrap();
        let before = a.stats();
        assert_eq!(
            a.activate(
                Path::Fabric,
                2,
                Watermark {
                    received: 0,
                    data_grant: 78,
                    progress_grant: 108
                },
                1
            ),
            Err(Error::StateLost)
        );
        assert_eq!(a.stats(), before);
        a.acknowledge(0).unwrap();
    }
    #[test]
    fn direct_only_and_recovery_deadline_survive_repeated_attempts() {
        let (mut a, b) = pair(Policy::DirectOnly);
        a.enqueue(frame(3)).unwrap();
        assert_eq!(
            a.activate(Path::Fabric, 2, b.watermark().unwrap(), 1),
            Err(Error::PolicyDenied)
        );
        assert_eq!(a.state(), State::Ready);
        assert_eq!(a.stats().epoch, 1);
        a.suspend(100).unwrap();
        a.suspend(30000).unwrap();
        assert_eq!(
            a.activate(Path::Fabric, 2, b.watermark().unwrap(), 60099),
            Err(Error::PolicyDenied)
        );
        assert_eq!(
            a.activate(Path::Rtc, 2, b.watermark().unwrap(), 60100),
            Err(Error::ResumeExpired)
        );
        assert_eq!(a.stats().log_bytes, 0);
        assert_eq!(a.state(), State::Closed);
        assert_eq!(a.enqueue(frame(3)), Err(Error::ResumeExpired));
        a.close(Error::Closed);
    }
    #[test]
    fn hundred_handoffs_preserve_bytes_under_alternating_frame_and_ack_loss() {
        let (mut a, mut b) = pair(Policy::RelayAllowed);
        let mut output = Vec::new();
        for i in 0..100u64 {
            let mut f = frame(3);
            f.payload[0] = i as u8;
            a.enqueue(f).unwrap();
            let old = a.next_record().unwrap().unwrap();
            if i % 2 == 0 {
                let (seq, f) = b.receive(&old).unwrap().unwrap();
                output.push(f.payload[0]);
                b.release(seq).unwrap();
            }
            a.suspend(i).unwrap();
            b.suspend(i).unwrap();
            let path = if i % 2 == 0 { Path::Fabric } else { Path::Rtc };
            a.activate(path, i + 2, b.watermark().unwrap(), i).unwrap();
            b.activate(path, i + 2, a.watermark().unwrap(), i).unwrap();
            assert!(b.receive(&old).unwrap().is_none());
            if let Some(wire) = a.next_record().unwrap() {
                let (seq, f) = b.receive(&wire).unwrap().unwrap();
                output.push(f.payload[0]);
                b.release(seq).unwrap();
            }
            let w = b.watermark().unwrap();
            a.acknowledge(w.received).unwrap();
            a.update_grants(w.data_grant, w.progress_grant).unwrap();
            assert_eq!(a.stats().log_bytes, 0);
            assert_eq!(b.stats().receive_bytes, 0);
        }
        assert_eq!(output, (0..100u8).collect::<Vec<_>>());
    }
}
