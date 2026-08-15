use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use genehub_proto::{
    decode_speech_json, encode_speech_audio, encode_speech_frame, encode_speech_json,
    SpeechCancelReason, SpeechCompleted, SpeechContextUpdate, SpeechFailure, SpeechFailureCode,
    SpeechFrameDecoder, SpeechFrameKind, SpeechPartial, SpeechReady, SpeechRuntimeCapabilities,
    SpeechStart,
};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use genet_daemon_logic_api::{SpeechConfig, SpeechRuntimeConfig};

use super::{
    failure, speech_correlation_id, validate_runtime_capabilities, RuntimeCommand, RuntimeEvent,
    RuntimeSession, SpeechRuntime,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const READY_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PROBE_STDOUT_BYTES: usize = 256 * 1024;
const MAX_RUNTIME_STDERR_BYTES: usize = 64 * 1024;
const MAX_RUNTIME_ARGS: usize = 32;
const MAX_RUNTIME_ARG_BYTES: usize = 4 * 1024;
const MAX_RUNTIME_TOTAL_ARG_BYTES: usize = 16 * 1024;

#[derive(Debug)]
struct BoundedOutput {
    bytes: Vec<u8>,
    total_bytes: usize,
    truncated: bool,
}

#[derive(Clone, Copy)]
enum RetainOutput {
    Head,
    Tail,
}

#[derive(Default)]
pub(super) struct ExternalSpeechRuntime;

#[async_trait::async_trait]
impl SpeechRuntime for ExternalSpeechRuntime {
    async fn probe(
        &self,
        config: &SpeechConfig,
    ) -> Result<SpeechRuntimeCapabilities, SpeechFailure> {
        let registration = config.runtime.as_ref().ok_or_else(not_configured)?;
        probe_registration(registration).await
    }

    async fn open(
        &self,
        config: &SpeechConfig,
        start: &SpeechStart,
        capabilities: &SpeechRuntimeCapabilities,
    ) -> Result<RuntimeSession, SpeechFailure> {
        let registration = config.runtime.as_ref().ok_or_else(not_configured)?;
        if start.language_hints.iter().any(|language| {
            !capabilities
                .languages
                .iter()
                .any(|supported| supported == language)
        }) || start.language_hints.len() > capabilities.max_language_hints as usize
        {
            return Err(failure(
                SpeechFailureCode::UnsupportedLanguage,
                "当前语音 runtime 不支持所选语言提示",
                false,
            ));
        }

        let (commands, command_rx) = mpsc::channel(16);
        let (event_tx, events) = mpsc::channel(16);
        let (ready_tx, ready_rx) = oneshot::channel();
        let registration = registration.clone();
        let start = start.clone();
        let expected_runtime = capabilities.runtime.clone();
        tokio::spawn(supervise(
            registration,
            start,
            expected_runtime,
            command_rx,
            event_tx,
            ready_tx,
        ));

        match tokio::time::timeout(READY_TIMEOUT, ready_rx).await {
            Ok(Ok(Ok(()))) => Ok(RuntimeSession {
                capabilities: capabilities.clone(),
                commands,
                events,
            }),
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err(failure(
                SpeechFailureCode::RuntimeUnavailable,
                "语音 runtime 在握手前结束",
                true,
            )),
            Err(_) => Err(failure(
                SpeechFailureCode::Timeout,
                "语音 runtime 启动超过 15 秒；请先确认社区模型服务已经预热",
                true,
            )),
        }
    }
}

pub(super) fn validate_registration(
    command: String,
    args: Vec<String>,
) -> anyhow::Result<SpeechRuntimeConfig> {
    if command.is_empty()
        || command.len() > MAX_RUNTIME_ARG_BYTES
        || command.chars().any(char::is_control)
    {
        anyhow::bail!("runtime 命令必须是有效的绝对路径");
    }
    let path = Path::new(&command);
    if !path.is_absolute() {
        anyhow::bail!("runtime 命令必须使用绝对路径；不会从项目目录或 PATH 查找");
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| anyhow::anyhow!("无法读取 runtime 命令 {}：{error}", path.display()))?;
    let metadata = std::fs::metadata(&canonical)?;
    if !metadata.is_file() {
        anyhow::bail!("runtime 命令不是普通文件：{}", canonical.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            anyhow::bail!("runtime 命令不可执行：{}", canonical.display());
        }
    }
    if args.len() > MAX_RUNTIME_ARGS {
        anyhow::bail!("runtime 参数不能超过 {MAX_RUNTIME_ARGS} 个");
    }
    let mut total = 0usize;
    for arg in &args {
        if arg.len() > MAX_RUNTIME_ARG_BYTES || arg.chars().any(char::is_control) {
            anyhow::bail!("runtime 参数必须是长度不超过 4096 的可见字符串");
        }
        if matches!(arg.as_str(), "--genehub-probe" | "--genehub-stdio") {
            anyhow::bail!("runtime 参数不能占用 GeneHub 保留参数 {arg}");
        }
        total = total.saturating_add(arg.len());
    }
    if total > MAX_RUNTIME_TOTAL_ARG_BYTES {
        anyhow::bail!("runtime 参数总长度不能超过 {MAX_RUNTIME_TOTAL_ARG_BYTES} 字节");
    }
    let canonical = canonical.to_str().ok_or_else(|| {
        anyhow::anyhow!(
            "runtime 命令路径必须能表示为 UTF-8：{}",
            canonical.display()
        )
    })?;
    Ok(SpeechRuntimeConfig {
        command: canonical.to_string(),
        args,
    })
}

async fn probe_registration(
    registration: &SpeechRuntimeConfig,
) -> Result<SpeechRuntimeCapabilities, SpeechFailure> {
    // Revalidate persisted data at use time. A hand-edited config must not
    // bypass the same boundary as the loopback registration RPC.
    let registration =
        match validate_registration(registration.command.clone(), registration.args.clone()) {
            Ok(registration) => registration,
            Err(error) => {
                tracing::warn!(
                    event = "speech_runtime_probe_failed",
                    reason = "invalid_registration",
                    error_fingerprint = %output_fingerprint(format!("{error:#}").as_bytes()),
                    "speech runtime registration was invalid; details were withheld"
                );
                return Err(failure(
                    SpeechFailureCode::RuntimeUnavailable,
                    format!("语音 runtime 配置无效：{error:#}"),
                    false,
                ));
            }
        };
    let mut command = adapter_command(&registration, "--genehub-probe");
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        tracing::warn!(
            event = "speech_runtime_probe_failed",
            reason = "spawn_failed",
            io_error_kind = ?error.kind(),
            "speech runtime probe could not start; details were withheld"
        );
        failure(
            SpeechFailureCode::RuntimeUnavailable,
            format!("无法启动语音 runtime：{error}"),
            true,
        )
    })?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stdout_task = tokio::spawn(read_bounded(
        stdout,
        MAX_PROBE_STDOUT_BYTES,
        RetainOutput::Head,
    ));
    let stderr_task = tokio::spawn(read_bounded(
        stderr,
        MAX_RUNTIME_STDERR_BYTES,
        RetainOutput::Tail,
    ));

    let status = match tokio::time::timeout(PROBE_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            crate::process::kill_child_tree(&mut child).await;
            let status = child.wait().await.ok();
            let stdout = join_read(stdout_task, "stdout").await?;
            let stderr = join_read(stderr_task, "stderr").await?;
            log_probe_failure("wait_failed", status.as_ref(), &stdout, &stderr);
            return Err(failure(
                SpeechFailureCode::RuntimeUnavailable,
                format!("等待语音 runtime 探测失败：{error}"),
                true,
            ));
        }
        Err(_) => {
            crate::process::kill_child_tree(&mut child).await;
            let status = child.wait().await.ok();
            let stdout = join_read(stdout_task, "stdout").await?;
            let stderr = join_read(stderr_task, "stderr").await?;
            log_probe_failure("timeout", status.as_ref(), &stdout, &stderr);
            return Err(failure(
                SpeechFailureCode::Timeout,
                "语音 runtime 探测超过 10 秒",
                true,
            ));
        }
    };
    let stdout = join_read(stdout_task, "stdout").await?;
    let stderr = join_read(stderr_task, "stderr").await?;
    if !status.success() {
        let detail = safe_stderr_detail(&stderr);
        log_probe_failure("nonzero_exit", Some(&status), &stdout, &stderr);
        return Err(failure(
            SpeechFailureCode::RuntimeUnavailable,
            format!("语音 runtime 探测失败（{status}）{detail}"),
            true,
        ));
    }
    if stdout.truncated {
        log_probe_failure("stdout_too_large", Some(&status), &stdout, &stderr);
        return Err(failure(
            SpeechFailureCode::ProtocolMismatch,
            format!("语音 runtime 的探测结果超过 {MAX_PROBE_STDOUT_BYTES} 字节上限"),
            false,
        ));
    }
    let capabilities: SpeechRuntimeCapabilities = match serde_json::from_slice(&stdout.bytes) {
        Ok(capabilities) => capabilities,
        Err(error) => {
            log_probe_failure("invalid_json", Some(&status), &stdout, &stderr);
            return Err(failure(
                SpeechFailureCode::ProtocolMismatch,
                format!("语音 runtime 的探测结果不是有效 JSON：{error}"),
                false,
            ));
        }
    };
    if let Err(error) = validate_runtime_capabilities(&capabilities) {
        log_probe_failure("invalid_capabilities", Some(&status), &stdout, &stderr);
        return Err(failure(
            SpeechFailureCode::ProtocolMismatch,
            format!("语音 runtime 能力声明无效：{error:#}"),
            false,
        ));
    }
    tracing::info!(
        event = "speech_runtime_probe_ready",
        runtime_id = %capabilities.runtime.id,
        model_id = %capabilities.runtime.model,
        implementation = %capabilities.runtime.implementation,
        partial_results = capabilities.segmentation.partial_results,
        max_candidates = capabilities.n_best.max_candidates,
        stderr_bytes = stderr.total_bytes,
        stderr_truncated = stderr.truncated,
        stderr_category = stderr_category(&stderr.bytes),
        stderr_fingerprint = %output_fingerprint(&stderr.bytes),
        "speech runtime probe succeeded"
    );
    Ok(capabilities)
}

