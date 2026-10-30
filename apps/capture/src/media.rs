use crate::{
    engine::{Config, Engine, NativeSession},
    h264,
    state::{VideoFormat, View},
};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors,
        media_engine::{MediaEngine, MIME_TYPE_H264, MIME_TYPE_OPUS},
        APIBuilder,
    },
    ice_transport::{ice_candidate::RTCIceCandidateInit, ice_server::RTCIceServer},
    interceptor::registry::Registry,
    media::Sample,
    peer_connection::{
        configuration::RTCConfiguration, peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription, RTCPeerConnection,
    },
    rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
    track::track_local::{track_local_static_sample::TrackLocalStaticSample, TrackLocal},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Offer {
    pub session_id: String,
    pub session_token: String,
    pub generation: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub sdp: String,
    pub ice_servers: Vec<RTCIceServer>,
}
pub struct Media {
    pub peer: Arc<RTCPeerConnection>,
    view: Weak<View>,
    native: Mutex<Option<Arc<NativeSession>>>,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    closed: AtomicBool,
    remote_candidates: AtomicU32,
}
impl Media {
    pub fn connected(&self) -> bool {
        self.peer.connection_state() == RTCPeerConnectionState::Connected
            && !self.closed.load(Ordering::SeqCst)
    }
    pub async fn open(
        view: &Arc<View>,
        engine: Arc<Engine>,
        config: Config,
        offer: Offer,
    ) -> Result<(Arc<Self>, Value)> {
        let negotiation_started = Instant::now();
        if offer.kind != "offer"
            || offer.generation != 1
            || offer.sdp.len() > 128 * 1024
            || offer.ice_servers.len() > 16
        {
            bail!("invalid_offer");
        }
        for server in &offer.ice_servers {
            if server.urls.len() > 8
                || server.username.len() > 1024
                || server.credential.len() > 1024
            {
                bail!("invalid_ice");
            }
            for url in &server.urls {
                if url.len() > 1024
                    || !["stun:", "stuns:", "turn:", "turns:"]
                        .iter()
                        .any(|p| url.starts_with(p))
                {
                    bail!("invalid_ice");
                }
            }
        }
        // The advertised level is the one the configured picture size/rate/bitrate
        // needs; the encoder's first SPS is checked against it below.
        let (picture_w, picture_h) = if config.width > 0 && config.height > 0 {
            (config.width as u32, config.height as u32)
        } else {
            (config.source_width as u32, config.source_height as u32)
        };
        let advertised_level = h264::level_for(
            picture_w,
            picture_h,
            config.fps as u32,
            config.bitrate_kbps as u32,
        )
        .context("unsupported_capture_profile")?;
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs()?;
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)?;
        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .build();
        let peer = Arc::new(
            api.new_peer_connection(RTCConfiguration {
                ice_servers: offer.ice_servers,
                ..Default::default()
            })
            .await?,
        );
        let media = Arc::new(Self {
            peer: peer.clone(),
            view: Arc::downgrade(view),
            native: Mutex::new(None),
            tasks: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
            remote_candidates: AtomicU32::new(0),
        });
        let weak_view = Arc::downgrade(view);
        peer.on_ice_candidate(Box::new(move|candidate|{let view=weak_view.clone();Box::pin(async move{
            if let Some(view)=view.upgrade(){let value=candidate.and_then(|c|c.to_json().ok());let _=view.events.send(json!({"event":"media.candidate","params":{"generation":1,"candidate":value}}));}
        })}));
        let weak_view = Arc::downgrade(view);
        peer.on_data_channel(Box::new(move |channel| {
            let view = weak_view.clone();
            Box::pin(async move {
                let label = channel.label().to_owned();
                let motion = label == "gh-motion-v1";
                if label != "gh-control-v1" && !motion {
                    let _ = channel.close().await;
                    return;
                }
                let close_view = view.clone();
                channel.on_close(Box::new(move || {
                    let view = close_view.clone();
                    Box::pin(async move {
                        if let Some(view) = view.upgrade() {
                            let _ = view.release_control(None).await;
                        }
                    })
                }));
                channel.on_message(Box::new(move |message| {
                    let view = view.clone();
                    Box::pin(async move {
                        if let Some(view) = view.upgrade() {
                            if view.input(&message.data, motion).await.is_err() {
                                let _ = view.release_control(None).await;
                            }
                        }
                    })
                }));
            })
        }));
        let video = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_H264.into(),
                clock_rate: 90000,
                sdp_fmtp_line: format!(
                    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id={}",
                    h264::profile_level_id(advertised_level)
                ),
                ..Default::default()
            },
            "video".into(),
            "desktop".into(),
        ));
        let audio = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_OPUS.into(),
                clock_rate: 48000,
                channels: 2,
                ..Default::default()
            },
            "audio".into(),
            "desktop".into(),
        ));
        let sender = peer
            .add_track(video.clone() as Arc<dyn TrackLocal + Send + Sync>)
            .await?;
        let audio_sender = peer
            .add_track(audio.clone() as Arc<dyn TrackLocal + Send + Sync>)
            .await?;
        let expected_key = view.app.upgrade().context("app ended")?.display.key.clone();
        let weak = Arc::downgrade(&media);
        media.tasks.lock().unwrap().push(tokio::spawn(async move{
            while let Ok((packets,_))=sender.read_rtcp().await{
                let Some(media)=weak.upgrade()else{break};
                for packet in packets{
                    if packet.as_any().is::<webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication>()||packet.as_any().is::<webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest>(){
                        if let Some(native)=media.native.lock().unwrap().as_ref(){native.keyframe();}
                    }
                    if let Some(remb)=packet.as_any().downcast_ref::<webrtc::rtcp::payload_feedbacks::receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate>(){
                        if let Some(native)=media.native.lock().unwrap().as_ref(){native.bitrate(((remb.bitrate/1000.0)as i32).clamp(256,config.bitrate_kbps));}
                    }
                }
            }
        }));
        media.tasks.lock().unwrap().push(tokio::spawn(async move {
            while audio_sender.read_rtcp().await.is_ok() {}
        }));
        let weak = Arc::downgrade(&media);
        peer.on_peer_connection_state_change(Box::new(move |state| {
            let weak = weak.clone();
            Box::pin(async move {
                if matches!(
                    state,
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                ) {
                    if let Some(media) = weak.upgrade() {
                        if let Some(view) = media.view.upgrade() {
                            tokio::spawn(async move {
                                view.close("media_ended").await;
                            });
                        }
                    }
                }
            })
        }));
        // No media is captured until the offered DTLS identity is installed and
        // its peer is connected. Starting a provider cannot expose a desktop.
        if let Err(error) = peer
            .set_remote_description(RTCSessionDescription::offer(offer.sdp)?)
            .await
        {
            media.close().await;
            return Err(error.into());
        }
        let answer = peer.create_answer(None).await?;
        let mut complete = peer.gathering_complete_promise().await;
        peer.set_local_description(answer).await?;
        let _ = tokio::time::timeout(Duration::from_secs(2), complete.recv()).await;
        let answer = peer
            .local_description()
            .await
            .context("missing local answer")?;
        eprintln!(
            "Capture media answer ready in {} ms",
            negotiation_started.elapsed().as_millis()
        );
        let weak = Arc::downgrade(&media);
        media.tasks.lock().unwrap().push(tokio::spawn(async move {
            let started_at = Instant::now();
            loop {
                let Some(media) = weak.upgrade() else { return };
                if media.closed.load(Ordering::SeqCst) {
                    return;
                }
                if media.connected() {
                    break;
                }
                if started_at.elapsed() > Duration::from_secs(25) {
                    if let Some(view) = media.view.upgrade() {
                        tokio::spawn(async move {
                            view.close("media_connect_timeout").await;
                        });
                    }
                    return;
                }
                drop(media);
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            eprintln!("Capture native media starting");
            let capture =
                tokio::task::spawn_blocking(move || engine.start(config, &expected_key)).await;
            let mut capture = match capture {
                Ok(Ok(capture)) => capture,
                error => {
                    // Native startup diagnostics contain no SDP or session keys.
                    match error {
                        Ok(Err(error)) => eprintln!("Capture native start failed: {error:#}"),
                        Err(_) => eprintln!("Capture native start worker failed"),
                        _ => unreachable!(),
                    }
                    if let Some(media) = weak.upgrade() {
                        if let Some(view) = media.view.upgrade() {
                            tokio::spawn(async move {
                                view.close("encoder_unavailable").await;
                            });
                        }
                    }
                    return;
                }
            };
            let Some(media) = weak.upgrade() else {
                capture.session.stop();
                return;
            };
            {
                let mut native_slot = media.native.lock().unwrap();
                if media.closed.load(Ordering::SeqCst) {
                    capture.session.stop();
                    return;
                }
                *native_slot = Some(capture.session.clone());
            }
            let native = capture.session.clone();
            let view = media.view.clone();
            if let (Some(view), Some(status)) = (view.upgrade(), native.audio_status()) {
                view.health.set_audio(status);
                let _ = view.events.send(json!({"event":"media.status","params":view.health.json()}));
            }
            let mut last_encoded = 0i64;
            let advertised = advertised_level;
            let video_task = tokio::spawn(async move {
                while let Some(frame) = capture.video.recv().await {
                    if let Some(view) = view.upgrade() {
                        if !native.target_live() {
                            tokio::spawn(async move {
                                view.close("target_changed").await;
                            });
                            break;
                        }
                        if !view.media_allowed() {
                            break;
                        }
                        *view.last_native.lock().unwrap() = Instant::now();
                        view.health.note_video(frame.repeat);
                        if frame.keyframe && !view.health.video_checked() {
                            if let Some(sps) = h264::parse_sps(&frame.data) {
                                let format = VideoFormat {
                                    profile_idc: sps.profile_idc,
                                    level_idc: sps.level_idc,
                                    advertised_level: advertised,
                                    size: sps.size,
                                };
                                eprintln!(
                                    "Capture H.264 SPS profile_idc={} constraints={:#04x} level_idc={} advertised_level_idc={} size={:?}",
                                    sps.profile_idc, sps.constraint_flags, sps.level_idc, advertised, sps.size
                                );
                                let acceptable = sps.profile_idc == 66;
                                let within = format.within_advertised();
                                view.health.set_video(format);
                                let _ = view.events.send(json!({"event":"media.status","params":view.health.json()}));
                                if !acceptable {
                                    // Answered Constrained Baseline: any other profile cannot be
                                    // decoded by the negotiated receiver. Refuse, never send it.
                                    tokio::spawn(async move {
                                        view.close("h264_profile_mismatch").await;
                                    });
                                    break;
                                }
                                if !within {
                                    eprintln!("Capture H.264 level exceeds the advertised level; strict receivers may refuse the stream");
                                }
                            }
                        }
                    } else {
                        break;
                    }
                    if native.keyframe_needed.swap(false, Ordering::Relaxed) {
                        native.keyframe();
                    }
                    let elapsed = if last_encoded > 0 {
                        (frame.encoded_us - last_encoded).clamp(1000, 1_000_000) as u64
                    } else {
                        1_000_000 / (config.fps as u64)
                    };
                    last_encoded = frame.encoded_us;
                    if video
                        .write_sample(&Sample {
                            data: frame.data,
                            duration: Duration::from_micros(elapsed),
                            ..Default::default()
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
            let weak_view = media.view.clone();
            let audio_task = tokio::spawn(async move {
                while let Some(packet) = capture.audio.recv().await {
                    // Source close gates both tracks before waiting for the
                    // independent input guard's release confirmation.
                    if !weak_view.upgrade().is_some_and(|view| view.media_allowed()) {
                        break;
                    }
                    if audio
                        .write_sample(&Sample {
                            data: packet.data,
                            duration: Duration::from_secs_f64(f64::from(packet.samples) / 48000.0),
                            ..Default::default()
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
            // Source facts stay observable while viewing: the H5 shows
            // "waiting for the first capture" / "desktop idle" from these.
            let health_view = media.view.clone();
            let health_task = tokio::spawn(async move {
                let mut timer = tokio::time::interval(Duration::from_secs(2));
                loop {
                    timer.tick().await;
                    let Some(view) = health_view.upgrade() else { break };
                    if view.closing.load(Ordering::SeqCst) {
                        break;
                    }
                    let _ = view
                        .events
                        .send(json!({"event":"media.status","params":view.health.json()}));
                }
            });
            media
                .tasks
                .lock()
                .unwrap()
                .extend([video_task, audio_task, health_task]);
            drop(media);
            let _ = capture.ended.changed().await;
            if let Some(media) = weak.upgrade() {
                if let Some(view) = media.view.upgrade() {
                    tokio::spawn(async move {
                        view.close("native_capture_ended").await;
                    });
                }
            }
        }));
        Ok((media, json!({"type":"answer","sdp":answer.sdp})))
    }
    pub async fn signal(&self, candidate: Option<RTCIceCandidateInit>) -> Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            bail!("session_expired");
        }
        if let Some(candidate) = candidate {
            if candidate.candidate.len() > 4096
                || self.remote_candidates.fetch_add(1, Ordering::SeqCst) >= 256
            {
                bail!("invalid_candidate");
            }
            self.peer.add_ice_candidate(candidate).await?;
        }
        Ok(())
    }
    pub async fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
        let native = self.native.lock().unwrap().take();
        if let Some(native) = native {
            let _ = tokio::task::spawn_blocking(move || native.stop()).await;
        }
        let _ = self.peer.close().await;
    }
}

impl Drop for Media {
    fn drop(&mut self) {
        for task in self
            .tasks
            .get_mut()
            .unwrap_or_else(|p| p.into_inner())
            .drain(..)
        {
            task.abort();
        }
        if let Some(native) = self
            .native
            .get_mut()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            native.stop();
        }
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let peer = self.peer.clone();
            runtime.spawn(async move {
                let _ = peer.close().await;
            });
        }
    }
}
