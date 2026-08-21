use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use anyhow::{Context, Result};
use genehub_proto::{
    SpeechCandidate, SpeechFeedbackLevel, SpeechFeedbackReceipt, SpeechFeedbackScope,
    SpeechRuntimeDescriptor, SpeechScoreKind, MAX_SPEECH_CANDIDATES, MAX_SPEECH_TRANSCRIPT_CHARS,
};
use sha2::{Digest, Sha256};

use crate::state::Shared;

use super::{FeedbackEvidence, FeedbackSubmission};

const PREFERENCES_PATH: &str = ".genethub/speech/preferences.jsonl";
const LEARNED_TERMS_PATH: &str = ".genethub/speech/learned-terms.txt";
const PRIVATE_GITIGNORE_PATH: &str = ".genethub/speech/.gitignore";

pub(super) async fn record(
    state: &Shared,
    submission: FeedbackSubmission,
    evidence: FeedbackEvidence,
) -> Result<SpeechFeedbackReceipt> {
    let FeedbackSubmission {
        workspace_id,
        request_id,
        selected_candidate_id,
        rejected_candidate_id,
        scope,
    } = submission;
    let candidates = authoritative_candidates(&evidence, scope.as_ref())?;
    let scope = authoritative_scope(&evidence, scope.as_ref(), &selected_candidate_id)?;
    validate(
        &request_id,
        &evidence.context_snapshot_id,
        &candidates,
        &selected_candidate_id,
        rejected_candidate_id.as_deref(),
        Some(&scope),
    )?;
    if is_stub_evidence(&evidence) {
        // The protocol Stub deliberately emits invented alternatives so the
        // review UI can be exercised. They are never valid preference or
        // training evidence, even if a modified client submits them directly.
        return Ok(SpeechFeedbackReceipt {
            stored: false,
            learned_terms: Vec::new(),
            feedback_id: None,
            relative_path: None,
        });
    }
    if !state
        .config
        .read()
        .await
        .speech
        .correction_workspaces
        .iter()
        .any(|configured| configured == &workspace_id)
    {
        return Ok(SpeechFeedbackReceipt {
            stored: false,
            learned_terms: Vec::new(),
            feedback_id: None,
            relative_path: None,
        });
    }
    let workspace = state.workspaces.get(&workspace_id).await?;
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

    let chosen = selected.clone();
    let rejected_candidate = rejected.cloned();
    let rejected_candidate_id = rejected.map(|candidate| candidate.candidate_id.clone());
    let feedback_id = feedback_id(
        &workspace_id,
        &request_id,
        &evidence.context_snapshot_id,
        &selected_candidate_id,
        rejected_candidate_id.as_deref(),
        &scope,
    )?;
    let record = PreferenceRecord {
        schema: "genethub-speech-preference.v3",
        feedback_id: feedback_id.clone(),
        recorded_at: chrono::Utc::now().to_rfc3339(),
        workspace_id,
        request_id,
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
    let root = workspace.root.clone();
    let learned = learned_terms.clone();
    crate::blocking::run(move || store(&root, &record, &learned))
        .await
        .context("joining Qwen3 preference write")??;
    Ok(SpeechFeedbackReceipt {
        stored: true,
        learned_terms,
        feedback_id: Some(feedback_id),
        relative_path: Some(PREFERENCES_PATH.to_string()),
    })
}

fn is_stub_evidence(evidence: &FeedbackEvidence) -> bool {
    evidence.score_kind == SpeechScoreKind::MockRelative
        || matches!(evidence.runtime.implementation.as_str(), "stub" | "mock")
}

/// Resolve every hypothesis from the daemon's own recently completed result.
/// The RPC still accepts legacy candidate fields for wire compatibility, but
/// none of those client-provided texts or scores reach a training record.
fn authoritative_candidates(
    evidence: &FeedbackEvidence,
    scope: Option<&SpeechFeedbackScope>,
) -> Result<Vec<SpeechCandidate>> {
    let Some(scope) = scope else {
        return Ok(evidence.candidates.clone());
    };
    match scope.level {
        SpeechFeedbackLevel::Utterance => Ok(evidence.candidates.clone()),
        SpeechFeedbackLevel::Segment | SpeechFeedbackLevel::Span => {
            let segment_id = scope
                .segment_id
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("segment preference scope is incomplete"))?;
            let segment = evidence
                .segments
                .iter()
                .find(|segment| segment.segment_id == segment_id)
                .ok_or_else(|| {
                    anyhow::anyhow!("segment preference is not in the completed result")
                })?;
            if scope.segment_start_ms != Some(segment.start_ms)
                || scope.segment_end_ms != Some(segment.end_ms)
            {
                anyhow::bail!("segment preference timing does not match the completed result");
            }
            if scope.level == SpeechFeedbackLevel::Span {
                let span_id = scope
                    .uncertain_span_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("span preference range is missing"))?;
                let span = segment
                    .uncertain_spans
                    .iter()
                    .find(|span| span.span_id == span_id)
                    .ok_or_else(|| {
                        anyhow::anyhow!("span preference is not in the completed result")
                    })?;
                if scope.span_start_char != Some(span.start_char)
                    || scope.span_end_char != Some(span.end_char)
                {
                    anyhow::bail!("span preference range does not match the completed result");
                }
            }
            Ok(segment.candidates.clone())
        }
    }
}