async fn supervise(
    registration: SpeechRuntimeConfig,
    start: SpeechStart,
    expected_runtime: genehub_proto::SpeechRuntimeDescriptor,
    mut commands: mpsc::Receiver<RuntimeCommand>,
    events: mpsc::Sender<RuntimeEvent>,
    ready: oneshot::Sender<Result<(), SpeechFailure>>,
) {
    let mut command = adapter_command(&registration, "--genehub-stdio");
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!(
                event = "speech_runtime_process_start_failed",
                request_id = %start.request_id,
                correlation_id = %speech_correlation_id(&start.request_id),
                runtime_id = %expected_runtime.id,
                model_id = %expected_runtime.model,
                implementation = %expected_runtime.implementation,
                io_error_kind = ?error.kind(),
                "speech runtime process could not start; details were withheld"
            );
            let _ = ready.send(Err(failure(
                SpeechFailureCode::RuntimeUnavailable,
                format!("无法启动语音 runtime：{error}"),
                true,
            )));
            return;
        }
    };
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stderr_task = tokio::spawn(read_bounded(
        stderr,
        MAX_RUNTIME_STDERR_BYTES,
        RetainOutput::Tail,
    ));
    let mut ready = Some(ready);
    let mut decoder = SpeechFrameDecoder::default();

    if write_wire(
        &mut stdin,
        encode_speech_json(SpeechFrameKind::Start, &start),
    )
    .await
    .is_err()
    {
        if let Some(ready) = ready.take() {
            let _ = ready.send(Err(failure(
                SpeechFailureCode::RuntimeUnavailable,
                "无法向语音 runtime 发送 Start",
                true,
            )));
        }
        crate::process::kill_child_tree(&mut child).await;
        let status = child.wait().await.ok();
        let stderr = join_runtime_stderr(stderr_task).await;
        log_runtime_process_end(
            &start,
            &expected_runtime,
            "start_write_failed",
            status.as_ref(),
            true,
            &stderr,
        );
        return;
    }

    let mut buffer = vec![0u8; 16 * 1024];
    let mut terminal_sent = false;
    let mut canceled = false;
    let mut end_reason = "stdout_eof";
    let mut handshake_completed = false;
    'runtime: loop {
        tokio::select! {
            read = stdout.read(&mut buffer) => {
                let read = match read {
                    Ok(0) => {
                        end_reason = "stdout_eof";
                        break;
                    }
                    Ok(read) => read,
                    Err(_) => {
                        end_reason = "stdout_read_failed";
                        break;
                    }
                };
                let frames = match decoder.push(&buffer[..read]) {
                    Ok(frames) => frames,
                    Err(error) => {
                        send_protocol_failure(&events, format!("语音 runtime 帧无效：{error}")).await;
                        terminal_sent = true;
                        end_reason = "invalid_frame";
                        break;
                    }
                };
                for frame in frames {
                    if let Some(handshake) = ready.take() {
                        if frame.kind != SpeechFrameKind::Ready {
                            let _ = handshake.send(Err(failure(
                                SpeechFailureCode::ProtocolMismatch,
                                "语音 runtime 的第一条消息必须是 Ready",
                                false,
                            )));
                            end_reason = "invalid_ready_kind";
                            break 'runtime;
                        }
                        let accepted = decode_speech_json::<SpeechReady>(&frame)
                            .map_err(|_| "Ready JSON 无效")
                            .and_then(|value| {
                                if value.request_id == start.request_id
                                    && value.runtime_id == expected_runtime.id
                                    && value.model_id == expected_runtime.model
                                    && value.context_revision == start.context_revision
                                {
                                    Ok(())
                                } else {
                                    Err("Ready 与探测结果或请求不一致")
                                }
                            });
                        match accepted {
                            Ok(()) => {
                                handshake_completed = true;
                                let _ = handshake.send(Ok(()));
                            }
                            Err(message) => {
                                let _ = handshake.send(Err(failure(
                                    SpeechFailureCode::ProtocolMismatch,
                                    message,
                                    false,
                                )));
                                end_reason = "invalid_ready_identity";
                                break 'runtime;
                            }
                        }
                        continue;
                    }
                    let event = match frame.kind {
                        SpeechFrameKind::ContextApplied => {
                            #[derive(serde::Deserialize)]
                            struct Applied { revision: u32 }
                            decode_speech_json::<Applied>(&frame)
                                .map(|value| RuntimeEvent::ContextApplied { revision: value.revision })
                        }
                        SpeechFrameKind::Partial => decode_speech_json::<SpeechPartial>(&frame)
                            .map(RuntimeEvent::Partial),
                        SpeechFrameKind::Completed => decode_speech_json::<SpeechCompleted>(&frame)
                            .map(|value| RuntimeEvent::Completed {
                                request_id: value.request_id,
                                duration_ms: value.duration_ms,
                                context_snapshot_id: value.context_snapshot_id,
                                candidates: value.candidates,
                                segments: value.segments.unwrap_or_default(),
                                score_kind: value.score_kind,
                                scores_calibrated: value.scores_calibrated,
                            }),
                        SpeechFrameKind::Failed => decode_speech_json::<SpeechFailure>(&frame)
                            .map(sanitize_runtime_failure)
                            .map(RuntimeEvent::Failed),
                        _ => {
                            send_protocol_failure(
                                &events,
                                format!("语音 runtime 返回了方向错误的消息 {:?}", frame.kind),
                            ).await;
                            terminal_sent = true;
                            end_reason = "wrong_direction_frame";
                            break 'runtime;
                        }
                    };
                    match event {
                        Ok(event) => {
                            let terminal = matches!(event, RuntimeEvent::Completed { .. } | RuntimeEvent::Failed(_));
                            if terminal {
                                terminal_sent = true;
                                end_reason = if matches!(event, RuntimeEvent::Completed { .. }) {
                                    "completed"
                                } else {
                                    "runtime_failed"
                                };
                            }
                            if events.send(event).await.is_err() || terminal {
                                break 'runtime;
                            }
                        }
                        Err(error) => {
                            send_protocol_failure(&events, format!("语音 runtime JSON 无效：{error}")).await;
                            terminal_sent = true;
                            end_reason = "invalid_json";
                            break 'runtime;
                        }
                    }
                }
            }
            command = commands.recv() => {
                let Some(command) = command else {
                    canceled = true;
                    end_reason = "command_channel_closed";
                    break;
                };
                let is_cancel = matches!(command, RuntimeCommand::Cancel);
                let wire = match command {
                    RuntimeCommand::Audio { index, capture_start_ms, pcm, duration_ms } =>
                        encode_speech_audio(index, capture_start_ms, duration_ms, &pcm),
                    RuntimeCommand::Context { revision, context } => encode_speech_json(
                        SpeechFrameKind::ContextUpdate,
                        &SpeechContextUpdate { revision, context },
                    ),
                    RuntimeCommand::Finish => encode_speech_frame(SpeechFrameKind::Finish, &[]),
                    RuntimeCommand::Cancel => encode_speech_json(
                        SpeechFrameKind::Cancel,
                        &serde_json::json!({ "reason": SpeechCancelReason::User }),
                    ),
                };
                if write_wire(&mut stdin, wire).await.is_err() {
                    end_reason = "stdin_write_failed";
                    break;
                }
                if is_cancel {
                    canceled = true;
                    end_reason = "client_cancel";
                    break;
                }
            }
        }
    }

    if let Some(ready) = ready.take() {
        let _ = ready.send(Err(failure(
            SpeechFailureCode::RuntimeUnavailable,
            "语音 runtime 在 Ready 前结束",
            true,
        )));
    } else if decoder.finish().is_err() {
        send_protocol_failure(&events, "语音 runtime 以不完整帧结束".to_string()).await;
        terminal_sent = true;
        end_reason = "incomplete_frame";
    }
    let status = child.try_wait().ok().flatten();
    let forced = status.is_none();
    if forced {
        crate::process::kill_child_tree(&mut child).await;
    }
    let status = match status {
        Some(status) => Some(status),
        None => child.wait().await.ok(),
    };
    let stderr = join_runtime_stderr(stderr_task).await;
    log_runtime_process_end(
        &start,
        &expected_runtime,
        end_reason,
        status.as_ref(),
        forced,
        &stderr,
    );
    if handshake_completed && !terminal_sent && !canceled {
        let detail = safe_stderr_detail(&stderr);
        let _ = events
            .send(RuntimeEvent::Failed(failure(
                SpeechFailureCode::RuntimeUnavailable,
                format!("语音 runtime 提前结束{detail}"),
                true,
            )))
            .await;
    }
}

