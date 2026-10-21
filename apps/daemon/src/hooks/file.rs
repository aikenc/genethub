//! The files that make up a project's timer hooks.
//!
//! The directory is the registry. Nothing here remembers a hook: every call
//! reads `<project>/.genethub/hooks/` again, so what a caller sees is what will
//! run, and a hook that was added, edited, disabled or deleted is the next
//! read's business. A file that cannot run is returned as invalid, with the
//! reason, rather than dropped: a broken hook someone cannot see is a hook
//! that quietly never fires.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

/// A hook file is `<id>.genet.json`.
pub const SUFFIX: &str = ".genet.json";
/// What a hook file says about itself. Absent is accepted, for files written by
/// hand; anything else is a different format.
pub const SCHEMA: &str = "genet.hook.v1";
/// The only event there is.
pub const EVENT_TIMER: &str = "timer";

pub const MIN_EVERY: Duration = Duration::from_secs(1);
pub const MAX_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_FILE_BYTES: u64 = 64 * 1024;

/// What a valid hook file asks for. `owner` and `payload` are the file's own
/// business: kept, shown, handed to the command, never interpreted.
#[derive(Debug, Clone, PartialEq)]
pub struct Spec {
    pub every: Duration,
    pub exec: Vec<String>,
    pub cwd: Option<String>,
    pub timeout: Duration,
    pub enabled: bool,
    pub owner: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    Valid { id: String, spec: Spec },
    Invalid { id: String, problem: String },
}

impl Entry {
    pub fn id(&self) -> &str {
        match self {
            Entry::Valid { id, .. } | Entry::Invalid { id, .. } => id,
        }
    }
}

/// Every hook file in `dir`, by id. A directory that is not there has no hooks.
pub fn snapshot(dir: &Path) -> Vec<Entry> {
    let reader = match std::fs::read_dir(dir) {
        Ok(reader) => reader,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            return vec![Entry::Invalid {
                id: ".".into(),
                problem: format!("the hooks directory cannot be read: {error}"),
            }]
        }
    };
    let mut entries = Vec::new();
    for item in reader.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        // Temporary files from an atomic write, editor backups and anything
        // else that is not a hook file are not hooks.
        if name.starts_with('.') || !name.ends_with(SUFFIX) {
            continue;
        }
        let id = name[..name.len() - SUFFIX.len()].to_string();
        if id.is_empty() {
            continue;
        }
        let path = item.path();
        entries.push(match read(&path) {
            Ok(spec) => Entry::Valid { id, spec },
            Err(problem) => Entry::Invalid { id, problem },
        });
    }
    entries.sort_by(|a, b| a.id().cmp(b.id()));
    refuse_duplicates(entries)
}

