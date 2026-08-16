use std::collections::BTreeMap;
use std::time::Duration;

use genet_daemon_logic_api::{
    CapabilityBatch, CapabilityCall, CapabilityEvent, CapabilityFailureKind, CapabilityRequest,
    CapabilityValue, FileLocator, FileRequest, FileRoot, HttpRequest, ProcessDialogueStep,
    ProcessRequest, ProcessSpec, PtyRequest, RedirectPolicy, RtcRequest, SocketRequest,
    MAX_CAPABILITY_BATCH,
};
use genet_daemon_system::SystemHost;

async fn one(
    host: &SystemHost,
    request: CapabilityRequest,
) -> genet_daemon_logic_api::CapabilityResult {
    host.execute(CapabilityBatch {
        batch_id: 9,
        calls: vec![CapabilityCall {
            call_id: 17,
            request,
        }],
    })
    .await
    .results
    .pop()
    .unwrap()
}

fn private(path: &str) -> FileLocator {
    FileLocator {
        root: FileRoot::Private,
        path: path.to_string(),
    }
}

#[tokio::test]
async fn private_and_workspace_files_are_bounded_atomic_and_rooted() {
    let root = tempfile::tempdir().unwrap();
    let private_dir = root.path().join("private");
    let logs = root.path().join("logs");
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let host = SystemHost::new(&private_dir, &logs).unwrap();

    assert!(matches!(
        one(
            &host,
            CapabilityRequest::SecureWrite {
                key: "settings/config.json".into(),
                bytes: br#"{"ok":true}"#.to_vec(),
            },
        )
        .await
        .result,
        Ok(CapabilityValue::Unit)
    ));
    assert!(matches!(
        one(
            &host,
            CapabilityRequest::SecureRead {
                key: "settings/config.json".into(),
                max_bytes: 1024,
            },
        )
        .await
        .result,
        Ok(CapabilityValue::Bytes(bytes)) if bytes == br#"{"ok":true}"#
    ));
    assert!(matches!(
        one(
            &host,
            CapabilityRequest::SecureRead {
                key: "../logic/active.json".into(),
                max_bytes: 1024,
            },
        )
        .await
        .result,
        Err(error) if error.kind == CapabilityFailureKind::Denied
    ));

    assert!(one(
        &host,
        CapabilityRequest::File(FileRequest::RegisterWorkspaceRoot {
            handle: "r_test".into(),
            native_path: workspace.display().to_string(),
        }),
    )
    .await
    .result
    .is_ok());
    let root_locator = FileLocator {
        root: FileRoot::Workspace {
            handle: "r_test".into(),
        },
        path: String::new(),
    };
    assert_eq!(
        host.workspace_path(&root_locator).await.unwrap(),
        workspace.canonicalize().unwrap(),
        "a locator for the root must preserve its canonical spelling"
    );
    let locator = FileLocator {
        root: FileRoot::Workspace {
            handle: "r_test".into(),
        },
        path: "nested/file.txt".into(),
    };
    assert!(one(
        &host,
        CapabilityRequest::File(FileRequest::WriteAtomic {
            locator: locator.clone(),
            bytes: b"portable".to_vec(),
        }),
    )
    .await
    .result
    .is_ok());
    assert_eq!(
        std::fs::read(workspace.join("nested/file.txt")).unwrap(),
        b"portable"
    );
    assert!(matches!(
        one(
            &host,
            CapabilityRequest::File(FileRequest::Read {
                locator: FileLocator {
                    root: FileRoot::Workspace {
                        handle: "r_test".into(),
                    },
                    path: "../private/settings/config.json".into(),
                },
                max_bytes: 1024,
            }),
        )
        .await
        .result,
        Err(error) if error.kind == CapabilityFailureKind::Denied
    ));

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&private_dir, workspace.join("escape")).unwrap();
        assert!(matches!(
            one(
                &host,
                CapabilityRequest::File(FileRequest::Read {
                    locator: FileLocator {
                        root: FileRoot::Workspace {
                            handle: "r_test".into(),
                        },
                        path: "escape/settings/config.json".into(),
                    },
                    max_bytes: 1024,
                }),
            )
            .await
            .result,
            Err(error) if error.kind == CapabilityFailureKind::Denied
        ));
    }
}

