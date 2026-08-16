use genehub_proto::{
    SpeechCandidate, SpeechContextPack, SpeechFailure, SpeechFailureCode, SpeechPartial,
    SpeechRuntimeCapabilities, SpeechScoreKind, SpeechSegment, SpeechSegmentBoundary,
    SpeechSegmentBoundaryKind, SpeechSpanAlternative, SpeechStart, SpeechUncertainSpan,
};
use tokio::sync::mpsc;

use genet_daemon_logic_api::SpeechConfig;

use super::{
    stub_runtime_capabilities, RuntimeCommand, RuntimeEvent, RuntimeSession, SpeechRuntime,
};

/// A zero-setup protocol Stub. It deliberately does not pretend to understand
/// the audio; it exercises the exact stream, context, Partial and N-best path
/// that a community Qwen3 runtime will implement.
#[derive(Default)]
pub struct ProtocolStubRuntime;

#[async_trait::async_trait]
impl SpeechRuntime for ProtocolStubRuntime {
    async fn probe(
        &self,
        _config: &SpeechConfig,
    ) -> Result<SpeechRuntimeCapabilities, SpeechFailure> {
        Ok(stub_runtime_capabilities())
    }

    async fn open(
        &self,
        _config: &SpeechConfig,
        start: &SpeechStart,
        _capabilities: &SpeechRuntimeCapabilities,
    ) -> Result<RuntimeSession, SpeechFailure> {
        let (commands, command_rx) = mpsc::channel(16);
        let (event_tx, events) = mpsc::channel(8);
        tokio::spawn(run(
            command_rx,
            event_tx,
            start.request_id.clone(),
            start.context.clone(),
            start.accept_partial,
        ));
        Ok(RuntimeSession {
            capabilities: stub_runtime_capabilities(),
            commands,
            events,
        })
    }
}

