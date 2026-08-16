mod external;
mod mock;

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use genehub_proto::{
    decode_speech_audio, decode_speech_json, encode_speech_json, SpeechAudioFormat,
    SpeechCancelReason, SpeechCandidate, SpeechCapabilities, SpeechCompleted, SpeechContextLimits,
    SpeechContextPack, SpeechContextUpdate, SpeechFailure, SpeechFailureCode, SpeechFrame,
    SpeechFrameDecoder, SpeechFrameKind, SpeechNBestCapabilities, SpeechPartial, SpeechReady,
    SpeechRuntimeCapabilities, SpeechRuntimeDescriptor, SpeechRuntimeStatus, SpeechScoreKind,
    SpeechSegment, SpeechSegmentationCapabilities, SpeechSettings, SpeechStart,
    MAX_SPEECH_CANDIDATES, MAX_SPEECH_CONTEXT_BYTES, MAX_SPEECH_DURATION_MS,
    MAX_SPEECH_FRAME_PAYLOAD_BYTES, MAX_SPEECH_PROMPT_CHARS, MAX_SPEECH_SEGMENTS,
    MAX_SPEECH_SEGMENT_CANDIDATE_CHARS, MAX_SPEECH_TRANSCRIPT_CHARS, MAX_SPEECH_UNCERTAIN_SPANS,
    SPEECH_PROTOCOL_VERSION, SPEECH_RUNTIME_CAPABILITIES_SCHEMA,
};
use genet_daemon_logic_api::{SpeechCompletionEvidence, SpeechConfig, SpeechRuntimeConfig};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, Semaphore};

use crate::dataplane::endpoint::{PeerServices, ServerStream, StreamInput};

const MAX_RUNTIME_SESSIONS: usize = 4;
const MAX_PINNED_TERMS: usize = 50;
const MAX_AUTOMATIC_TERMS: usize = 150;
const MAX_LANGUAGE_HINTS: usize = 4;
const MIN_AUDIO_CHUNK_MS: u16 = 20;
const MAX_AUDIO_CHUNK_MS: u16 = 200;

struct SpeechDiagnostics {
    request_id: String,
    correlation_id: String,
    started_at: Instant,
    audio_chunks: u32,
    audio_bytes: u64,
    partials: u32,
    first_partial_ms: Option<u64>,
    runtime: Option<SpeechRuntimeDescriptor>,
}

impl SpeechDiagnostics {
    fn new(start: &SpeechStart) -> Self {
        Self {
            request_id: start.request_id.clone(),
            correlation_id: speech_correlation_id(&start.request_id),
            started_at: Instant::now(),
            audio_chunks: 0,
            audio_bytes: 0,
            partials: 0,
            first_partial_ms: None,
            runtime: None,
        }
    }

    fn elapsed_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64
    }

    fn record_audio(&mut self, chunks: u32, duration_ms: u32) {
        self.audio_chunks = self.audio_chunks.saturating_add(chunks);
        self.audio_bytes = self
            .audio_bytes
            .saturating_add(u64::from(duration_ms).saturating_mul(32));
    }

    fn record_partial(&mut self) -> bool {
        self.partials = self.partials.saturating_add(1);
        if self.first_partial_ms.is_none() {
            self.first_partial_ms = Some(self.elapsed_ms());
            true
        } else {
            false
        }
    }

    fn correlated(&self, error: &SpeechFailure) -> SpeechFailure {
        let mut error = error.clone();
        error.correlation_id = Some(self.correlation_id.clone());
        error
    }

    fn log_failure(&self, stage: &'static str, error: &SpeechFailure) {
        let message_fingerprint = diagnostic_fingerprint(&error.message);
        tracing::warn!(
            event = "speech_failed",
            request_id = %self.request_id,
            correlation_id = %self.correlation_id,
            stage,
            code = ?error.code,
            retryable = error.retryable,
            elapsed_ms = self.elapsed_ms(),
            audio_chunks = self.audio_chunks,
            audio_bytes = self.audio_bytes,
            partials = self.partials,
            first_partial_ms = ?self.first_partial_ms,
            runtime_id = self.runtime.as_ref().map(|runtime| runtime.id.as_str()),
            model_id = self.runtime.as_ref().map(|runtime| runtime.model.as_str()),
            implementation = self.runtime.as_ref().map(|runtime| runtime.implementation.as_str()),
            message_fingerprint = %message_fingerprint,
            "speech transcription failed without logging speech content"
        );
    }
}

pub(super) fn speech_correlation_id(request_id: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(request_id.as_bytes()));
    format!("sp_{}", &digest[..20])
}

fn valid_speech_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 128
        && request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn diagnostic_fingerprint(value: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(value.as_bytes()));
    digest[..16].to_string()
}

#[async_trait::async_trait]
trait SpeechRuntime: Send + Sync {
    async fn probe(
        &self,
        config: &SpeechConfig,
    ) -> Result<SpeechRuntimeCapabilities, SpeechFailure>;
    async fn open(
        &self,
        config: &SpeechConfig,
        start: &SpeechStart,
        capabilities: &SpeechRuntimeCapabilities,
    ) -> Result<RuntimeSession, SpeechFailure>;
}

enum RuntimeCommand {
    Audio {
        index: u32,
        capture_start_ms: u32,
        pcm: Vec<u8>,
        duration_ms: u16,
    },
    Context {
        revision: u32,
        context: SpeechContextPack,
    },
    Finish,
    Cancel,
}

enum RuntimeEvent {
    ContextApplied {
        revision: u32,
    },
    Partial(SpeechPartial),
    Completed {
        request_id: String,
        duration_ms: u32,
        context_snapshot_id: String,
        candidates: Vec<SpeechCandidate>,
        segments: Vec<SpeechSegment>,
        score_kind: SpeechScoreKind,
        scores_calibrated: bool,
    },
    Failed(SpeechFailure),
}

struct RuntimeSession {
    capabilities: SpeechRuntimeCapabilities,
    commands: mpsc::Sender<RuntimeCommand>,
    events: mpsc::Receiver<RuntimeEvent>,
}

type CapabilityCacheKey = (bool, Option<SpeechRuntimeConfig>);
type CapabilityCache = Option<(CapabilityCacheKey, SpeechRuntimeCapabilities)>;

impl RuntimeSession {
    async fn send(&self, command: RuntimeCommand) -> Result<(), SpeechFailure> {
        self.commands.send(command).await.map_err(|_| {
            failure(
                SpeechFailureCode::RuntimeUnavailable,
                "语音 runtime 已经结束",
                true,
            )
        })
    }
}

pub struct SpeechBroker {
    external_runtime: Arc<dyn SpeechRuntime>,
    stub_runtime: Arc<dyn SpeechRuntime>,
    capability_cache: tokio::sync::RwLock<CapabilityCache>,
    slots: Arc<Semaphore>,
}

impl SpeechBroker {
    pub fn new() -> Self {
        Self {
            external_runtime: Arc::new(external::ExternalSpeechRuntime),
            stub_runtime: Arc::new(mock::ProtocolStubRuntime),
            capability_cache: tokio::sync::RwLock::new(None),
            slots: Arc::new(Semaphore::new(MAX_RUNTIME_SESSIONS)),
        }
    }

    fn runtime(&self, config: &SpeechConfig) -> &dyn SpeechRuntime {
        if config.stub_enabled {
            self.stub_runtime.as_ref()
        } else {
            self.external_runtime.as_ref()
        }
    }

    fn cache_key(config: &SpeechConfig) -> (bool, Option<SpeechRuntimeConfig>) {
        (config.stub_enabled, config.runtime.clone())
    }

