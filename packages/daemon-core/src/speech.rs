//! Portable speech policy and configuration.
//!
//! Audio streams and the external model process are resident native resources.
//! Everything that can change as product logic—settings, consent, context and
//! feedback policy—stays here in the signed application.

use std::collections::{BTreeMap, HashSet};

use genehub_proto::{
    ErrorCode, ProtocolError, SpeechCandidate, SpeechCapabilities, SpeechContextOmissions,
    SpeechContextPack, SpeechContextSource, SpeechContextTerm, SpeechFeedbackLevel,
    SpeechFeedbackReceipt, SpeechFeedbackScope, SpeechRuntimeDescriptor, SpeechRuntimeStatus,
    SpeechScoreKind, SpeechSegment, TimelineItem, MAX_SPEECH_CANDIDATES, MAX_SPEECH_CONTEXT_BYTES,
    MAX_SPEECH_PROMPT_CHARS, MAX_SPEECH_TRANSCRIPT_CHARS,
};
use genet_daemon_logic_api::{
    CapabilityFailureKind, CapabilityRequest, CapabilityValue, FileKind, FileLocator, FileRequest,
    FileRoot, SpeechCompletionEvidence, SpeechConfig, SpeechRuntimeConfig, SpeechRuntimeRequest,
};
use sha2::{Digest, Sha256};

use crate::capability::Client;
use crate::config::{Config, WorkspaceEntry, WorkspaceFolderEntry};
use crate::CapabilityExecutor;

const MAX_PINNED_TERMS: usize = 50;
const MAX_LANGUAGE_HINTS: usize = 4;
const SUPPORTED_LANGUAGES: &[&str] = &["zh", "en", "yue", "ja", "ko"];
const CONTEXT_COMPILER_VERSION: &str = "qwen3-context-v1";
const MAX_AUTOMATIC_TERMS: usize = 150;
const MAX_WALKED_ENTRIES: usize = 2_000;
const MAX_MESSAGE_CHARS: usize = 400;
const MAX_PROJECT_CONTEXT_CHARS: usize = 2_000;
const MAX_CONTEXT_FILE_BYTES: u32 = 16 * 1024;
const PREFERENCES_PATH: &str = ".genethub/speech/preferences.jsonl";
const LEARNED_TERMS_PATH: &str = ".genethub/speech/learned-terms.txt";
const PRIVATE_GITIGNORE_PATH: &str = ".genethub/speech/.gitignore";
const MAX_PREFERENCES_BYTES: u32 = 4 * 1024 * 1024;
const MAX_LEARNED_TERMS_BYTES: u32 = 1024 * 1024;

#[allow(clippy::too_many_arguments)]
pub fn update_settings(
    config: &mut Config,
    stub_enabled: Option<bool>,
    context_enabled: bool,
    pinned_terms: Vec<String>,
    language_hints: Vec<String>,
    collect_corrections: bool,
    workspace_id: Option<String>,
    workspace: Option<&WorkspaceEntry>,
) -> Result<(), ProtocolError> {
    let (pinned_terms, language_hints) = validate_settings(pinned_terms, language_hints)?;
    if collect_corrections && workspace_id.is_none() {
        return Err(bad_request("开启纠正收集时必须选择一个工作区"));
    }
    if workspace_id.is_some() && workspace.is_none() {
        return Err(bad_request("no such workspace"));
    }
    if let Some(stub_enabled) = stub_enabled {
        config.speech.stub_enabled = stub_enabled;
    }
    config.speech.context_enabled = context_enabled;
    config.speech.pinned_terms = pinned_terms;
    config.speech.language_hints = language_hints;
    config.speech.collect_corrections = false;
    if let Some(workspace_id) = workspace_id {
        config
            .speech
            .correction_workspaces
            .retain(|configured| configured != &workspace_id);
        if collect_corrections {
            config.speech.correction_workspaces.push(workspace_id);
            config.speech.correction_workspaces.sort();
            config.speech.correction_workspaces.dedup();
        }
    }
    Ok(())
}

pub fn capabilities(
    config: &SpeechConfig,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<SpeechCapabilities, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::SpeechRuntime(
        SpeechRuntimeRequest::Capabilities {
            config: config.clone(),
        },
    ))? {
        CapabilityValue::SpeechCapabilities(capabilities) => Ok(capabilities),
        _ => Err(internal(
            "speech capabilities driver returned the wrong value",
        )),
    }
}

pub fn probe(
    config: &SpeechConfig,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<SpeechRuntimeStatus, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::SpeechRuntime(
        SpeechRuntimeRequest::Probe {
            config: config.clone(),
        },
    ))? {
        CapabilityValue::SpeechRuntimeStatus(status) => Ok(status),
        _ => Err(internal("speech probe driver returned the wrong value")),
    }
}

pub fn validate_registration(
    command: String,
    args: Vec<String>,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<SpeechRuntimeConfig, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::SpeechRuntime(
        SpeechRuntimeRequest::ValidateRegistration { command, args },
    ))? {
        CapabilityValue::SpeechRuntimeConfig(config) => Ok(config),
        _ => Err(internal(
            "speech registration driver returned the wrong value",
        )),
    }
}

