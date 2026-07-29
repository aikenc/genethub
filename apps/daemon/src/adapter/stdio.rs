//! The one piece of boilerplate every stdio-speaking adapter shares: writing
//! a newline-delimited JSON frame.
//!
//! Reading is deliberately **not** unified here. ACP framing (JSON-RPC ids),
//! the built-in agent's framing (a bare `type` tag) and Claude Code's framing
//! (`type` plus a separate bidirectional control channel) diverge enough that
//! forcing one read loop onto all three would just relocate the per-protocol
//! knowledge into a match arm inside a "shared" file, without removing it —
//! exactly what `docs/architecture.md` §3 boundary B1 warns against.

use anyhow::{Context, Result};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;

/// Serializes `value` and writes it as one line to `stdin`, flushing after.
pub async fn write_json_line(stdin: &mut ChildStdin, value: &Value) -> Result<()> {
    let mut line = serde_json::to_string(value)?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .context("writing to the agent process")?;
    stdin.flush().await?;
    Ok(())
}
