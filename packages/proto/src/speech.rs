//! Qwen3-ASR speech-to-text contracts.
//!
//! `speech.transcribe` is an application stream carried by the existing
//! protocol-v3 data plane. GeneHub owns this UI/wire contract, not the model
//! process: the built-in deterministic protocol Stub and a community PC runtime use the
//! same boundary.

use std::fmt;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use ts_rs::TS;

pub const SPEECH_PROTOCOL_VERSION: u16 = 2;
pub const SPEECH_FRAME_VERSION: u8 = 2;
pub const SPEECH_FRAME_HEADER_BYTES: usize = 8;
pub const MAX_SPEECH_FRAME_PAYLOAD_BYTES: usize = 256 * 1024;
pub const MAX_SPEECH_CONTEXT_BYTES: usize = 16 * 1024;
pub const MAX_SPEECH_PROMPT_CHARS: usize = 4_000;
pub const MAX_SPEECH_DURATION_MS: u32 = 5 * 60 * 1_000;
pub const MAX_SPEECH_CANDIDATES: usize = 5;
pub const MAX_SPEECH_TRANSCRIPT_CHARS: usize = 4_000;
pub const MAX_SPEECH_SEGMENTS: usize = 32;
pub const MAX_SPEECH_UNCERTAIN_SPANS: usize = 12;
pub const MAX_SPEECH_SEGMENT_CANDIDATE_CHARS: usize = 16_000;