pub fn compile_context(
    config: &SpeechConfig,
    workspace: &WorkspaceEntry,
    session_items: &[TimelineItem],
    draft: Option<&str>,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<SpeechContextPack, ProtocolError> {
    let mut omitted = SpeechContextOmissions::default();
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    for term in config.pinned_terms.iter().take(MAX_PINNED_TERMS) {
        push_term(
            &mut terms,
            &mut seen,
            term,
            1.0,
            SpeechContextSource::Pinned,
        );
    }
    omitted.pinned_terms = config.pinned_terms.len().saturating_sub(terms.len()) as u32;

    let mut project_context = String::new();
    let mut recent_messages = Vec::new();
    if config.context_enabled {
        let available = session_items
            .iter()
            .filter_map(context_message)
            .collect::<Vec<_>>();
        let start = available.len().saturating_sub(8);
        omitted.messages = start as u32;
        recent_messages.extend(available.into_iter().skip(start));

        let mut client = Client::new(executor, next);
        let discovered = discover_project_context(workspace, &mut client)?;
        project_context = discovered.context;
        omitted.project_context_truncated = discovered.context_truncated;
        omitted.project_index_unavailable = discovered.index_unavailable;
        for candidate in discovered.terms {
            if terms.len() >= MAX_PINNED_TERMS + MAX_AUTOMATIC_TERMS {
                omitted.automatic_terms = omitted.automatic_terms.saturating_add(1);
            } else if seen.insert(candidate.text.to_lowercase()) {
                terms.push(candidate);
            }
        }
    }

    let draft = draft.and_then(normalize_message);
    let mut pack = SpeechContextPack {
        snapshot_id: String::new(),
        prompt: build_prompt(&project_context, &terms, &recent_messages, draft.as_deref()),
        terms,
        language_hints: config.language_hints.clone(),
        compiler_version: CONTEXT_COMPILER_VERSION.to_string(),
        omitted,
    };
    fit_budget(
        &mut pack,
        &project_context,
        &recent_messages,
        draft.as_deref(),
    )?;
    let digest = Sha256::digest(
        serde_json::to_vec(&pack)
            .map_err(|error| internal(format!("encoding speech context: {error}")))?,
    );
    pack.snapshot_id = format!("sc_{digest:x}")[..27].to_string();
    Ok(pack)
}

pub fn clock(executor: &mut impl CapabilityExecutor, next: &mut u64) -> Result<i64, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::Clock)? {
        CapabilityValue::Clock { unix_millis, .. } => Ok(unix_millis),
        _ => Err(internal("speech clock returned the wrong value")),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn record_feedback(
    config: &SpeechConfig,
    workspace: &WorkspaceEntry,
    evidence: SpeechCompletionEvidence,
    selected_candidate_id: String,
    rejected_candidate_id: Option<String>,
    requested_scope: Option<SpeechFeedbackScope>,
    now_millis: i64,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<SpeechFeedbackReceipt, ProtocolError> {
    let candidates = authoritative_candidates(&evidence, requested_scope.as_ref())?;
    let scope = authoritative_scope(&evidence, requested_scope.as_ref(), &selected_candidate_id)?;
    validate_feedback(
        &evidence.request_id,
        &evidence.context_snapshot_id,
        &candidates,
        &selected_candidate_id,
        rejected_candidate_id.as_deref(),
        &scope,
    )?;
    if is_stub_evidence(&evidence)
        || !config
            .correction_workspaces
            .iter()
            .any(|configured| configured == &evidence.workspace_id)
    {
        return Ok(empty_feedback_receipt());
    }
    let folder = workspace
        .folders
        .first()
        .ok_or_else(|| bad_request("workspace has no folder for speech feedback"))?;
    let selected = candidates
        .iter()
        .find(|candidate| candidate.candidate_id == selected_candidate_id)
        .expect("validated selected candidate");
    let default = candidates
        .iter()
        .min_by_key(|candidate| candidate.rank)
        .expect("validated non-empty candidates");
    let rejected = rejected_candidate_id
        .as_deref()
        .and_then(|id| {
            candidates
                .iter()
                .find(|candidate| candidate.candidate_id == id)
        })
        .or_else(|| (default.candidate_id != selected.candidate_id).then_some(default));
    let rejected_terms = rejected
        .unwrap_or(default)
        .matched_terms
        .iter()
        .map(|term| term.trim().to_lowercase())
        .collect::<HashSet<_>>();
    let learned_terms = selected
        .matched_terms
        .iter()
        .map(|term| term.trim())
        .filter(|term| !rejected_terms.contains(&term.to_lowercase()))
        .map(str::to_string)
        .collect::<Vec<_>>();
    let rejected_candidate_id = rejected.map(|candidate| candidate.candidate_id.clone());
    let chosen = selected.clone();
    let rejected_candidate = rejected.cloned();
    let feedback_id = feedback_id(
        &evidence.workspace_id,
        &evidence.request_id,
        &evidence.context_snapshot_id,
        &selected_candidate_id,
        rejected_candidate_id.as_deref(),
        &scope,
    )?;
    let recorded_at = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_millis)
        .ok_or_else(|| internal("speech feedback clock is out of range"))?
        .to_rfc3339();
    let record = PreferenceRecord {
        schema: "genethub-speech-preference.v3",
        feedback_id: feedback_id.clone(),
        recorded_at,
        workspace_id: evidence.workspace_id,
        request_id: evidence.request_id,
        runtime: evidence.runtime,
        context_snapshot_id: evidence.context_snapshot_id,
        score_kind: evidence.score_kind,
        scores_calibrated: evidence.scores_calibrated,
        candidates,
        selected_candidate_id,
        rejected_candidate_id,
        chosen,
        rejected: rejected_candidate,
        scope,
        audio_ref: None,
    };
    store_feedback(folder, &record, &learned_terms, executor, next)?;
    Ok(SpeechFeedbackReceipt {
        stored: true,
        learned_terms,
        feedback_id: Some(feedback_id),
        relative_path: Some(PREFERENCES_PATH.to_string()),
    })
}

fn empty_feedback_receipt() -> SpeechFeedbackReceipt {
    SpeechFeedbackReceipt {
        stored: false,
        learned_terms: Vec::new(),
        feedback_id: None,
        relative_path: None,
    }
}

fn is_stub_evidence(evidence: &SpeechCompletionEvidence) -> bool {
    evidence.score_kind == SpeechScoreKind::MockRelative
        || matches!(evidence.runtime.implementation.as_str(), "stub" | "mock")
}

fn authoritative_candidates(
    evidence: &SpeechCompletionEvidence,
    scope: Option<&SpeechFeedbackScope>,
) -> Result<Vec<SpeechCandidate>, ProtocolError> {
    let Some(scope) = scope else {
        return Ok(evidence.candidates.clone());
    };
    match scope.level {
        SpeechFeedbackLevel::Utterance => Ok(evidence.candidates.clone()),
        SpeechFeedbackLevel::Segment | SpeechFeedbackLevel::Span => {
            let segment_id = scope
                .segment_id
                .as_deref()
                .ok_or_else(|| bad_request("segment preference scope is incomplete"))?;
            let segment = evidence
                .segments
                .iter()
                .find(|segment| segment.segment_id == segment_id)
                .ok_or_else(|| bad_request("segment preference is not in the completed result"))?;
            if scope.segment_start_ms != Some(segment.start_ms)
                || scope.segment_end_ms != Some(segment.end_ms)
            {
                return Err(bad_request(
                    "segment preference timing does not match the completed result",
                ));
            }
            if scope.level == SpeechFeedbackLevel::Span {
                let span_id = scope
                    .uncertain_span_id
                    .as_deref()
                    .ok_or_else(|| bad_request("span preference range is missing"))?;
                let span = segment
                    .uncertain_spans
                    .iter()
                    .find(|span| span.span_id == span_id)
                    .ok_or_else(|| bad_request("span preference is not in the completed result"))?;
                if scope.span_start_char != Some(span.start_char)
                    || scope.span_end_char != Some(span.end_char)
                {
                    return Err(bad_request(
                        "span preference range does not match the completed result",
                    ));
                }
            }
            Ok(segment.candidates.clone())
        }
    }
}

fn authoritative_scope(
    evidence: &SpeechCompletionEvidence,
    requested: Option<&SpeechFeedbackScope>,
    selected_candidate_id: &str,
) -> Result<SpeechFeedbackScope, ProtocolError> {
    let level = requested
        .map(|scope| scope.level)
        .unwrap_or(SpeechFeedbackLevel::Utterance);
    if level == SpeechFeedbackLevel::Utterance {
        let selected = evidence
            .candidates
            .iter()
            .find(|candidate| candidate.candidate_id == selected_candidate_id)
            .ok_or_else(|| bad_request("selected Qwen3 candidate does not exist"))?;
        return Ok(SpeechFeedbackScope {
            level,
            utterance_text: selected.text.clone(),
            segment_id: None,
            segment_start_ms: None,
            segment_end_ms: None,
            preceding_text: None,
            following_text: None,
            uncertain_span_id: None,
            span_start_char: None,
            span_end_char: None,
        });
    }
    let requested = requested.expect("non-utterance scope is present");
    let segment_id = requested
        .segment_id
        .as_deref()
        .ok_or_else(|| bad_request("segment preference scope is incomplete"))?;
    let segment_index = evidence
        .segments
        .iter()
        .position(|segment| segment.segment_id == segment_id)
        .ok_or_else(|| bad_request("segment preference is not in the completed result"))?;
    let segment = &evidence.segments[segment_index];
    if requested.segment_start_ms != Some(segment.start_ms)
        || requested.segment_end_ms != Some(segment.end_ms)
    {
        return Err(bad_request(
            "segment preference timing does not match the completed result",
        ));
    }
    let selected = segment
        .candidates
        .iter()
        .find(|candidate| candidate.candidate_id == selected_candidate_id)
        .ok_or_else(|| bad_request("selected Qwen3 segment candidate does not exist"))?;
    let preceding_text = evidence.segments[..segment_index]
        .iter()
        .map(default_segment_text)
        .collect::<Result<Vec<_>, _>>()?
        .concat();
    let following_text = evidence.segments[segment_index + 1..]
        .iter()
        .map(default_segment_text)
        .collect::<Result<Vec<_>, _>>()?
        .concat();
    let (uncertain_span_id, span_start_char, span_end_char) = match level {
        SpeechFeedbackLevel::Segment => {
            if requested.uncertain_span_id.is_some()
                || requested.span_start_char.is_some()
                || requested.span_end_char.is_some()
            {
                return Err(bad_request("segment preference contains span fields"));
            }
            (None, None, None)
        }
        SpeechFeedbackLevel::Span => {
            let span_id = requested
                .uncertain_span_id
                .as_deref()
                .ok_or_else(|| bad_request("span preference range is missing"))?;
            let span = segment
                .uncertain_spans
                .iter()
                .find(|span| span.span_id == span_id)
                .ok_or_else(|| bad_request("span preference is not in the completed result"))?;
            if requested.span_start_char != Some(span.start_char)
                || requested.span_end_char != Some(span.end_char)
            {
                return Err(bad_request(
                    "span preference range does not match the completed result",
                ));
            }
            (
                Some(span.span_id.clone()),
                Some(span.start_char),
                Some(span.end_char),
            )
        }
        SpeechFeedbackLevel::Utterance => unreachable!(),
    };
    Ok(SpeechFeedbackScope {
        level,
        utterance_text: format!("{preceding_text}{}{following_text}", selected.text),
        segment_id: Some(segment.segment_id.clone()),
        segment_start_ms: Some(segment.start_ms),
        segment_end_ms: Some(segment.end_ms),
        preceding_text: Some(preceding_text),
        following_text: Some(following_text),
        uncertain_span_id,
        span_start_char,
        span_end_char,
    })
}

fn default_segment_text(segment: &SpeechSegment) -> Result<String, ProtocolError> {
    segment
        .candidates
        .iter()
        .find(|candidate| candidate.candidate_id == segment.default_candidate_id)
        .map(|candidate| candidate.text.clone())
        .ok_or_else(|| bad_request("Qwen3 segment default candidate does not exist"))
}

fn validate_feedback(
    request_id: &str,
    context_snapshot_id: &str,
    candidates: &[SpeechCandidate],
    selected_candidate_id: &str,
    rejected_candidate_id: Option<&str>,
    scope: &SpeechFeedbackScope,
) -> Result<(), ProtocolError> {
    if request_id.is_empty()
        || request_id.len() > 128
        || request_id.chars().any(char::is_control)
        || context_snapshot_id.is_empty()
        || context_snapshot_id.len() > 128
        || candidates.is_empty()
        || candidates.len() > MAX_SPEECH_CANDIDATES
    {
        return Err(bad_request("invalid Qwen3 preference identity or count"));
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
            return Err(bad_request("Qwen3 preference candidate is invalid"));
        }
    }
    if !(1..=candidates.len()).all(|rank| ranks.contains(&(rank as u8)))
        || !ids.contains(selected_candidate_id)
        || rejected_candidate_id.is_some_and(|id| id == selected_candidate_id || !ids.contains(id))
    {
        return Err(bad_request(
            "Qwen3 preference candidate selection is invalid",
        ));
    }
    validate_scope(scope, candidates, selected_candidate_id)
}