    pub async fn probe(&self, config: &SpeechConfig) -> SpeechRuntimeStatus {
        match self.runtime(config).probe(config).await {
            Ok(capabilities) => {
                *self.capability_cache.write().await =
                    Some((Self::cache_key(config), capabilities));
                SpeechRuntimeStatus::Ready
            }
            Err(error) => SpeechRuntimeStatus::Unavailable {
                message: error.message,
            },
        }
    }

    pub async fn capabilities(&self, config: &SpeechConfig) -> SpeechCapabilities {
        match self.runtime(config).probe(config).await {
            Ok(runtime) => {
                *self.capability_cache.write().await =
                    Some((Self::cache_key(config), runtime.clone()));
                capabilities_from_runtime(SpeechRuntimeStatus::Ready, runtime)
            }
            Err(error) => unavailable_capabilities(config, error.message),
        }
    }

    pub async fn validate_registration(
        &self,
        command: String,
        args: Vec<String>,
    ) -> Result<SpeechRuntimeConfig> {
        let runtime = external::validate_registration(command, args)?;
        let candidate = SpeechConfig {
            runtime: Some(runtime.clone()),
            ..SpeechConfig::default()
        };
        let capabilities = self
            .external_runtime
            .probe(&candidate)
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
        *self.capability_cache.write().await = Some((Self::cache_key(&candidate), capabilities));
        Ok(runtime)
    }

    async fn open(
        &self,
        config: &SpeechConfig,
        start: &SpeechStart,
    ) -> Result<RuntimeSession, SpeechFailure> {
        let cached = self
            .capability_cache
            .read()
            .await
            .as_ref()
            .filter(|(selection, _)| selection == &Self::cache_key(config))
            .map(|(_, capabilities)| capabilities.clone());
        let capabilities = match cached {
            Some(capabilities) => capabilities,
            None => {
                let capabilities = self.runtime(config).probe(config).await?;
                *self.capability_cache.write().await =
                    Some((Self::cache_key(config), capabilities.clone()));
                capabilities
            }
        };
        self.runtime(config)
            .open(config, start, &capabilities)
            .await
    }
}

impl Default for SpeechBroker {
    fn default() -> Self {
        Self::new()
    }
}

pub fn settings(config: &SpeechConfig) -> SpeechSettings {
    SpeechSettings {
        runtime: configured_descriptor(config),
        stub_enabled: config.stub_enabled,
        context_enabled: config.context_enabled,
        pinned_terms: config.pinned_terms.clone(),
        language_hints: config.language_hints.clone(),
        // Never project a legacy machine-wide opt-in back to clients. A user
        // must choose every project explicitly in the new UI.
        collect_corrections: false,
        correction_workspaces: config.correction_workspaces.clone(),
    }
}

#[cfg(test)]
fn mock_capabilities() -> SpeechCapabilities {
    capabilities_from_runtime(SpeechRuntimeStatus::Ready, stub_runtime_capabilities())
}

fn stub_runtime_capabilities() -> SpeechRuntimeCapabilities {
    SpeechRuntimeCapabilities {
        schema: SPEECH_RUNTIME_CAPABILITIES_SCHEMA.to_string(),
        speech_protocol_version: SPEECH_PROTOCOL_VERSION,
        runtime: stub_runtime_descriptor(),
        audio: vec![SpeechAudioFormat::default()],
        languages: SUPPORTED_LANGUAGES
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        max_language_hints: MAX_LANGUAGE_HINTS as u8,
        max_duration_ms: MAX_SPEECH_DURATION_MS,
        n_best: SpeechNBestCapabilities {
            max_candidates: MAX_SPEECH_CANDIDATES as u8,
            score_kind: SpeechScoreKind::MockRelative,
            calibrated: false,
        },
        segmentation: SpeechSegmentationCapabilities {
            max_segments: MAX_SPEECH_SEGMENTS as u8,
            partial_results: true,
            local_n_best: true,
            uncertain_spans: true,
        },
    }
}

fn capabilities_from_runtime(
    runtime_status: SpeechRuntimeStatus,
    runtime: SpeechRuntimeCapabilities,
) -> SpeechCapabilities {
    SpeechCapabilities {
        protocol_version: SPEECH_PROTOCOL_VERSION,
        runtime_status,
        runtime: runtime.runtime,
        audio: runtime.audio,
        languages: runtime.languages,
        max_language_hints: runtime.max_language_hints,
        max_duration_ms: runtime.max_duration_ms,
        context: SpeechContextLimits {
            max_bytes: MAX_SPEECH_CONTEXT_BYTES as u32,
            max_prompt_chars: MAX_SPEECH_PROMPT_CHARS as u32,
            max_pinned_terms: MAX_PINNED_TERMS as u16,
            max_automatic_terms: MAX_AUTOMATIC_TERMS as u16,
        },
        n_best: runtime.n_best,
        segmentation: runtime.segmentation,
    }
}

fn unavailable_capabilities(config: &SpeechConfig, message: String) -> SpeechCapabilities {
    SpeechCapabilities {
        protocol_version: SPEECH_PROTOCOL_VERSION,
        runtime_status: SpeechRuntimeStatus::Unavailable { message },
        runtime: configured_descriptor(config),
        audio: vec![SpeechAudioFormat::default()],
        languages: SUPPORTED_LANGUAGES
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        max_language_hints: MAX_LANGUAGE_HINTS as u8,
        max_duration_ms: MAX_SPEECH_DURATION_MS,
        context: SpeechContextLimits {
            max_bytes: MAX_SPEECH_CONTEXT_BYTES as u32,
            max_prompt_chars: MAX_SPEECH_PROMPT_CHARS as u32,
            max_pinned_terms: MAX_PINNED_TERMS as u16,
            max_automatic_terms: MAX_AUTOMATIC_TERMS as u16,
        },
        n_best: SpeechNBestCapabilities {
            max_candidates: 1,
            score_kind: SpeechScoreKind::Unavailable,
            calibrated: false,
        },
        segmentation: SpeechSegmentationCapabilities {
            max_segments: 0,
            partial_results: false,
            local_n_best: false,
            uncertain_spans: false,
        },
    }
}

fn configured_descriptor(config: &SpeechConfig) -> SpeechRuntimeDescriptor {
    if config.stub_enabled {
        stub_runtime_descriptor()
    } else if config.runtime.is_some() {
        SpeechRuntimeDescriptor {
            id: "community-speech-runtime".to_string(),
            model: String::new(),
            label: "已注册的社区语音 Runtime".to_string(),
            implementation: "external-stdio".to_string(),
        }
    } else {
        SpeechRuntimeDescriptor {
            id: "unconfigured".to_string(),
            model: String::new(),
            label: "尚未安装本地语音模型".to_string(),
            implementation: "unconfigured".to_string(),
        }
    }
}

fn stub_runtime_descriptor() -> SpeechRuntimeDescriptor {
    SpeechRuntimeDescriptor {
        id: "genehub-speech-stub".to_string(),
        model: "no-model".to_string(),
        label: "GeneHub 语音协议 Stub".to_string(),
        implementation: "stub".to_string(),
    }
}