/// Rebuild textual context from the daemon-owned completion. The client only
/// chooses ids; its legacy `utteranceText`/neighbour fields are intentionally
/// ignored so a modified UI cannot poison later preference training data.
fn authoritative_scope(
    evidence: &FeedbackEvidence,
    requested: Option<&SpeechFeedbackScope>,
    selected_candidate_id: &str,
) -> Result<SpeechFeedbackScope> {
    let level = requested
        .map(|scope| scope.level)
        .unwrap_or(SpeechFeedbackLevel::Utterance);
    if level == SpeechFeedbackLevel::Utterance {
        let selected = evidence
            .candidates
            .iter()
            .find(|candidate| candidate.candidate_id == selected_candidate_id)
            .ok_or_else(|| anyhow::anyhow!("selected Qwen3 candidate does not exist"))?;
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
        .ok_or_else(|| anyhow::anyhow!("segment preference scope is incomplete"))?;
    let segment_index = evidence
        .segments
        .iter()
        .position(|segment| segment.segment_id == segment_id)
        .ok_or_else(|| anyhow::anyhow!("segment preference is not in the completed result"))?;
    let segment = &evidence.segments[segment_index];
    if requested.segment_start_ms != Some(segment.start_ms)
        || requested.segment_end_ms != Some(segment.end_ms)
    {
        anyhow::bail!("segment preference timing does not match the completed result");
    }
    let selected = segment
        .candidates
        .iter()
        .find(|candidate| candidate.candidate_id == selected_candidate_id)
        .ok_or_else(|| anyhow::anyhow!("selected Qwen3 segment candidate does not exist"))?;
    let preceding_text = evidence.segments[..segment_index]
        .iter()
        .map(default_segment_text)
        .collect::<Result<Vec<_>>>()?
        .concat();
    let following_text = evidence.segments[segment_index + 1..]
        .iter()
        .map(default_segment_text)
        .collect::<Result<Vec<_>>>()?
        .concat();
    let (uncertain_span_id, span_start_char, span_end_char) = match level {
        SpeechFeedbackLevel::Segment => {
            if requested.uncertain_span_id.is_some()
                || requested.span_start_char.is_some()
                || requested.span_end_char.is_some()
            {
                anyhow::bail!("segment preference contains span fields");
            }
            (None, None, None)
        }
        SpeechFeedbackLevel::Span => {
            let span_id = requested
                .uncertain_span_id
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("span preference range is missing"))?;
            let span = segment
                .uncertain_spans
                .iter()
                .find(|span| span.span_id == span_id)
                .ok_or_else(|| anyhow::anyhow!("span preference is not in the completed result"))?;
            if requested.span_start_char != Some(span.start_char)
                || requested.span_end_char != Some(span.end_char)
            {
                anyhow::bail!("span preference range does not match the completed result");
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

fn default_segment_text(segment: &genehub_proto::SpeechSegment) -> Result<String> {
    segment
        .candidates
        .iter()
        .find(|candidate| candidate.candidate_id == segment.default_candidate_id)
        .map(|candidate| candidate.text.clone())
        .ok_or_else(|| anyhow::anyhow!("Qwen3 segment default candidate does not exist"))
}

fn validate(
    request_id: &str,
    context_snapshot_id: &str,
    candidates: &[SpeechCandidate],
    selected_candidate_id: &str,
    rejected_candidate_id: Option<&str>,
    scope: Option<&SpeechFeedbackScope>,
) -> Result<()> {
    if request_id.is_empty()
        || request_id.len() > 128
        || request_id.chars().any(char::is_control)
        || context_snapshot_id.is_empty()
        || context_snapshot_id.len() > 128
    {
        anyhow::bail!("invalid Qwen3 preference identity");
    }
    if candidates.is_empty() || candidates.len() > MAX_SPEECH_CANDIDATES {
        anyhow::bail!("Qwen3 preference candidate count is invalid");
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
            anyhow::bail!("Qwen3 preference candidate is invalid");
        }
    }
    if !(1..=candidates.len()).all(|rank| ranks.contains(&(rank as u8))) {
        anyhow::bail!("Qwen3 preference candidate ranks are not contiguous");
    }
    if !ids.contains(selected_candidate_id) {
        anyhow::bail!("selected Qwen3 candidate does not exist");
    }
    if rejected_candidate_id.is_some_and(|id| id == selected_candidate_id || !ids.contains(id)) {
        anyhow::bail!("rejected Qwen3 candidate is invalid");
    }
    if let Some(scope) = scope {
        validate_scope(scope, candidates, selected_candidate_id)?;
    }
    Ok(())
}

fn validate_scope(
    scope: &SpeechFeedbackScope,
    candidates: &[SpeechCandidate],
    selected_candidate_id: &str,
) -> Result<()> {
    if scope.utterance_text.trim().is_empty()
        || scope.utterance_text.chars().count() > MAX_SPEECH_TRANSCRIPT_CHARS
    {
        anyhow::bail!("Qwen3 preference utterance is invalid");
    }
    let selected = candidates
        .iter()
        .find(|candidate| candidate.candidate_id == selected_candidate_id)
        .expect("validated selected candidate");
    let text_field_is_valid = |value: Option<&String>| {
        value.is_some_and(|text| text.chars().count() <= MAX_SPEECH_TRANSCRIPT_CHARS)
    };
    let id_field_is_valid = |value: Option<&String>| {
        value.is_some_and(|id| {
            !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control)
        })
    };

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
                anyhow::bail!("utterance preference scope contains segment fields");
            }
        }
        SpeechFeedbackLevel::Segment | SpeechFeedbackLevel::Span => {
            let (Some(start_ms), Some(end_ms), Some(preceding), Some(following)) = (
                scope.segment_start_ms,
                scope.segment_end_ms,
                scope.preceding_text.as_ref(),
                scope.following_text.as_ref(),
            ) else {
                anyhow::bail!("segment preference scope is incomplete");
            };
            if !id_field_is_valid(scope.segment_id.as_ref())
                || start_ms > end_ms
                || !text_field_is_valid(Some(preceding))
                || !text_field_is_valid(Some(following))
                || format!("{preceding}{}{following}", selected.text) != scope.utterance_text
            {
                anyhow::bail!("segment preference context is invalid");
            }
            match scope.level {
                SpeechFeedbackLevel::Segment => {
                    if scope.uncertain_span_id.is_some()
                        || scope.span_start_char.is_some()
                        || scope.span_end_char.is_some()
                    {
                        anyhow::bail!("segment preference contains span fields");
                    }
                }
                SpeechFeedbackLevel::Span => {
                    let (Some(span_start), Some(span_end)) =
                        (scope.span_start_char, scope.span_end_char)
                    else {
                        anyhow::bail!("span preference range is missing");
                    };
                    // Span offsets are defined against the segment's rank-1
                    // default text. They stay stable when the selected or
                    // immediately rejected hypothesis has a different length.
                    let max_chars = candidates
                        .iter()
                        .min_by_key(|candidate| candidate.rank)
                        .expect("validated non-empty candidates")
                        .text
                        .chars()
                        .count();
                    if !id_field_is_valid(scope.uncertain_span_id.as_ref())
                        || span_start >= span_end
                        || span_end as usize > max_chars
                    {
                        anyhow::bail!("span preference range is invalid");
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
    /// Audio retention is a separately consented future runtime capability.
    /// Stub results are rejected before a record reaches this schema.
    audio_ref: Option<String>,
}

fn store(root: &Path, record: &PreferenceRecord, learned_terms: &[String]) -> Result<()> {
    let genethub = root.join(".genethub");
    let speech = genethub.join("speech");
    ensure_plain_directory(&genethub)?;
    ensure_plain_directory(&speech)?;
    ensure_private_gitignore(root)?;

    let preferences = root.join(PREFERENCES_PATH);
    reject_link_or_non_file(&preferences)?;
    let mut output = open_private_append(&preferences)
        .with_context(|| format!("opening {}", preferences.display()))?;
    if !contains_feedback_id(&mut output, &record.feedback_id)? {
        if needs_line_separator(&mut output)? {
            output.write_all(b"\n")?;
        }
        let mut line = serde_json::to_vec(record)?;
        line.push(b'\n');
        output.write_all(&line)?;
    }

    if !learned_terms.is_empty() {
        let path = root.join(LEARNED_TERMS_PATH);
        reject_link_or_non_file(&path)?;
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let mut seen = existing
            .lines()
            .map(|term| term.trim().to_lowercase())
            .filter(|term| !term.is_empty())
            .collect::<HashSet<_>>();
        let mut output =
            open_private_append(&path).with_context(|| format!("opening {}", path.display()))?;
        if needs_line_separator(&mut output)? {
            output.write_all(b"\n")?;
        }
        for term in learned_terms {
            if seen.insert(term.to_lowercase()) {
                writeln!(output, "{term}")?;
            }
        }
    }
    Ok(())
}

fn open_private_append(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).read(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // `mode` only applies at creation. Harden older or manually-created
        // files too before writing dictated text into them.
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

/// Correction pairs may contain project vocabulary or dictated text. Keep the
/// generated files out of source control by default while leaving context.md
/// and terms.txt shareable. Existing ignore rules are preserved verbatim.
fn ensure_private_gitignore(root: &Path) -> Result<()> {
    let path = root.join(PRIVATE_GITIGNORE_PATH);
    reject_link_or_non_file(&path)?;
    let existing = match std::fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    };
    if existing.len() > 64 * 1024 {
        anyhow::bail!("Qwen3 preference .gitignore exceeds its safety limit");
    }
    let rules = ["/preferences.jsonl", "/learned-terms.txt"];
    let missing = rules
        .into_iter()
        .filter(|rule| !existing.lines().any(|line| line.trim() == *rule))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    let mut output = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    if !existing.is_empty() && !existing.ends_with('\n') {
        output.write_all(b"\n")?;
    }
    for rule in missing {
        writeln!(output, "{rule}")?;
    }
    Ok(())
}

fn feedback_id(
    workspace_id: &str,
    request_id: &str,
    context_snapshot_id: &str,
    selected_candidate_id: &str,
    rejected_candidate_id: Option<&str>,
    scope: &SpeechFeedbackScope,
) -> Result<String> {
    let canonical = serde_json::to_vec(&(
        3u8,
        workspace_id,
        request_id,
        context_snapshot_id,
        selected_candidate_id,
        rejected_candidate_id,
        scope,
    ))?;
    let digest = Sha256::digest(canonical);
    Ok(format!("spf_{digest:x}")[..32].to_string())
}

fn contains_feedback_id(file: &mut std::fs::File, feedback_id: &str) -> Result<bool> {
    file.seek(SeekFrom::Start(0))?;
    let mut reader = std::io::BufReader::new(file.try_clone()?);
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = std::io::BufRead::read_line(&mut reader, &mut line)?;
        if bytes == 0 {
            return Ok(false);
        }
        if line.len() > 256 * 1024 {
            anyhow::bail!("Qwen3 preference line exceeds its safety limit");
        }
        if serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .and_then(|value| {
                value
                    .get("feedbackId")
                    .and_then(|id| id.as_str())
                    .map(str::to_string)
            })
            .as_deref()
            == Some(feedback_id)
        {
            return Ok(true);
        }
    }
}

fn needs_line_separator(file: &mut std::fs::File) -> Result<bool> {
    let length = file.metadata()?.len();
    if length == 0 {
        return Ok(false);
    }
    file.seek(SeekFrom::End(-1))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)?;
    file.seek(SeekFrom::End(0))?;
    Ok(last[0] != b'\n')
}

fn ensure_plain_directory(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            anyhow::bail!("Qwen3 preference path is not a plain directory")
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path).with_context(|| format!("creating {}", path.display()))
        }
        Err(error) => Err(error).with_context(|| format!("inspecting {}", path.display())),
    }
}