fn adapter_command(registration: &SpeechRuntimeConfig, mode: &str) -> Command {
    let mut command = Command::new(&registration.command);
    command
        .args(&registration.args)
        .arg(mode)
        .kill_on_drop(true);
    if let Some(parent) = PathBuf::from(&registration.command).parent() {
        command.current_dir(parent);
    }
    crate::process::without_a_window(&mut command);
    command
}

async fn write_wire(
    stdin: &mut tokio::process::ChildStdin,
    wire: Result<Vec<u8>, genehub_proto::SpeechCodecError>,
) -> std::io::Result<()> {
    let wire = wire.map_err(std::io::Error::other)?;
    stdin.write_all(&wire).await?;
    stdin.flush().await
}

async fn read_bounded(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
    retain: RetainOutput,
) -> Result<BoundedOutput, String> {
    let mut bytes = Vec::new();
    let mut total_bytes = 0usize;
    let mut chunk = [0u8; 8192];
    loop {
        let read = reader
            .read(&mut chunk)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(BoundedOutput {
                bytes,
                total_bytes,
                truncated: total_bytes > limit,
            });
        }
        total_bytes = total_bytes.saturating_add(read);
        match retain {
            RetainOutput::Head => {
                let available = limit.saturating_sub(bytes.len());
                bytes.extend_from_slice(&chunk[..read.min(available)]);
            }
            RetainOutput::Tail => {
                if read >= limit {
                    bytes.clear();
                    bytes.extend_from_slice(&chunk[read - limit..read]);
                } else {
                    let overflow = bytes.len().saturating_add(read).saturating_sub(limit);
                    if overflow > 0 {
                        bytes.drain(..overflow);
                    }
                    bytes.extend_from_slice(&chunk[..read]);
                }
            }
        }
    }
}