fn validate_runtime_capabilities(capabilities: &SpeechRuntimeCapabilities) -> Result<()> {
    if capabilities.schema != SPEECH_RUNTIME_CAPABILITIES_SCHEMA {
        anyhow::bail!("schema 必须是 {SPEECH_RUNTIME_CAPABILITIES_SCHEMA}");
    }
    if capabilities.speech_protocol_version != SPEECH_PROTOCOL_VERSION {
        anyhow::bail!(
            "speechProtocolVersion {} 与 GeneHub {} 不兼容",
            capabilities.speech_protocol_version,
            SPEECH_PROTOCOL_VERSION
        );
    }
    for (name, value, allow_empty) in [
        ("runtime.id", capabilities.runtime.id.as_str(), false),
        ("runtime.model", capabilities.runtime.model.as_str(), false),
        ("runtime.label", capabilities.runtime.label.as_str(), false),
        (
            "runtime.implementation",
            capabilities.runtime.implementation.as_str(),
            false,
        ),
    ] {
        if (!allow_empty && value.trim().is_empty())
            || value.len() > 128
            || value.chars().any(char::is_control)
        {
            anyhow::bail!("{name} 无效");
        }
    }
    if matches!(
        capabilities.runtime.implementation.as_str(),
        "mock" | "unconfigured"
    ) {
        anyhow::bail!("外部 runtime 不能声明为 mock 或 unconfigured");
    }
    if capabilities.audio.is_empty()
        || capabilities.audio.len() > 4
        || !capabilities.audio.contains(&SpeechAudioFormat::default())
    {
        anyhow::bail!("audio 必须包含 mono 16 kHz PCM s16le");
    }
    if capabilities.languages.is_empty() || capabilities.languages.len() > 64 {
        anyhow::bail!("languages 必须包含 1 到 64 个语言代码");
    }
    let mut seen = HashSet::new();
    for language in &capabilities.languages {
        if language.is_empty()
            || language.len() > 16
            || language != &language.to_ascii_lowercase()
            || !language
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
            || !seen.insert(language)
        {
            anyhow::bail!("languages 包含无效或重复的语言代码");
        }
    }
    if capabilities.max_language_hints > MAX_LANGUAGE_HINTS as u8 {
        anyhow::bail!("maxLanguageHints 超过 GeneHub 上限");
    }
    if capabilities.max_duration_ms == 0 || capabilities.max_duration_ms > MAX_SPEECH_DURATION_MS {
        anyhow::bail!("maxDurationMs 必须在 1 到 {MAX_SPEECH_DURATION_MS} 之间");
    }
    if !(1..=MAX_SPEECH_CANDIDATES as u8).contains(&capabilities.n_best.max_candidates) {
        anyhow::bail!("nBest.maxCandidates 必须在 1 到 {MAX_SPEECH_CANDIDATES} 之间");
    }
    if capabilities.n_best.score_kind == SpeechScoreKind::MockRelative {
        anyhow::bail!("外部 runtime 不能声明 mockRelative 分数");
    }
    if capabilities.segmentation.max_segments > MAX_SPEECH_SEGMENTS as u8 {
        anyhow::bail!("segmentation.maxSegments 超过 GeneHub 上限");
    }
    if capabilities.segmentation.uncertain_spans && !capabilities.segmentation.local_n_best {
        anyhow::bail!("uncertainSpans 依赖 localNBest");
    }
    if capabilities.segmentation.local_n_best
        && (capabilities.segmentation.max_segments == 0 || capabilities.n_best.max_candidates < 2)
    {
        anyhow::bail!("localNBest 需要分段和至少两个真实候选");
    }
    Ok(())
}

pub fn validate_settings(
    pinned_terms: Vec<String>,
    language_hints: Vec<String>,
) -> Result<(Vec<String>, Vec<String>)> {
    if pinned_terms.len() > MAX_PINNED_TERMS {
        anyhow::bail!("固定专业术语不能超过 {MAX_PINNED_TERMS} 个");
    }
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    for term in pinned_terms {
        let term = term.trim();
        if term.is_empty() || term.chars().count() > 64 || term.chars().any(char::is_control) {
            anyhow::bail!("每个固定专业术语必须包含 1 到 64 个可见字符");
        }
        if seen.insert(term.to_lowercase()) {
            terms.push(term.to_string());
        }
    }

    if language_hints.len() > MAX_LANGUAGE_HINTS {
        anyhow::bail!("语言提示不能超过 {MAX_LANGUAGE_HINTS} 个");
    }
    let mut languages = Vec::new();
    for language in language_hints {
        let language = language.trim().to_ascii_lowercase();
        if !SUPPORTED_LANGUAGES.contains(&language.as_str()) {
            anyhow::bail!("不支持的语音语言提示 `{language}`");
        }
        if !languages.contains(&language) {
            languages.push(language);
        }
    }
    Ok((terms, languages))
}

