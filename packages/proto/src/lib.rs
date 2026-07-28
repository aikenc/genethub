//! The GeneHub client session protocol, defined once.
//!
//! Rust is the source of truth and the TypeScript definitions are generated
//! from it (`cargo test -p genehub-proto`, output in `bindings/index.ts`).
//! Writing the protocol twice is how frontend and backend drift apart around
//! the third field rename; generating one from the other makes that impossible.

pub mod domain;
pub mod event;
pub mod rpc;
pub mod timeline;

pub use domain::*;
pub use event::*;
pub use rpc::*;
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
        });
        round_trip(TimelineItem::ToolCall {
            id: "i3".into(),
            name: "mystery".into(),
            status: ToolStatus::Running,
            detail: ToolCallDetail::Unknown {
                raw: json!({"anything": [1, 2, 3]}),
            },
        });
    }

    #[test]
    fn every_request_variant_parses_from_its_wire_name() {
        let cases = [
            json!({"id": "1", "type": "hello", "payload": {"clientName": "web", "protocolVersion": 1}}),
            json!({"id": "2", "type": "session.send", "payload": {"sessionId": "s", "text": "go"}}),
            json!({"id": "3", "type": "agent.list"}),
            json!({"id": "4", "type": "git.commit", "payload": {"workspaceId": "w", "message": "m"}}),
            json!({"id": "5", "type": "pty.resize", "payload": {"ptyId": "p", "cols": 80, "rows": 24}}),
        ];
        for case in cases {
            let raw = case.to_string();
            parse_envelope(&raw).unwrap_or_else(|e| panic!("{raw} failed to parse: {e:?}"));
        }
    }

    #[test]
    fn optional_request_fields_may_be_omitted() {
        let envelope = parse_envelope(
            &json!({"id": "1", "type": "session.create", "payload": {"workspaceId": "w", "agentId": "genet"}})
                .to_string(),
        )
        .expect("parse");
        match envelope.request {
            Request::SessionCreate {
                model_id, title, ..
            } => {
                assert!(model_id.is_none());
                assert!(title.is_none());
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    /// A client that sends a bad payload still needs its reply, otherwise the
    /// request sits pending until timeout with no explanation.
    #[test]
    fn a_malformed_payload_still_yields_the_envelope_id() {
        let (id, error) = parse_envelope(r#"{"id":"c9","type":"session.send","payload":{}}"#)
            .expect_err("should reject a payload missing required fields");
        assert_eq!(id.as_deref(), Some("c9"));
        assert_eq!(error.code, ErrorCode::BadRequest);
    }

    #[test]
    fn unparseable_json_reports_no_id_rather_than_inventing_one() {
        let (id, error) = parse_envelope("{not json").expect_err("should reject");
        assert!(id.is_none());
        assert_eq!(error.code, ErrorCode::BadRequest);
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
    fn results_and_errors_serialize_without_null_noise() {
        let ok = serde_json::to_value(ServerFrame::ok("1", Reply::Ack)).unwrap();
        assert_eq!(ok["type"], "result");
        assert_eq!(ok["ok"], true);
        assert!(ok.get("error").is_none(), "no null error field: {ok}");

        let err = serde_json::to_value(ServerFrame::err("1", ErrorCode::NotFound, "gone")).unwrap();
        assert_eq!(err["ok"], false);
        assert_eq!(err["error"]["code"], "notFound");
        assert!(err.get("payload").is_none(), "no null payload field: {err}");
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
}