#[tokio::test]
async fn file_locks_are_kernel_backed_exclusive_and_explicitly_releasable() {
    let root = tempfile::tempdir().unwrap();
    let private_dir = root.path().join("private");
    let logs = root.path().join("logs");
    let first = SystemHost::new(&private_dir, &logs).unwrap();
    let second = SystemHost::new(&private_dir, &logs).unwrap();
    let locator = private("sessions/s_test/writer.lock");

    let resource_id = match one(
        &first,
        CapabilityRequest::File(FileRequest::Lock {
            locator: locator.clone(),
            exclusive: true,
        }),
    )
    .await
    .result
    {
        Ok(CapabilityValue::FileLocked { resource_id }) => resource_id,
        other => panic!("first lock failed: {other:?}"),
    };

    assert!(matches!(
        one(
            &second,
            CapabilityRequest::File(FileRequest::Lock {
                locator: locator.clone(),
                exclusive: true,
            }),
        )
        .await
        .result,
        Err(error) if error.kind == CapabilityFailureKind::Conflict
    ));

    assert!(matches!(
        one(
            &first,
            CapabilityRequest::File(FileRequest::Unlock { resource_id }),
        )
        .await
        .result,
        Ok(CapabilityValue::Unit)
    ));

    assert!(matches!(
        one(
            &second,
            CapabilityRequest::File(FileRequest::Lock {
                locator,
                exclusive: true,
            }),
        )
        .await
        .result,
        Ok(CapabilityValue::FileLocked { .. })
    ));
}