fn validate_scope(
    scope: &SpeechFeedbackScope,
    candidates: &[SpeechCandidate],
    selected_candidate_id: &str,
) -> Result<(), ProtocolError> {
    if scope.utterance_text.trim().is_empty()
        || scope.utterance_text.chars().count() > MAX_SPEECH_TRANSCRIPT_CHARS
    {
        return Err(bad_request("Qwen3 preference utterance is invalid"));
    }
    let selected = candidates
        .iter()
        .find(|candidate| candidate.candidate_id == selected_candidate_id)
        .expect("validated selected candidate");
    match scope.level {
        SpeechFeedbackLevel::Utterance => {
            if scope.utterance_text != selected.text
                || scope.segment_id.is_some()
                || scope.segment_start_ms.is_some()
                || scope.segment_end_ms.is_some()
                || scope.preceding_text.is_some()
                || scope.following_text.is_some()
                || scope.uncertain_span_id.is_some()
                || scope.span_start_char.is_some()
                || scope.span_end_char.is_some()
            {
                return Err(bad_request(
                    "utterance preference scope contains segment fields",
                ));
            }
        }
        SpeechFeedbackLevel::Segment | SpeechFeedbackLevel::Span => {
            let (Some(segment_id), Some(start), Some(end), Some(preceding), Some(following)) = (
                scope.segment_id.as_ref(),
                scope.segment_start_ms,
                scope.segment_end_ms,
                scope.preceding_text.as_ref(),
                scope.following_text.as_ref(),
            ) else {
                return Err(bad_request("segment preference scope is incomplete"));
            };
            if segment_id.is_empty()
                || segment_id.len() > 128
                || start > end
                || preceding.chars().count() > MAX_SPEECH_TRANSCRIPT_CHARS
                || following.chars().count() > MAX_SPEECH_TRANSCRIPT_CHARS
                || format!("{preceding}{}{following}", selected.text) != scope.utterance_text
            {
                return Err(bad_request("segment preference context is invalid"));
            }
            match scope.level {
                SpeechFeedbackLevel::Segment => {
                    if scope.uncertain_span_id.is_some()
                        || scope.span_start_char.is_some()
                        || scope.span_end_char.is_some()
                    {
                        return Err(bad_request("segment preference contains span fields"));
                    }
                }
                SpeechFeedbackLevel::Span => {
                    let (Some(span_id), Some(span_start), Some(span_end)) = (
                        scope.uncertain_span_id.as_ref(),
                        scope.span_start_char,
                        scope.span_end_char,
                    ) else {
                        return Err(bad_request("span preference range is missing"));
                    };
                    let max_chars = candidates
                        .iter()
                        .min_by_key(|candidate| candidate.rank)
                        .expect("validated non-empty candidates")
                        .text
                        .chars()
                        .count();
                    if span_id.is_empty()
                        || span_id.len() > 128
                        || span_start >= span_end
                        || span_end as usize > max_chars
                    {
                        return Err(bad_request("span preference range is invalid"));
                    }
                }
                SpeechFeedbackLevel::Utterance => unreachable!(),
            }
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreferenceRecord {
    schema: &'static str,
    feedback_id: String,
    recorded_at: String,
    workspace_id: String,
    request_id: String,
    runtime: SpeechRuntimeDescriptor,
    context_snapshot_id: String,
    score_kind: SpeechScoreKind,
    scores_calibrated: bool,
    candidates: Vec<SpeechCandidate>,
    selected_candidate_id: String,
    rejected_candidate_id: Option<String>,
    chosen: SpeechCandidate,
    rejected: Option<SpeechCandidate>,
    scope: SpeechFeedbackScope,
    audio_ref: Option<String>,
}

fn store_feedback(
    folder: &WorkspaceFolderEntry,
    record: &PreferenceRecord,
    learned_terms: &[String],
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let mut client = Client::new(executor, next);
    expect_unit(
        client.call(CapabilityRequest::File(FileRequest::CreateDirAll {
            locator: workspace_locator(folder, ".genethub/speech"),
        }))?,
        "creating speech preference directory",
    )?;
    ensure_private_gitignore(folder, &mut client)?;

    let existing = read_optional(folder, PREFERENCES_PATH, MAX_PREFERENCES_BYTES, &mut client)?;
    let exists = existing.lines().try_fold(false, |found, line| {
        if line.len() > 256 * 1024 {
            return Err(bad_request(
                "Qwen3 preference line exceeds its safety limit",
            ));
        }
        Ok::<_, ProtocolError>(
            found
                || serde_json::from_str::<serde_json::Value>(line)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("feedbackId")
                            .and_then(|id| id.as_str())
                            .map(str::to_string)
                    })
                    .as_deref()
                    == Some(record.feedback_id.as_str()),
        )
    })?;
    if !exists {
        let mut bytes = Vec::new();
        if !existing.is_empty() && !existing.ends_with('\n') {
            bytes.push(b'\n');
        }
        serde_json::to_writer(&mut bytes, record)
            .map_err(|error| internal(format!("encoding speech preference: {error}")))?;
        bytes.push(b'\n');
        expect_unit(
            client.call(CapabilityRequest::File(FileRequest::Append {
                locator: workspace_locator(folder, PREFERENCES_PATH),
                bytes,
            }))?,
            "appending speech preference",
        )?;
    }

    if !learned_terms.is_empty() {
        let existing = read_optional(
            folder,
            LEARNED_TERMS_PATH,
            MAX_LEARNED_TERMS_BYTES,
            &mut client,
        )?;
        let mut seen = existing
            .lines()
            .map(|term| term.trim().to_lowercase())
            .filter(|term| !term.is_empty())
            .collect::<HashSet<_>>();
        let mut bytes = Vec::new();
        if !existing.is_empty() && !existing.ends_with('\n') {
            bytes.push(b'\n');
        }
        for term in learned_terms {
            if seen.insert(term.to_lowercase()) {
                bytes.extend_from_slice(term.as_bytes());
                bytes.push(b'\n');
            }
        }
        if !bytes.is_empty() {
            expect_unit(
                client.call(CapabilityRequest::File(FileRequest::Append {
                    locator: workspace_locator(folder, LEARNED_TERMS_PATH),
                    bytes,
                }))?,
                "appending learned speech terms",
            )?;
        }
    }
    Ok(())
}

fn ensure_private_gitignore<E: CapabilityExecutor>(
    folder: &WorkspaceFolderEntry,
    client: &mut Client<'_, E>,
) -> Result<(), ProtocolError> {
    let existing = read_optional(folder, PRIVATE_GITIGNORE_PATH, 64 * 1024, client)?;
    let rules = ["/preferences.jsonl", "/learned-terms.txt"];
    let missing = rules
        .into_iter()
        .filter(|rule| !existing.lines().any(|line| line.trim() == *rule))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    for rule in missing {
        next.push_str(rule);
        next.push('\n');
    }
    expect_unit(
        client.call(CapabilityRequest::File(FileRequest::WriteAtomic {
            locator: workspace_locator(folder, PRIVATE_GITIGNORE_PATH),
            bytes: next.into_bytes(),
        }))?,
        "writing speech preference ignore rules",
    )
}

fn read_optional<E: CapabilityExecutor>(
    folder: &WorkspaceFolderEntry,
    path: &str,
    max_bytes: u32,
    client: &mut Client<'_, E>,
) -> Result<String, ProtocolError> {
    match client.call_raw(CapabilityRequest::File(FileRequest::Read {
        locator: workspace_locator(folder, path),
        max_bytes,
    }))? {
        Ok(CapabilityValue::Bytes(bytes)) => String::from_utf8(bytes)
            .map_err(|_| bad_request(format!("speech preference file {path} is not UTF-8"))),
        Ok(_) => Err(internal("speech preference read returned the wrong value")),
        Err(error) if error.kind == CapabilityFailureKind::NotFound => Ok(String::new()),
        Err(error) => Err(map_failure(error)),
    }
}

fn expect_unit(value: CapabilityValue, operation: &str) -> Result<(), ProtocolError> {
    match value {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal(format!("{operation} returned the wrong value"))),
    }
}