pub const SPEECH_TRANSCRIBE_METHOD: &str = "speech.transcribe";
pub const SPEECH_FEATURE_TRANSCRIBE: &str = "speech.transcribe.v2";
pub const SPEECH_FEATURE_PARTIAL: &str = "speech.transcribe.partial.v1";
pub const SPEECH_FEATURE_CONTEXT_PREVIEW: &str = "speech.context.preview.v2";
pub const SPEECH_FEATURE_FEEDBACK: &str = "speech.feedback.v2";
pub const SPEECH_RUNTIME_CAPABILITIES_SCHEMA: &str = "genehub.speech-runtime.capabilities.v1";
pub const SPEECH_RUNTIME_ID: &str = "qwen3-asr";
pub const SPEECH_MODEL_ID: &str = "Qwen3-ASR-1.7B";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum SpeechRuntimeStatus {
    Ready,
    #[serde(rename_all = "camelCase")]
    Unavailable {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechRuntimeDescriptor {
    pub id: String,
    pub model: String,
    pub label: String,
    /// `stub` identifies GeneHub's no-model protocol test runtime; a community
    /// adapter reports its own stable implementation identifier.
    pub implementation: String,
}

impl Default for SpeechRuntimeDescriptor {
    fn default() -> Self {
        Self {
            id: SPEECH_RUNTIME_ID.to_string(),
            model: SPEECH_MODEL_ID.to_string(),
            label: "Qwen3-ASR 1.7B".to_string(),
            implementation: "mock".to_string(),
        }
    }
}

/// Machine-local Qwen3 prompt and preference settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechSettings {
    pub runtime: SpeechRuntimeDescriptor,
    /// The deterministic no-model protocol Stub is selected instead of the
    /// registered community runtime. Stub output is never training evidence.
    #[serde(default)]
    pub stub_enabled: bool,
    pub context_enabled: bool,
    pub pinned_terms: Vec<String>,
    pub language_hints: Vec<String>,
    /// Legacy machine-wide flag retained on the wire for clients that predate
    /// project-scoped consent. New daemons always return false and use
    /// `correction_workspaces` instead.
    pub collect_corrections: bool,
    /// Stable workspace ids for which the user explicitly enabled local
    /// preference collection. Consent for one project must never silently
    /// enable collection in another project on the same machine.
    #[serde(default)]
    pub correction_workspaces: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum SpeechEncoding {
    PcmS16Le,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechAudioFormat {
    pub encoding: SpeechEncoding,
    pub sample_rate_hz: u32,
    pub channels: u8,
}

impl Default for SpeechAudioFormat {
    fn default() -> Self {
        Self {
            encoding: SpeechEncoding::PcmS16Le,
            sample_rate_hz: 16_000,
            channels: 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum SpeechContextSource {
    Pinned,
    Correction,
    ProjectConfig,
    Workspace,
    ProjectFile,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechContextTerm {
    pub text: String,
    pub source: SpeechContextSource,
    pub score: f32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechContextOmissions {
    pub pinned_terms: u32,
    pub automatic_terms: u32,
    pub messages: u32,
    pub project_index_unavailable: bool,
    pub project_context_truncated: bool,
}

/// The exact bounded Qwen3 prompt snapshot used for one transcription.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechContextPack {
    pub snapshot_id: String,
    pub prompt: String,
    pub terms: Vec<SpeechContextTerm>,
    pub language_hints: Vec<String>,
    pub compiler_version: String,
    pub omitted: SpeechContextOmissions,
}

impl SpeechContextPack {
    pub fn empty() -> Self {
        Self {
            snapshot_id: "speech-context-empty".to_string(),
            prompt: String::new(),
            terms: Vec::new(),
            language_hints: Vec::new(),
            compiler_version: "qwen3-context-v1".to_string(),
            omitted: SpeechContextOmissions::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechContextLimits {
    pub max_bytes: u32,
    pub max_prompt_chars: u32,
    pub max_pinned_terms: u16,
    pub max_automatic_terms: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum SpeechScoreKind {
    /// The runtime exposes Best-1 only and does not claim comparable scores.
    Unavailable,
    /// Honest marker for the deterministic no-model development runtime.
    MockRelative,
    /// Expected score shape for a future Qwen3 beam-search adapter.
    LengthNormalizedLogProbability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechNBestCapabilities {
    pub max_candidates: u8,
    pub score_kind: SpeechScoreKind,
    pub calibrated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechSegmentationCapabilities {
    pub max_segments: u8,
    /// Whether the runtime can return revisioned Best-1 replacements while
    /// audio is arriving. Segments and candidate review remain final-only.
    pub partial_results: bool,
    pub local_n_best: bool,
    pub uncertain_spans: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechCapabilities {
    pub protocol_version: u16,
    pub runtime_status: SpeechRuntimeStatus,
    pub runtime: SpeechRuntimeDescriptor,
    pub audio: Vec<SpeechAudioFormat>,
    pub languages: Vec<String>,
    pub max_language_hints: u8,
    pub max_duration_ms: u32,
    pub context: SpeechContextLimits,
    pub n_best: SpeechNBestCapabilities,
    pub segmentation: SpeechSegmentationCapabilities,
}

/// The bounded document printed by a community runtime for
/// `--genehub-probe`. GeneHub validates every field before advertising it to a
/// client; installing the model and implementing this adapter remain outside
/// the GeneHub distribution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechRuntimeCapabilities {
    pub schema: String,
    pub speech_protocol_version: u16,
    pub runtime: SpeechRuntimeDescriptor,
    pub audio: Vec<SpeechAudioFormat>,
    pub languages: Vec<String>,
    pub max_language_hints: u8,
    pub max_duration_ms: u32,
    pub n_best: SpeechNBestCapabilities,
    pub segmentation: SpeechSegmentationCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechStart {
    pub request_id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_id: Option<String>,
    pub audio: SpeechAudioFormat,
    pub language_hints: Vec<String>,
    pub context: SpeechContextPack,
    pub context_revision: u32,
    /// Older v2 clients omit this and receive only the final result. New
    /// clients opt in so adding Partial does not break an already shipped
    /// decoder.
    #[serde(default)]
    pub accept_partial: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechContextUpdate {
    pub revision: u32,
    pub context: SpeechContextPack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum SpeechCancelReason {
    User,
    PageHidden,
    TargetChanged,
    ClientBackpressure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechReady {
    pub request_id: String,
    pub runtime_id: String,
    pub model_id: String,
    pub context_revision: u32,
}

/// A complete replacement for the current Best-1 preview. Revisions increase
/// monotonically within one request; `stable_prefix_chars` uses Unicode scalar
/// offsets and tells the UI which prefix the runtime does not expect to revise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechPartial {
    pub request_id: String,
    pub revision: u32,
    pub text: String,
    pub audio_end_ms: u32,
    pub stable_prefix_chars: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechCandidate {
    pub candidate_id: String,
    pub rank: u8,
    pub text: String,
    pub score: f32,
    pub matched_terms: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum SpeechSegmentBoundaryKind {
    VoiceActivity,
    DecoderEndpoint,
    MaxDuration,
    Final,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechSegmentBoundary {
    pub kind: SpeechSegmentBoundaryKind,
    pub confidence: f32,
}

/// One alternative for a locally ambiguous character span. `candidate_id`
/// references a candidate in the containing segment, so choosing a span never
/// needs to replace unrelated segments in the utterance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechSpanAlternative {
    pub alternative_id: String,
    pub candidate_id: String,
    pub text: String,
    pub score: f32,
}

/// Character offsets are Unicode scalar-value offsets inside the segment's
/// default text, not UTF-8 bytes or JavaScript UTF-16 code units.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechUncertainSpan {
    pub span_id: String,
    pub start_char: u32,
    pub end_char: u32,
    pub alternatives: Vec<SpeechSpanAlternative>,
    pub default_alternative_id: String,
}

/// A final acoustic/linguistic segment. Text character offsets locate the
/// segment inside `SpeechCompleted.text`; time offsets locate it in the one
/// recording. Segment alternatives are full segment strings, while
/// `uncertain_spans` makes the local disagreement directly reviewable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechSegment {
    pub segment_id: String,
    pub start_ms: u32,
    pub end_ms: u32,
    pub text_start_char: u32,
    pub text_end_char: u32,
    pub text: String,
    pub candidates: Vec<SpeechCandidate>,
    pub default_candidate_id: String,
    pub uncertain_spans: Vec<SpeechUncertainSpan>,
    pub boundary: SpeechSegmentBoundary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechCompleted {
    pub request_id: String,
    pub text: String,
    pub duration_ms: u32,
    pub context_snapshot_id: String,
    pub candidates: Vec<SpeechCandidate>,
    pub default_candidate_id: String,
    pub score_kind: SpeechScoreKind,
    pub scores_calibrated: bool,
    /// Optional for wire compatibility with clients and runtimes that only
    /// understand whole-utterance N-best.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub segments: Option<Vec<SpeechSegment>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum SpeechFeedbackLevel {
    Utterance,
    Segment,
    Span,
}

/// Conditioning retained with a preference pair. A segment/span correction
/// stays fine-grained while `utterance_text` and its neighbours preserve the
/// context needed by a later reranker or preference-tuning pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechFeedbackScope {
    pub level: SpeechFeedbackLevel,
    pub utterance_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub segment_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub segment_start_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub segment_end_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preceding_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub following_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub uncertain_span_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub span_start_char: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub span_end_char: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechFeedbackReceipt {
    pub stored: bool,
    pub learned_terms: Vec<String>,
    /// Stable id of the authoritative preference pair. It is safe to include
    /// in diagnostics and lets support correlate a UI report without copying
    /// transcript or candidate text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub feedback_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub relative_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum SpeechFailureCode {
    RuntimeUnavailable,
    UnsupportedLanguage,
    ContextRejected,
    Timeout,
    ProtocolMismatch,
    Canceled,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SpeechFailure {
    pub code: SpeechFailureCode,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub retry_after_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub correlation_id: Option<String>,
}

/// Values below 0x80 travel client-to-daemon; values at or above 0x80 travel
/// daemon-to-client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SpeechFrameKind {
    Start = 0x01,
    Audio = 0x02,
    ContextUpdate = 0x03,
    Finish = 0x04,
    Cancel = 0x05,
    Ready = 0x80,
    ContextApplied = 0x81,
    Completed = 0x82,
    Failed = 0x83,
    Partial = 0x84,
}

impl SpeechFrameKind {
    pub fn from_byte(value: u8) -> Option<Self> {
        Some(match value {
            0x01 => Self::Start,
            0x02 => Self::Audio,
            0x03 => Self::ContextUpdate,
            0x04 => Self::Finish,
            0x05 => Self::Cancel,
            0x80 => Self::Ready,
            0x81 => Self::ContextApplied,
            0x82 => Self::Completed,
            0x83 => Self::Failed,
            0x84 => Self::Partial,
            _ => return None,
        })
    }

    pub fn client_to_daemon(self) -> bool {
        (self as u8) < 0x80
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeechFrame {
    pub kind: SpeechFrameKind,
    pub flags: u16,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpeechCodecError {
    UnsupportedVersion(u8),
    UnknownKind(u8),
    NonZeroFlags(u16),
    PayloadTooLarge(usize),
    Truncated,
    InvalidJson(String),
    InvalidAudio,
}

impl fmt::Display for SpeechCodecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported speech frame version {version}")
            }
            Self::UnknownKind(kind) => write!(formatter, "unknown speech frame kind {kind}"),
            Self::NonZeroFlags(flags) => {
                write!(formatter, "unsupported speech frame flags {flags}")
            }
            Self::PayloadTooLarge(bytes) => {
                write!(
                    formatter,
                    "speech frame payload is too large ({bytes} bytes)"
                )
            }
            Self::Truncated => formatter.write_str("truncated speech frame"),
            Self::InvalidJson(error) => write!(formatter, "invalid speech JSON payload: {error}"),
            Self::InvalidAudio => formatter.write_str("invalid speech audio payload"),
        }
    }
}

impl std::error::Error for SpeechCodecError {}

#[derive(Debug, Default)]
pub struct SpeechFrameDecoder {
    buffered: Vec<u8>,
}

impl SpeechFrameDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<SpeechFrame>, SpeechCodecError> {
        self.buffered.extend_from_slice(bytes);
        let mut frames = Vec::new();
        loop {
            if self.buffered.len() < SPEECH_FRAME_HEADER_BYTES {
                break;
            }
            let version = self.buffered[0];
            if version != SPEECH_FRAME_VERSION {
                return Err(SpeechCodecError::UnsupportedVersion(version));
            }
            let raw_kind = self.buffered[1];
            let kind = SpeechFrameKind::from_byte(raw_kind)
                .ok_or(SpeechCodecError::UnknownKind(raw_kind))?;
            let flags = u16::from_be_bytes([self.buffered[2], self.buffered[3]]);
            if flags != 0 {
                return Err(SpeechCodecError::NonZeroFlags(flags));
            }
            let length = u32::from_be_bytes([
                self.buffered[4],
                self.buffered[5],
                self.buffered[6],
                self.buffered[7],
            ]) as usize;
            if length > MAX_SPEECH_FRAME_PAYLOAD_BYTES {
                return Err(SpeechCodecError::PayloadTooLarge(length));
            }
            let total = SPEECH_FRAME_HEADER_BYTES + length;
            if self.buffered.len() < total {
                break;
            }
            let payload = self.buffered[SPEECH_FRAME_HEADER_BYTES..total].to_vec();
            self.buffered.drain(..total);
            frames.push(SpeechFrame {
                kind,
                flags,
                payload,
            });
        }
        if self.buffered.len() > SPEECH_FRAME_HEADER_BYTES + MAX_SPEECH_FRAME_PAYLOAD_BYTES {
            return Err(SpeechCodecError::PayloadTooLarge(self.buffered.len()));
        }
        Ok(frames)
    }

    pub fn finish(&self) -> Result<(), SpeechCodecError> {
        if self.buffered.is_empty() {
            Ok(())
        } else {
            Err(SpeechCodecError::Truncated)
        }
    }
}

pub fn encode_speech_frame(
    kind: SpeechFrameKind,
    payload: &[u8],
) -> Result<Vec<u8>, SpeechCodecError> {
    if payload.len() > MAX_SPEECH_FRAME_PAYLOAD_BYTES {
        return Err(SpeechCodecError::PayloadTooLarge(payload.len()));
    }
    let mut wire = Vec::with_capacity(SPEECH_FRAME_HEADER_BYTES + payload.len());
    wire.push(SPEECH_FRAME_VERSION);
    wire.push(kind as u8);
    wire.extend_from_slice(&0u16.to_be_bytes());
    wire.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    wire.extend_from_slice(payload);
    Ok(wire)
}

pub fn encode_speech_json<T: Serialize>(
    kind: SpeechFrameKind,
    value: &T,
) -> Result<Vec<u8>, SpeechCodecError> {
    let payload = serde_json::to_vec(value)
        .map_err(|error| SpeechCodecError::InvalidJson(error.to_string()))?;
    encode_speech_frame(kind, &payload)
}

pub fn decode_speech_json<T: DeserializeOwned>(frame: &SpeechFrame) -> Result<T, SpeechCodecError> {
    serde_json::from_slice(&frame.payload)
        .map_err(|error| SpeechCodecError::InvalidJson(error.to_string()))
}

pub fn encode_speech_audio(
    index: u32,
    capture_start_ms: u32,
    duration_ms: u16,
    pcm: &[u8],
) -> Result<Vec<u8>, SpeechCodecError> {
    let mut payload = Vec::with_capacity(10 + pcm.len());
    payload.extend_from_slice(&index.to_be_bytes());
    payload.extend_from_slice(&capture_start_ms.to_be_bytes());
    payload.extend_from_slice(&duration_ms.to_be_bytes());
    payload.extend_from_slice(pcm);
    encode_speech_frame(SpeechFrameKind::Audio, &payload)
}

pub fn decode_speech_audio(
    frame: &SpeechFrame,
) -> Result<(u32, u32, u16, &[u8]), SpeechCodecError> {
    if frame.kind != SpeechFrameKind::Audio || frame.payload.len() < 10 {
        return Err(SpeechCodecError::InvalidAudio);
    }
    let index = u32::from_be_bytes(frame.payload[0..4].try_into().unwrap());
    let capture_start_ms = u32::from_be_bytes(frame.payload[4..8].try_into().unwrap());
    let duration_ms = u16::from_be_bytes(frame.payload[8..10].try_into().unwrap());
    Ok((index, capture_start_ms, duration_ms, &frame.payload[10..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_has_a_cross_language_golden_vector() {
        assert_eq!(
            encode_speech_audio(7, 100, 20, &[0x01, 0x02]).unwrap(),
            vec![
                0x02, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00,
                0x00, 0x64, 0x00, 0x14, 0x01, 0x02,
            ]
        );
    }

    #[test]
    fn decoder_handles_split_and_coalesced_frames() {
        let first = encode_speech_frame(SpeechFrameKind::Finish, &[]).unwrap();
        let second = encode_speech_json(
            SpeechFrameKind::Cancel,
            &serde_json::json!({ "reason": "user" }),
        )
        .unwrap();
        let mut joined = first.clone();
        joined.extend_from_slice(&second);

        let mut decoder = SpeechFrameDecoder::default();
        assert!(decoder.push(&joined[..5]).unwrap().is_empty());
        let frames = decoder.push(&joined[5..]).unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].kind, SpeechFrameKind::Finish);
        assert_eq!(frames[1].kind, SpeechFrameKind::Cancel);
        decoder.finish().unwrap();
    }

    #[test]
    fn decoder_rejects_unknown_and_unbounded_frames_before_buffering_payload() {
        let mut decoder = SpeechFrameDecoder::default();
        assert_eq!(
            decoder.push(&[2, 0x7f, 0, 0, 0, 0, 0, 0]).unwrap_err(),
            SpeechCodecError::UnknownKind(0x7f)
        );

        let mut decoder = SpeechFrameDecoder::default();
        let length = (MAX_SPEECH_FRAME_PAYLOAD_BYTES as u32 + 1).to_be_bytes();
        let mut header = vec![2, SpeechFrameKind::Start as u8, 0, 0];
        header.extend_from_slice(&length);
        assert!(matches!(
            decoder.push(&header),
            Err(SpeechCodecError::PayloadTooLarge(_))
        ));
    }

    #[test]
    fn partial_round_trips_as_a_complete_best_one_replacement() {
        let partial = SpeechPartial {
            request_id: "request-1".into(),
            revision: 2,
            text: "GeneHub 正在识别".into(),
            audio_end_ms: 840,
            stable_prefix_chars: 7,
        };
        let wire = encode_speech_json(SpeechFrameKind::Partial, &partial).unwrap();
        let frames = SpeechFrameDecoder::default().push(&wire).unwrap();

        assert_eq!(frames[0].kind, SpeechFrameKind::Partial);
        assert_eq!(
            decode_speech_json::<SpeechPartial>(&frames[0]).unwrap(),
            partial
        );
    }

    #[test]
    fn older_v2_start_documents_default_to_final_only() {
        let json = serde_json::json!({
            "requestId": "request-1",
            "workspaceId": "workspace-1",
            "audio": {"encoding": "pcmS16Le", "sampleRateHz": 16000, "channels": 1},
            "languageHints": ["zh"],
            "context": {
                "snapshotId": "snapshot-1",
                "prompt": "",
                "terms": [],
                "languageHints": ["zh"],
                "compilerVersion": "qwen3-context-v1",
                "omitted": {
                    "pinnedTerms": 0,
                    "automaticTerms": 0,
                    "messages": 0,
                    "projectIndexUnavailable": false,
                    "projectContextTruncated": false
                }
            },
            "contextRevision": 1
        });

        let start: SpeechStart = serde_json::from_value(json).unwrap();
        assert!(!start.accept_partial);
    }
}