async fn join_read(
    task: tokio::task::JoinHandle<Result<BoundedOutput, String>>,
    name: &str,
) -> Result<BoundedOutput, SpeechFailure> {
    task.await
        .map_err(|error| {
            failure(
                SpeechFailureCode::RuntimeUnavailable,
                format!("读取语音 runtime {name} 失败：{error}"),
                true,
            )
        })?
        .map_err(|error| {
            failure(
                SpeechFailureCode::ProtocolMismatch,
                format!("语音 runtime {name} {error}"),
                false,
            )
        })
}

async fn join_runtime_stderr(
    task: tokio::task::JoinHandle<Result<BoundedOutput, String>>,
) -> BoundedOutput {
    match task.await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => BoundedOutput {
            bytes: error.into_bytes(),
            total_bytes: 0,
            truncated: false,
        },
        Err(error) => BoundedOutput {
            bytes: error.to_string().into_bytes(),
            total_bytes: 0,
            truncated: false,
        },
    }
}

async fn send_protocol_failure(events: &mpsc::Sender<RuntimeEvent>, message: String) {
    let _ = events
        .send(RuntimeEvent::Failed(failure(
            SpeechFailureCode::ProtocolMismatch,
            message,
            false,
        )))
        .await;
}

fn safe_stderr_detail(stderr: &BoundedOutput) -> String {
    if stderr.bytes.iter().all(u8::is_ascii_whitespace) {
        String::new()
    } else {
        format!(
            "（诊断类别 {}，指纹 {}{}）",
            stderr_category(&stderr.bytes),
            output_fingerprint(&stderr.bytes),
            if stderr.truncated {
                "，输出已截断"
            } else {
                ""
            }
        )
    }
}