fn feedback_id(
    workspace_id: &str,
    request_id: &str,
    context_snapshot_id: &str,
    selected_candidate_id: &str,
    rejected_candidate_id: Option<&str>,
    scope: &SpeechFeedbackScope,
) -> Result<String, ProtocolError> {
    let canonical = serde_json::to_vec(&(
        3u8,
        workspace_id,
        request_id,
        context_snapshot_id,
        selected_candidate_id,
        rejected_candidate_id,
        scope,
    ))
    .map_err(|error| internal(format!("encoding speech feedback identity: {error}")))?;
    let digest = Sha256::digest(canonical);
    Ok(format!("spf_{digest:x}")[..32].to_string())
}

fn context_message(item: &TimelineItem) -> Option<String> {
    let (role, text) = match item {
        TimelineItem::UserMessage { text, .. } => ("用户", text),
        TimelineItem::AssistantMessage { text, .. } => ("Agent", text),
        _ => return None,
    };
    Some(format!("{role}：{}", normalize_message(text)?))
}

fn normalize_message(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(MAX_MESSAGE_CHARS).collect())
}

fn build_prompt(
    project_context: &str,
    terms: &[SpeechContextTerm],
    recent_messages: &[String],
    draft: Option<&str>,
) -> String {
    let mut sections = Vec::new();
    if !project_context.is_empty() {
        sections.push(format!("项目背景：\n{project_context}"));
    }
    if !terms.is_empty() {
        sections.push(format!(
            "专业术语（保持原拼写）：\n{}",
            terms
                .iter()
                .map(|term| term.text.as_str())
                .collect::<Vec<_>>()
                .join("、")
        ));
    }
    if !recent_messages.is_empty() {
        sections.push(format!("最近对话：\n{}", recent_messages.join("\n")));
    }
    if let Some(draft) = draft {
        sections.push(format!("当前输入草稿：\n{draft}"));
    }
    sections
        .join("\n\n")
        .chars()
        .take(MAX_SPEECH_PROMPT_CHARS)
        .collect()
}

