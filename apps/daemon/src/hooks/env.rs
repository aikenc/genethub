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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_values_comments_and_quotes() {
        let env = parse(
            "# a comment\n\nEXPERT_AGENT=codex\nexport PROJECT_DIRS=\"/a b:/c\"\nQ='single'\nEMPTY=\nWITH_EQ=a=b\nURL=http://x/#frag\n",
        );
        assert!(env.problems.is_empty(), "{:?}", env.problems);
        let get = |k: &str| env.vars.get(k).map(String::as_str);
        assert_eq!(get("EXPERT_AGENT"), Some("codex"));
        assert_eq!(get("PROJECT_DIRS"), Some("/a b:/c"));
        assert_eq!(get("Q"), Some("single"));
        assert_eq!(get("EMPTY"), Some(""));
        assert_eq!(get("WITH_EQ"), Some("a=b"), "only the first = splits");
        assert_eq!(
            get("URL"),
            Some("http://x/#frag"),
            "# inside a value is not a comment"
        );
    }

    #[test]
    fn a_bad_line_is_reported_and_the_rest_still_load() {
        let env =
            parse("GOOD=1\nnot a pair\n9LIVES=x\nBAD KEY=y\nGENEHUB_CLI=/evil\nALSO_GOOD=2\n");
        assert_eq!(env.vars.keys().collect::<Vec<_>>(), ["ALSO_GOOD", "GOOD"]);
        assert_eq!(env.problems.len(), 4);
        assert!(env.problems[0].contains("line 2") && env.problems[0].contains("KEY=VALUE"));
        assert!(env.problems[1].contains("line 3"));
        assert!(env.problems[2].contains("line 4"));
        assert!(
            env.problems[3].contains("GENEHUB_") && env.problems[3].contains("line 5"),
            "a project cannot redefine what GeneHub sets"
        );
    }

    #[test]
    fn a_missing_or_oversized_file_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), OpenEnv::default());
        let home = dir.path().join(".genethub");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("open.env"), "A=1\n").unwrap();
        assert_eq!(
            load(dir.path()).vars.get("A").map(String::as_str),
            Some("1")
        );
        std::fs::write(
            home.join("open.env"),
            "A=".to_string() + &"x".repeat(300 * 1024),
        )
        .unwrap();
        let big = load(dir.path());
        assert!(big.vars.is_empty() && big.problems[0].contains("larger than"));
    }
}
