//! Session persistence: one JSON object per line, append-only.
//!
//! Entries form a tree via `id`/`parentId`. We only ever append to the current
//! leaf — branching is out of scope for now — but the on-disk shape leaves room
//! for it so old files stay loadable once it lands.

use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::protocol::Message;

pub const SESSION_VERSION: u32 = 3;

pub struct Session {
    pub id: String,
    pub file: Option<PathBuf>,
    pub cwd: PathBuf,
    pub messages: Vec<Message>,
    leaf_id: Option<String>,
    name: Option<String>,
}

impl Session {
    /// In-memory only: `--no-session`.
    pub fn in_memory(cwd: PathBuf) -> Self {
        Session {
            id: uuid::Uuid::new_v4().to_string(),
            file: None,
            cwd,
            messages: Vec::new(),
            leaf_id: None,
            name: None,
        }
    }

    /// Backed by `path`, loading prior entries when the file already exists.
    pub fn open(path: PathBuf, cwd: PathBuf) -> Self {
        let mut session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            file: Some(path.clone()),
            cwd,
            messages: Vec::new(),
            leaf_id: None,
            name: None,
        };

        if path.exists() {
            session.load();
        } else {
            session.write_header();
        }
        session
    }

    /// Default location: `sessions/--<cwd>--/<timestamp>_<uuid>.jsonl`, so
    /// sessions group by project without colliding across machines.
    pub fn default_path(data_dir: &Path, cwd: &Path) -> PathBuf {
        let mangled = cwd.to_string_lossy().replace(['/', '\\'], "-");
        let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S");
        data_dir
            .join("sessions")
            .join(format!("--{mangled}--"))
            .join(format!("{stamp}_{}.jsonl", uuid::Uuid::new_v4()))
    }

    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    pub fn set_name(&mut self, name: String) {
        self.name = Some(name.clone());
        self.append_entry("session_info", json!({ "name": name }));
    }

    pub fn append_message(&mut self, message: Message) {
        let value = serde_json::to_value(&message).unwrap_or(Value::Null);
        self.messages.push(message);
        self.append_entry("message", json!({ "message": value }));
    }

    pub fn append_model_change(&mut self, provider: &str, model_id: &str) {
        self.append_entry(
            "model_change",
            json!({ "provider": provider, "modelId": model_id }),
        );
    }

    pub fn append_thinking_level_change(&mut self, level: &str) {
        self.append_entry("thinking_level_change", json!({ "thinkingLevel": level }));
    }

    fn append_entry(&mut self, kind: &str, extra: Value) {
        let id = short_id();
        let mut entry = json!({
            "type": kind,
            "id": id,
            "parentId": self.leaf_id,
            "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        });
        if let Some(map) = extra.as_object() {
            for (key, value) in map {
                entry[key] = value.clone();
            }
        }
        self.leaf_id = Some(id);
        self.write_line(&entry);
    }

    fn write_header(&self) {
        let header = json!({
            "type": "session",
            "version": SESSION_VERSION,
            "id": self.id,
            "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "cwd": self.cwd.to_string_lossy(),
        });
        self.write_line(&header);
    }

    fn write_line(&self, value: &Value) {
        let Some(path) = self.file.as_ref() else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = create_dir_all(parent);
        }
        let opened = OpenOptions::new().create(true).append(true).open(path);
        match opened {
            Ok(mut file) => {
                let _ = writeln!(file, "{value}");
            }
            Err(err) => eprintln!("genet-agent: session write failed: {err}"),
        }
    }

    fn load(&mut self) {
        let Some(path) = self.file.clone() else { return };
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return;
        };

        for line in raw.lines().filter(|l| !l.trim().is_empty()) {
            let Ok(entry) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            match entry.get("type").and_then(|t| t.as_str()) {
                Some("session") => {
                    if let Some(id) = entry.get("id").and_then(|i| i.as_str()) {
                        self.id = id.to_string();
                    }
                }
                Some("message") => {
                    if let Some(message) = entry.get("message") {
                        match serde_json::from_value::<Message>(message.clone()) {
                            Ok(message) => self.messages.push(message),
                            // Roles we do not model (bashExecution, custom, …)
                            // stay on disk but out of our context.
                            Err(_) => continue,
                        }
                    }
                }
                Some("session_info") => {
                    self.name = entry
                        .get("name")
                        .and_then(|n| n.as_str())
                        .map(|n| n.to_string());
                }
                _ => {}
            }
            if let Some(id) = entry.get("id").and_then(|i| i.as_str()) {
                if entry.get("type").and_then(|t| t.as_str()) != Some("session") {
                    self.leaf_id = Some(id.to_string());
                }
            }
        }
    }
}

/// Entry ids are 8 hex chars: short enough to read in a log, wide enough to
/// avoid collisions within a session.
fn short_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Content, StopReason, Usage};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("genet-session-{tag}-{}", uuid::Uuid::new_v4()));
        create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn short_ids_are_eight_hex_chars() {
        let id = short_id();
        assert_eq!(id.len(), 8);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn default_path_mangles_cwd_like_pi() {
        let path = Session::default_path(Path::new("/data"), Path::new("/home/me/proj"));
        let dir = path.parent().unwrap().file_name().unwrap().to_string_lossy();
        assert_eq!(dir, "---home-me-proj--");
        assert_eq!(path.extension().unwrap(), "jsonl");
    }

    #[test]
    fn header_is_written_then_entries_chain_by_parent_id() {
        let dir = temp_dir("chain");
        let file = dir.join("s.jsonl");
        let mut session = Session::open(file.clone(), dir.clone());
        session.append_message(Message::user("hello"));
        session.append_message(Message::Assistant {
            content: vec![Content::text("hi")],
            api: "fake".into(),
            provider: "fake".into(),
            model: "echo".into(),
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: 0,
        });

        let lines: Vec<Value> = std::fs::read_to_string(&file)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();

        assert_eq!(lines[0]["type"], "session");
        assert_eq!(lines[0]["version"], 3);
        assert_eq!(lines[1]["type"], "message");
        assert!(lines[1]["parentId"].is_null());
        assert_eq!(lines[2]["parentId"], lines[1]["id"]);
        assert_eq!(lines[2]["message"]["role"], "assistant");
    }

    #[test]
    fn reopening_a_file_restores_messages() {
        let dir = temp_dir("reopen");
        let file = dir.join("s.jsonl");
        {
            let mut session = Session::open(file.clone(), dir.clone());
            session.append_message(Message::user("first"));
        }
        let reopened = Session::open(file, dir);
        assert_eq!(reopened.messages.len(), 1);
        assert!(matches!(&reopened.messages[0], Message::User { content, .. } if content == "first"));
    }

    #[test]
    fn in_memory_sessions_write_nothing() {
        let mut session = Session::in_memory(PathBuf::from("/tmp"));
        session.append_message(Message::user("hello"));
        assert!(session.file.is_none());
        assert_eq!(session.messages.len(), 1);
    }
}
