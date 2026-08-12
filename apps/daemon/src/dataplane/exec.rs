//! Running one command on this machine for somebody who is not sitting at it.
//!
//! The counterpart of `pty.rs`, and deliberately not built on it. A terminal
//! merges the two output streams, because a person is reading both at once and
//! wants them interleaved the way they happened; a caller that has to tell a
//! diagnostic from a result cannot un-merge them afterwards. A terminal also
//! has no exit status to report — the shell inside it does, and it is not
//! visible from outside.
//!
//! There is no command inspection here, and that is a decision rather than an
//! omission (`genet-remote-execution.md` §7.1). A list of permitted command
//! names cannot survive `python -c`, so a layer that reads the argv would offer
//! a guarantee it could not keep. What holds instead is the same thing that
//! holds for a terminal: who may ask at all (`authz.rs`), and what the process
//! can touch once it is running (`isolation.rs`). The argv is passed to the
//! operating system as a list and never through a shell, so nothing in it can
//! become a second command on the way.

use anyhow::{Context, Result};
use genehub_proto::{ErrorCode, ExchangeResponseHead, ShellFrame, ShellRunRequest};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

use super::endpoint::{send_error, PeerServices, ServerStream};
use crate::authz::Principal;

/// How much of one read is turned into one frame. Large enough that a chatty
/// build does not become a frame per line, small enough that the first output
/// of a slow command arrives while it is still interesting.
const READ_CHUNK: usize = 16 * 1024;

/// Queued frames between the readers and the wire. Bounded so that a command
/// producing faster than the link can carry blocks in its own `write` rather
/// than growing a buffer in this process.
const FRAME_QUEUE: usize = 64;

pub(super) async fn handle(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    if !stream.read_body(0).await?.is_empty() {
        anyhow::bail!("shell.run accepts no request body");
    }
    let request: ShellRunRequest = match serde_json::from_value(stream.head.metadata.clone()) {
        Ok(request) => request,
        Err(error) => {
            return send_error(
                stream,
                400,
                ErrorCode::BadRequest,
                format!("invalid shell.run metadata: {error}"),
            )
            .await
        }
    };
    let Some((program, arguments)) = request.argv.split_first() else {
        return send_error(
            stream,
            400,
            ErrorCode::BadRequest,
            "shell.run needs a command to run",
        )
        .await;
    };

    // A resource-routed peer holds one workspace and nothing else. Checked
    // before the workspace is even looked up, so that a wrong id cannot be
    // told apart from a forbidden one by how long the answer takes.
    if let Some(scope) = &services.access.workspace_id {
        if scope != &request.workspace_id {
            return send_error(
                stream,
                403,
                ErrorCode::Forbidden,
                "the routed capability does not cover this workspace",
            )
            .await;
        }
    }
    let workspace = match services.state.workspaces.get(&request.workspace_id).await {
        Ok(workspace) => workspace,
        Err(error) => {
            return send_error(stream, 404, ErrorCode::NotFound, format!("{error:#}")).await
        }
    };

    let cwd = match &request.cwd {
        None => workspace.root.clone(),
        // Any of the workspace's folders, not only the first: a multi-folder
        // workspace is one project. Refusing beats clamping to the root — a
        // command quietly run in the wrong directory looks like it worked.
        Some(cwd) => {
            let candidate = std::path::Path::new(cwd);
            let resolved = workspace
                .folders
                .iter()
                .find_map(|folder| {
                    crate::session::store::ensure_within(&folder.root, candidate).ok()
                })
                .or_else(|| crate::session::store::ensure_within(&workspace.root, candidate).ok());
            match resolved {
                Some(resolved) => resolved,
                None => {
                    return send_error(
                        stream,
                        403,
                        ErrorCode::Forbidden,
                        format!("cwd {cwd} escapes the workspace"),
                    )
                    .await
                }
            }
        }
    };

    let caller = Principal::of(&services.state, &services.access);
    let confinement = match crate::isolation::required_for(&caller, &workspace) {
        Ok(confinement) => confinement,
        // Not 403: the caller is allowed and the machine is unable, and no
        // wider grant would change that.
        Err(refusal) => {
            return send_error(stream, 501, ErrorCode::IsolationUnavailable, refusal).await
        }
    };

    let mut command = match &confinement {
        None => {
            let mut command = tokio::process::Command::new(program);
            command.args(arguments);
            command
        }
        Some(policy) => {
            let argv = policy.wrap(std::path::Path::new(program))?;
            let (helper, wrapper_arguments) = argv
                .split_first()
                .context("the confinement wrapper has no command")?;
            let mut command = tokio::process::Command::new(helper);
            command.args(wrapper_arguments).args(arguments);
            command
        }
    };
    command
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // The command belongs to the request that asked for it. If this task
        // goes away — the peer disconnected, the endpoint tore down — the
        // process must not outlive the only thing that was watching it.
        .kill_on_drop(true);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let (status, code) = if error.kind() == std::io::ErrorKind::NotFound {
                (404, ErrorCode::NotFound)
            } else {
                (500, ErrorCode::Internal)
            };
            return send_error(stream, status, code, format!("{program}: {error}")).await;
        }
    };

    stream
        .respond(&ExchangeResponseHead {
            status: 200,
            metadata: serde_json::json!({ "codec": "json-u32be" }),
            body_length: None,
            error: None,
        })
        .await?;

    let (sender, mut frames) = mpsc::channel(FRAME_QUEUE);
    let mut readers = tokio::task::JoinSet::new();
    if let Some(stdout) = child.stdout.take() {
        readers.spawn(pump(stdout, sender.clone(), |data| ShellFrame::Stdout {
            data,
        }));
    }
    if let Some(stderr) = child.stderr.take() {
        readers.spawn(pump(stderr, sender.clone(), |data| ShellFrame::Stderr {
            data,
        }));
    }
    // Both readers hold a clone; the loop below ends when the last one is
    // dropped, which is the same moment the process has stopped writing.
    drop(sender);
    while let Some(frame) = frames.recv().await {
        stream.write_message(&frame).await?;
    }

    let status = child.wait().await.context("waiting for the command")?;
    stream.write_message(&exit_frame(&status)).await?;
    stream.finish().await
}

async fn pump<R>(
    mut source: R,
    sender: mpsc::Sender<ShellFrame>,
    wrap: impl Fn(String) -> ShellFrame,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = vec![0u8; READ_CHUNK];
    loop {
        match source.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => {
                // Lossy on purpose. A command that writes bytes which are not
                // text is being asked for its output as text, and mangling one
                // character beats failing the whole run.
                let data = String::from_utf8_lossy(&buffer[..read]).into_owned();
                if sender.send(wrap(data)).await.is_err() {
                    return;
                }
            }
        }
    }
}

fn exit_frame(status: &std::process::ExitStatus) -> ShellFrame {
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    };
    #[cfg(not(unix))]
    let signal = None;
    ShellFrame::Exit {
        code: status.code(),
        signal,
    }
}
