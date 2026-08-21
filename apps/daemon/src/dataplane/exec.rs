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

/// How long output may stay quiet after the command has exited before the
/// last of it is declared to have arrived. Rearmed by every frame, so a
/// descendant that is still saying something keeps its turn; one that is
/// merely holding the pipe open does not.
const SETTLE: std::time::Duration = std::time::Duration::from_millis(200);

/// How much standard input a command may be given.
///
/// Generous for the things this is for — a patch, a document, a list of paths
/// — and far short of the point where sending input through a request stops
/// being the sensible way to hand a command its data. Past this, write a file
/// and name it.
const MAX_STDIN_BYTES: usize = 1024 * 1024;

pub(super) async fn handle(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    // Whatever the caller sent is the command's standard input. Read before
    // anything is spawned, because the command must not start until its input
    // is known — a reader that reaches end-of-file early gets a different and
    // wrong answer.
    let stdin = stream.read_body(MAX_STDIN_BYTES).await?;
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

    let argv = crate::process::launch_argv(program, confinement.as_ref())?;
    let mut command = crate::process::command(&argv, arguments, &cwd);
    command
        .envs(&request.env)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // A pipe only when there is something to put in it. An empty pipe and
    // `/dev/null` both read as end-of-file, so the difference is invisible to
    // the command — but a pipe is one more thing to hold open and close in
    // order, and there is no reason to arrange that for nothing.
    if stdin.is_empty() {
        command.stdin(std::process::Stdio::null());
    } else {
        command.stdin(std::process::Stdio::piped());
    }

    // The command belongs to the request that asked for it, and so does
    // everything it starts. If this task goes away — the peer disconnected,
    // the endpoint tore down — none of it may outlive the only thing that was
    // watching it (`process.rs`).
    let mut child = match crate::process::Group::spawn(&mut command) {
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
            metadata: serde_json::json!({
                "codec": "json-u32be",
                // Said before the first byte of output, because it is what the
                // output has to be read in light of: under confinement a path
                // outside the workspace does not report "forbidden", it reports
                // nothing at all, and a caller that has not been told the rule
                // will read that as "this machine does not have it".
                "confinement": crate::isolation::describe(confinement.as_ref()),
            }),
            body_length: None,
            error: None,
        })
        .await?;

    // Written from a task rather than here, because a command that reads none
    // of its input — `head -1` on something large — leaves the pipe full and
    // the write unfinished, and this side has output to be getting on with.
    // The handle is dropped when the write ends, which is what tells the
    // command its input is complete.
    if let Some(mut sink) = child.stdin() {
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            // Both failures mean the same thing and neither is ours to report:
            // the command stopped reading, which it is allowed to do.
            let _ = sink.write_all(&stdin).await;
            let _ = sink.shutdown().await;
        });
    }

    let (sender, mut frames) = mpsc::channel(FRAME_QUEUE);
    let mut readers = tokio::task::JoinSet::new();
    if let Some(stdout) = child.stdout() {
        readers.spawn(pump(stdout, sender.clone(), |data| ShellFrame::Stdout {
            data,
        }));
    }
    if let Some(stderr) = child.stderr() {
        readers.spawn(pump(stderr, sender.clone(), |data| ShellFrame::Stderr {
            data,
        }));
    }
    // Both readers hold a clone, so the channel closes when the last of them
    // sees end-of-file.
    drop(sender);

    // Absent means no limit: an open-ended command is a legitimate thing to
    // ask for over a stream the caller can walk away from.
    let deadline = request.timeout_ms.map(|milliseconds| {
        tokio::time::Instant::now() + std::time::Duration::from_millis(milliseconds)
    });
    let mut timed_out = false;

    // Whichever comes first. Waiting for end-of-file before asking for the
    // exit status would be waiting for the wrong thing: a command that leaves
    // something behind — `sleep 30 &` — has handed its stdout to a process
    // that outlives it, and the pipe stays open long after there is an exit
    // status to report.
    let status = loop {
        tokio::select! {
            frame = frames.recv() => match frame {
                Some(frame) => stream.write_message(&frame).await?,
                None => break Some(child.wait().await.context("waiting for the command")?),
            },
            status = child.wait() => break Some(status.context("waiting for the command")?),
            () = sleep_until(deadline) => {
                timed_out = true;
                tracing::info!(
                    milliseconds = request.timeout_ms,
                    argv = ?request.argv,
                    "a command ran out of time and was ended",
                );
                // Asked to finish before being made to, so that a command
                // interrupted this way still gets to leave the workspace in a
                // sane state — a half-written file is a worse outcome than a
                // slow one.
                break child.end().await;
            }
        }
    };

    // The command is over; what it wrote may not have arrived yet. Drain until
    // the output falls quiet rather than until the pipe closes, because the
    // thing still holding the pipe is exactly the thing that is not going to
    // close it.
    while let Ok(Some(frame)) = tokio::time::timeout(SETTLE, frames.recv()).await {
        stream.write_message(&frame).await?;
    }

    stream
        .write_message(&exit_frame(status.as_ref(), timed_out))
        .await?;
    stream.finish().await
}

/// A deadline that may not exist, as something a `select!` arm can wait on.
///
/// The alternative is a guard on the arm plus an unwrap inside it, which is
/// the same thing written so that the absent case is a panic waiting to be
/// introduced.
async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
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

/// The last word on a command. `None` where the operating system could not be
/// asked how it ended, which happens only after it has already been stopped —
/// so there is still an answer to give, just a less specific one.
fn exit_frame(status: Option<&crate::os_process::ExitStatus>, timed_out: bool) -> ShellFrame {
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.and_then(ExitStatusExt::signal)
    };
    #[cfg(not(unix))]
    let signal = None;
    ShellFrame::Exit {
        code: status.and_then(|status| status.code()),
        signal,
        timed_out,
    }
}
