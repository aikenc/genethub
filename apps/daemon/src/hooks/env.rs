//! `<project>/.genethub/open.env`: the machine-dependent settings a project's
//! scripts share, in the one format every Agent and every shell already knows.
//!
//! The format is the smallest useful dotenv: `KEY=VALUE`, `#` comment lines,
//! optional matching quotes around the value. No multi-line values, no
//! substitution, no nesting: a rule an Agent has to guess at is a rule it will
//! get wrong. A line that does not parse is reported and skipped, not fatal,
//! because one typo should not take every hook of the project down.

use std::collections::BTreeMap;
use std::path::Path;

/// Names the daemon sets itself. A project file cannot redefine them: a script
/// that trusts `GENEHUB_CLI` must be able to.
const RESERVED_PREFIX: &str = "GENEHUB_";
const MAX_BYTES: u64 = 256 * 1024;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct OpenEnv {
    pub vars: BTreeMap<String, String>,
    /// One sentence per skipped line, saying what to change.
    pub problems: Vec<String>,
}

/// The project's file, or nothing when there is none.
pub fn load(project_root: &Path) -> OpenEnv {
    let path = project_root.join(".genethub").join("open.env");
    let Ok(meta) = std::fs::metadata(&path) else {
        return OpenEnv::default();
    };
    if meta.len() > MAX_BYTES {
        return OpenEnv {
            problems: vec![format!(
                "open.env is larger than {MAX_BYTES} bytes and was not read"
            )],
            ..OpenEnv::default()
        };
    }
    match std::fs::read_to_string(&path) {
        Ok(text) => parse(&text),
        Err(error) => OpenEnv {
            problems: vec![format!("open.env cannot be read: {error}")],
            ..OpenEnv::default()
        },
    }
}

pub fn parse(text: &str) -> OpenEnv {
    let mut env = OpenEnv::default();
    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let number = index + 1;
        let line = line
            .strip_prefix("export ")
            .map(str::trim_start)
            .unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            env.problems
                .push(format!("line {number}: expected KEY=VALUE, found `{line}`"));
            continue;
        };
        let key = key.trim();
        if !valid_key(key) {
            env.problems.push(format!(
                "line {number}: `{key}` is not a variable name (letters, digits and _, not starting with a digit)"
            ));
            continue;
        }
        if key.starts_with(RESERVED_PREFIX) {
            env.problems.push(format!(
                "line {number}: names starting with {RESERVED_PREFIX} are set by GeneHub and cannot be defined here"
            ));
            continue;
        }
        env.vars.insert(key.to_string(), unquote(value.trim()));
    }
    env
}

fn valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(first) if first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn unquote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && (bytes[0] == b'"' || bytes[0] == b'\'')
        && bytes[bytes.len() - 1] == bytes[0]
    {
        return value[1..value.len() - 1].to_string();
    }
    value.to_string()
}
