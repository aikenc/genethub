use std::fmt;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub level: &'static str,
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

impl Diagnostic {
    pub fn error(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            level: "error",
            code,
            message: message.into(),
            sources: Vec::new(),
            target: None,
            semantic_key: None,
            action: action_for(code).map(str::to_string),
        }
    }

    pub fn warning(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            level: "warn",
            code,
            message: message.into(),
            sources: Vec::new(),
            target: None,
            semantic_key: None,
            action: action_for(code).map(str::to_string),
        }
    }

    pub fn source(mut self, source: impl Into<String>) -> Self {
        self.sources.push(source.into());
        self
    }

    pub fn sources(mut self, sources: impl IntoIterator<Item = String>) -> Self {
        self.sources.extend(sources);
        self
    }

    pub fn target(mut self, target: impl Into<String>) -> Self {
        self.target = Some(target.into());
        self
    }

    pub fn semantic_key(mut self, key: impl Into<String>) -> Self {
        self.semantic_key = Some(key.into());
        self
    }

    pub fn action(mut self, action: impl Into<String>) -> Self {
        self.action = Some(action.into());
        self
    }
}

#[derive(Debug)]
pub struct BuilderError(pub Diagnostic);

impl fmt::Display for BuilderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.0.code, self.0.message)
    }
}

impl std::error::Error for BuilderError {}

pub type BuilderResult<T> = Result<T, BuilderError>;

pub fn fail<T>(diagnostic: Diagnostic) -> BuilderResult<T> {
    Err(BuilderError(diagnostic))
}

fn action_for(code: &str) -> Option<&'static str> {
    match code {
        "PB001" => Some("Correct pipespace.json or the ownership lock to match the documented schema."),
        "PB002" => Some("Use a lowercase kebab-case Agent Space name."),
        "PB003" | "PB004" => Some("Create or correct the matching .code-workspace source."),
        "PB005" | "PB007" | "PB008" => Some("Correct the local Skill Provider and selected Skill sources."),
        "PB006" => Some("The local-only MVP supports folder Skill Providers; remove remote or executable Providers."),
        "PB009" => Some("Use a supported Agent-native source path and valid document shape."),
        "PB010" => Some("Move human-owned content into Builder sources or restore the ownership lock before rebuilding."),
        "PB011" => Some("Keep every source and generated target inside the local PM project without symlinks or secrets."),
        "PB013" => Some("Wait for the active build to finish, then retry."),
        "PB014" => Some("Confirm the owning process is gone, then remove the stale build.lock."),
        "PB017" => Some("Rebuild the Agent Space from its current sources, then verify again."),
        "PB018" => Some("Remove Provider post commands; PM Agent Space builds must be pure projections."),
        _ => None,
    }
}