fn stderr_category(stderr: &[u8]) -> &'static str {
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if text.contains("out of memory") || text.contains("cuda oom") {
        "gpu_out_of_memory"
    } else if text.contains("no module named") || text.contains("module not found") {
        "dependency_missing"
    } else if text.contains("cuda") && (text.contains("driver") || text.contains("version")) {
        "gpu_runtime_mismatch"
    } else if text.contains("permission denied") {
        "permission_denied"
    } else if text.contains("no such file") || text.contains("not found") {
        "file_missing"
    } else if text.contains("error") || text.contains("exception") || text.contains("traceback") {
        "runtime_error"
    } else if text.trim().is_empty() {
        "none"
    } else {
        "runtime_output"
    }
}

fn output_fingerprint(bytes: &[u8]) -> String {
    let digest = format!("{:x}", Sha256::digest(bytes));
    digest[..16].to_string()
}

fn sanitize_runtime_failure(mut error: SpeechFailure) -> SpeechFailure {
    let message = error
        .message
        .trim()
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(500)
        .collect::<String>();
    error.message = if message.is_empty() {
        "语音 runtime 报告了一个未说明的错误".to_string()
    } else {
        message
    };
    error.retry_after_ms = error.retry_after_ms.filter(|delay| *delay <= 60_000);
    // Correlation ids belong to GeneHub, not an untrusted child process.
    error.correlation_id = None;
    error
}