fn reject_link_or_non_file(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            anyhow::bail!("Qwen3 preference target is not a plain file")
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("inspecting {}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn preference_is_jsonl_and_learned_terms_are_deduplicated() {
        let dir = tempfile::tempdir().unwrap();
        let values = candidates();
        let chosen = values[1].clone();
        let rejected = values[0].clone();
        let record = PreferenceRecord {
            schema: "genethub-speech-preference.v3",
            feedback_id: "spf_test_pair".into(),
            recorded_at: "2026-08-11T00:00:00Z".into(),
            workspace_id: "w1".into(),
            request_id: "r1".into(),
            runtime: SpeechRuntimeDescriptor::default(),
            context_snapshot_id: "sc_1".into(),
            score_kind: SpeechScoreKind::MockRelative,
            scores_calibrated: false,
            candidates: values,
            selected_candidate_id: "c2".into(),
            rejected_candidate_id: Some("c1".into()),
            chosen,
            rejected: Some(rejected),
            scope: SpeechFeedbackScope {
                level: SpeechFeedbackLevel::Utterance,
                utterance_text: "GeneHub".into(),
                segment_id: None,
                segment_start_ms: None,
                segment_end_ms: None,
                preceding_text: None,
                following_text: None,
                uncertain_span_id: None,
                span_start_char: None,
                span_end_char: None,
            },
            audio_ref: None,
        };
        store(dir.path(), &record, &["GeneHub".into()]).unwrap();
        store(dir.path(), &record, &["GeneHub".into()]).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(LEARNED_TERMS_PATH))
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            ["GeneHub"]
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join(PREFERENCES_PATH))
                .unwrap()
                .lines()
                .count(),
            1
        );
        let first = std::fs::read_to_string(dir.path().join(PREFERENCES_PATH)).unwrap();
        let value: serde_json::Value = serde_json::from_str(first.lines().next().unwrap()).unwrap();
        assert_eq!(value["schema"], "genethub-speech-preference.v3");
        assert_eq!(value["runtime"]["model"], "Qwen3-ASR-1.7B");
        assert_eq!(value["feedbackId"], "spf_test_pair");
        assert_eq!(value["chosen"]["candidateId"], "c2");
        assert_eq!(value["rejected"]["candidateId"], "c1");
        let ignore = std::fs::read_to_string(dir.path().join(PRIVATE_GITIGNORE_PATH)).unwrap();
        assert!(ignore.lines().any(|line| line == "/preferences.jsonl"));
        assert!(ignore.lines().any(|line| line == "/learned-terms.txt"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(PREFERENCES_PATH))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn append_repairs_missing_line_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let speech = dir.path().join(".genethub/speech");
        std::fs::create_dir_all(&speech).unwrap();
        std::fs::write(speech.join("learned-terms.txt"), "ExistingTerm").unwrap();
        std::fs::write(speech.join("preferences.jsonl"), "{\"legacy\":true}").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                speech.join("preferences.jsonl"),
                std::fs::Permissions::from_mode(0o644),
            )
            .unwrap();
        }
        let values = candidates();
        let chosen = values[1].clone();
        let rejected = values[0].clone();
        let record = PreferenceRecord {
            schema: "genethub-speech-preference.v3",
            feedback_id: "spf_append_pair".into(),
            recorded_at: "2026-08-11T00:00:00Z".into(),
            workspace_id: "w1".into(),
            request_id: "r1".into(),
            runtime: SpeechRuntimeDescriptor::default(),
            context_snapshot_id: "sc_1".into(),
            score_kind: SpeechScoreKind::MockRelative,
            scores_calibrated: false,
            candidates: values,
            selected_candidate_id: "c2".into(),
            rejected_candidate_id: Some("c1".into()),
            chosen,
            rejected: Some(rejected),
            scope: SpeechFeedbackScope {
                level: SpeechFeedbackLevel::Utterance,
                utterance_text: "GeneHub".into(),
                segment_id: None,
                segment_start_ms: None,
                segment_end_ms: None,
                preceding_text: None,
                following_text: None,
                uncertain_span_id: None,
                span_start_char: None,
                span_end_char: None,
            },
            audio_ref: None,
        };

        store(dir.path(), &record, &["GeneHub".into()]).unwrap();

        let terms = std::fs::read_to_string(speech.join("learned-terms.txt")).unwrap();
        assert_eq!(
            terms.lines().collect::<Vec<_>>(),
            ["ExistingTerm", "GeneHub"]
        );
        let preferences = std::fs::read_to_string(speech.join("preferences.jsonl")).unwrap();
        assert_eq!(preferences.lines().count(), 2);
        for line in preferences.lines() {
            serde_json::from_str::<serde_json::Value>(line).unwrap();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(speech.join("preferences.jsonl"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn feedback_rejects_duplicate_candidate_text() {
        let mut values = candidates();
        values[1].text = values[0].text.clone();
        assert!(validate("r1", "sc_1", &values, "c2", None, None).is_err());
    }

    #[test]
    fn span_feedback_binds_a_local_pair_to_utterance_context() {
        let scope = SpeechFeedbackScope {
            level: SpeechFeedbackLevel::Span,
            utterance_text: "前文GeneHub后文".into(),
            segment_id: Some("segment-1".into()),
            segment_start_ms: Some(100),
            segment_end_ms: Some(900),
            preceding_text: Some("前文".into()),
            following_text: Some("后文".into()),
            uncertain_span_id: Some("span-1".into()),
            span_start_char: Some(0),
            span_end_char: Some(2),
        };
        assert!(validate("r1", "sc_1", &candidates(), "c2", Some("c1"), Some(&scope),).is_ok());

        let mut invalid = scope;
        invalid.following_text = Some("别的后文".into());
        assert!(validate(
            "r1",
            "sc_1",
            &candidates(),
            "c2",
            Some("c1"),
            Some(&invalid),
        )
        .is_err());
    }

    #[test]
    fn authoritative_scope_discards_client_supplied_training_text() {
        use genehub_proto::{
            SpeechSegment, SpeechSegmentBoundary, SpeechSegmentBoundaryKind, SpeechSpanAlternative,
            SpeechUncertainSpan,
        };

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
        let evidence = FeedbackEvidence {
            recorded_at: std::time::Instant::now(),
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
        assert!(!serde_json::to_string(&scope).unwrap().contains("恶意"));
        assert!(!serde_json::to_string(&scope).unwrap().contains("注入"));
    }

    #[test]
    fn protocol_stub_completion_is_never_training_evidence() {
        let evidence = FeedbackEvidence {
            recorded_at: std::time::Instant::now(),
            workspace_id: "w1".into(),
            request_id: "r1".into(),
            runtime: SpeechRuntimeDescriptor {
                id: "genehub-speech-stub".into(),
                model: "no-model".into(),
                label: "GeneHub 语音协议 Stub".into(),
                implementation: "stub".into(),
            },
            context_snapshot_id: "sc_1".into(),
            candidates: candidates(),
            segments: vec![],
            score_kind: SpeechScoreKind::MockRelative,
            scores_calibrated: false,
        };
        assert!(is_stub_evidence(&evidence));
    }
}
