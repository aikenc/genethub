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

use anyhow::Result;
use genehub_proto::{
    Confinement, ErrorCode, ExchangeResponseHead, ProtocolError, ShellFrame, ShellRunRequest,
};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

use super::endpoint::{send_error, PeerServices, ServerStream};
use crate::authz::Principal;
use crate::state::Shared;

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

pub(crate) enum StartError {
    Protocol(ProtocolError),
    Transport(String),
}

pub(crate) struct Started {
    pub confinement: Option<Confinement>,
    pub frames: mpsc::Receiver<ShellFrame>,
}

fn protocol(code: ErrorCode, message: impl Into<String>) -> StartError {
    StartError::Protocol(ProtocolError {
        code,
        message: message.into(),
    })
}

/// Starts a command for a local caller and yields its frames, including Exit.
///
/// Shared by the data-plane `shell.run` stream and the in-process CLI front.
pub(crate) async fn start(
    state: &Shared,
    caller: &Principal,
    request: ShellRunRequest,
    stdin: Vec<u8>,
) -> Result<Started, StartError> {
    if stdin.len() > MAX_STDIN_BYTES {
        return Err(protocol(
            ErrorCode::BadRequest,
            format!("standard input exceeds {MAX_STDIN_BYTES} bytes"),
        ));
    }
    let Some((program, arguments)) = request.argv.split_first() else {
        return Err(protocol(
            ErrorCode::BadRequest,
            "shell.run needs a command to run",
        ));
    };

    let workspace = state
        .workspaces
        .get(&request.workspace_id)
        .await
        .map_err(|error| protocol(ErrorCode::NotFound, format!("{error:#}")))?;

    let cwd = match &request.cwd {
        None => workspace.root.clone(),
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
                    return Err(protocol(
                        ErrorCode::Forbidden,
                        format!("cwd {cwd} escapes the workspace"),
                    ))
                }
            }
        }
    };

    let confinement = match crate::isolation::required_for(caller, &workspace) {
        Ok(confinement) => confinement,
        Err(refusal) => return Err(protocol(ErrorCode::IsolationUnavailable, refusal)),
    };

    let argv = crate::process::launch_argv(program, confinement.as_ref())
        .map_err(|error| StartError::Transport(format!("{program}: {error:#}")))?;
    let mut command = crate::process::command(&argv, arguments, &cwd);
    command
        .envs(&request.env)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if stdin.is_empty() {
        command.stdin(std::process::Stdio::null());
    } else {
        command.stdin(std::process::Stdio::piped());
    }

    let mut child = match crate::process::Group::spawn(&mut command) {
        Ok(child) => child,
        Err(error) => {
            let code = if error.kind() == std::io::ErrorKind::NotFound {
                ErrorCode::NotFound
            } else {
                ErrorCode::Internal
            };
            return Err(protocol(code, format!("{program}: {error}")));
        }
    };

    if let Some(mut sink) = child.stdin() {
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let _ = sink.write_all(&stdin).await;
            let _ = sink.shutdown().await;
        });
    }

    let (sender, mut frames) = mpsc::channel(FRAME_QUEUE);
    if let Some(stdout) = child.stdout() {
        let sender = sender.clone();
        tokio::spawn(pump(stdout, sender, |data| ShellFrame::Stdout { data }));
    }
    if let Some(stderr) = child.stderr() {
        let sender = sender.clone();
        tokio::spawn(pump(stderr, sender, |data| ShellFrame::Stderr { data }));
    }
    drop(sender);

    let described = crate::isolation::describe(confinement.as_ref());
    let (out, rx) = mpsc::channel(FRAME_QUEUE);
    let timeout_ms = request.timeout_ms;
    let argv_log = request.argv.clone();
    tokio::spawn(async move {
        let deadline = timeout_ms.map(|milliseconds| {
            tokio::time::Instant::now() + std::time::Duration::from_millis(milliseconds)
        });
        let mut timed_out = false;
        let status = loop {
            tokio::select! {
                frame = frames.recv() => match frame {
                    Some(frame) => {
                        if out.send(frame).await.is_err() {
                            return;
                        }
                    }
                    None => break Some(match child.wait().await {
                        Ok(status) => status,
                        Err(_) => break None,
                    }),
                },
                status = child.wait() => break Some(match status {
                    Ok(status) => status,
                    Err(_) => break None,
                }),
                () = sleep_until(deadline) => {
                    timed_out = true;
                    tracing::info!(
                        milliseconds = timeout_ms,
                        argv = ?argv_log,
                        "a command ran out of time and was ended",
                    );
                    break child.end().await;
                }
            }
        };
        while let Ok(Some(frame)) = tokio::time::timeout(SETTLE, frames.recv()).await {
            if out.send(frame).await.is_err() {
                return;
            }
        }
        let _ = out.send(exit_frame(status.as_ref(), timed_out)).await;
    });

    Ok(Started {
        confinement: described,
        frames: rx,
    })
}

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
    let caller = Principal::of(&services.state, &services.access);
    let mut started = match start(&services.state, &caller, request, stdin).await {
        Ok(started) => started,
        Err(StartError::Protocol(error)) => {
            let status = match error.code {
                ErrorCode::BadRequest => 400,
                ErrorCode::Forbidden => 403,
                ErrorCode::NotFound => 404,
                ErrorCode::IsolationUnavailable => 501,
                _ => 500,
            };
            return send_error(stream, status, error.code, error.message).await;
        }
        Err(StartError::Transport(message)) => {
            return send_error(stream, 500, ErrorCode::Internal, message).await
        }
    };

    stream
        .respond(&ExchangeResponseHead {
            status: 200,
            metadata: serde_json::json!({
                "codec": "json-u32be",
                "confinement": started.confinement,
            }),
            body_length: None,
            error: None,
        })
        .await?;
    while let Some(frame) = started.frames.recv().await {
        stream.write_message(&frame).await?;
    }
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