fn log_probe_failure(
    reason: &'static str,
    status: Option<&std::process::ExitStatus>,
    stdout: &BoundedOutput,
    stderr: &BoundedOutput,
) {
    tracing::warn!(
        event = "speech_runtime_probe_failed",
        reason,
        exit_code = status.and_then(std::process::ExitStatus::code),
        exit_success = status.is_some_and(std::process::ExitStatus::success),
        stdout_bytes = stdout.total_bytes,
        stdout_truncated = stdout.truncated,
        stdout_fingerprint = %output_fingerprint(&stdout.bytes),
        stderr_bytes = stderr.total_bytes,
        stderr_truncated = stderr.truncated,
        stderr_category = stderr_category(&stderr.bytes),
        stderr_fingerprint = %output_fingerprint(&stderr.bytes),
        "speech runtime probe failed; stdout and stderr content were withheld"
    );
}

fn log_runtime_process_end(
    start: &SpeechStart,
    runtime: &genehub_proto::SpeechRuntimeDescriptor,
    reason: &'static str,
    status: Option<&std::process::ExitStatus>,
    forced: bool,
    stderr: &BoundedOutput,
) {
    tracing::info!(
        event = "speech_runtime_process_ended",
        request_id = %start.request_id,
        correlation_id = %speech_correlation_id(&start.request_id),
        runtime_id = %runtime.id,
        model_id = %runtime.model,
        implementation = %runtime.implementation,
        reason,
        exit_code = status.and_then(std::process::ExitStatus::code),
        exit_success = status.is_some_and(std::process::ExitStatus::success),
        forced,
        stderr_bytes = stderr.total_bytes,
        stderr_truncated = stderr.truncated,
        stderr_category = stderr_category(&stderr.bytes),
        stderr_fingerprint = %output_fingerprint(&stderr.bytes),
        "speech runtime process ended; stderr content was withheld"
    );
}

