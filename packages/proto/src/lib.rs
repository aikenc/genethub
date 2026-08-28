//! The GeneHub client session protocol, defined once.
//!
//! Rust is the source of truth and the TypeScript definitions are generated
//! from it (`cargo test -p genehub-proto`, output in `bindings/index.ts`).
//! Writing the protocol twice is how frontend and backend drift apart around
//! the third field rename; generating one from the other makes that impossible.

pub mod data;
pub mod domain;
pub mod event;
pub mod rpc;
pub mod speech;
pub mod timeline;

pub use data::*;
pub use domain::*;
pub use event::*;
pub use rpc::*;
pub use speech::*;
pub use timeline::*;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Round-trip is the property worth pinning: the wire form is the contract,
    /// and an independent check that it survives a serialize/deserialize cycle
    /// catches tag and rename mistakes that no amount of reading will.
    fn round_trip<T>(value: T)
    where
        T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
    {
        let encoded = serde_json::to_string(&value).expect("serialize");
        let decoded: T = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(value, decoded, "round trip changed the value: {encoded}");
    }

    #[test]
    fn timeline_items_survive_a_round_trip() {
        round_trip(TimelineItem::AssistantMessage {
            id: "i1".into(),
            text: "hi".into(),
        });
        round_trip(TimelineItem::ToolCall {
            id: "i2".into(),
            name: "shell".into(),
            status: ToolStatus::Ok,
            detail: ToolCallDetail::Shell {
                command: "ls".into(),
                output: "a\nb".into(),
                exit_code: Some(0),
            },
            images: vec![],
        });
        round_trip(TimelineItem::ToolCall {
            id: "i3".into(),
            name: "mystery".into(),
            status: ToolStatus::Running,
            detail: ToolCallDetail::Unknown {
                raw: json!({"anything": [1, 2, 3]}),
            },
            images: vec![],
        });
    }

    #[test]
    fn every_request_variant_parses_from_its_wire_name() {
        let cases = [
            json!({"type": "session.send", "payload": {"sessionId": "s", "text": "go"}}),
            json!({"type": "agent.list"}),
            json!({"type": "git.commit", "payload": {"workspaceId": "w", "message": "m"}}),
            json!({"type": "pty.resize", "payload": {"ptyId": "p", "cols": 80, "rows": 24}}),
            json!({"type": "workspace.rename", "payload": {"workspaceId": "w", "name": "demo"}}),
            json!({"type": "session.fork", "payload": {"sessionId": "s", "turnId": "t"}}),
            json!({"type": "session.artifact.begin", "payload": {
                "sessionId": "s",
                "files": [{"name": "events.jsonl", "mime": "application/x-ndjson", "bytes": 0}],
                "metadata": {"schema": "genehub.preview-runtime.v2"}
            }}),
            json!({"type": "session.forkExport", "payload": {"sessionId": "s", "turnId": "t"}}),
            json!({"type": "diagnostics.snapshot"}),
        ];
        for case in cases {
            let raw = case.to_string();
            serde_json::from_str::<Request>(&raw)
                .unwrap_or_else(|error| panic!("{raw} failed to parse: {error:?}"));
        }
    }

    #[test]
    fn optional_request_fields_may_be_omitted() {
        let request: Request = serde_json::from_value(
            json!({"type": "session.create", "payload": {"workspaceId": "w", "agentId": "genet"}}),
        )
        .expect("parse");
        match request {
            Request::SessionCreate {
                model_id, title, ..
            } => {
                assert!(model_id.is_none());
                assert!(title.is_none());
            }
            other => panic!("wrong variant: {other:?}"),
        }

        let fork: Request = serde_json::from_value(
            json!({"type": "session.fork", "payload": {"sessionId": "s", "turnId": "t"}}),
        )
        .expect("parse legacy fork");
        assert!(matches!(fork, Request::SessionFork { target: None, .. }));
    }

    #[test]
    fn diagnostics_omit_an_absent_categorical_code() {
        let event = SupportDiagnosticEvent {
            at: "2026-08-12T00:00:00.000Z".into(),
            component: "daemon".into(),
            operation: "lifecycle".into(),
            outcome: "started".into(),
            code: None,
            count: 1,
        };
        let encoded = serde_json::to_value(event).expect("serialize diagnostic event");
        assert_eq!(encoded.get("code"), None, "None must be absent, not null");
    }

    #[test]
    fn fork_target_survives_the_wire() {
        round_trip(Request::SessionFork {
            session_id: "source".into(),
            turn_id: "turn-7".into(),
            target: Some(ForkTarget {
                agent_id: "claude".into(),
                workspace_id: Some("target-workspace".into()),
                model_id: Some("sonnet".into()),
                mode_id: None,
                effort_id: None,
            }),
        });
    }

    #[test]
    fn portable_fork_transfer_survives_the_wire() {
        round_trip(ForkTransfer {
            source_session_id: "source".into(),
            source_turn_id: "turn-7".into(),
            source_agent_id: "codex".into(),
            source_round_id: Some("round-3".into()),
            title: Some("Investigate".into()),
            items: vec![TimelineItem::AssistantMessage {
                id: "a1".into(),
                text: "done".into(),
            }],
            blob_appendix: vec![],
            coverage: HistoryCoverage {
                source_item_count: Some(1),
                retained_item_count: 1,
                omitted_item_count: 0,
                retrieval: RetrievalCapability::Genehub,
                reason: None,
            },
        });
    }

    #[test]
    fn session_events_survive_a_round_trip() {
        round_trip(SequencedEvent {
            seq: 7,
            session_id: "s".into(),
            event: SessionEvent::ItemDelta {
                turn_id: "t".into(),
                item_id: "i".into(),
                delta: ItemDelta::Text {
                    delta: "chunk".into(),
                },
            },
        });
        round_trip(SequencedEvent {
            seq: 8,
            session_id: "s".into(),
            event: SessionEvent::TurnFailed {
                turn_id: "t".into(),
                error: TurnError {
                    code: TurnErrorCode::MissingCredentials,
                    message: "no api key configured".into(),
                },
            },
        });
    }

    #[test]
    fn appending_text_only_applies_to_streaming_items() {
        let mut message = TimelineItem::AssistantMessage {
            id: "i".into(),
            text: "a".into(),
        };
        assert!(message.append_text("b"));
        assert_eq!(
            message,
            TimelineItem::AssistantMessage {
                id: "i".into(),
                text: "ab".into()
            }
        );

        let mut todo = TimelineItem::Todo {
            id: "i".into(),
            items: vec![],
        };
        assert!(
            !todo.append_text("b"),
            "a text delta for a todo item is a protocol error, not a no-op"
        );
    }

    #[test]
    fn protocol_identity_is_camel_case_on_the_wire() {
        // The numbers themselves are pinned in `genehub-identity`, which owns
        // them. What this crate owns is the shape they travel in.
        let encoded = serde_json::to_value(ProtocolIdentity {
            web_protocol: WEB_PROTOCOL_VERSION,
        })
        .expect("serialize");
        assert_eq!(encoded, json!({"webProtocol": 3}));
        round_trip(ProtocolIdentity {
            web_protocol: WEB_PROTOCOL_VERSION,
        });
    }

    #[test]
    fn an_invite_sent_the_way_it_was_sent_before_grants_still_means_no_limits() {
        // Pairing is the exchange that has to keep working on the machine
        // nobody can walk over to and fix, so an older client that never heard
        // of grants must still be understood, and understood as asking for
        // what it always got.
        let old: Request = serde_json::from_value(json!({"type": "device.invite"})).unwrap();
        assert_eq!(old, Request::DeviceInvite(None));

        let narrowed: Request = serde_json::from_value(
            json!({"type": "device.invite", "payload": {"grants": ["read", "session"]}}),
        )
        .unwrap();
        assert_eq!(
            narrowed,
            Request::DeviceInvite(Some(InviteScope {
                grants: vec!["read".into(), "session".into()]
            }))
        );

        round_trip(Request::DeviceInvite(None));
        round_trip(Request::DeviceInvite(Some(InviteScope {
            grants: vec!["pty".into()],
        })));
    }
}