async fn run(
    mut commands: mpsc::Receiver<RuntimeCommand>,
    events: mpsc::Sender<RuntimeEvent>,
    request_id: String,
    mut context: SpeechContextPack,
    accept_partial: bool,
) {
    let mut duration_ms = 0u32;
    let mut partial_revision = 0u32;
    let mut previous_partial = String::new();
    if context.snapshot_id.is_empty() {
        let _ = events
            .send(RuntimeEvent::Failed(SpeechFailure {
                code: SpeechFailureCode::ContextRejected,
                message: "Qwen3 context snapshot 缺少标识".into(),
                retryable: false,
                retry_after_ms: None,
                correlation_id: None,
            }))
            .await;
        return;
    }
    while let Some(command) = commands.recv().await {
        match command {
            RuntimeCommand::Audio {
                pcm: bytes,
                duration_ms: chunk_ms,
                ..
            } => {
                // Consume the real audio stream so backpressure and framing are
                // exercised, but never infer content in the mock.
                let _ = bytes.len();
                duration_ms = duration_ms.saturating_add(chunk_ms as u32);
                if accept_partial {
                    let next = partial_text(&context, duration_ms);
                    if let Some(next) = next.filter(|next| next != &previous_partial) {
                        partial_revision += 1;
                        let stable_prefix_chars = common_prefix_chars(&previous_partial, &next);
                        previous_partial = next.clone();
                        if events
                            .send(RuntimeEvent::Partial(SpeechPartial {
                                request_id: request_id.clone(),
                                revision: partial_revision,
                                text: next,
                                audio_end_ms: duration_ms,
                                stable_prefix_chars,
                            }))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
            RuntimeCommand::Context {
                revision,
                context: next,
            } => {
                context = next;
                if events
                    .send(RuntimeEvent::ContextApplied { revision })
                    .await
                    .is_err()
                {
                    return;
                }
            }
            RuntimeCommand::Finish => {
                let (candidates, segments) = completion(&context, duration_ms);
                let _ = events
                    .send(RuntimeEvent::Completed {
                        request_id,
                        duration_ms,
                        context_snapshot_id: context.snapshot_id.clone(),
                        candidates,
                        segments,
                        score_kind: SpeechScoreKind::MockRelative,
                        scores_calibrated: false,
                    })
                    .await;
                return;
            }
            RuntimeCommand::Cancel => return,
        }
    }
}

fn partial_text(context: &SpeechContextPack, duration_ms: u32) -> Option<String> {
    let term = context
        .terms
        .iter()
        .map(|term| term.text.trim())
        .find(|term| !term.is_empty() && !term.to_ascii_lowercase().contains("qwen"))
        .unwrap_or("GeneHub");
    match duration_ms {
        0..=399 => None,
        400..=999 => Some(format!("请在 {term} 中")),
        1_000..=1_799 => Some(format!("请在 {term} 中全面支持")),
        1_800..=2_599 => Some(format!("请在 {term} 中全面支持 Qwen 三语音识别，")),
        _ => Some(format!(
            "请在 {term} 中全面支持 Qwen 三语音识别，并保留整个输入的识别候选。"
        )),
    }
}

fn common_prefix_chars(left: &str, right: &str) -> u32 {
    left.chars()
        .zip(right.chars())
        .take_while(|(left, right)| left == right)
        .count() as u32
}

fn completion(
    context: &SpeechContextPack,
    duration_ms: u32,
) -> (Vec<SpeechCandidate>, Vec<SpeechSegment>) {
    let term = context
        .terms
        .iter()
        .map(|term| term.text.trim())
        .find(|term| !term.is_empty() && !term.to_ascii_lowercase().contains("qwen"))
        .unwrap_or("GeneHub");
    let matched = vec![term.to_string()];
    let first = vec![
        SpeechCandidate {
            candidate_id: "stub-s1-1".to_string(),
            rank: 1,
            text: format!("请在 {term} 中全面支持 Qwen 三语音识别，"),
            score: -0.18,
            matched_terms: matched.clone(),
        },
        SpeechCandidate {
            candidate_id: "stub-s1-2".to_string(),
            rank: 2,
            text: format!("请在 {term} 中全面支持 Qwen3-ASR，"),
            score: -0.24,
            matched_terms: vec![term.to_string(), "Qwen3-ASR".to_string()],
        },
        SpeechCandidate {
            candidate_id: "stub-s1-3".to_string(),
            rank: 3,
            text: format!("请在 {term} 中全面支持 Qwen3 ASR，"),
            score: -0.39,
            matched_terms: vec![term.to_string(), "Qwen3 ASR".to_string()],
        },
    ];
    let second = vec![
        SpeechCandidate {
            candidate_id: "stub-s2-1".to_string(),
            rank: 1,
            text: "并保留整个输入的识别候选。".to_string(),
            score: -0.12,
            matched_terms: Vec::new(),
        },
        SpeechCandidate {
            candidate_id: "stub-s2-2".to_string(),
            rank: 2,
            text: "并按分段提供 N-best 识别候选。".to_string(),
            score: -0.21,
            matched_terms: vec!["N-best".to_string()],
        },
        SpeechCandidate {
            candidate_id: "stub-s2-3".to_string(),
            rank: 3,
            text: "并标记低置信度的专业术语。".to_string(),
            score: -0.33,
            matched_terms: Vec::new(),
        },
    ];
    let first_default = first[0].text.clone();
    let second_default = second[0].text.clone();
    let first_chars = first_default.chars().count() as u32;
    let second_chars = second_default.chars().count() as u32;
    let (first_span_start, first_span_end) = char_range(&first_default, "Qwen 三语音识别");
    let (second_span_start, second_span_end) = char_range(&second_default, "整个输入的识别候选");
    let split_ms = duration_ms / 2;
    let segments = vec![
        SpeechSegment {
            segment_id: "stub-segment-1".to_string(),
            start_ms: 0,
            end_ms: split_ms,
            text_start_char: 0,
            text_end_char: first_chars,
            text: first_default.clone(),
            candidates: first.clone(),
            default_candidate_id: first[0].candidate_id.clone(),
            uncertain_spans: vec![SpeechUncertainSpan {
                span_id: "stub-span-model".to_string(),
                start_char: first_span_start,
                end_char: first_span_end,
                alternatives: vec![
                    SpeechSpanAlternative {
                        alternative_id: "stub-span-model-1".to_string(),
                        candidate_id: first[0].candidate_id.clone(),
                        text: "Qwen 三语音识别".to_string(),
                        score: first[0].score,
                    },
                    SpeechSpanAlternative {
                        alternative_id: "stub-span-model-2".to_string(),
                        candidate_id: first[1].candidate_id.clone(),
                        text: "Qwen3-ASR".to_string(),
                        score: first[1].score,
                    },
                    SpeechSpanAlternative {
                        alternative_id: "stub-span-model-3".to_string(),
                        candidate_id: first[2].candidate_id.clone(),
                        text: "Qwen3 ASR".to_string(),
                        score: first[2].score,
                    },
                ],
                default_alternative_id: "stub-span-model-1".to_string(),
            }],
            boundary: SpeechSegmentBoundary {
                kind: SpeechSegmentBoundaryKind::DecoderEndpoint,
                confidence: 0.86,
            },
        },
        SpeechSegment {
            segment_id: "stub-segment-2".to_string(),
            start_ms: split_ms,
            end_ms: duration_ms,
            text_start_char: first_chars,
            text_end_char: first_chars + second_chars,
            text: second_default.clone(),
            candidates: second.clone(),
            default_candidate_id: second[0].candidate_id.clone(),
            uncertain_spans: vec![SpeechUncertainSpan {
                span_id: "stub-span-granularity".to_string(),
                start_char: second_span_start,
                end_char: second_span_end,
                alternatives: vec![
                    SpeechSpanAlternative {
                        alternative_id: "stub-span-granularity-1".to_string(),
                        candidate_id: second[0].candidate_id.clone(),
                        text: "整个输入的识别候选".to_string(),
                        score: second[0].score,
                    },
                    SpeechSpanAlternative {
                        alternative_id: "stub-span-granularity-2".to_string(),
                        candidate_id: second[1].candidate_id.clone(),
                        text: "分段提供 N-best 识别候选".to_string(),
                        score: second[1].score,
                    },
                    SpeechSpanAlternative {
                        alternative_id: "stub-span-granularity-3".to_string(),
                        candidate_id: second[2].candidate_id.clone(),
                        text: "低置信度的专业术语".to_string(),
                        score: second[2].score,
                    },
                ],
                default_alternative_id: "stub-span-granularity-1".to_string(),
            }],
            boundary: SpeechSegmentBoundary {
                kind: SpeechSegmentBoundaryKind::Final,
                confidence: 1.0,
            },
        },
    ];
    let candidates = (0..3)
        .map(|index| SpeechCandidate {
            candidate_id: format!("mock-global-{}", index + 1),
            rank: (index + 1) as u8,
            text: format!("{}{}", first[index].text, second[index].text),
            score: first[index].score + second[index].score,
            matched_terms: first[index]
                .matched_terms
                .iter()
                .chain(second[index].matched_terms.iter())
                .cloned()
                .collect(),
        })
        .collect();
    (candidates, segments)
}

fn char_range(text: &str, needle: &str) -> (u32, u32) {
    let byte_start = text.find(needle).expect("mock span must exist");
    let start = text[..byte_start].chars().count() as u32;
    (start, start + needle.chars().count() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::{SpeechAudioFormat, SpeechContextSource, SpeechContextTerm, SpeechStart};

    #[test]
    fn mock_exposes_distinct_ranked_candidates_and_uses_project_terms() {
        let mut context = SpeechContextPack::empty();
        context.terms.push(SpeechContextTerm {
            text: "PipeSpace".into(),
            source: SpeechContextSource::ProjectConfig,
            score: 1.0,
        });
        let (result, segments) = completion(&context, 1_200);
        assert_eq!(result.len(), 3);
        assert_eq!(
            result.iter().map(|item| item.rank).collect::<Vec<_>>(),
            [1, 2, 3]
        );
        assert!(result[1].text.contains("PipeSpace"));
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].uncertain_spans.len(), 1);
        assert_eq!(
            segments
                .iter()
                .map(|segment| segment.text.as_str())
                .collect::<String>(),
            result[0].text
        );
        assert_ne!(result[0].text, result[1].text);
    }

    #[test]
    fn mock_completion_passes_the_production_result_validator() {
        let context = SpeechContextPack::empty();
        let duration_ms = 1_200;
        let (candidates, segments) = completion(&context, duration_ms);

        let default = super::super::validate_runtime_candidates(&candidates)
            .expect("mock whole-utterance candidates must be valid");
        super::super::validate_runtime_segments(&segments, default, duration_ms)
            .expect("mock segments and uncertain spans must be valid");
    }

    #[tokio::test]
    async fn mock_session_consumes_audio_and_completes_only_after_finish() {
        let mut context = SpeechContextPack::empty();
        context.terms.push(SpeechContextTerm {
            text: "GeneHub".into(),
            source: SpeechContextSource::Pinned,
            score: 1.0,
        });
        let start = SpeechStart {
            request_id: "request-1".into(),
            workspace_id: "workspace-1".into(),
            session_id: None,
            audio: SpeechAudioFormat::default(),
            language_hints: vec!["zh".into()],
            context,
            context_revision: 1,
            accept_partial: false,
        };
        let runtime = ProtocolStubRuntime;
        let mut session = runtime
            .open(
                &SpeechConfig::default(),
                &start,
                &stub_runtime_capabilities(),
            )
            .await
            .unwrap();
        session
            .send(RuntimeCommand::Audio {
                index: 0,
                capture_start_ms: 0,
                pcm: vec![0; 3_200],
                duration_ms: 100,
            })
            .await
            .unwrap();
        assert!(session.events.try_recv().is_err());
        session.send(RuntimeCommand::Finish).await.unwrap();
        let RuntimeEvent::Completed {
            candidates,
            segments,
            score_kind,
            scores_calibrated,
            ..
        } = session.events.recv().await.unwrap()
        else {
            panic!("mock must complete after Finish")
        };
        assert_eq!(candidates.len(), 3);
        assert_eq!(segments.len(), 2);
        assert_eq!(score_kind, SpeechScoreKind::MockRelative);
        assert!(!scores_calibrated);
    }

    #[tokio::test]
    async fn stub_session_emits_revisioned_partial_after_streamed_audio() {
        let mut context = SpeechContextPack::empty();
        context.terms.push(SpeechContextTerm {
            text: "PipeSpace".into(),
            source: SpeechContextSource::ProjectConfig,
            score: 1.0,
        });
        let start = SpeechStart {
            request_id: "request-partial".into(),
            workspace_id: "workspace-1".into(),
            session_id: None,
            audio: SpeechAudioFormat::default(),
            language_hints: vec!["zh".into()],
            context,
            context_revision: 1,
            accept_partial: true,
        };
        let runtime = ProtocolStubRuntime;
        let mut session = runtime
            .open(
                &SpeechConfig::default(),
                &start,
                &stub_runtime_capabilities(),
            )
            .await
            .unwrap();
        for index in 0..2 {
            session
                .send(RuntimeCommand::Audio {
                    index,
                    capture_start_ms: index * 200,
                    pcm: vec![0; 6_400],
                    duration_ms: 200,
                })
                .await
                .unwrap();
        }
        let RuntimeEvent::Partial(partial) = session.events.recv().await.unwrap() else {
            panic!("Stub must emit a partial through the runtime event path")
        };
        assert_eq!(partial.revision, 1);
        assert_eq!(partial.audio_end_ms, 400);
        assert_eq!(partial.stable_prefix_chars, 0);
        assert!(partial.text.contains("PipeSpace"));
    }
}
