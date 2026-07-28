//! Minimal argv parsing. Only the flags the daemon passes when spawning us.

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Args {
    pub mode: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub session: Option<String>,
    pub no_session: bool,
    /// Accepted and ignored; refusing to start would break the daemon.
    pub ignored: Vec<String>,
}

pub fn parse<I: IntoIterator<Item = String>>(argv: I) -> Result<Args, String> {
    let mut args = Args::default();
    let mut it = argv.into_iter().peekable();

    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) => (flag.to_string(), Some(value.to_string())),
            None => (arg.clone(), None),
        };
        let mut value = |flag: &str| -> Result<String, String> {
            match inline.clone() {
                Some(value) => Ok(value),
                None => it.next().ok_or_else(|| format!("{flag} expects a value")),
            }
        };

        match flag.as_str() {
            "--mode" => args.mode = Some(value("--mode")?),
            "--model" => args.model = Some(value("--model")?),
            "--thinking" => args.thinking = Some(value("--thinking")?),
            "--session" => args.session = Some(value("--session")?),
            "--no-session" => args.no_session = true,
            "--mcp-config" | "--extension" => {
                let value = value(&flag)?;
                args.ignored.push(format!("{flag} {value}"));
            }
            other => args.ignored.push(other.to_string()),
        }
    }

    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_str(argv: &[&str]) -> Args {
        parse(argv.iter().map(|s| s.to_string())).unwrap()
    }

    #[test]
    fn parses_the_launch_line_the_daemon_builds() {
        let args = parse_str(&[
            "--mode",
            "rpc",
            "--model",
            "anthropic/claude-sonnet-4",
            "--thinking",
            "high",
            "--session",
            "/tmp/s.jsonl",
        ]);
        assert_eq!(args.mode.as_deref(), Some("rpc"));
        assert_eq!(args.model.as_deref(), Some("anthropic/claude-sonnet-4"));
        assert_eq!(args.thinking.as_deref(), Some("high"));
        assert_eq!(args.session.as_deref(), Some("/tmp/s.jsonl"));
        assert!(!args.no_session);
    }

    #[test]
    fn accepts_inline_values_and_no_session() {
        let args = parse_str(&["--mode=rpc", "--no-session"]);
        assert_eq!(args.mode.as_deref(), Some("rpc"));
        assert!(args.no_session);
    }

    #[test]
    fn unsupported_flags_are_collected_not_fatal() {
        let args = parse_str(&[
            "--mode",
            "rpc",
            "--mcp-config",
            "/tmp/mcp.json",
            "--extension",
            "/tmp/ext",
        ]);
        assert_eq!(args.ignored.len(), 2);
        assert_eq!(args.mode.as_deref(), Some("rpc"));
    }

    #[test]
    fn missing_value_is_reported() {
        let err = parse(vec!["--model".to_string()]).unwrap_err();
        assert!(err.contains("--model"));
    }
}