#[tokio::test]
async fn batches_randomness_and_clocks_are_bounded() {
    let root = tempfile::tempdir().unwrap();
    let host = SystemHost::new(root.path().join("private"), root.path().join("logs")).unwrap();
    let too_many = host
        .execute(CapabilityBatch {
            batch_id: 1,
            calls: (0..=MAX_CAPABILITY_BATCH)
                .map(|id| CapabilityCall {
                    call_id: id as u64,
                    request: CapabilityRequest::Clock,
                })
                .collect(),
        })
        .await;
    assert_eq!(too_many.results.len(), MAX_CAPABILITY_BATCH + 1);
    assert!(too_many.results.iter().all(
        |result| matches!(&result.result, Err(error) if error.kind == CapabilityFailureKind::TooLarge)
    ));
    assert!(matches!(
        one(&host, CapabilityRequest::Random { bytes: 32 })
            .await
            .result,
        Ok(CapabilityValue::Bytes(bytes)) if bytes.len() == 32 && bytes.iter().any(|byte| *byte != 0)
    ));
    assert!(matches!(
        one(&host, CapabilityRequest::Clock).await.result,
        Ok(CapabilityValue::Clock { unix_millis, .. }) if unix_millis > 1_700_000_000_000
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn process_streams_are_ordered_and_survive_the_request_that_spawned_them() {
    let root = tempfile::tempdir().unwrap();
    let native_root = root.path().canonicalize().unwrap();
    let host = SystemHost::new(root.path().join("private"), root.path().join("logs")).unwrap();
    let mut events = host.take_events().unwrap();
    let spawned = one(
        &host,
        CapabilityRequest::Process(ProcessRequest::Spawn(ProcessSpec {
            program: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                "read line; printf 'out:%s' \"$line\"; printf 'err' >&2".into(),
            ],
            env: BTreeMap::new(),
            cwd: Some(FileLocator {
                root: FileRoot::NativePath,
                path: native_root.display().to_string(),
            }),
            confinement: genet_daemon_logic_api::ConfinementMode::None,
            capture_stdout: true,
            capture_stderr: true,
        })),
    )
    .await;
    let resource_id = match spawned.result.unwrap() {
        CapabilityValue::ProcessStarted { resource_id, pid } => {
            assert!(pid.is_some());
            resource_id
        }
        other => panic!("unexpected {other:?}"),
    };
    one(
        &host,
        CapabilityRequest::Process(ProcessRequest::Write {
            resource_id,
            bytes: b"hello\n".to_vec(),
        }),
    )
    .await
    .result
    .unwrap();
    one(
        &host,
        CapabilityRequest::Process(ProcessRequest::CloseInput { resource_id }),
    )
    .await
    .result
    .unwrap();

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap();
        match event {
            CapabilityEvent::ProcessOutput {
                resource_id: id,
                stream: genet_daemon_logic_api::ProcessStream::Stdout,
                bytes,
            } if id == resource_id => stdout.extend(bytes),
            CapabilityEvent::ProcessOutput {
                resource_id: id,
                stream: genet_daemon_logic_api::ProcessStream::Stderr,
                bytes,
            } if id == resource_id => stderr.extend(bytes),
            CapabilityEvent::ProcessExited {
                resource_id: id,
                code,
            } if id == resource_id => {
                assert_eq!(code, Some(0));
                break;
            }
            _ => {}
        }
    }
    assert_eq!(stdout, b"out:hello");
    assert_eq!(stderr, b"err");
}

#[cfg(unix)]
#[tokio::test]
async fn process_dialogue_preserves_one_process_across_bounded_request_steps() {
    let root = tempfile::tempdir().unwrap();
    let native_root = root.path().canonicalize().unwrap();
    let host = SystemHost::new(root.path().join("private"), root.path().join("logs")).unwrap();
    let result = one(
        &host,
        CapabilityRequest::Process(ProcessRequest::Dialogue {
            spec: ProcessSpec {
                program: "/bin/sh".into(),
                args: vec![
                    "-c".into(),
                    "while IFS= read -r line; do printf 'reply:%s\\n' \"$line\"; done".into(),
                ],
                env: BTreeMap::new(),
                cwd: Some(FileLocator {
                    root: FileRoot::NativePath,
                    path: native_root.display().to_string(),
                }),
                confinement: genet_daemon_logic_api::ConfinementMode::None,
                capture_stdout: true,
                capture_stderr: true,
            },
            steps: vec![
                ProcessDialogueStep {
                    stdin: b"first\n".to_vec(),
                    wait_for_line: b"reply:first".to_vec(),
                },
                ProcessDialogueStep {
                    stdin: b"second\n".to_vec(),
                    wait_for_line: b"reply:second".to_vec(),
                },
            ],
            timeout_millis: 5_000,
            max_stdout_bytes: 1024,
            max_stderr_bytes: 1024,
        }),
    )
    .await
    .result
    .unwrap();
    assert!(matches!(
        result,
        CapabilityValue::ProcessCompleted { stdout, stderr, .. }
            if stdout == b"reply:first\nreply:second\n" && stderr.is_empty()
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn pty_output_and_close_are_resource_events() {
    let root = tempfile::tempdir().unwrap();
    let native_root = root.path().canonicalize().unwrap();
    let host = SystemHost::new(root.path().join("private"), root.path().join("logs")).unwrap();
    let mut events = host.take_events().unwrap();
    let opened = one(
        &host,
        CapabilityRequest::Pty(PtyRequest::Open {
            cwd: FileLocator {
                root: FileRoot::NativePath,
                path: native_root.display().to_string(),
            },
            confinement: genet_daemon_logic_api::ConfinementMode::None,
            cols: 80,
            rows: 24,
            env: BTreeMap::new(),
        }),
    )
    .await;
    let resource_id = match opened.result.unwrap() {
        CapabilityValue::Resource { resource_id } => resource_id,
        other => panic!("unexpected {other:?}"),
    };
    let mut output = Vec::new();
    let ready_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut answered_cursor_queries = 0usize;
    while tokio::time::Instant::now() < ready_deadline {
        match tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
            Ok(Some(CapabilityEvent::PtyOutput {
                resource_id: id,
                bytes,
            })) if id == resource_id => {
                output.extend(bytes);
                let seen = String::from_utf8_lossy(&output);
                let cursor_queries = seen.matches("\u{1b}[6n").count();
                while answered_cursor_queries < cursor_queries {
                    one(
                        &host,
                        CapabilityRequest::Pty(PtyRequest::Write {
                            resource_id,
                            bytes: b"\x1b[1;1R".to_vec(),
                        }),
                    )
                    .await
                    .result
                    .unwrap();
                    answered_cursor_queries += 1;
                }
                if ["# ", "$ ", "% "]
                    .iter()
                    .any(|prompt| seen.ends_with(prompt))
                {
                    break;
                }
            }
            Ok(Some(CapabilityEvent::PtyClosed {
                resource_id: id, ..
            })) if id == resource_id => {
                panic!("PTY closed before its startup prompt")
            }
            Ok(Some(_)) | Err(_) => {}
            Ok(None) => panic!("PTY event channel closed before startup"),
        }
    }
    one(
        &host,
        CapabilityRequest::Pty(PtyRequest::Write {
            resource_id,
            bytes: b"echo __GENEHUB_PTY_OK__\r".to_vec(),
        }),
    )
    .await
    .result
    .unwrap();
    let marker_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < marker_deadline
        && !String::from_utf8_lossy(&output).contains("__GENEHUB_PTY_OK__")
    {
        match tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
            Ok(Some(CapabilityEvent::PtyOutput {
                resource_id: id,
                bytes,
            })) if id == resource_id => output.extend(bytes),
            Ok(Some(CapabilityEvent::PtyClosed {
                resource_id: id, ..
            })) if id == resource_id => {
                panic!("PTY closed before accepting input")
            }
            Ok(Some(_)) | Err(_) => {}
            Ok(None) => panic!("PTY event channel closed before marker"),
        }
    }
    assert!(
        String::from_utf8_lossy(&output).contains("__GENEHUB_PTY_OK__"),
        "PTY never accepted input: {}",
        String::from_utf8_lossy(&output)
    );
    one(
        &host,
        CapabilityRequest::Pty(PtyRequest::Close { resource_id }),
    )
    .await
    .result
    .unwrap();
    loop {
        match tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .unwrap()
            .unwrap()
        {
            CapabilityEvent::PtyClosed {
                resource_id: id, ..
            } if id == resource_id => break,
            _ => {}
        }
    }
}

#[tokio::test]
async fn http_and_websocket_drivers_move_bounded_raw_messages() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let root = tempfile::tempdir().unwrap();
    let host = SystemHost::new(root.path().join("private"), root.path().join("logs")).unwrap();
    let mut events = host.take_events().unwrap();

    let http = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http_addr = http.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = http.accept().await.unwrap();
        let mut request = [0_u8; 2048];
        let _ = stream.read(&mut request).await.unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nportable")
            .await
            .unwrap();
    });
    let response = one(
        &host,
        CapabilityRequest::Http(HttpRequest {
            method: "GET".into(),
            url: format!("http://{http_addr}/probe"),
            headers: vec![("user-agent".into(), "genehub-test".into())],
            body: vec![],
            timeout_millis: 5_000,
            max_response_bytes: 1024,
            redirect: RedirectPolicy::None,
        }),
    )
    .await;
    assert!(matches!(
        response.result,
        Ok(CapabilityValue::Http(response)) if response.status == 200 && response.body == b"portable"
    ));

    let websocket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let websocket_addr = websocket.local_addr().unwrap();
    tokio::spawn(async move {
        let (stream, _) = websocket.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        use futures_util::{SinkExt, StreamExt};
        if let Some(Ok(message)) = socket.next().await {
            socket.send(message).await.unwrap();
        }
    });
    let connected = one(
        &host,
        CapabilityRequest::Socket(SocketRequest::Connect {
            url: format!("ws://{websocket_addr}/events"),
            headers: vec![],
            max_message_bytes: 1024,
        }),
    )
    .await;
    let resource_id = match connected.result.unwrap() {
        CapabilityValue::Resource { resource_id } => resource_id,
        other => panic!("unexpected {other:?}"),
    };
    one(
        &host,
        CapabilityRequest::Socket(SocketRequest::Send {
            resource_id,
            bytes: b"socket".to_vec(),
        }),
    )
    .await
    .result
    .unwrap();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap();
        if let CapabilityEvent::SocketMessage {
            resource_id: id,
            bytes,
        } = event
        {
            if id == resource_id {
                assert_eq!(bytes, b"socket");
                break;
            }
        }
    }
}