pub(crate) async fn handle(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    if stream.head.body_length.is_some() {
        return crate::dataplane::endpoint::send_error(
            stream,
            400,
            genehub_proto::ErrorCode::BadRequest,
            "speech.transcribe must be an open-ended duplex stream",
        )
        .await;
    }

    let mut decoder = SpeechFrameDecoder::default();
    let mut pending = VecDeque::new();
    let start = loop {
        match stream.next_input().await? {
            StreamInput::Chunk(bytes) => {
                pending.extend(decoder.push(&bytes)?);
                let Some(frame) = pending.pop_front() else {
                    continue;
                };
                if frame.kind != SpeechFrameKind::Start {
                    return crate::dataplane::endpoint::send_error(
                        stream,
                        400,
                        genehub_proto::ErrorCode::BadRequest,
                        "Start must be the first speech message",
                    )
                    .await;
                }
                break decode_speech_json::<SpeechStart>(&frame)?;
            }
            StreamInput::Fin | StreamInput::Reset(_) => {
                return crate::dataplane::endpoint::send_error(
                    stream,
                    400,
                    genehub_proto::ErrorCode::BadRequest,
                    "speech stream ended before Start",
                )
                .await
            }
        }
    };
    let mut diagnostics = SpeechDiagnostics::new(&start);
    if !valid_speech_request_id(&start.request_id) {
        tracing::warn!(
            event = "speech_request_rejected",
            correlation_id = %diagnostics.correlation_id,
            request_id_bytes = start.request_id.len(),
            "speech request used an invalid id; content was withheld"
        );
        return crate::dataplane::endpoint::send_error(
            stream,
            400,
            genehub_proto::ErrorCode::BadRequest,
            format!(
                "speech request id is invalid（错误编号 {}）",
                diagnostics.correlation_id
            ),
        )
        .await;
    }
    let context_bytes = serde_json::to_vec(&start.context)
        .map(|encoded| encoded.len())
        .unwrap_or_default();
    tracing::info!(
        event = "speech_request_started",
        request_id = %diagnostics.request_id,
        correlation_id = %diagnostics.correlation_id,
        context_bytes,
        prompt_chars = start.context.prompt.chars().count(),
        context_terms = start.context.terms.len(),
        language_hints = start.language_hints.len(),
        omitted_pinned_terms = start.context.omitted.pinned_terms,
        omitted_automatic_terms = start.context.omitted.automatic_terms,
        omitted_messages = start.context.omitted.messages,
        project_index_unavailable = start.context.omitted.project_index_unavailable,
        project_context_truncated = start.context.omitted.project_context_truncated,
        accept_partial = start.accept_partial,
        "speech request accepted without logging prompt or transcript content"
    );

    let config = match services
        .state
        .logic
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("portable daemon logic is unavailable"))?
        .prepare_speech(services.access.workspace_id.clone(), start.clone())
        .await
    {
        Ok(config) => config,
        Err(error) => {
            let diagnostic_error = failure(
                SpeechFailureCode::ProtocolMismatch,
                "语音请求参数无效",
                false,
            );
            diagnostics.log_failure("guest_validate_start", &diagnostic_error);
            return crate::dataplane::endpoint::send_error(
                stream,
                400,
                genehub_proto::ErrorCode::BadRequest,
                format!("{error:#}（错误编号 {}）", diagnostics.correlation_id),
            )
            .await;
        }
    };
    if let Err(error) = validate_start(&start) {
        let diagnostic_error = failure(
            SpeechFailureCode::ProtocolMismatch,
            "语音请求参数无效",
            false,
        );
        diagnostics.log_failure("validate_start", &diagnostic_error);
        return crate::dataplane::endpoint::send_error(
            stream,
            400,
            genehub_proto::ErrorCode::BadRequest,
            format!("{error:#}（错误编号 {}）", diagnostics.correlation_id),
        )
        .await;
    }

    stream
        .respond(&genehub_proto::ExchangeResponseHead {
            status: 200,
            metadata: serde_json::json!({
                "codec": "genehub-speech-v2",
            }),
            body_length: None,
            error: None,
        })
        .await?;

    let Ok(_slot) = services.state.speech.slots.clone().try_acquire_owned() else {
        write_failure(
            stream,
            &diagnostics,
            "concurrency_limit",
            &failure(
                SpeechFailureCode::RuntimeUnavailable,
                "这台机器正在进行的 Qwen3-ASR 转写过多，请稍后重试",
                true,
            ),
        )
        .await?;
        return stream.finish().await;
    };
    let mut runtime = match services.state.speech.open(&config, &start).await {
        Ok(session) => session,
        Err(error) => {
            write_failure(stream, &diagnostics, "runtime_open", &error).await?;
            return stream.finish().await;
        }
    };
    let runtime_capabilities = runtime.capabilities.clone();
    let runtime_descriptor = runtime_capabilities.runtime.clone();
    diagnostics.runtime = Some(runtime_descriptor.clone());
    tracing::info!(
        event = "speech_runtime_ready",
        request_id = %diagnostics.request_id,
        correlation_id = %diagnostics.correlation_id,
        runtime_id = %runtime_descriptor.id,
        model_id = %runtime_descriptor.model,
        implementation = %runtime_descriptor.implementation,
        elapsed_ms = diagnostics.elapsed_ms(),
        partial_results = runtime_capabilities.segmentation.partial_results,
        max_candidates = runtime_capabilities.n_best.max_candidates,
        local_n_best = runtime_capabilities.segmentation.local_n_best,
        uncertain_spans = runtime_capabilities.segmentation.uncertain_spans,
        "speech runtime completed its handshake"
    );

    write_json(
        stream,
        SpeechFrameKind::Ready,
        &SpeechReady {
            request_id: start.request_id.clone(),
            runtime_id: runtime_descriptor.id.clone(),
            model_id: runtime_descriptor.model.clone(),
            context_revision: start.context_revision,
        },
    )
    .await?;

    let mut expected_index = 0u32;
    let mut duration_ms = 0u32;
    let mut context_revision = start.context_revision;
    let mut context_snapshot_id = start.context.snapshot_id.clone();
    let mut finishing = false;
    let mut partial_revision = 0u32;
    let mut finish_deadline = None;
    let mut remote_finished = false;
    let mut result: Option<(
        Vec<SpeechCandidate>,
        Vec<SpeechSegment>,
        SpeechScoreKind,
        bool,
    )> = None;
    let mut client_idle_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);

    loop {
        while let Some(frame) = pending.pop_front() {
            let previous_index = expected_index;
            let previous_duration_ms = duration_ms;
            let outcome = apply_client_frame(
                frame,
                &runtime,
                &mut expected_index,
                &mut duration_ms,
                &mut context_revision,
                &mut context_snapshot_id,
                &mut finishing,
            )
            .await;
            if expected_index > previous_index {
                diagnostics.record_audio(
                    expected_index - previous_index,
                    duration_ms.saturating_sub(previous_duration_ms),
                );
            }
            match outcome {
                Ok(ClientOutcome::Continue) => {}
                Ok(ClientOutcome::Finish) => {
                    finish_deadline =
                        Some(tokio::time::Instant::now() + std::time::Duration::from_secs(30));
                }
                Ok(ClientOutcome::Cancel) => {
                    tracing::info!(
                        event = "speech_canceled",
                        request_id = %diagnostics.request_id,
                        correlation_id = %diagnostics.correlation_id,
                        stage = "client_cancel",
                        elapsed_ms = diagnostics.elapsed_ms(),
                        audio_chunks = diagnostics.audio_chunks,
                        audio_bytes = diagnostics.audio_bytes,
                        "speech request canceled"
                    );
                    return stream.finish().await;
                }
                Err(error) => {
                    let _ = runtime.send(RuntimeCommand::Cancel).await;
                    write_failure(stream, &diagnostics, "client_frame", &error).await?;
                    return stream.finish().await;
                }
            }
        }

        if remote_finished {
            if let Some((candidates, segments, score_kind, scores_calibrated)) = result.take() {
                // The Completed event is validated before it enters `result`.
                // Avoid a second fallible path here: an error after the client
                // half-closes cannot be delivered as a structured SpeechFailed.
                let default = candidates
                    .iter()
                    .min_by_key(|candidate| candidate.rank)
                    .expect("validated runtime completion has a default candidate");
                let completed = SpeechCompleted {
                    request_id: start.request_id.clone(),
                    text: default.text.clone(),
                    duration_ms,
                    context_snapshot_id,
                    default_candidate_id: default.candidate_id.clone(),
                    candidates,
                    score_kind,
                    scores_calibrated,
                    segments: (!segments.is_empty()).then_some(segments),
                };
                if serde_json::to_vec(&completed)?.len() > MAX_SPEECH_FRAME_PAYLOAD_BYTES {
                    write_failure(
                        stream,
                        &diagnostics,
                        "completion_size",
                        &failure(
                            SpeechFailureCode::ProtocolMismatch,
                            "Qwen3-ASR runtime 返回的候选总量超过 256 KiB 上限",
                            false,
                        ),
                    )
                    .await?;
                    return stream.finish().await;
                }
                let evidence = SpeechCompletionEvidence {
                    recorded_at_millis: chrono::Utc::now().timestamp_millis(),
                    workspace_id: start.workspace_id.clone(),
                    request_id: start.request_id.clone(),
                    runtime: runtime_descriptor.clone(),
                    context_snapshot_id: completed.context_snapshot_id.clone(),
                    candidates: completed.candidates.clone(),
                    segments: completed.segments.clone().unwrap_or_default(),
                    score_kind: completed.score_kind,
                    scores_calibrated: completed.scores_calibrated,
                };
                let Some(logic) = services.state.logic.as_ref() else {
                    write_failure(
                        stream,
                        &diagnostics,
                        "feedback_evidence",
                        &failure(
                            SpeechFailureCode::RuntimeUnavailable,
                            "signed daemon application is unavailable",
                            true,
                        ),
                    )
                    .await?;
                    return stream.finish().await;
                };
                logic.remember_speech_completion(evidence).await?;
                tracing::info!(
                    event = "speech_completed",
                    request_id = %diagnostics.request_id,
                    correlation_id = %diagnostics.correlation_id,
                    runtime_id = %runtime_descriptor.id,
                    model_id = %runtime_descriptor.model,
                    implementation = %runtime_descriptor.implementation,
                    elapsed_ms = diagnostics.elapsed_ms(),
                    audio_duration_ms = completed.duration_ms,
                    audio_chunks = diagnostics.audio_chunks,
                    audio_bytes = diagnostics.audio_bytes,
                    partials = diagnostics.partials,
                    first_partial_ms = ?diagnostics.first_partial_ms,
                    candidates = completed.candidates.len(),
                    segments = completed.segments.as_ref().map(Vec::len).unwrap_or_default(),
                    score_kind = ?completed.score_kind,
                    scores_calibrated = completed.scores_calibrated,
                    "speech transcription completed without logging transcript content"
                );
                write_json(stream, SpeechFrameKind::Completed, &completed).await?;
                return stream.finish().await;
            }
        }

        let finish_timeout = async {
            match finish_deadline {
                Some(deadline) => tokio::time::sleep_until(deadline).await,
                None => std::future::pending::<()>().await,
            }
        };
        let client_idle = async {
            if !finishing && !remote_finished {
                tokio::time::sleep_until(client_idle_deadline).await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        tokio::select! {
            input = stream.next_input(), if !remote_finished => {
                match input? {
                    StreamInput::Chunk(bytes) => {
                        client_idle_deadline = tokio::time::Instant::now()
                            + std::time::Duration::from_secs(30);
                        match decoder.push(&bytes) {
                            Ok(frames) => pending.extend(frames),
                            Err(_) => {
                                let _ = runtime.send(RuntimeCommand::Cancel).await;
                                write_failure(stream, &diagnostics, "client_decode", &failure(
                                    SpeechFailureCode::ProtocolMismatch,
                                    "语音数据帧无效",
                                    false,
                                )).await?;
                                return stream.finish().await;
                            }
                        }
                    }
                    StreamInput::Fin => {
                        remote_finished = true;
                        if decoder.finish().is_err() || !finishing {
                            let _ = runtime.send(RuntimeCommand::Cancel).await;
                            tracing::info!(
                                event = "speech_canceled",
                                request_id = %diagnostics.request_id,
                                correlation_id = %diagnostics.correlation_id,
                                stage = "stream_finished_before_request",
                                elapsed_ms = diagnostics.elapsed_ms(),
                                audio_chunks = diagnostics.audio_chunks,
                                audio_bytes = diagnostics.audio_bytes,
                                "speech client closed before a complete Finish frame"
                            );
                            return stream.finish().await;
                        }
                    }
                    StreamInput::Reset(_) => {
                        let _ = runtime.send(RuntimeCommand::Cancel).await;
                        tracing::info!(
                            event = "speech_canceled",
                            request_id = %diagnostics.request_id,
                            correlation_id = %diagnostics.correlation_id,
                            stage = "stream_reset",
                            elapsed_ms = diagnostics.elapsed_ms(),
                            "speech stream was reset by its client"
                        );
                        return Ok(());
                    }
                }
            }
            event = runtime.events.recv(), if result.is_none() => {
                let Some(event) = event else {
                    write_failure(stream, &diagnostics, "runtime_closed", &failure(
                        SpeechFailureCode::RuntimeUnavailable,
                        "Qwen3-ASR runtime 在返回结果前结束",
                        true,
                    )).await?;
                    return stream.finish().await;
                };
                match event {
                    RuntimeEvent::ContextApplied { revision } => {
                        write_json(
                            stream,
                            SpeechFrameKind::ContextApplied,
                            &serde_json::json!({ "revision": revision }),
                        ).await?;
                    }
                    RuntimeEvent::Partial(partial) => {
                        if let Err(error) = validate_runtime_partial(
                            &partial,
                            &start,
                            duration_ms,
                            &mut partial_revision,
                            &runtime_capabilities,
                        ) {
                            write_failure(stream, &diagnostics, "runtime_partial", &failure(
                                SpeechFailureCode::ProtocolMismatch,
                                format!("语音 runtime 返回了无效 partial：{error}"),
                                false,
                            )).await?;
                            return stream.finish().await;
                        }
                        if diagnostics.record_partial() {
                            tracing::info!(
                                event = "speech_first_partial",
                                request_id = %diagnostics.request_id,
                                correlation_id = %diagnostics.correlation_id,
                                elapsed_ms = diagnostics.first_partial_ms.unwrap_or_default(),
                                revision = partial.revision,
                                audio_end_ms = partial.audio_end_ms,
                                stable_prefix_chars = partial.stable_prefix_chars,
                                transcript_chars = partial.text.chars().count(),
                                "speech emitted its first partial without logging text"
                            );
                        }
                        write_json(stream, SpeechFrameKind::Partial, &partial).await?;
                    }
                    RuntimeEvent::Completed {
                        request_id,
                        duration_ms: reported_duration_ms,
                        context_snapshot_id: reported_context_snapshot_id,
                        candidates,
                        segments,
                        score_kind,
                        scores_calibrated,
                    } => {
                        if let Err(error) = validate_runtime_candidates(&candidates)
                            .and_then(|default| validate_runtime_segments(&segments, default, duration_ms))
                            .and_then(|_| validate_runtime_result(
                                &runtime_capabilities,
                                &start.request_id,
                                &request_id,
                                duration_ms,
                                reported_duration_ms,
                                &context_snapshot_id,
                                &reported_context_snapshot_id,
                                &candidates,
                                &segments,
                                score_kind,
                                scores_calibrated,
                            ))
                        {
                            write_failure(stream, &diagnostics, "runtime_completion", &failure(
                                SpeechFailureCode::ProtocolMismatch,
                                format!("Qwen3-ASR runtime 返回了无效候选：{error}"),
                                false,
                            )).await?;
                            return stream.finish().await;
                        }
                        result = Some((candidates, segments, score_kind, scores_calibrated));
                    }
                    RuntimeEvent::Failed(error) => {
                        write_failure(stream, &diagnostics, "runtime_reported", &error).await?;
                        return stream.finish().await;
                    }
                }
            }
            _ = finish_timeout => {
                let _ = runtime.send(RuntimeCommand::Cancel).await;
                write_failure(stream, &diagnostics, "final_timeout", &failure(
                    SpeechFailureCode::Timeout,
                    "停止录音后等待 Qwen3-ASR 最终结果超时",
                    true,
                )).await?;
                return stream.finish().await;
            }
            _ = client_idle => {
                let _ = runtime.send(RuntimeCommand::Cancel).await;
                write_failure(stream, &diagnostics, "client_idle", &failure(
                    SpeechFailureCode::Timeout,
                    "语音输入等待音频超时",
                    true,
                )).await?;
                return stream.finish().await;
            }
        }
    }
}

fn validate_start(start: &SpeechStart) -> Result<()> {
    if !valid_speech_request_id(&start.request_id) {
        anyhow::bail!("speech request id must contain only ASCII letters, digits, '-' or '_'");
    }
    if start.audio != SpeechAudioFormat::default() {
        anyhow::bail!("speech audio must be mono 16 kHz PCM s16le");
    }
    if start.context_revision == 0 {
        anyhow::bail!("speech context revision must start above zero");
    }
    validate_context(&start.context)?;
    if start.language_hints.len() > MAX_LANGUAGE_HINTS
        || start
            .language_hints
            .iter()
            .any(|language| !SUPPORTED_LANGUAGES.contains(&language.as_str()))
    {
        anyhow::bail!("unsupported speech language hint");
    }
    Ok(())
}

fn validate_context(context: &SpeechContextPack) -> Result<()> {
    if serde_json::to_vec(context)?.len() > MAX_SPEECH_CONTEXT_BYTES {
        anyhow::bail!("Qwen3 speech context exceeds its byte budget");
    }
    if context.prompt.chars().count() > MAX_SPEECH_PROMPT_CHARS {
        anyhow::bail!("Qwen3 speech prompt exceeds its character budget");
    }
    if context.terms.len() > MAX_PINNED_TERMS + MAX_AUTOMATIC_TERMS
        || context.terms.iter().any(|term| {
            term.text.trim().is_empty() || term.text.chars().count() > 64 || !term.score.is_finite()
        })
    {
        anyhow::bail!("Qwen3 speech terms exceed their budget");
    }
    Ok(())
}

fn validate_runtime_candidates(candidates: &[SpeechCandidate]) -> Result<&SpeechCandidate> {
    if candidates.is_empty() || candidates.len() > MAX_SPEECH_CANDIDATES {
        anyhow::bail!("candidate count is out of range");
    }
    let mut ids = HashSet::new();
    let mut ranks = HashSet::new();
    let mut texts = HashSet::new();
    for candidate in candidates {
        if candidate.candidate_id.is_empty()
            || candidate.candidate_id.len() > 128
            || candidate.candidate_id.chars().any(char::is_control)
            || !ids.insert(candidate.candidate_id.as_str())
            || candidate.rank == 0
            || candidate.rank as usize > MAX_SPEECH_CANDIDATES
            || !ranks.insert(candidate.rank)
            || candidate.text.trim().is_empty()
            || candidate.text.chars().count() > MAX_SPEECH_TRANSCRIPT_CHARS
            || !texts.insert(candidate.text.trim())
            || !candidate.score.is_finite()
            || candidate.matched_terms.len() > 20
            || candidate.matched_terms.iter().any(|term| {
                term.trim().is_empty()
                    || term.chars().count() > 64
                    || term.chars().any(char::is_control)
                    || !candidate.text.contains(term)
            })
        {
            anyhow::bail!("candidate identity, text, score or terms are invalid");
        }
    }
    if !(1..=candidates.len()).all(|rank| ranks.contains(&(rank as u8))) {
        anyhow::bail!("candidate ranks must be contiguous from 1");
    }
    candidates
        .iter()
        .find(|candidate| candidate.rank == 1)
        .ok_or_else(|| anyhow::anyhow!("candidate rank 1 is missing"))
}

fn validate_runtime_segments(
    segments: &[SpeechSegment],
    utterance_default: &SpeechCandidate,
    duration_ms: u32,
) -> Result<()> {
    if segments.is_empty() {
        return Ok(());
    }
    if segments.len() > MAX_SPEECH_SEGMENTS {
        anyhow::bail!("segment count is out of range");
    }
    let utterance = utterance_default.text.chars().collect::<Vec<_>>();
    let mut segment_ids = HashSet::new();
    let mut candidate_ids = HashSet::new();
    let mut span_ids = HashSet::new();
    let mut previous_text_end = 0usize;
    let mut previous_audio_end = 0u32;
    let mut candidate_chars = 0usize;
    let mut maximum_composed_chars = 0usize;

    for (index, segment) in segments.iter().enumerate() {
        let text_start = segment.text_start_char as usize;
        let text_end = segment.text_end_char as usize;
        if segment.segment_id.is_empty()
            || segment.segment_id.len() > 128
            || segment.segment_id.chars().any(char::is_control)
            || !segment_ids.insert(segment.segment_id.as_str())
            || segment.start_ms > segment.end_ms
            || segment.end_ms > duration_ms
            || segment.start_ms < previous_audio_end
            || text_start != previous_text_end
            || text_start >= text_end
            || text_end > utterance.len()
            || utterance[text_start..text_end].iter().collect::<String>() != segment.text
            || !segment.boundary.confidence.is_finite()
            || !(0.0..=1.0).contains(&segment.boundary.confidence)
        {
            anyhow::bail!("segment identity, timing, text range or boundary is invalid");
        }
        if (index + 1 == segments.len())
            != matches!(
                segment.boundary.kind,
                genehub_proto::SpeechSegmentBoundaryKind::Final
            )
        {
            anyhow::bail!("only the last segment may carry the final boundary");
        }

        let default = validate_runtime_candidates(&segment.candidates)?;
        if default.candidate_id != segment.default_candidate_id || default.text != segment.text {
            anyhow::bail!("segment default candidate does not match its text");
        }
        for candidate in &segment.candidates {
            if !candidate_ids.insert(candidate.candidate_id.as_str()) {
                anyhow::bail!("segment candidate ids must be globally unique");
            }
            candidate_chars = candidate_chars.saturating_add(candidate.text.chars().count());
        }
        maximum_composed_chars = maximum_composed_chars.saturating_add(
            segment
                .candidates
                .iter()
                .map(|candidate| candidate.text.chars().count())
                .max()
                .expect("validated non-empty segment candidates"),
        );
        if candidate_chars > MAX_SPEECH_SEGMENT_CANDIDATE_CHARS {
            anyhow::bail!("segment candidate text exceeds its total budget");
        }

        let segment_chars = segment.text.chars().collect::<Vec<_>>();
        let segment_candidate_ids = segment
            .candidates
            .iter()
            .map(|candidate| candidate.candidate_id.as_str())
            .collect::<HashSet<_>>();
        let mut previous_span_end = 0usize;
        if segment.uncertain_spans.len() > MAX_SPEECH_UNCERTAIN_SPANS {
            anyhow::bail!("segment has too many uncertain spans");
        }
        for span in &segment.uncertain_spans {
            let span_start = span.start_char as usize;
            let span_end = span.end_char as usize;
            if span.span_id.is_empty()
                || span.span_id.len() > 128
                || span.span_id.chars().any(char::is_control)
                || !span_ids.insert(span.span_id.as_str())
                || span_start < previous_span_end
                || span_start >= span_end
                || span_end > segment_chars.len()
                || !(2..=MAX_SPEECH_CANDIDATES).contains(&span.alternatives.len())
            {
                anyhow::bail!("uncertain span identity or range is invalid");
            }
            let mut alternative_ids = HashSet::new();
            let mut alternative_candidates = HashSet::new();
            for alternative in &span.alternatives {
                let candidate = segment
                    .candidates
                    .iter()
                    .find(|candidate| candidate.candidate_id == alternative.candidate_id);
                if alternative.alternative_id.is_empty()
                    || alternative.alternative_id.len() > 128
                    || alternative.alternative_id.chars().any(char::is_control)
                    || !alternative_ids.insert(alternative.alternative_id.as_str())
                    || !alternative_candidates.insert(alternative.candidate_id.as_str())
                    || !segment_candidate_ids.contains(alternative.candidate_id.as_str())
                    || alternative.text.trim().is_empty()
                    || alternative.text.chars().count() > 256
                    || !alternative.score.is_finite()
                    || candidate.is_none_or(|candidate| !candidate.text.contains(&alternative.text))
                {
                    anyhow::bail!("uncertain span alternative is invalid");
                }
            }
            let Some(default_alternative) = span
                .alternatives
                .iter()
                .find(|alternative| alternative.alternative_id == span.default_alternative_id)
            else {
                anyhow::bail!("uncertain span has no default alternative");
            };
            if default_alternative.candidate_id != segment.default_candidate_id
                || segment_chars[span_start..span_end]
                    .iter()
                    .collect::<String>()
                    != default_alternative.text
            {
                anyhow::bail!("uncertain span default does not match segment text");
            }
            previous_span_end = span_end;
        }

        previous_text_end = text_end;
        previous_audio_end = segment.end_ms;
    }
    if previous_text_end != utterance.len() {
        anyhow::bail!("segments do not cover the complete utterance text");
    }
    if maximum_composed_chars > MAX_SPEECH_TRANSCRIPT_CHARS {
        anyhow::bail!("segment alternatives can compose an oversized transcript");
    }
    Ok(())
}

fn validate_runtime_partial(
    partial: &SpeechPartial,
    start: &SpeechStart,
    received_duration_ms: u32,
    previous_revision: &mut u32,
    capabilities: &SpeechRuntimeCapabilities,
) -> Result<()> {
    let text_chars = partial.text.chars().count();
    if !start.accept_partial || !capabilities.segmentation.partial_results {
        anyhow::bail!("partial was not negotiated");
    }
    if partial.request_id != start.request_id
        || partial.revision == 0
        || partial.revision <= *previous_revision
        || text_chars > MAX_SPEECH_TRANSCRIPT_CHARS
        || partial.audio_end_ms > received_duration_ms
        || partial.stable_prefix_chars as usize > text_chars
    {
        anyhow::bail!("partial identity, revision, text or audio boundary is invalid");
    }
    *previous_revision = partial.revision;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_runtime_result(
    capabilities: &SpeechRuntimeCapabilities,
    expected_request_id: &str,
    request_id: &str,
    expected_duration_ms: u32,
    duration_ms: u32,
    expected_context_snapshot_id: &str,
    context_snapshot_id: &str,
    candidates: &[SpeechCandidate],
    segments: &[SpeechSegment],
    score_kind: SpeechScoreKind,
    scores_calibrated: bool,
) -> Result<()> {
    if request_id != expected_request_id
        || duration_ms != expected_duration_ms
        || context_snapshot_id != expected_context_snapshot_id
    {
        anyhow::bail!(
            "completion identity, duration or context snapshot does not match the request"
        );
    }
    if candidates.len() > capabilities.n_best.max_candidates as usize
        || score_kind != capabilities.n_best.score_kind
        || scores_calibrated != capabilities.n_best.calibrated
    {
        anyhow::bail!("completion exceeds or contradicts declared N-best capabilities");
    }
    if segments.len() > capabilities.segmentation.max_segments as usize {
        anyhow::bail!("completion exceeds declared segmentation capabilities");
    }
    if !capabilities.segmentation.local_n_best
        && segments.iter().any(|segment| segment.candidates.len() > 1)
    {
        anyhow::bail!("runtime returned local N-best without declaring it");
    }
    if !capabilities.segmentation.uncertain_spans
        && segments
            .iter()
            .any(|segment| !segment.uncertain_spans.is_empty())
    {
        anyhow::bail!("runtime returned uncertain spans without declaring them");
    }
    Ok(())
}

#[derive(Debug)]
enum ClientOutcome {
    Continue,
    Finish,
    Cancel,
}

#[derive(serde::Deserialize)]
struct SpeechCancelPayload {
    reason: SpeechCancelReason,
}

async fn apply_client_frame(
    frame: SpeechFrame,
    runtime: &RuntimeSession,
    expected_index: &mut u32,
    duration_ms: &mut u32,
    context_revision: &mut u32,
    context_snapshot_id: &mut String,
    finishing: &mut bool,
) -> Result<ClientOutcome, SpeechFailure> {
    if !frame.kind.client_to_daemon() || frame.kind == SpeechFrameKind::Start {
        return Err(failure(
            SpeechFailureCode::ProtocolMismatch,
            "语音消息方向或顺序无效",
            false,
        ));
    }
    if *finishing && !matches!(frame.kind, SpeechFrameKind::Cancel) {
        return Err(failure(
            SpeechFailureCode::ProtocolMismatch,
            "停止录音后不能再发送语音数据",
            false,
        ));
    }
    match frame.kind {
        SpeechFrameKind::Audio => {
            let (index, capture_start_ms, chunk_ms, pcm) =
                decode_speech_audio(&frame).map_err(|_| {
                    failure(SpeechFailureCode::ProtocolMismatch, "语音音频帧无效", false)
                })?;
            let expected_bytes = 16_000usize * 2 * chunk_ms as usize / 1_000;
            if index != *expected_index
                || capture_start_ms != *duration_ms
                || !(MIN_AUDIO_CHUNK_MS..=MAX_AUDIO_CHUNK_MS).contains(&chunk_ms)
                || pcm.len() != expected_bytes
            {
                return Err(failure(
                    SpeechFailureCode::ProtocolMismatch,
                    "语音音频块不连续或格式不正确",
                    false,
                ));
            }
            *duration_ms = duration_ms.saturating_add(chunk_ms as u32);
            if *duration_ms > MAX_SPEECH_DURATION_MS {
                return Err(failure(
                    SpeechFailureCode::ProtocolMismatch,
                    "单次语音输入不能超过 5 分钟",
                    false,
                ));
            }
            *expected_index = expected_index.saturating_add(1);
            runtime
                .send(RuntimeCommand::Audio {
                    index,
                    capture_start_ms,
                    pcm: pcm.to_vec(),
                    duration_ms: chunk_ms,
                })
                .await?;
            Ok(ClientOutcome::Continue)
        }
        SpeechFrameKind::ContextUpdate => {
            let update: SpeechContextUpdate = decode_speech_json(&frame).map_err(|_| {
                failure(
                    SpeechFailureCode::ProtocolMismatch,
                    "Qwen3 上下文更新无效",
                    false,
                )
            })?;
            if update.revision <= *context_revision || validate_context(&update.context).is_err() {
                return Err(failure(
                    SpeechFailureCode::ContextRejected,
                    "Qwen3 上下文更新超出预算或版本倒退",
                    false,
                ));
            }
            *context_revision = update.revision;
            *context_snapshot_id = update.context.snapshot_id.clone();
            runtime
                .send(RuntimeCommand::Context {
                    revision: update.revision,
                    context: update.context,
                })
                .await?;
            Ok(ClientOutcome::Continue)
        }
        SpeechFrameKind::Finish => {
            if !frame.payload.is_empty() {
                return Err(failure(
                    SpeechFailureCode::ProtocolMismatch,
                    "Finish 消息不能携带内容",
                    false,
                ));
            }
            *finishing = true;
            runtime.send(RuntimeCommand::Finish).await?;
            Ok(ClientOutcome::Finish)
        }
        SpeechFrameKind::Cancel => {
            let cancel: SpeechCancelPayload = decode_speech_json(&frame).map_err(|_| {
                failure(
                    SpeechFailureCode::ProtocolMismatch,
                    "Cancel 消息无效",
                    false,
                )
            })?;
            let _ = cancel.reason;
            runtime.send(RuntimeCommand::Cancel).await?;
            Ok(ClientOutcome::Cancel)
        }
        _ => Err(failure(
            SpeechFailureCode::ProtocolMismatch,
            "语音消息类型无效",
            false,
        )),
    }
}

async fn write_json<T: serde::Serialize>(
    stream: &mut ServerStream,
    kind: SpeechFrameKind,
    value: &T,
) -> Result<()> {
    stream.write(&encode_speech_json(kind, value)?).await
}

async fn write_failure(
    stream: &mut ServerStream,
    diagnostics: &SpeechDiagnostics,
    stage: &'static str,
    error: &SpeechFailure,
) -> Result<()> {
    let error = diagnostics.correlated(error);
    diagnostics.log_failure(stage, &error);
    write_json(stream, SpeechFrameKind::Failed, &error).await
}

fn failure(code: SpeechFailureCode, message: impl Into<String>, retryable: bool) -> SpeechFailure {
    SpeechFailure {
        code,
        message: message.into(),
        retryable,
        retry_after_ms: None,
        correlation_id: None,
    }
}

const SUPPORTED_LANGUAGES: &[&str] = &[
    "zh", "yue", "en", "ja", "ko", "vi", "th", "id", "ms", "fil", "tl", "hi", "ar", "fr", "de",
    "es", "pt", "ru", "it", "nl", "sv", "da", "fi", "no", "el", "pl", "cs", "hu", "ro", "bg", "hr",
    "sk", "tr", "fa", "mk", "et", "lv", "lt", "mt", "sl", "uk",
];

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::{
        encode_speech_audio, encode_speech_frame, encode_speech_json, SpeechEncoding,
    };

    fn decode_one(wire: Vec<u8>) -> SpeechFrame {
        SpeechFrameDecoder::default().push(&wire).unwrap().remove(0)
    }

    fn runtime_session() -> (RuntimeSession, mpsc::Receiver<RuntimeCommand>) {
        let (commands, receiver) = mpsc::channel(4);
        let (_event_sender, events) = mpsc::channel(4);
        (
            RuntimeSession {
                capabilities: stub_runtime_capabilities(),
                commands,
                events,
            },
            receiver,
        )
    }

    #[test]
    fn settings_are_qwen3_local_and_bounded() {
        assert!(validate_settings(vec!["GeneHub".into()], vec!["zh".into(), "en".into()]).is_ok());
        assert!(validate_settings(vec![], vec!["invented".into()]).is_err());
        let defaults = settings(&SpeechConfig::default());
        assert_eq!(defaults.runtime.id, "unconfigured");
        assert_eq!(defaults.runtime.implementation, "unconfigured");
        assert!(!defaults.stub_enabled);
        let stub = SpeechConfig {
            stub_enabled: true,
            ..SpeechConfig::default()
        };
        let settings = settings(&stub);
        assert_eq!(settings.runtime.id, "genehub-speech-stub");
        assert_eq!(settings.runtime.implementation, "stub");
        assert!(settings.stub_enabled);
    }

    #[test]
    fn capabilities_are_offline_nbest_without_realtime_claims() {
        let capabilities = mock_capabilities();
        assert_eq!(capabilities.audio, vec![SpeechAudioFormat::default()]);
        assert_eq!(capabilities.audio[0].encoding, SpeechEncoding::PcmS16Le);
        assert_eq!(capabilities.max_duration_ms, 300_000);
        assert_eq!(capabilities.n_best.max_candidates, 5);
        assert!(!capabilities.n_best.calibrated);
        assert!(capabilities.segmentation.partial_results);
        assert_eq!(capabilities.runtime.implementation, "stub");
    }

    #[tokio::test]
    async fn persisted_stub_selection_switches_runtime_without_an_external_registration() {
        let broker = SpeechBroker::new();
        let mut config = SpeechConfig {
            stub_enabled: true,
            ..SpeechConfig::default()
        };
        let stub = broker.capabilities(&config).await;
        assert_eq!(stub.runtime_status, SpeechRuntimeStatus::Ready);
        assert_eq!(stub.runtime.implementation, "stub");

        config.stub_enabled = false;
        let external = broker.capabilities(&config).await;
        assert!(matches!(
            external.runtime_status,
            SpeechRuntimeStatus::Unavailable { .. }
        ));
        assert_eq!(external.runtime.implementation, "unconfigured");
    }

    #[test]
    fn external_capabilities_must_not_fake_nbest_or_mock_scores() {
        let mut capabilities = stub_runtime_capabilities();
        capabilities.runtime.implementation = "community-adapter/1".into();
        capabilities.n_best.max_candidates = 1;
        capabilities.n_best.score_kind = SpeechScoreKind::Unavailable;
        capabilities.segmentation.max_segments = 0;
        capabilities.segmentation.local_n_best = false;
        capabilities.segmentation.uncertain_spans = false;
        assert!(validate_runtime_capabilities(&capabilities).is_ok());

        capabilities.segmentation.uncertain_spans = true;
        assert!(validate_runtime_capabilities(&capabilities).is_err());
        capabilities.segmentation.uncertain_spans = false;
        capabilities.n_best.score_kind = SpeechScoreKind::MockRelative;
        assert!(validate_runtime_capabilities(&capabilities).is_err());
    }

    #[test]
    fn segment_alternatives_cannot_compose_beyond_the_transcript_budget() {
        let whole = SpeechCandidate {
            candidate_id: "whole-1".into(),
            rank: 1,
            text: "ab".into(),
            score: -0.1,
            matched_terms: vec![],
        };
        let segments = vec![
            SpeechSegment {
                segment_id: "s1".into(),
                start_ms: 0,
                end_ms: 1,
                text_start_char: 0,
                text_end_char: 1,
                text: "a".into(),
                candidates: vec![
                    SpeechCandidate {
                        candidate_id: "s1-1".into(),
                        rank: 1,
                        text: "a".into(),
                        score: -0.1,
                        matched_terms: vec![],
                    },
                    SpeechCandidate {
                        candidate_id: "s1-2".into(),
                        rank: 2,
                        text: "x".repeat(MAX_SPEECH_TRANSCRIPT_CHARS),
                        score: -0.2,
                        matched_terms: vec![],
                    },
                ],
                default_candidate_id: "s1-1".into(),
                uncertain_spans: vec![],
                boundary: genehub_proto::SpeechSegmentBoundary {
                    kind: genehub_proto::SpeechSegmentBoundaryKind::DecoderEndpoint,
                    confidence: 0.9,
                },
            },
            SpeechSegment {
                segment_id: "s2".into(),
                start_ms: 1,
                end_ms: 2,
                text_start_char: 1,
                text_end_char: 2,
                text: "b".into(),
                candidates: vec![SpeechCandidate {
                    candidate_id: "s2-1".into(),
                    rank: 1,
                    text: "b".into(),
                    score: -0.1,
                    matched_terms: vec![],
                }],
                default_candidate_id: "s2-1".into(),
                uncertain_spans: vec![],
                boundary: genehub_proto::SpeechSegmentBoundary {
                    kind: genehub_proto::SpeechSegmentBoundaryKind::Final,
                    confidence: 1.0,
                },
            },
        ];

        assert!(validate_runtime_segments(&segments, &whole, 2).is_err());
    }

    #[tokio::test]
    async fn client_state_enforces_contiguous_audio_and_finish() {
        let (runtime, mut commands) = runtime_session();
        let mut expected_index = 0;
        let mut duration_ms = 0;
        let mut context_revision = 1;
        let mut context_snapshot_id = "sc_1".to_string();
        let mut finishing = false;

        let audio = decode_one(encode_speech_audio(0, 0, 100, &vec![0; 3_200]).unwrap());
        assert!(matches!(
            apply_client_frame(
                audio,
                &runtime,
                &mut expected_index,
                &mut duration_ms,
                &mut context_revision,
                &mut context_snapshot_id,
                &mut finishing,
            )
            .await
            .unwrap(),
            ClientOutcome::Continue
        ));
        assert!(matches!(
            commands.recv().await,
            Some(RuntimeCommand::Audio { index: 0, capture_start_ms: 0, pcm, duration_ms: 100 }) if pcm.len() == 3_200
        ));

        let finish = decode_one(encode_speech_frame(SpeechFrameKind::Finish, &[]).unwrap());
        assert!(matches!(
            apply_client_frame(
                finish,
                &runtime,
                &mut expected_index,
                &mut duration_ms,
                &mut context_revision,
                &mut context_snapshot_id,
                &mut finishing,
            )
            .await
            .unwrap(),
            ClientOutcome::Finish
        ));
        assert!(matches!(
            commands.recv().await,
            Some(RuntimeCommand::Finish)
        ));
    }

    #[tokio::test]
    async fn cancel_requires_a_known_reason() {
        let (runtime, _commands) = runtime_session();
        let mut expected_index = 0;
        let mut duration_ms = 0;
        let mut context_revision = 1;
        let mut context_snapshot_id = "sc_1".to_string();
        let mut finishing = false;
        let cancel = decode_one(
            encode_speech_json(
                SpeechFrameKind::Cancel,
                &serde_json::json!({ "reason": "invented" }),
            )
            .unwrap(),
        );

        let error = apply_client_frame(
            cancel,
            &runtime,
            &mut expected_index,
            &mut duration_ms,
            &mut context_revision,
            &mut context_snapshot_id,
            &mut finishing,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, SpeechFailureCode::ProtocolMismatch);
    }
}