/// Two files whose ids differ only in case are one id on some filesystems and
/// two on others. Neither runs, on any of them, so the answer does not depend
/// on where the project is opened.
fn refuse_duplicates(entries: Vec<Entry>) -> Vec<Entry> {
    let mut seen: HashMap<String, Vec<String>> = HashMap::new();
    for entry in &entries {
        seen.entry(entry.id().to_lowercase())
            .or_default()
            .push(entry.id().to_string());
    }
    entries
        .into_iter()
        .map(|entry| {
            let ids = &seen[&entry.id().to_lowercase()];
            if ids.len() < 2 {
                return entry;
            }
            Entry::Invalid {
                id: entry.id().to_string(),
                problem: format!(
                    "the id is also {} when case is ignored; rename one of the files",
                    ids.iter()
                        .filter(|other| other.as_str() != entry.id())
                        .map(|other| format!("`{other}`"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            }
        })
        .collect()
}

fn read(path: &Path) -> Result<Spec, String> {
    // A link would let a file outside the project decide what the daemon runs.
    let meta =
        std::fs::symlink_metadata(path).map_err(|error| format!("cannot be read: {error}"))?;
    if meta.file_type().is_symlink() {
        return Err("a symbolic link is refused; write the file in place".into());
    }
    if !meta.is_file() {
        return Err("is not a regular file".into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("is larger than {MAX_FILE_BYTES} bytes"));
    }
    let text = std::fs::read_to_string(path).map_err(|error| format!("cannot be read: {error}"))?;
    parse(&text)
}

/// Checks one hook file's text. Every refusal says what to change.
pub fn parse(text: &str) -> Result<Spec, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|error| format!("is not valid JSON: {error}"))?;
    let Some(object) = value.as_object() else {
        return Err("must be one JSON object".into());
    };
    if let Some(schema) = object.get("schema") {
        if schema.as_str() != Some(SCHEMA) {
            return Err(format!("\"schema\" must be \"{SCHEMA}\" or absent"));
        }
    }
    match object.get("event").and_then(Value::as_str) {
        Some(EVENT_TIMER) => {}
        Some(other) => {
            return Err(format!(
            "\"event\" `{other}` is not one the daemon fires; the only event is \"{EVENT_TIMER}\""
        ))
        }
        None => return Err(format!("\"event\" is required (\"{EVENT_TIMER}\")")),
    }
    let every = match object.get("every") {
        Some(Value::String(text)) => parse_every(text)?,
        Some(_) => {
            return Err("\"every\" must be a string such as \"5s\", \"1m\" or \"2h\"".into())
        }
        None => return Err("\"every\" is required, for example \"5s\"".into()),
    };
    let exec = match object.get("exec") {
        Some(Value::Array(items)) if !items.is_empty() => items
            .iter()
            .map(|item| match item.as_str() {
                Some(text) if !text.is_empty() => Ok(text.to_string()),
                _ => Err(
                    "\"exec\" must be a list of non-empty strings: the program, then its arguments"
                        .to_string(),
                ),
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(
                "\"exec\" is required: a non-empty list, the program then its arguments (no shell)"
                    .into(),
            )
        }
    };
    let timeout = match object.get("timeout") {
        None => DEFAULT_TIMEOUT,
        Some(Value::Number(number)) => match number.as_u64() {
            Some(seconds) if (1..=MAX_TIMEOUT.as_secs()).contains(&seconds) => {
                Duration::from_secs(seconds)
            }
            _ => {
                return Err(format!(
                    "\"timeout\" is whole seconds from 1 to {}",
                    MAX_TIMEOUT.as_secs()
                ))
            }
        },
        Some(_) => return Err("\"timeout\" must be a number of seconds".into()),
    };
    let enabled = match object.get("enabled") {
        None => true,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return Err("\"enabled\" must be true or false".into()),
    };
    let cwd = match object.get("cwd") {
        None => None,
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        Some(_) => return Err("\"cwd\" must be a non-empty string".into()),
    };
    let owner = object
        .get("owner")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(Spec {
        every,
        exec,
        cwd,
        timeout,
        enabled,
        owner,
        payload: object.get("payload").cloned().unwrap_or(Value::Null),
    })
}

/// `5s`, `1m`, `2h`: whole numbers, one unit, between one second and a day.
pub fn parse_every(text: &str) -> Result<Duration, String> {
    let bad = || {
        format!(
            "\"every\" `{text}` is not a duration; write whole seconds, minutes or hours: \"5s\", \"1m\", \"2h\""
        )
    };
    let (digits, unit) = text.split_at(text.len().saturating_sub(1));
    let count: u64 = digits.parse().map_err(|_| bad())?;
    let seconds = match unit {
        "s" => count,
        "m" => count.checked_mul(60).ok_or_else(bad)?,
        "h" => count.checked_mul(3600).ok_or_else(bad)?,
        _ => return Err(bad()),
    };
    let every = Duration::from_secs(seconds);
    if every < MIN_EVERY || every > MAX_EVERY {
        return Err(format!(
            "\"every\" `{text}` is outside {}s to {}h",
            MIN_EVERY.as_secs(),
            MAX_EVERY.as_secs() / 3600
        ));
    }
    Ok(every)
}
