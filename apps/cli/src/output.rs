//! Stable machine-readable output for the read-only CLI surface.
//!
//! The older daemon and Hub control commands predate this envelope. New
//! resource commands use it from their first release so agents never have to
//! infer meaning from prose or from a command-specific top-level shape.

use serde_json::{json, Value};

use crate::{EXIT_FAILED, EXIT_INVALID_ARGS, EXIT_UNREACHABLE};

pub const CLI_SCHEMA: &str = "genet.cli/v1";

#[derive(Debug, Clone, PartialEq)]
pub struct CliFailure {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
    pub exit: i32,
}

impl CliFailure {
    pub fn invalid_args(message: impl Into<String>) -> Self {
        Self {
            code: "invalidArgs",
            message: message.into(),
            retryable: false,
            details: None,
            exit: EXIT_INVALID_ARGS,
        }
    }

    pub fn daemon_unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "daemonUnavailable",
            message: message.into(),
            retryable: true,
            details: None,
            exit: EXIT_UNREACHABLE,
        }
    }

    pub fn protocol(message: impl Into<String>) -> Self {
        Self {
            code: "protocolIncompatible",
            message: message.into(),
            retryable: false,
            details: None,
            exit: EXIT_UNREACHABLE,
        }
    }

    pub fn target_not_found(kind: &str, id: &str) -> Self {
        Self {
            code: "targetNotFound",
            message: format!("no such {kind}: {id}"),
            retryable: false,
            details: Some(json!({format!("{kind}Id"): id})),
            exit: EXIT_FAILED,
        }
    }

    pub fn business(
        code: &'static str,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details,
            exit: EXIT_FAILED,
        }
    }
}

pub fn envelope(kind: &str, data: Value) -> Value {
    json!({
        "schema": CLI_SCHEMA,
        "type": kind,
        "data": data,
    })
}

pub fn error_envelope(error: &CliFailure) -> Value {
    // Errors stay at the same top-level path for a one-shot query and for a
    // future streaming operation. An Agent can branch on `type`, then inspect
    // `error.code`, without learning a second envelope shape.
    json!({
        "schema": CLI_SCHEMA,
        "type": "error",
        "error": {
            "code": error.code,
            "message": error.message,
            "retryable": error.retryable,
            "details": error.details,
        }
    })
}

pub fn generic_error_envelope(code: &str, message: &str) -> Value {
    json!({
        "schema": CLI_SCHEMA,
        "type": "error",
        "error": {
            "code": code,
            "message": message,
            "retryable": false,
            "details": null,
        }
    })
}

pub fn succeed(kind: &str, data: Value) -> i32 {
    println!("{}", envelope(kind, data));
    crate::EXIT_OK
}

pub fn fail(error: CliFailure) -> i32 {
    eprintln!("error: {}", error.message);
    println!("{}", error_envelope(&error));
    error.exit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_success_has_the_stable_three_field_envelope() {
        let value = envelope("workspace.list", json!({"workspaces": []}));
        assert_eq!(value["schema"], CLI_SCHEMA);
        assert_eq!(value["type"], "workspace.list");
        assert_eq!(value["data"], json!({"workspaces": []}));
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert!(!value.to_string().contains('\n'));
    }

    #[test]
    fn parameter_errors_use_the_stable_top_level_error_shape() {
        let error = CliFailure {
            code: "invalidArgs",
            message: "workspace show needs an id".into(),
            retryable: false,
            details: Some(json!({"argument": "id"})),
            exit: EXIT_INVALID_ARGS,
        };
        let value = error_envelope(&error);

        assert_eq!(value["schema"], CLI_SCHEMA);
        assert_eq!(value["type"], "error");
        assert_eq!(value["error"]["code"], "invalidArgs");
        assert_eq!(value["error"]["retryable"], false);
        assert_eq!(value["error"]["details"]["argument"], "id");
        assert_eq!(error.exit, 2);
    }

    #[test]
    fn legacy_commands_share_the_agent_envelope_even_when_codes_are_frozen() {
        let value = generic_error_envelope("invalid_args", "unknown command");
        assert_eq!(value["schema"], CLI_SCHEMA);
        assert_eq!(value["type"], "error");
        assert_eq!(value["error"]["code"], "invalid_args");
        assert_eq!(value["error"]["retryable"], false);
    }
}