struct DiscoveredContext {
    terms: Vec<SpeechContextTerm>,
    context: String,
    context_truncated: bool,
    index_unavailable: bool,
}

fn discover_project_context<E: CapabilityExecutor>(
    workspace: &WorkspaceEntry,
    client: &mut Client<'_, E>,
) -> Result<DiscoveredContext, ProtocolError> {
    let mut ranked = BTreeMap::<String, (String, f32, SpeechContextSource)>::new();
    add_name_terms(
        &mut ranked,
        &workspace.name,
        0.90,
        SpeechContextSource::Workspace,
    );
    for folder in &workspace.folders {
        add_name_terms(
            &mut ranked,
            &folder.name,
            0.85,
            SpeechContextSource::Workspace,
        );
    }

    let mut context = String::new();
    let mut context_truncated = false;
    for folder in &workspace.folders {
        for (path, source, score) in [
            (
                ".genethub/speech/terms.txt",
                SpeechContextSource::ProjectConfig,
                0.98,
            ),
            (
                ".genethub/speech/learned-terms.txt",
                SpeechContextSource::Correction,
                0.99,
            ),
        ] {
            if let Some((text, _)) = read_bounded_text(folder, path, client)? {
                for term in text
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty() && !line.starts_with('#'))
                    .take(MAX_AUTOMATIC_TERMS)
                {
                    add_ranked_term(&mut ranked, term, score, source);
                }
            }
        }
        if context.is_empty() {
            if let Some((value, truncated)) =
                read_bounded_text(folder, ".genethub/speech/context.md", client)?
            {
                context = value;
                context_truncated = truncated;
            }
        }
    }

    let mut walked = 0usize;
    let mut index_unavailable = false;
    for folder in &workspace.folders {
        if let Err(_error) = walk_project(folder, "", &mut walked, &mut ranked, client) {
            index_unavailable = true;
        }
        if walked >= MAX_WALKED_ENTRIES {
            break;
        }
    }
    let mut terms = ranked
        .into_values()
        .map(|(text, score, source)| SpeechContextTerm {
            text,
            source,
            score,
        })
        .collect::<Vec<_>>();
    terms.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.text.cmp(&right.text))
    });
    Ok(DiscoveredContext {
        terms,
        context,
        context_truncated,
        index_unavailable,
    })
}

