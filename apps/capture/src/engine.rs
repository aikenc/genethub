//! Capture's private native ABI. Encoded data is copied during the callback;
//! GPU surfaces and third-party configuration never cross daemon IPC.
use anyhow::{anyhow, bail, Context, Result};
use libloading::Library;
use serde::{Deserialize, Serialize};
use std::{
    ffi::{c_char, c_void, CStr, CString},
    path::{Path, PathBuf},
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::{mpsc, watch};

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub display_id: i32,
    pub width: i32,
    pub height: i32,
    pub fps: i32,
    pub bitrate_kbps: i32,
    pub input_only: i32,
    pub source_width: i32,
    pub source_height: i32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub id: i32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub key: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub available: bool,
    pub input_permission: bool,
    pub reason: String,
    pub displays: Vec<Display>,
}
pub struct Video {
    pub data: bytes::Bytes,
    pub encoded_us: i64,
    pub keyframe: bool,
    /// The engine's own account: this is the held picture encoded again (idle
    /// floor, refinement, cursor redraw), not a new capture of the desktop.
    pub repeat: bool,
}
pub enum AudioStatus {
    Flowing,
    Unavailable(String),
}
pub struct Audio {
    pub data: bytes::Bytes,
    pub samples: u32,
}
struct Callbacks {
    video: mpsc::Sender<Video>,
    audio: mpsc::Sender<Audio>,
    ended: watch::Sender<Option<String>>,
    keyframe_needed: Arc<AtomicBool>,
    waiting_keyframe: AtomicBool,
}
type VideoFn = unsafe extern "C" fn(*mut c_void, *const u8, usize, i64, i32);
type AudioFn = unsafe extern "C" fn(*mut c_void, *const u8, usize, i32);
type EndedFn = unsafe extern "C" fn(*mut c_void, *const c_char);
type StartFn = unsafe extern "C" fn(
    *const Config,
    *const c_char,
    Option<VideoFn>,
    Option<AudioFn>,
    Option<EndedFn>,
    *mut c_void,
    *mut *mut c_char,
) -> *mut c_void;
pub struct Engine {
    _library: Library,
    pub path: PathBuf,
    probe: unsafe extern "C" fn() -> *mut c_char,
    preflight: unsafe extern "C" fn(*const c_char, i32, i32, i32) -> i32,
    free: unsafe extern "C" fn(*mut c_char),
    start: StartFn,
    stop: unsafe extern "C" fn(*mut c_void),
    audio_status: unsafe extern "C" fn(*mut c_void, *mut *mut c_char) -> i32,
    target_live: unsafe extern "C" fn(*mut c_void) -> i32,
    keyframe: unsafe extern "C" fn(*mut c_void),
    bitrate: unsafe extern "C" fn(*mut c_void, i32),
    input: unsafe extern "C" fn(*mut c_void, i32, i32, i32, *const c_char),
    manage: unsafe extern "C" fn(
        *const c_char,
        extern "C" fn(*mut c_void, i32) -> i32,
        *mut c_void,
    ) -> i32,
}
// The loaded API's session calls are thread-safe; serialized handle ownership
// below fences stop against every caller. The library outlives all handles.
impl Engine {
    pub fn open(path: &Path) -> Result<Arc<Self>> {
        let path = path
            .canonicalize()
            .context("native engine missing; build apps/capture/native first")?;
        unsafe {
            let library = Library::new(&path)?;
            let abi = *library.get::<unsafe extern "C" fn() -> u32>(b"gh_capture_abi\0")?;
            if abi() != 5 {
                bail!("unsupported capture native ABI");
            }
            Ok(Arc::new(Self {
                probe: *library.get(b"gh_capture_probe\0")?,
                preflight: *library.get(b"gh_capture_preflight\0")?,
                free: *library.get(b"gh_capture_free\0")?,
                start: *library.get(b"gh_capture_start\0")?,
                stop: *library.get(b"gh_capture_stop\0")?,
                audio_status: *library.get(b"gh_capture_audio_status\0")?,
                target_live: *library.get(b"gh_capture_target_live\0")?,
                keyframe: *library.get(b"gh_capture_keyframe\0")?,
                bitrate: *library.get(b"gh_capture_bitrate\0")?,
                input: *library.get(b"gh_capture_input\0")?,
                manage: *library.get(b"gh_capture_manage\0")?,
                _library: library,
                path,
            }))
        }
    }
    unsafe fn take_text(&self, pointer: *mut c_char) -> Result<String> {
        if pointer.is_null() {
            bail!("native engine allocation failed");
        }
        let text = CStr::from_ptr(pointer).to_string_lossy().into_owned();
        (self.free)(pointer);
        Ok(text)
    }
    pub fn probe(&self) -> Result<Probe> {
        let text = unsafe { self.take_text((self.probe)())? };
        serde_json::from_str(&text).context("native probe contract invalid")
    }
    pub fn request_permission(&self, permission: &str) -> Result<bool> {
        let kind = match permission {
            "screen" => 0,
            "input" => 1,
            _ => bail!("--request-permission requires screen or input"),
        };
        #[cfg(target_os = "macos")]
        unsafe {
            let request = self
                ._library
                .get::<unsafe extern "C" fn(i32, u32) -> i32>(
                    b"gh_capture_request_permission_interactive\0",
                )
                .context("update the Capture package: interactive permission action unavailable")?;
            match request(kind, 120_000) {
                0 => Ok(false),
                1 => Ok(true),
                -2 => bail!("macOS could not open System Settings for this permission"),
                _ => bail!("OS permission request failed"),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = kind;
            bail!("permission-request settings action is only supported on macOS")
        }
    }
    pub fn preflight(&self, key: &str, width: u32, height: u32, input: bool) -> Result<()> {
        let key = CString::new(key)?;
        let state = unsafe {
            (self.preflight)(key.as_ptr(), width as i32, height as i32, i32::from(input))
        };
        match state {
            1 => Ok(()),
            0 => bail!("target_changed"),
            -3 => bail!("desktop_unavailable"),
            _ => bail!("permission_required"),
        }
    }
    /// Runs the OS UI on the caller's main thread. The callback context stays
    /// owned by the caller until this synchronous call returns.
    pub unsafe fn manage(
        &self,
        target: &str,
        callback: extern "C" fn(*mut c_void, i32) -> i32,
        context: *mut c_void,
    ) -> Result<()> {
        let target = CString::new(target)?;
        if (self.manage)(target.as_ptr(), callback, context) != 0 {
            bail!("native management UI unavailable; use explicit --headless");
        }
        Ok(())
    }
    pub fn start(self: &Arc<Self>, config: Config, expected_key: &str) -> Result<Started> {
        let expected_key = CString::new(expected_key)?;
        let (video_tx, video) = mpsc::channel(4);
        let (audio_tx, audio) = mpsc::channel(24);
        let (ended_tx, ended) = watch::channel(None);
        let needed = Arc::new(AtomicBool::new(false));
        let callbacks = Box::new(Callbacks {
            video: video_tx,
            audio: audio_tx,
            ended: ended_tx,
            keyframe_needed: needed.clone(),
            waiting_keyframe: AtomicBool::new(true),
        });
        let user = Box::into_raw(callbacks);
        let mut error = ptr::null_mut();
        let handle = unsafe {
            (self.start)(
                &config,
                expected_key.as_ptr(),
                Some(video_callback),
                Some(audio_callback),
                Some(ended_callback),
                user.cast(),
                &mut error,
            )
        };
        if handle.is_null() {
            unsafe {
                drop(Box::from_raw(user));
            }
            let reason = if error.is_null() {
                "native_start_failed".to_string()
            } else {
                unsafe { self.take_text(error)? }
            };
            bail!("{reason}");
        }
        Ok(Started {
            session: Arc::new(NativeSession {
                engine: self.clone(),
                state: Mutex::new(Some(Handle { handle, user })),
                keyframe_needed: needed,
            }),
            video,
            audio,
            ended,
        })
    }
}
struct Handle {
    handle: *mut c_void,
    user: *mut Callbacks,
}
// SAFETY: all access is serialized by NativeSession.state; the native API
// allows concurrent capture callbacks and stop joins them before user is freed.
unsafe impl Send for Handle {}
pub struct NativeSession {
    engine: Arc<Engine>,
    state: Mutex<Option<Handle>>,
    pub keyframe_needed: Arc<AtomicBool>,
}
pub struct Started {
    pub session: Arc<NativeSession>,
    pub video: mpsc::Receiver<Video>,
    pub audio: mpsc::Receiver<Audio>,
    pub ended: watch::Receiver<Option<String>>,
}
impl NativeSession {
    pub fn target_live(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .is_some_and(|handle| unsafe { (self.engine.target_live)(handle.handle) == 1 })
    }
    pub fn audio_status(&self) -> Option<AudioStatus> {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let handle = state.as_ref()?;
        let mut reason = ptr::null_mut();
        let status = unsafe { (self.engine.audio_status)(handle.handle, &mut reason) };
        let reason = if reason.is_null() {
            String::new()
        } else {
            unsafe { self.engine.take_text(reason).unwrap_or_default() }
        };
        match status {
            1 => Some(AudioStatus::Flowing),
            0 => Some(AudioStatus::Unavailable(if reason.is_empty() {
                "audio_unavailable".into()
            } else {
                reason
            })),
            _ => None,
        }
    }
    pub fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(handle) = state.take() {
            unsafe {
                (self.engine.stop)(handle.handle);
                drop(Box::from_raw(handle.user));
            }
        }
    }
    pub fn keyframe(&self) {
        if let Some(handle) = self
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            unsafe {
                (self.engine.keyframe)(handle.handle);
            }
        }
    }
    pub fn bitrate(&self, kbps: i32) {
        if let Some(handle) = self
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            unsafe {
                (self.engine.bitrate)(handle.handle, kbps.clamp(256, 50000));
            }
        }
    }
    pub fn input(&self, kind: i32, a: i32, b: i32, text: &str) -> Result<()> {
        let text = CString::new(text)?;
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let handle = state
            .as_ref()
            .ok_or_else(|| anyhow!("native session stopped"))?;
        unsafe {
            (self.engine.input)(handle.handle, kind, a, b, text.as_ptr());
        }
        Ok(())
    }
}
impl Drop for NativeSession {
    fn drop(&mut self) {
        self.stop();
    }
}
unsafe extern "C" fn video_callback(
    user: *mut c_void,
    data: *const u8,
    size: usize,
    encoded_us: i64,
    key: i32,
) {
    if user.is_null() || data.is_null() || size == 0 || size > 8 * 1024 * 1024 {
        return;
    }
    let cb = &*(user as *const Callbacks);
    if cb.waiting_keyframe.load(Ordering::Relaxed) && key & 1 == 0 {
        return;
    }
    let frame = Video {
        data: bytes::Bytes::copy_from_slice(std::slice::from_raw_parts(data, size)),
        encoded_us,
        keyframe: key & 1 != 0,
        repeat: key & 2 != 0,
    };
    if cb.video.try_send(frame).is_err() {
        cb.waiting_keyframe.store(true, Ordering::Relaxed);
        cb.keyframe_needed.store(true, Ordering::Relaxed);
    } else if key & 1 != 0 {
        cb.waiting_keyframe.store(false, Ordering::Relaxed);
    }
}
unsafe extern "C" fn audio_callback(user: *mut c_void, data: *const u8, size: usize, samples: i32) {
    if user.is_null()
        || data.is_null()
        || size == 0
        || size > 16384
        || !(1..=5760).contains(&samples)
    {
        return;
    }
    let cb = &*(user as *const Callbacks);
    let _ = cb.audio.try_send(Audio {
        data: bytes::Bytes::copy_from_slice(std::slice::from_raw_parts(data, size)),
        samples: samples as u32,
    });
}
unsafe extern "C" fn ended_callback(user: *mut c_void, reason: *const c_char) {
    if user.is_null() {
        return;
    }
    let cb = &*(user as *const Callbacks);
    let reason = if reason.is_null() {
        "native_capture_ended".into()
    } else {
        CStr::from_ptr(reason).to_string_lossy().into_owned()
    };
    let _ = cb.ended.send(Some(reason));
}
