//! Separate input process: EOF or an unanswered guard-generated challenge
//! releases held keys/buttons even when the media/service process freezes.
use crate::engine::{Config, Display, Engine, NativeSession};
use anyhow::{anyhow, bail, Context, Result};
use genehub_proto::RemoteDesktopInputEvent;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    io::{BufRead, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::mpsc,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum GuardCommand {
    Renew { nonce: String },
    Input { event: RemoteDesktopInputEvent },
    Stop,
}
pub struct Authority {
    pub valid: AtomicBool,
    deadline: Mutex<Instant>,
    policy_epoch: Arc<AtomicU64>,
    issued_epoch: u64,
}
impl Authority {
    pub fn new(policy_epoch: Arc<AtomicU64>, issued_epoch: u64, valid_until: Instant) -> Arc<Self> {
        Arc::new(Self {
            valid: AtomicBool::new(true),
            deadline: Mutex::new(valid_until),
            issued_epoch,
            policy_epoch,
        })
    }
    pub fn renew(&self) {
        let mut deadline = self.deadline.lock().unwrap();
        if self.valid.load(Ordering::SeqCst) && Instant::now() < *deadline {
            *deadline = Instant::now() + Duration::from_secs(3);
        } else {
            self.valid.store(false, Ordering::SeqCst);
        }
    }
    pub fn live(&self) -> bool {
        self.valid.load(Ordering::SeqCst)
            && self.issued_epoch == self.policy_epoch.load(Ordering::SeqCst)
            && Instant::now() < *self.deadline.lock().unwrap()
    }
}
pub struct InputGuard {
    sender: mpsc::Sender<GuardCommand>,
    pub authority: Arc<Authority>,
    child: tokio::sync::Mutex<Option<Child>>,
    release_result: AtomicU8,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl InputGuard {
    pub async fn start(
        engine: &Path,
        config: Config,
        display: &Display,
        policy_epoch: Arc<AtomicU64>,
        issued_epoch: u64,
        valid_until: Instant,
    ) -> Result<Self> {
        let started_at = Instant::now();
        // Fence revocation during the asynchronous child startup, too.
        let authority = Authority::new(policy_epoch, issued_epoch, valid_until);
        if !authority.live() {
            bail!("lease_expired");
        }
        let mut child = Command::new(std::env::current_exe()?)
            .arg("--input-guard")
            .arg("--engine")
            .arg(engine)
            .arg("--display")
            .arg(config.display_id.to_string())
            .arg("--display-key")
            .arg(&display.key)
            .arg("--width")
            .arg(display.width.to_string())
            .arg("--height")
            .arg(display.height.to_string())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .context("starting independent input guard")?;
        let mut input = child.stdin.take().context("guard stdin")?;
        let mut output = BufReader::new(child.stdout.take().context("guard stdout")?).lines();
        let ready = tokio::time::timeout(Duration::from_secs(10), output.next_line()).await;
        let is_ready = matches!(&ready,Ok(Ok(Some(line))) if serde_json::from_str::<Value>(line).is_ok_and(|v|v["ready"]==true));
        if !is_ready {
            let _ = child.kill().await;
            bail!("input guard unavailable or OS input permission missing");
        }
        if !authority.live() {
            let _ = child.kill().await;
            bail!("source_policy_changed");
        }
        eprintln!(
            "Capture input guard ready in {} ms",
            started_at.elapsed().as_millis()
        );
        let (sender, mut receiver) = mpsc::channel::<GuardCommand>(128);
        let writer = tokio::spawn(async move {
            while let Some(command) = receiver.recv().await {
                let stop = matches!(command, GuardCommand::Stop);
                let Ok(mut line) = serde_json::to_vec(&command) else {
                    break;
                };
                line.push(b'\n');
                if input.write_all(&line).await.is_err() || stop {
                    break;
                }
            }
            let _ = input.shutdown().await;
        });
        let tx = sender.clone();
        let auth = authority.clone();
        let reader = tokio::spawn(async move {
            while let Ok(Some(line)) = output.next_line().await {
                if line.len() > 4096 {
                    break;
                }
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    break;
                };
                if let Some(nonce) = message["challenge"].as_str() {
                    if !auth.live() || nonce.len() != 32 {
                        let _ = tx.try_send(GuardCommand::Stop);
                        break;
                    }
                    if tx
                        .try_send(GuardCommand::Renew {
                            nonce: nonce.into(),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }
            auth.valid.store(false, Ordering::SeqCst);
            let _ = tx.try_send(GuardCommand::Stop);
        });
        Ok(Self {
            sender,
            authority,
            child: tokio::sync::Mutex::new(Some(child)),
            release_result: AtomicU8::new(0),
            tasks: vec![writer, reader],
        })
    }
    pub fn input(&self, event: RemoteDesktopInputEvent) -> Result<()> {
        if !self.authority.live() {
            bail!("lease_expired");
        }
        self.sender
            .try_send(GuardCommand::Input { event })
            .map_err(|_| {
                self.authority.valid.store(false, Ordering::SeqCst);
                anyhow!("input queue full or guard ended")
            })
    }
    pub async fn stop(&self) -> Result<()> {
        self.authority.valid.store(false, Ordering::SeqCst);
        let _ = self.sender.try_send(GuardCommand::Stop);
        let mut child_slot = self.child.lock().await;
        if let Some(mut child) = child_slot.take() {
            match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
                Ok(Ok(status)) if status.success() => {
                    self.release_result.store(1, Ordering::SeqCst);
                }
                _ => {
                    self.release_result.store(2, Ordering::SeqCst);
                    let _ = child.kill().await;
                    return Err(anyhow!("input guard release not confirmed"));
                }
            }
        }
        if self.release_result.load(Ordering::SeqCst) != 1 {
            bail!("input guard release not confirmed");
        }
        for task in &self.tasks {
            task.abort();
        }
        Ok(())
    }
}
impl Drop for InputGuard {
    fn drop(&mut self) {
        self.authority.valid.store(false, Ordering::SeqCst);
        let _ = self.sender.try_send(GuardCommand::Stop);
    }
}

struct Held {
    keys: BTreeSet<i32>,
    buttons: BTreeSet<i32>,
    session: Arc<NativeSession>,
    relative: (f64, f64),
}
impl Held {
    fn release(&mut self) -> Result<()> {
        let mut error = None;
        for key in std::mem::take(&mut self.keys) {
            if let Err(e) = self.session.input(2, key, 0, "") {
                error = Some(e);
            }
        }
        for button in std::mem::take(&mut self.buttons) {
            if let Err(e) = self.session.input(7, button, 0, "") {
                error = Some(e);
            }
        }
        error.map_or(Ok(()), Err)
    }
    fn apply(&mut self, event: RemoteDesktopInputEvent) -> Result<()> {
        use RemoteDesktopInputEvent::*;
        match event {
            Key { code, down } => {
                let key = key_code(&code).context("unsupported physical key")?;
                if down {
                    if self.keys.insert(key) {
                        self.session.input(1, key, 0, "")?;
                    }
                } else if self.keys.remove(&key) {
                    self.session.input(2, key, 0, "")?;
                }
            }
            Text { text } => {
                if text.len() > 16384 || text.contains('\0') {
                    bail!("invalid text");
                }
                self.release()?;
                self.session.input(3, 0, 0, &text)?;
            }
            Absolute { x, y } => {
                let (x, y) = point(x, y)?;
                self.session.input(4, x, y, "")?;
            }
            Relative { dx_total, dy_total } => {
                if !dx_total.is_finite()
                    || !dy_total.is_finite()
                    || dx_total.abs() > 2_000_000_000.0
                    || dy_total.abs() > 2_000_000_000.0
                {
                    bail!("invalid relative motion");
                }
                let dx = (dx_total - self.relative.0).round();
                let dy = (dy_total - self.relative.1).round();
                if dx.abs() > 32767.0 || dy.abs() > 32767.0 {
                    bail!("relative discontinuity");
                }
                self.relative = (dx_total, dy_total);
                self.session.input(5, dx as i32, dy as i32, "")?;
            }
            Button { button, down, x, y } => {
                if button > 4 {
                    bail!("invalid button");
                }
                if let (Some(x), Some(y)) = (x, y) {
                    let (x, y) = point(x, y)?;
                    self.session.input(4, x, y, "")?;
                }
                let button = i32::from(button) + 1;
                if down {
                    if self.buttons.insert(button) {
                        self.session.input(6, button, 0, "")?;
                    }
                } else if self.buttons.remove(&button) {
                    self.session.input(7, button, 0, "")?;
                }
            }
            Wheel { dx, dy } => {
                if !dx.is_finite() || !dy.is_finite() || dx.abs() > 1200.0 || dy.abs() > 1200.0 {
                    bail!("invalid wheel");
                }
                self.session.input(8, -dy.round() as i32, 0, "")?;
                self.session.input(9, -dx.round() as i32, 0, "")?;
            }
            State { keys, buttons } => {
                if keys.len() > 64 || buttons.len() > 5 || buttons.iter().any(|b| *b > 4) {
                    bail!("invalid held state");
                }
                let wanted_keys = keys
                    .iter()
                    .map(|code| key_code(code).context("unsupported key in held state"))
                    .collect::<Result<BTreeSet<_>>>()?;
                let wanted_buttons = buttons
                    .into_iter()
                    .map(|b| i32::from(b) + 1)
                    .collect::<BTreeSet<_>>();
                for key in self.keys.difference(&wanted_keys) {
                    self.session.input(2, *key, 0, "")?;
                }
                for key in wanted_keys.difference(&self.keys) {
                    self.session.input(1, *key, 0, "")?;
                }
                for button in self.buttons.difference(&wanted_buttons) {
                    self.session.input(7, *button, 0, "")?;
                }
                for button in wanted_buttons.difference(&self.buttons) {
                    self.session.input(6, *button, 0, "")?;
                }
                self.keys = wanted_keys;
                self.buttons = wanted_buttons;
            }
            Reset => self.release()?,
        }
        Ok(())
    }
}
fn point(x: f64, y: f64) -> Result<(i32, i32)> {
    if !x.is_finite() || !y.is_finite() || !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
        bail!("point outside image");
    }
    Ok(((x * 32767.0).round() as i32, (y * 32767.0).round() as i32))
}
fn key_code(code: &str) -> Option<i32> {
    if code.len() == 4 && code.starts_with("Key") {
        let c = code.as_bytes()[3];
        if c.is_ascii_uppercase() {
            return Some(c.into());
        }
    }
    if code.len() == 6 && code.starts_with("Digit") {
        let c = code.as_bytes()[5];
        if c.is_ascii_digit() {
            return Some(c.into());
        }
    }
    if let Some(f) = code.strip_prefix('F').and_then(|s| s.parse::<i32>().ok()) {
        if (1..=24).contains(&f) {
            return Some(111 + f);
        }
    }
    Some(match code {
        "Backspace" => 8,
        "Tab" => 9,
        "Enter" => 13,
        "ShiftLeft" => 160,
        "ShiftRight" => 161,
        "ControlLeft" => 162,
        "ControlRight" => 163,
        "AltLeft" => 164,
        "AltRight" => 165,
        "Pause" => 19,
        "CapsLock" => 20,
        "Escape" => 27,
        "Space" => 32,
        "PageUp" => 33,
        "PageDown" => 34,
        "End" => 35,
        "Home" => 36,
        "ArrowLeft" => 37,
        "ArrowUp" => 38,
        "ArrowRight" => 39,
        "ArrowDown" => 40,
        "Insert" => 45,
        "Delete" => 46,
        "MetaLeft" => 91,
        "MetaRight" => 92,
        "Numpad0" => 96,
        "Numpad1" => 97,
        "Numpad2" => 98,
        "Numpad3" => 99,
        "Numpad4" => 100,
        "Numpad5" => 101,
        "Numpad6" => 102,
        "Numpad7" => 103,
        "Numpad8" => 104,
        "Numpad9" => 105,
        "NumpadMultiply" => 106,
        "NumpadAdd" => 107,
        "NumpadSubtract" => 109,
        "NumpadDecimal" => 110,
        "NumpadDivide" => 111,
        "NumpadEnter" => 13,
        "NumLock" => 144,
        "ScrollLock" => 145,
        "Semicolon" => 186,
        "Equal" => 187,
        "Comma" => 188,
        "Minus" => 189,
        "Period" => 190,
        "Slash" => 191,
        "Backquote" => 192,
        "BracketLeft" => 219,
        "Backslash" => 220,
        "BracketRight" => 221,
        "Quote" => 222,
        _ => return None,
    })
}

pub fn run(
    engine_path: &Path,
    display: i32,
    display_key: &str,
    width: i32,
    height: i32,
) -> Result<()> {
    // Survives a parent crash/restart: a new App cannot inject until this
    // guard has released its held state and stopped its native input session.
    let _input_lock =
        crate::user_lock("input.lock").context("previous input guard still running")?;
    let engine = Engine::open(engine_path)?;
    if width <= 0 || height <= 0 {
        bail!("invalid input target dimensions");
    }
    engine.preflight(display_key, width as u32, height as u32, true)?;
    let started = engine.start(
        Config {
            display_id: display,
            width: 0,
            height: 0,
            fps: 30,
            bitrate_kbps: 6000,
            input_only: 1,
            source_width: width,
            source_height: height,
        },
        display_key,
    )?;
    let mut held = Held {
        keys: BTreeSet::new(),
        buttons: BTreeSet::new(),
        session: started.session,
        relative: (0.0, 0.0),
    };
    let (sender, receiver) = std::sync::mpsc::sync_channel(128);
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        loop {
            let mut bytes = Vec::new();
            let Ok(size) = std::io::Read::take(&mut input, 65537).read_until(b'\n', &mut bytes)
            else {
                break;
            };
            if size == 0 || bytes.len() > 65536 {
                break;
            }
            let Ok(command) = serde_json::from_slice::<GuardCommand>(&bytes) else {
                break;
            };
            if sender.try_send(command).is_err() {
                break;
            }
        }
    });
    let mut output = std::io::stdout().lock();
    writeln!(output, "{}", json!({"ready":true}))?;
    output.flush()?;
    let mut challenge = uuid::Uuid::new_v4().simple().to_string();
    let mut deadline = Instant::now() + Duration::from_secs(3);
    let mut last_send = Instant::now() - Duration::from_secs(2);
    let mut consumed = false;
    let mut input_progress = Instant::now();
    let mut last_target_check = Instant::now() - Duration::from_secs(1);
    let result: Result<()> = loop {
        let now = Instant::now();
        if now >= deadline {
            break Ok(());
        }
        if now.duration_since(last_target_check) >= Duration::from_millis(50) {
            if !held.session.target_live() {
                break Err(anyhow!("target_changed"));
            }
            last_target_check = now;
        }
        if (!held.keys.is_empty() || !held.buttons.is_empty())
            && input_progress.elapsed() > Duration::from_secs(1)
        {
            break Ok(());
        }
        if now.duration_since(last_send) >= Duration::from_secs(1) {
            if consumed {
                challenge = uuid::Uuid::new_v4().simple().to_string();
                consumed = false;
            }
            if writeln!(output, "{}", json!({"challenge":challenge}))
                .and_then(|_| output.flush())
                .is_err()
            {
                break Ok(());
            }
            last_send = now;
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(GuardCommand::Renew { nonce }) if !consumed && nonce == challenge => {
                consumed = true;
                deadline = Instant::now() + Duration::from_secs(3);
            }
            Ok(GuardCommand::Input { event }) => {
                if matches!(
                    &event,
                    RemoteDesktopInputEvent::State { .. }
                        | RemoteDesktopInputEvent::Key { .. }
                        | RemoteDesktopInputEvent::Button { .. }
                ) {
                    input_progress = Instant::now();
                }
                if let Err(error) = held.apply(event) {
                    break Err(error);
                }
            }
            Ok(GuardCommand::Stop) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                break Ok(())
            }
            Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
    };
    let release = held.release();
    held.session.stop();
    let _ = writeln!(output, "{}", json!({"released":release.is_ok()}));
    let _ = output.flush();
    result.and(release)
}