fn walk_project<E: CapabilityExecutor>(
    folder: &WorkspaceFolderEntry,
    relative: &str,
    walked: &mut usize,
    ranked: &mut BTreeMap<String, (String, f32, SpeechContextSource)>,
    client: &mut Client<'_, E>,
) -> Result<(), ProtocolError> {
    if *walked >= MAX_WALKED_ENTRIES {
        return Ok(());
    }
    let entries = match client.call(CapabilityRequest::File(FileRequest::List {
        locator: workspace_locator(folder, relative),
    }))? {
        CapabilityValue::FileEntries(entries) => entries,
        _ => return Err(internal("speech project listing returned the wrong value")),
    };
    for entry in entries {
        if *walked >= MAX_WALKED_ENTRIES {
            break;
        }
        let child = if relative.is_empty() {
            entry.name.clone()
        } else {
            format!("{relative}/{}", entry.name)
        };
        if !project_index_entry(&child) || matches!(entry.kind, FileKind::Symlink | FileKind::Other)
        {
            continue;
        }
        *walked += 1;
        let stem = entry
            .name
            .rsplit_once('.')
            .map_or(entry.name.as_str(), |(stem, _)| stem);
        add_name_terms(
            ranked,
            stem,
            if entry.kind == FileKind::Directory {
                0.55
            } else {
                0.65
            },
            SpeechContextSource::ProjectFile,
        );
        if entry.kind == FileKind::Directory {
            walk_project(folder, &child, walked, ranked, client)?;
        }
    }
    Ok(())
}

fn read_bounded_text<E: CapabilityExecutor>(
    folder: &WorkspaceFolderEntry,
    path: &str,
    client: &mut Client<'_, E>,
) -> Result<Option<(String, bool)>, ProtocolError> {
    let bytes = match client.call_raw(CapabilityRequest::File(FileRequest::Read {
        locator: workspace_locator(folder, path),
        max_bytes: MAX_CONTEXT_FILE_BYTES,
    }))? {
        Ok(CapabilityValue::Bytes(bytes)) => bytes,
        Ok(_) => return Err(internal("speech context read returned the wrong value")),
        Err(error) if error.kind == CapabilityFailureKind::NotFound => return Ok(None),
        Err(error) if error.kind == CapabilityFailureKind::TooLarge => {
            let bytes = match client.call(CapabilityRequest::File(FileRequest::ReadRange {
                locator: workspace_locator(folder, path),
                offset: 0,
                length: MAX_CONTEXT_FILE_BYTES,
            }))? {
                CapabilityValue::Bytes(bytes) => bytes,
                _ => return Err(internal("speech context range returned the wrong value")),
            };
            let text = valid_utf8_prefix(bytes)?;
            return Ok(Some((
                text.chars()
                    .take(MAX_PROJECT_CONTEXT_CHARS)
                    .collect::<String>()
                    .trim()
                    .to_string(),
                true,
            )));
        }
        Err(error) => return Err(map_failure(error)),
    };
    let text =
        String::from_utf8(bytes).map_err(|_| bad_request("Qwen3 context file is not UTF-8"))?;
    let truncated = text.chars().count() > MAX_PROJECT_CONTEXT_CHARS;
    Ok(Some((
        text.chars()
            .take(MAX_PROJECT_CONTEXT_CHARS)
            .collect::<String>()
            .trim()
            .to_string(),
        truncated,
    )))
}

