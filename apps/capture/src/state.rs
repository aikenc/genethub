use crate::{
    engine::{AudioStatus, Config, Display, Engine, Probe},
    guard::InputGuard,
    media::Media,
};
use anyhow::{anyhow, bail, Result};
use genehub_proto::{
    RemoteDesktopInput, RemoteDesktopInputEvent, RemoteDesktopLease, RemoteDesktopSession,
    RemoteDesktopTarget,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, Mutex as AsyncMutex};

pub struct App {
    pub engine: Arc<Engine>,
    pub config: Config,
    pub display: Display,
    initial_probe: Probe,
    pub shared: AtomicBool,
    pub allow_control: AtomicBool,
    pub policy_epoch: Arc<AtomicU64>,
    pub stopping: AtomicBool,
    pub instance_id: String,
    pub run_id: String,
    pub view: AsyncMutex<Option<Arc<View>>>,
    release_unconfirmed: AtomicBool,
    epoch: AtomicU32,
    closed_sessions: Mutex<VecDeque<(String, String, Arc<AtomicU8>)>>,
}
pub struct Control {
    pub owner: String,
    pub lease: RemoteDesktopLease,
    pub guard: InputGuard,
    sequences: Mutex<(u32, u32)>,
    rate: Mutex<(Instant, u32)>,
}
/// Facts about the source, never inferred from encoder activity alone. The
/// engine marks a frame `repeat` when it is the held picture encoded again,
/// so a stalled/never-started capture cannot look alive through floor frames.
#[derive(Default)]
pub struct Health {
    real_frames: AtomicU64,
    repeat_frames: AtomicU64,
    last_real: Mutex<Option<Instant>>,
    video: Mutex<Option<VideoFormat>>,
    audio: Mutex<Option<AudioFact>>,
}
#[derive(Clone)]
pub struct VideoFormat {
    pub profile_idc: u8,
    pub level_idc: u8,
    pub advertised_level: u8,
    pub size: Option<(u32, u32)>,
}
impl VideoFormat {
    pub fn within_advertised(&self) -> bool {
        self.level_idc <= self.advertised_level
    }
}
#[derive(Clone)]
pub enum AudioFact {
    Flowing,
    Unavailable(String),
}
impl Health {
    pub fn note_video(&self, repeat: bool) {
        if repeat {
            self.repeat_frames.fetch_add(1, Ordering::Relaxed);
        } else {
            self.real_frames.fetch_add(1, Ordering::Relaxed);
            *self.last_real.lock().unwrap() = Some(Instant::now());
        }
    }
    /// A real capture reached the encoder at least once. Until then the picture
    /// cannot be shown to be the desktop, so control stays unavailable.
    pub fn captured(&self) -> bool {
        self.real_frames.load(Ordering::Relaxed) > 0
    }
    pub fn set_video(&self, format: VideoFormat) {
        *self.video.lock().unwrap() = Some(format);
    }
    pub fn video_checked(&self) -> bool {
        self.video.lock().unwrap().is_some()
    }
    pub fn set_audio(&self, status: AudioStatus) {
        *self.audio.lock().unwrap() = Some(match status {
            AudioStatus::Flowing => AudioFact::Flowing,
            AudioStatus::Unavailable(reason) => AudioFact::Unavailable(reason),
        });
    }
    pub fn json(&self) -> Value {
        let idle_ms = self
            .last_real
            .lock()
            .unwrap()
            .map(|at| at.elapsed().as_millis() as u64);
        let state = match idle_ms {
            None => "starting",
            Some(ms) if ms < 2000 => "live",
            Some(_) => "idle",
        };
        let video = self.video.lock().unwrap().as_ref().map(|f| {
            json!({"profileIdc":f.profile_idc,"levelIdc":f.level_idc,"advertisedLevelIdc":f.advertised_level,"levelWithinAdvertised":f.within_advertised(),
                "width":f.size.map(|s|s.0),"height":f.size.map(|s|s.1)})
        });
        let audio = match self.audio.lock().unwrap().as_ref() {
            None => json!({"state":"unknown"}),
            Some(AudioFact::Flowing) => json!({"state":"available"}),
            Some(AudioFact::Unavailable(reason)) => json!({"state":"unavailable","reason":reason}),
        };
        json!({"state":state,"realFrames":self.real_frames.load(Ordering::Relaxed),
            "repeatFrames":self.repeat_frames.load(Ordering::Relaxed),"sinceRealMs":idle_ms,
            "video":video,"audio":audio})
    }
}
pub struct View {
    pub app: std::sync::Weak<App>,
    pub id: String,
    pub token: String,
    pub target: RemoteDesktopTarget,
    pub closing: AtomicBool,
    close_state: Arc<AtomicU8>,
    pub events: broadcast::Sender<Value>,
    pub deadline: Mutex<Instant>,
    pub media: AsyncMutex<Option<Arc<Media>>>,
    pub control: AsyncMutex<Option<Arc<Control>>>,
    pub presented: AtomicU64,
    last_presented: Mutex<Instant>,
    pub last_native: Mutex<Instant>,
    pub health: Health,
    close_done: tokio::sync::watch::Sender<bool>,
}
impl App {
    pub fn new(
        engine: Arc<Engine>,
        config: Config,
        display: Display,
        initial_probe: Probe,
        shared: bool,
        allow_control: bool,
        run_id: String,
    ) -> Arc<Self> {
        Arc::new(Self {
            engine,
            config,
            display,
            initial_probe,
            shared: AtomicBool::new(shared),
            allow_control: AtomicBool::new(allow_control),
            policy_epoch: Arc::new(AtomicU64::new(0)),
            stopping: AtomicBool::new(false),
            instance_id: uuid::Uuid::new_v4().simple().to_string(),
            run_id,
            view: AsyncMutex::new(None),
            release_unconfirmed: AtomicBool::new(false),
            epoch: AtomicU32::new(0),
            closed_sessions: Mutex::new(VecDeque::new()),
        })
    }
    pub async fn open(self: &Arc<Self>) -> Result<Arc<View>> {
        if !self.shared.load(Ordering::SeqCst) {
            bail!("not_shared");
        }
        if !self.initial_probe.available {
            bail!("encoder_unavailable");
        }
        self.engine.preflight(
            &self.display.key,
            self.display.width,
            self.display.height,
            false,
        )?;
        let mut current = self.view.lock().await;
        if !self.shared.load(Ordering::SeqCst) {
            bail!("not_shared");
        }
        // A closing viewer still owns its guard/resources. A second View has
        // a different control mutex and must not bypass that arbitration.
        if current.is_some() {
            bail!("busy");
        }
        let (events, _) = broadcast::channel(32);
        let now = Instant::now();
        let view = Arc::new(View {
            app: Arc::downgrade(self),
            id: uuid::Uuid::new_v4().simple().to_string(),
            token: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            target: RemoteDesktopTarget {
                id: format!("display:{}", self.display.id),
                name: self.display.name.clone(),
                generation: 1,
                width: self.display.width,
                height: self.display.height,
            },
            closing: AtomicBool::new(false),
            close_state: Arc::new(AtomicU8::new(0)),
            events,
            deadline: Mutex::new(now + Duration::from_secs(3)),
            media: AsyncMutex::new(None),
            control: AsyncMutex::new(None),
            presented: AtomicU64::new(0),
            last_presented: Mutex::new(now),
            last_native: Mutex::new(now),
            health: Health::default(),
            close_done: tokio::sync::watch::channel(false).0,
        });
        *current = Some(view.clone());
        let weak = Arc::downgrade(&view);
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_millis(100));
            loop {
                timer.tick().await;
                let Some(view) = weak.upgrade() else { break };
                if view.closing.load(Ordering::SeqCst) {
                    break;
                }
                if Instant::now() >= *view.deadline.lock().unwrap() {
                    eprintln!(
                        "Capture view watchdog expired; presented_frames={}",
                        view.presented.load(Ordering::Relaxed)
                    );
                    view.close("session_expired").await;
                    break;
                }
                let control = view.control.lock().await.clone();
                if let Some(control) = control {
                    if !control.guard.authority.live() || !view.frame_live() {
                        let _ = view.release_control(Some(&control.owner)).await;
                    }
                }
            }
        });
        Ok(view)
    }
    pub async fn session(&self, id: &str, token: &str) -> Result<Arc<View>> {
        let view = self
            .view
            .lock()
            .await
            .clone()
            .ok_or_else(|| anyhow!("session_expired"))?;
        if view.id != id
            || view.token != token
            || view.closing.load(Ordering::SeqCst)
            || Instant::now() >= *view.deadline.lock().unwrap()
        {
            bail!("session_expired");
        }
        Ok(view)
    }
    pub async fn status(&self) -> Value {
        let available = self.initial_probe.available
            && self
                .engine
                .preflight(
                    &self.display.key,
                    self.display.width,
                    self.display.height,
                    false,
                )
                .is_ok();
        let input_permission = self.initial_probe.input_permission
            && self
                .engine
                .preflight(
                    &self.display.key,
                    self.display.width,
                    self.display.height,
                    true,
                )
                .is_ok();
        let view = self.view.lock().await.clone();
        json!({"protocol":"remote-desktop/1","appInstanceId":self.instance_id,"runId":self.run_id,
            "shared":self.shared.load(Ordering::SeqCst),"allowControl":self.allow_control.load(Ordering::SeqCst),"releaseUnconfirmed":self.release_unconfirmed.load(Ordering::SeqCst),"available":available,
            "inputPermission":input_permission,"target":{"id":format!("display:{}",self.display.id),"name":self.display.name,"generation":1,"width":self.display.width,"height":self.display.height},
            "viewing":view.as_ref().is_some_and(|v|!v.closing.load(Ordering::SeqCst)),
            "source":view.as_ref().filter(|v|!v.closing.load(Ordering::SeqCst)).map(|v|v.health.json())})
    }
    pub async fn stop(&self, id: &str, token: &str) -> Result<&'static str> {
        if let Some(state) = self
            .closed_sessions
            .lock()
            .unwrap()
            .iter()
            .find(|(i, t, _)| i == id && t == token)
            .map(|(_, _, state)| state.load(Ordering::SeqCst))
        {
            return Ok(close_state(state));
        }
        let view = self.session(id, token).await?;
        view.close("client_stop").await;
        Ok(close_state(view.close_state.load(Ordering::SeqCst)))
    }
    /// Only the local management UI calls this. No remotely callable policy API.
    pub fn policy(self: &Arc<Self>, desired: Option<i32>) -> i32 {
        let available = self.initial_probe.available
            && self
                .engine
                .preflight(
                    &self.display.key,
                    self.display.width,
                    self.display.height,
                    false,
                )
                .is_ok();
        let input_permission = self.initial_probe.input_permission
            && self
                .engine
                .preflight(
                    &self.display.key,
                    self.display.width,
                    self.display.height,
                    true,
                )
                .is_ok();
        if let Some(desired) = desired {
            let shared = desired & 1 != 0 && available;
            let control = shared
                && desired & 2 != 0
                && input_permission
                && !self.release_unconfirmed.load(Ordering::SeqCst);
            let old_shared = self.shared.swap(shared, Ordering::SeqCst);
            let old_control = self.allow_control.swap(control, Ordering::SeqCst);
            if old_shared != shared || old_control != control {
                // A rapid off/on cannot resurrect an already-issued input lease.
                self.policy_epoch.fetch_add(1, Ordering::SeqCst);
                let app = self.clone();
                tokio::spawn(async move {
                    let view = app.view.lock().await.clone();
                    if let Some(view) = view {
                        if !shared {
                            view.close("source_stopped_sharing").await;
                        } else if old_control {
                            let _ = view.release_control(None).await;
                        }
                    }
                });
            }
        }
        let mut flags = i32::from(self.shared.load(Ordering::SeqCst))
            | (i32::from(self.allow_control.load(Ordering::SeqCst)) << 1)
            | (i32::from(self.release_unconfirmed.load(Ordering::SeqCst)) << 4)
            | (i32::from(available) << 5)
            | (i32::from(input_permission) << 6)
            | (i32::from(self.stopping.load(Ordering::SeqCst)) << 7);
        if let Ok(current) = self.view.try_lock() {
            if current
                .as_ref()
                .is_some_and(|view| view.closing.load(Ordering::SeqCst))
            {
                flags |= 256;
            }
            if let Some(view) = current
                .as_ref()
                .filter(|v| !v.closing.load(Ordering::SeqCst))
            {
                flags |= 4;
                if let Ok(control) = view.control.try_lock() {
                    if control.as_ref().is_some_and(|c| c.guard.authority.live()) {
                        flags |= 8;
                    }
                }
            }
        }
        flags
    }
}
impl View {
    pub fn media_allowed(&self) -> bool {
        !self.closing.load(Ordering::SeqCst)
            && self.app.upgrade().is_some_and(|app| {
                app.shared.load(Ordering::SeqCst) && !app.stopping.load(Ordering::SeqCst)
            })
    }
    pub fn description(&self) -> RemoteDesktopSession {
        RemoteDesktopSession {
            session_id: self.id.clone(),
            session_token: self.token.clone(),
            target: self.target.clone(),
            ttl_ms: 3000,
            protocol: "remote-desktop/1".into(),
        }
    }
    pub fn renew(&self) -> Result<()> {
        let mut deadline = self.deadline.lock().unwrap();
        if self.closing.load(Ordering::SeqCst) || Instant::now() >= *deadline {
            bail!("session_expired");
        }
        *deadline = Instant::now() + Duration::from_secs(3);
        Ok(())
    }
    pub fn feedback(&self, presented: u64) {
        let previous = self.presented.fetch_max(presented, Ordering::Relaxed);
        if presented > previous {
            *self.last_presented.lock().unwrap() = Instant::now();
        }
    }
    fn frame_live(&self) -> bool {
        self.presented.load(Ordering::Relaxed) > 0
            && self.health.captured()
            && self.last_presented.lock().unwrap().elapsed() < Duration::from_secs(3)
            && self.last_native.lock().unwrap().elapsed() < Duration::from_secs(3)
    }
    pub async fn acquire(
        self: &Arc<Self>,
        owner: &str,
        valid_until: Instant,
    ) -> Result<RemoteDesktopLease> {
        let app = self.app.upgrade().ok_or_else(|| anyhow!("app_ended"))?;
        let issued_epoch = app.policy_epoch.load(Ordering::SeqCst);
        if Instant::now() >= valid_until {
            bail!("lease_expired");
        }
        if app.release_unconfirmed.load(Ordering::SeqCst) {
            bail!("release_unconfirmed");
        }
        app.engine.preflight(
            &app.display.key,
            self.target.width,
            self.target.height,
            true,
        )?;
        if !app.shared.load(Ordering::SeqCst)
            || !app.allow_control.load(Ordering::SeqCst)
            || !app.initial_probe.input_permission
        {
            bail!("permission_required");
        }
        if self.closing.load(Ordering::SeqCst) || !self.frame_live() {
            bail!("media_not_presenting");
        }
        if !self
            .media
            .lock()
            .await
            .as_ref()
            .is_some_and(|m| m.connected())
        {
            bail!("media_not_connected");
        }
        let mut current = self.control.lock().await;
        if self.closing.load(Ordering::SeqCst)
            || !self.frame_live()
            || !app.shared.load(Ordering::SeqCst)
            || !app.allow_control.load(Ordering::SeqCst)
            || issued_epoch != app.policy_epoch.load(Ordering::SeqCst)
            || Instant::now() >= valid_until
        {
            bail!("lease_expired");
        }
        if let Some(control) = current.as_ref() {
            if control.owner == owner && control.guard.authority.live() {
                return Ok(control.lease.clone());
            }
            bail!("busy");
        }
        let guard = InputGuard::start(
            &app.engine.path,
            app.config,
            &app.display,
            app.policy_epoch.clone(),
            issued_epoch,
            valid_until,
        )
        .await?;
        if self.closing.load(Ordering::SeqCst)
            || !self.frame_live()
            || !guard.authority.live()
            || !app.shared.load(Ordering::SeqCst)
            || !app.allow_control.load(Ordering::SeqCst)
            || Instant::now() >= *self.deadline.lock().unwrap()
        {
            let _ = guard.stop().await;
            bail!("session_expired");
        }
        let lease = RemoteDesktopLease {
            state: "granted".into(),
            lease_id: uuid::Uuid::new_v4().simple().to_string(),
            epoch: app.epoch.fetch_add(1, Ordering::SeqCst) + 1,
            target_generation: self.target.generation,
        };
        *current = Some(Arc::new(Control {
            owner: owner.into(),
            lease: lease.clone(),
            guard,
            sequences: Mutex::new((0, 0)),
            rate: Mutex::new((Instant::now(), 0)),
        }));
        let _ = self
            .events
            .send(json!({"event":"control.state","params":lease}));
        Ok(lease)
    }
    pub async fn renew_control(&self, owner: &str) -> Result<()> {
        let current = self.control.lock().await;
        let control = current
            .as_ref()
            .filter(|c| c.owner == owner)
            .ok_or_else(|| anyhow!("lease_expired"))?;
        if !control.guard.authority.live() {
            bail!("lease_expired");
        }
        control.guard.authority.renew();
        Ok(())
    }
    pub async fn release_control(&self, owner: Option<&str>) -> Result<()> {
        let mut current = self.control.lock().await;
        if current
            .as_ref()
            .is_some_and(|c| owner.is_some_and(|o| o != c.owner))
        {
            bail!("control_owner_mismatch");
        }
        if let Some(control) = current.as_ref() {
            control.guard.authority.valid.store(false, Ordering::SeqCst);
            let result = control.guard.stop().await;
            if result.is_err() {
                if let Some(app) = self.app.upgrade() {
                    app.release_unconfirmed.store(true, Ordering::SeqCst);
                }
            } else {
                // Keep arbitration locked until the old guard has exited.
                *current = None;
            }
            let _=self.events.send(json!({"event":"control.state","params":{"state":if result.is_ok(){"released"}else{"release-unconfirmed"}}}));
            result
        } else {
            Ok(())
        }
    }
    pub async fn input(&self, data: &[u8], motion: bool) -> Result<()> {
        let app = self.app.upgrade().ok_or_else(|| anyhow!("app_ended"))?;
        if !app.shared.load(Ordering::SeqCst) || !app.allow_control.load(Ordering::SeqCst) {
            bail!("input_unavailable");
        }
        if self.closing.load(Ordering::SeqCst) || data.len() > 16384 || !self.frame_live() {
            bail!("input_unavailable");
        }
        let packet: RemoteDesktopInput = serde_json::from_slice(data)?;
        let current = self
            .control
            .lock()
            .await
            .clone()
            .ok_or_else(|| anyhow!("lease_expired"))?;
        if packet.session_id != self.id
            || packet.epoch != current.lease.epoch
            || packet.target_generation != self.target.generation
        {
            return Ok(()); // Delayed input from a prior lease cannot stop a new one.
        }
        let is_motion = matches!(
            packet.event,
            RemoteDesktopInputEvent::Absolute { .. } | RemoteDesktopInputEvent::Relative { .. }
        );
        if is_motion != motion {
            bail!("wrong_input_channel");
        }
        {
            let mut seq = current.sequences.lock().unwrap();
            let last = if motion { &mut seq.1 } else { &mut seq.0 };
            if packet.seq == 0 || packet.seq <= *last {
                return Ok(());
            }
            *last = packet.seq;
        }
        {
            let mut rate = current.rate.lock().unwrap();
            if rate.0.elapsed() >= Duration::from_secs(1) {
                *rate = (Instant::now(), 0);
            }
            rate.1 += 1;
            if rate.1 > 1000 {
                current.guard.authority.valid.store(false, Ordering::SeqCst);
                bail!("input_rate_exceeded");
            }
        }
        current.guard.input(packet.event)
    }
    pub async fn close(self: &Arc<Self>, reason: &str) {
        if self.closing.swap(true, Ordering::SeqCst) {
            // Another close owns the release. A caller that must not return
            // before the OS release is confirmed (app shutdown) waits for it,
            // bounded by the input guard's own stop timeout.
            let mut done = self.close_done.subscribe();
            let _ = tokio::time::timeout(Duration::from_secs(8), done.wait_for(|d| *d)).await;
            return;
        }
        eprintln!("Capture viewer closing: {reason}");
        if let Some(app) = self.app.upgrade() {
            let mut closed = app.closed_sessions.lock().unwrap();
            closed.push_back((
                self.id.clone(),
                self.token.clone(),
                self.close_state.clone(),
            ));
            while closed.len() > 8 {
                closed.pop_front();
            }
        }
        let _ = self
            .events
            .send(json!({"event":"session.closed","params":{"reason":reason}}));
        let stop_media = async {
            if let Some(media) = self.media.lock().await.take() {
                media.close().await;
            }
        };
        // Do not delay either track's stop behind input-guard exit. Its OS
        // release confirmation still controls whether a new lease is possible.
        let _ = tokio::join!(self.release_control(None), stop_media);
        if let Some(app) = self.app.upgrade() {
            self.close_state.store(
                if app.release_unconfirmed.load(Ordering::SeqCst) {
                    2
                } else {
                    1
                },
                Ordering::SeqCst,
            );
            let mut current = app.view.lock().await;
            if current.as_ref().is_some_and(|v| v.id == self.id) {
                *current = None;
            }
        }
        self.close_done.send_replace(true);
    }
}
fn close_state(state: u8) -> &'static str {
    match state {
        1 => "released",
        2 => "release-unconfirmed",
        _ => "release-pending",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_pictures_never_count_as_a_capture() {
        let health = Health::default();
        for _ in 0..50 {
            health.note_video(true);
        }
        assert!(!health.captured(), "floor re-encodes must not prove a live source");
        let value = health.json();
        assert_eq!(value["state"], "starting");
        assert_eq!(value["repeatFrames"], 50);
        assert_eq!(value["realFrames"], 0);
        health.note_video(false);
        assert!(health.captured());
        assert_eq!(health.json()["state"], "live");
    }

    #[test]
    fn audio_and_video_facts_are_reported_not_assumed() {
        let health = Health::default();
        assert_eq!(health.json()["audio"]["state"], "unknown");
        health.set_audio(AudioStatus::Unavailable("no default playback device".into()));
        assert_eq!(health.json()["audio"]["state"], "unavailable");
        assert_eq!(health.json()["audio"]["reason"], "no default playback device");
        health.set_audio(AudioStatus::Flowing);
        assert_eq!(health.json()["audio"]["state"], "available");
        health.set_video(VideoFormat {
            profile_idc: 66,
            level_idc: 41,
            advertised_level: 40,
            size: Some((1920, 1080)),
        });
        let video = &health.json()["video"];
        assert_eq!(video["levelWithinAdvertised"], false);
        assert_eq!(video["width"], 1920);
    }
}