fn not_configured() -> SpeechFailure {
    failure(
        SpeechFailureCode::RuntimeUnavailable,
        "尚未注册本地语音 runtime。请让内置 Agent 使用 genehub-speech-runtime Skill 安装并登记模型。",
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_rejects_relative_commands_and_reserved_arguments() {
        assert!(validate_registration("python".into(), Vec::new()).is_err());
        let executable = std::env::current_exe().unwrap();
        assert!(validate_registration(
            executable.to_string_lossy().into_owned(),
            vec!["--genehub-probe".into()]
        )
        .is_err());
    }

    #[tokio::test]
    async fn bounded_output_drains_the_pipe_and_keeps_the_requested_edge() {
        let (mut writer, reader) = tokio::io::duplex(256);
        let bytes = (0u8..100).collect::<Vec<_>>();
        let write = tokio::spawn(async move {
            writer.write_all(&bytes).await.unwrap();
            writer.shutdown().await.unwrap();
        });
        let tail = read_bounded(reader, 10, RetainOutput::Tail).await.unwrap();
        write.await.unwrap();
        assert_eq!(tail.total_bytes, 100);
        assert!(tail.truncated);
        assert_eq!(tail.bytes, (90u8..100).collect::<Vec<_>>());

        let (mut writer, reader) = tokio::io::duplex(256);
        let write = tokio::spawn(async move {
            writer.write_all(&[1, 2, 3, 4, 5]).await.unwrap();
            writer.shutdown().await.unwrap();
        });
        let head = read_bounded(reader, 3, RetainOutput::Head).await.unwrap();
        write.await.unwrap();
        assert_eq!(head.bytes, [1, 2, 3]);
        assert_eq!(head.total_bytes, 5);
        assert!(head.truncated);
    }

    #[test]
    fn stderr_diagnostics_classify_and_fingerprint_without_exposing_content() {
        let stderr = BoundedOutput {
            bytes: b"Traceback: secret project term".to_vec(),
            total_bytes: 30,
            truncated: false,
        };
        let detail = safe_stderr_detail(&stderr);
        assert!(detail.contains("runtime_error"));
        assert!(detail.contains(&output_fingerprint(&stderr.bytes)));
        assert!(!detail.contains("secret"));
        assert!(!detail.contains("project term"));
    }

    #[test]
    fn runtime_failure_cannot_supply_a_correlation_id_or_unbounded_retry() {
        let mut reported = failure(
            SpeechFailureCode::RuntimeUnavailable,
            format!("{}\nraw", "x".repeat(600)),
            true,
        );
        reported.correlation_id = Some("child-controlled".into());
        reported.retry_after_ms = Some(600_001);

        let sanitized = sanitize_runtime_failure(reported);
        assert_eq!(sanitized.message.chars().count(), 500);
        assert!(!sanitized.message.chars().any(char::is_control));
        assert_eq!(sanitized.correlation_id, None);
        assert_eq!(sanitized.retry_after_ms, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_executes_registered_adapter_and_validates_its_capabilities() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let adapter = dir.path().join("adapter");
        std::fs::write(
            &adapter,
            r##"#!/bin/sh
printf '%s' '{"schema":"genehub.speech-runtime.capabilities.v1","speechProtocolVersion":2,"runtime":{"id":"test-qwen3","model":"Qwen/Qwen3-ASR-1.7B-hf","label":"Test Qwen3","implementation":"test-adapter/1"},"audio":[{"encoding":"pcmS16Le","sampleRateHz":16000,"channels":1}],"languages":["zh","en"],"maxLanguageHints":1,"maxDurationMs":300000,"nBest":{"maxCandidates":1,"scoreKind":"unavailable","calibrated":false},"segmentation":{"maxSegments":0,"partialResults":true,"localNBest":false,"uncertainSpans":false}}'
"##,
        )
        .unwrap();
        std::fs::set_permissions(&adapter, std::fs::Permissions::from_mode(0o700)).unwrap();

        let registration =
            validate_registration(adapter.to_string_lossy().into_owned(), Vec::new()).unwrap();
        let capabilities = probe_registration(&registration).await.unwrap();

        assert_eq!(capabilities.runtime.id, "test-qwen3");
        assert_eq!(capabilities.runtime.model, "Qwen/Qwen3-ASR-1.7B-hf");
        assert!(capabilities.segmentation.partial_results);
        assert_eq!(capabilities.n_best.max_candidates, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_adapter_receives_start_and_must_echo_the_probed_runtime() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let adapter = dir.path().join("adapter");
        let captured = dir.path().join("start.frame");
        let capabilities: SpeechRuntimeCapabilities = serde_json::from_str(
            r#"{
                "schema":"genehub.speech-runtime.capabilities.v1",
                "speechProtocolVersion":2,
                "runtime":{
                    "id":"test-qwen3",
                    "model":"Qwen/Qwen3-ASR-1.7B-hf",
                    "label":"Test Qwen3",
                    "implementation":"test-adapter/1"
                },
                "audio":[{"encoding":"pcmS16Le","sampleRateHz":16000,"channels":1}],
                "languages":["zh","en"],
                "maxLanguageHints":1,
                "maxDurationMs":300000,
                "nBest":{"maxCandidates":1,"scoreKind":"unavailable","calibrated":false},
                "segmentation":{
                    "maxSegments":0,
                    "partialResults":true,
                    "localNBest":false,
                    "uncertainSpans":false
                }
            }"#,
        )
        .unwrap();
        let start = SpeechStart {
            request_id: "request-stdio".into(),
            workspace_id: "workspace-1".into(),
            session_id: None,
            audio: genehub_proto::SpeechAudioFormat::default(),
            language_hints: vec!["zh".into()],
            context: genehub_proto::SpeechContextPack::empty(),
            context_revision: 1,
            accept_partial: true,
        };
        let start_wire = encode_speech_json(SpeechFrameKind::Start, &start).unwrap();
        let ready_wire = encode_speech_json(
            SpeechFrameKind::Ready,
            &SpeechReady {
                request_id: start.request_id.clone(),
                runtime_id: capabilities.runtime.id.clone(),
                model_id: capabilities.runtime.model.clone(),
                context_revision: start.context_revision,
            },
        )
        .unwrap();
        let ready_octal = ready_wire
            .iter()
            .map(|byte| format!(r"\0{byte:03o}"))
            .collect::<String>();
        std::fs::write(
            &adapter,
            format!(
                "#!/bin/sh\ndd bs=1 count={} of='{}' 2>/dev/null\nprintf '%b' '{}'\ncat >/dev/null\n",
                start_wire.len(),
                captured.display(),
                ready_octal,
            ),
        )
        .unwrap();
        std::fs::set_permissions(&adapter, std::fs::Permissions::from_mode(0o700)).unwrap();
        let registration =
            validate_registration(adapter.to_string_lossy().into_owned(), Vec::new()).unwrap();
        let config = SpeechConfig {
            runtime: Some(registration),
            ..SpeechConfig::default()
        };

        let session = ExternalSpeechRuntime
            .open(&config, &start, &capabilities)
            .await
            .unwrap();
        let frame = SpeechFrameDecoder::default()
            .push(&std::fs::read(captured).unwrap())
            .unwrap()
            .remove(0);
        assert_eq!(frame.kind, SpeechFrameKind::Start);
        assert_eq!(decode_speech_json::<SpeechStart>(&frame).unwrap(), start);
        session.send(RuntimeCommand::Cancel).await.unwrap();
    }
}