fn valid_utf8_prefix(mut bytes: Vec<u8>) -> Result<String, ProtocolError> {
    let valid = match std::str::from_utf8(&bytes) {
        Ok(_) => bytes.len(),
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(_) => return Err(bad_request("Qwen3 context file is not UTF-8")),
    };
    bytes.truncate(valid);
    String::from_utf8(bytes).map_err(|_| bad_request("Qwen3 context file is not UTF-8"))
}

fn workspace_locator(folder: &WorkspaceFolderEntry, path: &str) -> FileLocator {
    FileLocator {
        root: FileRoot::Workspace {
            handle: folder.root_handle.clone(),
        },
        path: path.to_string(),
    }
}

fn push_term(
    terms: &mut Vec<SpeechContextTerm>,
    seen: &mut HashSet<String>,
    raw: &str,
    score: f32,
    source: SpeechContextSource,
) {
    let Some(text) = normalize_term(raw) else {
        return;
    };
    if seen.insert(text.to_lowercase()) {
        terms.push(SpeechContextTerm {
            text,
            source,
            score,
        });
    }
}

fn add_ranked_term(
    ranked: &mut BTreeMap<String, (String, f32, SpeechContextSource)>,
    raw: &str,
    score: f32,
    source: SpeechContextSource,
) {
    let Some(term) = normalize_term(raw) else {
        return;
    };
    let key = term.to_lowercase();
    match ranked.get(&key) {
        Some((_, previous, _)) if *previous >= score => {}
        _ => {
            ranked.insert(key, (term, score, source));
        }
    }
}

fn add_name_terms(
    ranked: &mut BTreeMap<String, (String, f32, SpeechContextSource)>,
    raw: &str,
    score: f32,
    source: SpeechContextSource,
) {
    let mut values = vec![raw.to_string()];
    values.extend(
        raw.split(|character: char| {
            !character.is_alphanumeric() && character != '-' && character != '_'
        })
        .map(str::to_string),
    );
    values.extend(raw.split(['-', '_']).map(str::to_string));
    for value in values {
        add_ranked_term(ranked, &value, score, source);
    }
}

fn normalize_term(term: &str) -> Option<String> {
    let term = term.trim().trim_matches(['.', '-', '_']);
    let chars = term.chars().count();
    if !(2..=64).contains(&chars)
        || term.chars().any(char::is_control)
        || COMMON_TERMS.contains(&term.to_ascii_lowercase().as_str())
    {
        return None;
    }
    Some(term.to_string())
}

fn project_index_entry(relative: &str) -> bool {
    !relative.split('/').any(|component| {
        let name = component.to_ascii_lowercase();
        name == ".genethub"
            || name.starts_with(".env")
            || matches!(name.as_str(), ".git" | ".ssh" | ".aws" | ".gnupg")
            || name.contains("secret")
            || name.contains("credential")
            || name.contains("private_key")
            || name.ends_with(".pem")
            || name.ends_with(".key")
    })
}

fn fit_budget(
    pack: &mut SpeechContextPack,
    project_context: &str,
    recent_messages: &[String],
    draft: Option<&str>,
) -> Result<(), ProtocolError> {
    while serde_json::to_vec(pack)
        .map_err(|error| internal(format!("encoding speech context: {error}")))?
        .len()
        > MAX_SPEECH_CONTEXT_BYTES
    {
        if let Some(position) = pack
            .terms
            .iter()
            .rposition(|term| term.source != SpeechContextSource::Pinned)
        {
            pack.terms.remove(position);
            pack.omitted.automatic_terms = pack.omitted.automatic_terms.saturating_add(1);
            pack.prompt = build_prompt(project_context, &pack.terms, recent_messages, draft);
        } else if !pack.prompt.is_empty() {
            pack.prompt = pack
                .prompt
                .chars()
                .take(pack.prompt.chars().count().saturating_sub(200))
                .collect();
            pack.omitted.project_context_truncated = true;
        } else {
            return Err(bad_request(
                "pinned Qwen3 speech context exceeds its byte budget",
            ));
        }
    }
    Ok(())
}

fn map_failure(error: genet_daemon_logic_api::CapabilityFailure) -> ProtocolError {
    ProtocolError {
        code: match error.kind {
            CapabilityFailureKind::Invalid => ErrorCode::BadRequest,
            CapabilityFailureKind::Denied => ErrorCode::Forbidden,
            CapabilityFailureKind::NotFound => ErrorCode::NotFound,
            CapabilityFailureKind::Conflict => ErrorCode::Conflict,
            CapabilityFailureKind::Unavailable
            | CapabilityFailureKind::TooLarge
            | CapabilityFailureKind::Internal => ErrorCode::Internal,
        },
        message: error.message,
    }
}

const COMMON_TERMS: &[&str] = &[
    "src",
    "lib",
    "main",
    "test",
    "tests",
    "docs",
    "readme",
    "index",
    "package",
    "target",
    "node_modules",
    "public",
    "assets",
    "config",
    "json",
    "toml",
    "yaml",
    "lock",
    "debug",
    "release",
];