#[tokio::test]
async fn rtc_peers_are_bounded_opaque_resources_with_explicit_lifecycle() {
    let root = tempfile::tempdir().unwrap();
    let host = SystemHost::new(root.path().join("private"), root.path().join("logs")).unwrap();

    assert!(matches!(
        one(
            &host,
            CapabilityRequest::Rtc(RtcRequest::Create {
                ice_servers: vec![],
                data_channel_label: String::new(),
                max_message_bytes: 1024,
            }),
        )
        .await
        .result,
        Err(error) if error.kind == CapabilityFailureKind::Invalid
    ));

    let resource_id = match one(
        &host,
        CapabilityRequest::Rtc(RtcRequest::Create {
            ice_servers: vec![],
            data_channel_label: "genehub".to_string(),
            max_message_bytes: 1024,
        }),
    )
    .await
    .result
    .unwrap()
    {
        CapabilityValue::Resource { resource_id } => resource_id,
        other => panic!("unexpected {other:?}"),
    };

    assert!(matches!(
        one(
            &host,
            CapabilityRequest::Rtc(RtcRequest::Send {
                resource_id,
                bytes: b"not-open".to_vec(),
            }),
        )
        .await
        .result,
        Err(error) if error.kind == CapabilityFailureKind::Conflict
    ));
    assert!(matches!(
        one(
            &host,
            CapabilityRequest::Rtc(RtcRequest::Close { resource_id }),
        )
        .await
        .result,
        Ok(CapabilityValue::Unit)
    ));
    assert!(matches!(
        one(
            &host,
            CapabilityRequest::Rtc(RtcRequest::Send {
                resource_id,
                bytes: b"closed".to_vec(),
            }),
        )
        .await
        .result,
        Err(error) if error.kind == CapabilityFailureKind::NotFound
    ));
}

#[test]
fn helper_locator_is_not_accidentally_absolute() {
    assert_eq!(private("a").path, "a");
}
