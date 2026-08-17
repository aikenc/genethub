//! OpenCode's one-turn `run --format json` protocol.
//!
//! Using the CLI's documented JSON stream keeps all protocol interpretation in
//! the portable application and avoids teaching the platform about OpenCode's
//! HTTP/SSE server. Each process represents one turn; OpenCode's own session id
//! is persisted and supplied to the next process.

use genehub_proto::{
    SessionEvent, TimelineItem, ToolCallDetail, ToolStatus, TurnError, TurnErrorCode, Usage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Driver {
    turn_id: String,
    session_id: Option<String>,
    completed: bool,
    /// A few OpenCode releases could exit cleanly before flushing their final
    /// `step_finish`. A recognized frame proves a real run started; a clean
    /// exit with no frame is not success (older releases used that shape for
    /// `Session not found`).
    #[serde(default)]
    saw_event: bool,
}

impl Driver {
    pub fn new(turn_id: String, session_id: Option<String>) -> Self {
        Self {
            turn_id,
            session_id,
            completed: false,
            saw_event: false,
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn can_complete_on_clean_exit(&self) -> bool {
        self.saw_event && !self.completed
    }

    pub fn line(&mut self, line: &str) -> Vec<SessionEvent> {
        let Ok(frame) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        if let Some(session) = frame
            .get("sessionID")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            self.session_id = Some(session.to_string());
        }
        let kind = frame
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(
            kind,
            "text" | "reasoning" | "tool_use" | "step_start" | "step_finish" | "error"
        ) {
            self.saw_event = true;
        }
        let part = frame.get("part").unwrap_or(&Value::Null);
        let item_id = || {
            part.get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("{}-{kind}", self.turn_id))
        };
        let event = match kind {
            "text" => Some(SessionEvent::Item {
                turn_id: self.turn_id.clone(),
                item: TimelineItem::AssistantMessage {
                    id: item_id(),
                    text: text(part, "text"),
                },
            }),
            "reasoning" => Some(SessionEvent::Item {
                turn_id: self.turn_id.clone(),
                item: TimelineItem::Reasoning {
                    id: item_id(),
                    text: text(part, "text"),
                },
            }),
            "tool_use" => Some(SessionEvent::Item {
                turn_id: self.turn_id.clone(),
                item: tool(part, item_id()),
            }),
            "step_finish" => {
                self.completed = true;
                Some(SessionEvent::TurnCompleted {
                    turn_id: self.turn_id.clone(),
                    usage: usage(part),
                    fork_checkpoint: None,
                })
            }
            "error" => {
                self.completed = true;
                let message = frame
                    .get("error")
                    .and_then(|value| value.get("data"))
                    .and_then(|value| value.get("message"))
                    .and_then(Value::as_str)
                    .or_else(|| frame.get("error").and_then(Value::as_str))
                    .unwrap_or("OpenCode reported an error")
                    .to_string();
                Some(SessionEvent::TurnFailed {
                    turn_id: self.turn_id.clone(),
                    error: classify(&message),
                })
            }
            "step_start" => None,
            _ => None,
        };
        event.into_iter().collect()
    }
}

fn text(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn tool(part: &Value, id: String) -> TimelineItem {
    let name = text(part, "tool");
    let state = part.get("state").unwrap_or(&Value::Null);
    let status = match state
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("pending")
    {
        "running" => ToolStatus::Running,
        "completed" => ToolStatus::Ok,
        "error" => ToolStatus::Error,
        _ => ToolStatus::Pending,
    };
    let input = state.get("input").cloned().unwrap_or(Value::Null);
    let output = text(state, "output");
    let arg = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let detail = match name.as_str() {
        "bash" => ToolCallDetail::Shell {
            command: arg("command"),
            output,
            exit_code: None,
        },
        "read" => ToolCallDetail::Read {
            path: arg("filePath"),
            content: output,
            truncated: false,
        },
        "write" => ToolCallDetail::Write {
            path: arg("filePath"),
            content: arg("content"),
        },
        "edit" | "patch" => ToolCallDetail::Edit {
            path: arg("filePath"),
            diff: state
                .get("metadata")
                .and_then(|value| value.get("diff"))
                .and_then(Value::as_str)
                .unwrap_or(&output)
                .to_string(),
        },
        "grep" | "glob" | "list" => ToolCallDetail::Search {
            query: input
                .get("pattern")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| arg("path")),
            matches: output
                .lines()
                .filter(|line| !line.is_empty())
                .take(500)
                .map(|line| genehub_proto::SearchMatch {
                    path: line.to_string(),
                    line: None,
                    preview: String::new(),
                })
                .collect(),
        },
        "webfetch" | "websearch" => ToolCallDetail::Fetch {
            url: arg("url"),
            summary: output,
        },
        "todowrite" | "todoread" => ToolCallDetail::Plan { markdown: output },
        "task" => ToolCallDetail::SubAgent {
            agent: arg("subagent_type"),
            prompt: arg("prompt"),
            items: Vec::new(),
        },
        _ => ToolCallDetail::Unknown {
            raw: json!({ "input": input, "output": output }),
        },
    };
    TimelineItem::ToolCall {
        id,
        name,
        status,
        detail,
    }
}

fn usage(part: &Value) -> Usage {
    let tokens = part.get("tokens").unwrap_or(&Value::Null);
    let cache = tokens.get("cache").unwrap_or(&Value::Null);
    let count = |value: &Value, key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    Usage {
        input_tokens: count(tokens, "input"),
        output_tokens: count(tokens, "output"),
        cache_read_tokens: count(cache, "read"),
        cache_write_tokens: count(cache, "write"),
        cost_usd: part.get("cost").and_then(Value::as_f64),
    }
}

fn classify(message: &str) -> TurnError {
    let lower = message.to_ascii_lowercase();
    let code = if lower.contains("api key") || lower.contains("unauthorized") {
        TurnErrorCode::MissingCredentials
    } else if lower.contains("rate limit") || lower.contains("429") {
        TurnErrorCode::RateLimited
    } else if lower.contains("timeout") || lower.contains("timed out") {
        TurnErrorCode::Timeout
    } else {
        TurnErrorCode::Upstream
    };
    TurnError {
        code,
        message: message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_run_stream_preserves_session_items_and_usage() {
        let mut driver = Driver::new("turn_1".into(), None);
        let text =
            driver.line(r#"{"type":"text","sessionID":"ses_1","part":{"id":"p1","text":"hello"}}"#);
        assert!(matches!(
            &text[0],
            SessionEvent::Item { item: TimelineItem::AssistantMessage { text, .. }, .. }
                if text == "hello"
        ));
        let end = driver.line(
            r#"{"type":"step_finish","sessionID":"ses_1","part":{"tokens":{"input":3,"output":4,"cache":{"read":2,"write":1}},"cost":0.1}}"#,
        );
        assert!(
            matches!(&end[0], SessionEvent::TurnCompleted { usage, .. } if usage.output_tokens == 4)
        );
        assert_eq!(driver.session_id(), Some("ses_1"));
        assert!(driver.completed);
    }

    #[test]
    fn tools_errors_and_clean_exit_fallback_keep_the_headless_contract() {
        let mut driver = Driver::new("turn_1".into(), None);
        assert!(!driver.can_complete_on_clean_exit());
        assert!(driver
            .line(r#"{"type":"step_start","sessionID":"ses_1","part":{}}"#)
            .is_empty());
        assert!(driver.can_complete_on_clean_exit());

        let shell = driver.line(
            r#"{"type":"tool_use","part":{"id":"tool_1","tool":"bash","state":{"status":"completed","input":{"command":"pwd"},"output":"/work"}}}"#,
        );
        assert!(matches!(
            &shell[0],
            SessionEvent::Item {
                item: TimelineItem::ToolCall {
                    status: ToolStatus::Ok,
                    detail: ToolCallDetail::Shell { command, output, .. },
                    ..
                },
                ..
            } if command == "pwd" && output == "/work"
        ));

        let unknown = driver.line(
            r#"{"type":"tool_use","part":{"id":"tool_2","tool":"mystery","state":{"status":"error","input":{"a":1},"output":"bad"}}}"#,
        );
        assert!(matches!(
            &unknown[0],
            SessionEvent::Item {
                item: TimelineItem::ToolCall {
                    status: ToolStatus::Error,
                    detail: ToolCallDetail::Unknown { raw },
                    ..
                },
                ..
            } if raw["input"]["a"] == 1 && raw["output"] == "bad"
        ));

        let failed = driver.line(
            r#"{"type":"error","error":{"data":{"message":"provider returned 429 rate limit"}}}"#,
        );
        assert!(matches!(
            &failed[0],
            SessionEvent::TurnFailed { error, .. }
                if error.code == TurnErrorCode::RateLimited
        ));
        assert!(!driver.can_complete_on_clean_exit());
    }

    #[test]
    fn old_snapshot_without_clean_exit_marker_still_restores() {
        let driver = Driver::new("turn_1".into(), Some("ses_1".into()));
        let mut snapshot = serde_json::to_value(driver).unwrap();
        snapshot.as_object_mut().unwrap().remove("sawEvent");
        let restored: Driver = serde_json::from_value(snapshot).unwrap();
        assert_eq!(restored.session_id(), Some("ses_1"));
        assert!(!restored.can_complete_on_clean_exit());
    }
}