fn validate_settings(
    pinned_terms: Vec<String>,
    language_hints: Vec<String>,
) -> Result<(Vec<String>, Vec<String>), ProtocolError> {
    if pinned_terms.len() > MAX_PINNED_TERMS {
        return Err(bad_request(format!(
            "固定专业术语不能超过 {MAX_PINNED_TERMS} 个"
        )));
    }
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    for term in pinned_terms {
        let term = term.trim();
        if term.is_empty() || term.chars().count() > 64 || term.chars().any(char::is_control) {
            return Err(bad_request("每个固定专业术语必须包含 1 到 64 个可见字符"));
        }
        if seen.insert(term.to_lowercase()) {
            terms.push(term.to_string());
        }
    }
    if language_hints.len() > MAX_LANGUAGE_HINTS {
        return Err(bad_request(format!(
            "语言提示不能超过 {MAX_LANGUAGE_HINTS} 个"
        )));
    }
    let mut languages = Vec::new();
    for language in language_hints {
        let language = language.trim().to_ascii_lowercase();
        if !SUPPORTED_LANGUAGES.contains(&language.as_str()) {
            return Err(bad_request(format!("不支持的语音语言提示 `{language}`")));
        }
        if !languages.contains(&language) {
            languages.push(language);
        }
    }
    Ok((terms, languages))
}

fn bad_request(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::BadRequest,
        message: message.into(),
    }
}

fn internal(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Internal,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::{
        SpeechSegmentBoundary, SpeechSegmentBoundaryKind, SpeechSpanAlternative,
        SpeechUncertainSpan,
    };

    fn candidates() -> Vec<SpeechCandidate> {
        vec![
            SpeechCandidate {
                candidate_id: "c1".into(),
                rank: 1,
                text: "基因 Hub".into(),
                score: -0.1,
                matched_terms: vec![],
            },
            SpeechCandidate {
                candidate_id: "c2".into(),
                rank: 2,
                text: "GeneHub".into(),
                score: -0.2,
                matched_terms: vec!["GeneHub".into()],
            },
        ]
    }

    #[test]
    fn qwen_context_prompt_keeps_background_terms_recent_context_and_draft_bounded() {
        let terms = vec![SpeechContextTerm {
            text: "GeneHub".into(),
            source: SpeechContextSource::Pinned,
            score: 1.0,
        }];
        let prompt = build_prompt(
            "本项目实现内置 Agent。",
            &terms,
            &["用户：修改语音输入".into()],
            Some("请继续"),
        );
        assert!(prompt.contains("项目背景"));
        assert!(prompt.contains("GeneHub"));
        assert!(prompt.contains("最近对话"));
        assert!(prompt.contains("当前输入草稿"));
        assert!(prompt.chars().count() <= MAX_SPEECH_PROMPT_CHARS);
    }

    #[test]
    fn feedback_rejects_duplicate_candidate_text() {
        let mut values = candidates();
        values[1].text = values[0].text.clone();
        let scope = SpeechFeedbackScope {
            level: SpeechFeedbackLevel::Utterance,
            utterance_text: values[1].text.clone(),
            segment_id: None,
            segment_start_ms: None,
            segment_end_ms: None,
            preceding_text: None,
            following_text: None,
            uncertain_span_id: None,
            span_start_char: None,
            span_end_char: None,
        };
        assert!(validate_feedback("r1", "sc_1", &values, "c2", None, &scope).is_err());
    }

    #[test]
    fn authoritative_span_scope_discards_client_supplied_training_text() {
        let prefix = SpeechSegment {
            segment_id: "prefix".into(),
            start_ms: 0,
            end_ms: 90,
            text_start_char: 0,
            text_end_char: 2,
            text: "前文".into(),
            candidates: vec![SpeechCandidate {
                candidate_id: "prefix-1".into(),
                rank: 1,
                text: "前文".into(),
                score: -0.1,
                matched_terms: vec![],
            }],
            default_candidate_id: "prefix-1".into(),
            uncertain_spans: vec![],
            boundary: SpeechSegmentBoundary {
                kind: SpeechSegmentBoundaryKind::VoiceActivity,
                confidence: 0.8,
            },
        };
        let target = SpeechSegment {
            segment_id: "segment-1".into(),
            start_ms: 100,
            end_ms: 900,
            text_start_char: 2,
            text_end_char: 8,
            text: "基因 Hub".into(),
            candidates: candidates(),
            default_candidate_id: "c1".into(),
            uncertain_spans: vec![SpeechUncertainSpan {
                span_id: "span-1".into(),
                start_char: 0,
                end_char: 2,
                alternatives: vec![SpeechSpanAlternative {
                    alternative_id: "alt-1".into(),
                    candidate_id: "c1".into(),
                    text: "基因".into(),
                    score: -0.1,
                }],
                default_alternative_id: "alt-1".into(),
            }],
            boundary: SpeechSegmentBoundary {
                kind: SpeechSegmentBoundaryKind::Final,
                confidence: 1.0,
            },
        };
        let evidence = SpeechCompletionEvidence {
            recorded_at_millis: 0,
            workspace_id: "w1".into(),
            request_id: "r1".into(),
            runtime: SpeechRuntimeDescriptor::default(),
            context_snapshot_id: "sc_1".into(),
            candidates: candidates(),
            segments: vec![prefix, target],
            score_kind: SpeechScoreKind::MockRelative,
            scores_calibrated: false,
        };
        let forged = SpeechFeedbackScope {
            level: SpeechFeedbackLevel::Span,
            utterance_text: "注入训练语料".into(),
            segment_id: Some("segment-1".into()),
            segment_start_ms: Some(100),
            segment_end_ms: Some(900),
            preceding_text: Some("恶意前文".into()),
            following_text: Some("恶意后文".into()),
            uncertain_span_id: Some("span-1".into()),
            span_start_char: Some(0),
            span_end_char: Some(2),
        };

        let scope = authoritative_scope(&evidence, Some(&forged), "c2").unwrap();
        assert_eq!(scope.utterance_text, "前文GeneHub");
        assert_eq!(scope.preceding_text.as_deref(), Some("前文"));
        assert_eq!(scope.following_text.as_deref(), Some(""));
        let encoded = serde_json::to_string(&scope).unwrap();
        assert!(!encoded.contains("恶意"));
        assert!(!encoded.contains("注入"));
    }
}
