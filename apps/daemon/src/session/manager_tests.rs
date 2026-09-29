use super::*;

// Fixture delivery uses the actual ledger and handover; no test-only product API.
async fn deliver_decision(
    sessions: &SessionManager,
    live: &Arc<Live>,
    providers: &ProviderMap,
) -> Result<()> {
    let _interaction = live.interaction_lock.lock().await;
    if live.execution.lock().await.is_some() || live.meta.lock().await.inbox.paused {
        return Ok(());
    }
    sessions.queue_human_input(live).await?;
    let Some((_, continuation)) = sessions.prepare_human_delivery(live).await? else {
        return Ok(());
    };
    let meta = live.meta.lock().await.clone();
    let entry = meta
        .inbox
        .entries
        .iter()
        .find(|entry| entry.kernel_input.is_some() && entry.state != "handled")
        .expect("queued decision");
    let anchor = live
        .items
        .lock()
        .await
        .iter()
        .rev()
        .find(|item| matches!(item, TimelineItem::UserMessage { .. }))
        .cloned()
        .unwrap_or(TimelineItem::UserMessage {
            id: "test-decision-anchor".into(),
            text: "test goal".into(),
            attachments: Vec::new(),
        });
    sessions
        .send_prepared(
            &meta.id,
            continuation.prompt,
            Vec::new(),
            providers,
            entry.continues_round.clone(),
            Some((anchor, vec![entry.message_id.clone()])),
        )
        .await?;
    Ok(())
}

use genehub_proto::{ToolCallDetail, TurnError, TurnErrorCode, Usage};

fn boundary_view(id: &str, running: bool) -> RoundView {
    RoundView {
        source: None,
        round_id: id.into(),
        ord: 0,
        user_item_id: None,
        started_at_ms: 0,
        ended_at_ms: 0,
        outcome: if running {
            RoundLayerOutcome::Running
        } else {
            RoundLayerOutcome::Completed
        },
        trunk_count: 0,
    }
}

#[test]
fn an_open_round_is_left_out_of_the_capsule_boundary() {
    let views = vec![boundary_view("closed", false), boundary_view("open", true)];
    match closed_round_before_open(&views, None).unwrap() {
        ClosedBoundary::Through(id) => assert_eq!(id, "closed"),
        other => panic!("expected the closed round, got {other:?}"),
    }
    assert!(matches!(
        closed_round_before_open(&[boundary_view("open", true)], None).unwrap(),
        ClosedBoundary::Empty
    ));
    match closed_round_before_open(&views, Some("closed")).unwrap() {
        ClosedBoundary::Unchanged(Some(id)) => assert_eq!(id, "closed"),
        other => panic!("expected the named closed round, got {other:?}"),
    }
}

fn meta() -> SessionMeta {
    SessionMeta {
        human_receipts: Vec::new(),
        inbox: Default::default(),
        execution_retired: false,
        execution_cleanup: None,
        activity: Default::default(),
        message_preview: None,
        latest_reply: None,
        drafts: vec![],
        effort_id: None,
        fast: None,
        id: "s1".into(),
        workspace_id: "w1".into(),
        format: SESSION_FORMAT,
        agent_id: "genet".into(),
        tag_routing: false,
        routing_tags: Vec::new(),
        media_tags: Vec::new(),
        title: None,
        title_locked: false,
        cwd: PathBuf::from("/tmp"),
        model_id: None,
        mode_id: None,
        runtime_values: Default::default(),
        created_at_ms: 0,
        updated_at_ms: 0,
        archived: false,
        persist: None,
        agent_pid: None,

        human_wait: None,
        lineage: None,
        managed: None,
        managed_system_prompt: None,
        imported: None,
    }
}

fn item(id: &str, text: &str) -> TimelineItem {
    TimelineItem::AssistantMessage {
        id: id.into(),
        text: text.into(),
        received_at_ms: None,
    }
}

#[test]
fn migration_history_excludes_inputs_that_still_need_delivery() {
    let mut session = meta();
    session.inbox.entries = vec![
        crate::session::store::InboxEntry {
            message_id: "handled".into(),
            received_at_ms: 1,
            digest: "handled-digest".into(),
            source: "user".into(),
            task_run_id: None,
            state: "handled".into(),
            turn_id: Some("turn-1".into()),
            kernel_input: None,
            continues_round: None,
        },
        crate::session::store::InboxEntry {
            message_id: "queued".into(),
            received_at_ms: 2,
            digest: "queued-digest".into(),
            source: "user".into(),
            task_run_id: None,
            state: "queued".into(),
            turn_id: None,
            kernel_input: None,
            continues_round: None,
        },
    ];
    let items = vec![
        TimelineItem::UserMessage {
            id: "handled".into(),
            text: "already delivered".into(),
            attachments: Vec::new(),
        },
        TimelineItem::UserMessage {
            id: "queued".into(),
            text: "deliver exactly once".into(),
            attachments: Vec::new(),
        },
    ];

    let history = migration_seed_history(&session, &items);
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].id(), "handled");
}

#[test]
fn migration_seed_target_distinguishes_an_explicit_default_model() {
    let legacy = ContextSeed {
        state: ContextSeedState::Pending,
        text: "legacy".into(),
        target_agent_id: None,
        target_model_id: None,
    };
    assert!(context_seed_targets_route(
        &legacy,
        "any-agent",
        &Some("any-model".into())
    ));

    let routed_default = ContextSeed {
        state: ContextSeedState::Pending,
        text: "routed".into(),
        target_agent_id: Some("target".into()),
        target_model_id: None,
    };
    assert!(context_seed_targets_route(&routed_default, "target", &None));
    assert!(!context_seed_targets_route(
        &routed_default,
        "target",
        &Some("old-model".into())
    ));
}

/// A store whose single workspace, `w1`, is a throwaway directory. Sessions
/// live inside their workspace, so a test has to say which one that is.
fn test_store(workspace_root: &std::path::Path) -> Store {
    let homes = crate::session::WorkspaceHomes::default();
    homes.attach("w1", workspace_root);
    Store::new(homes)
}

/// A manager over a throwaway directory. Neither rename nor delete asks the
/// registry anything, so an empty one is enough to exercise both.
fn manager(root: &std::path::Path) -> SessionManager {
    SessionManager::new(
        test_store(root),
        Arc::new(Registry::new(&std::collections::BTreeMap::new())),
        16,
    )
}

#[tokio::test]
async fn drafts_are_bounded_and_survive_a_manager_restart() {
    let workspace = tempfile::tempdir().unwrap();
    let sessions = manager(workspace.path());
    sessions.store.save_meta(&meta()).unwrap();
    let draft = genehub_proto::SessionDraft {
        id: "draft-1".into(),
        text: "继续整理交互".into(),
        attachments: vec![],
        forward: None,
    };

    sessions
        .replace_drafts("s1", vec![draft.clone()])
        .await
        .unwrap();
    assert_eq!(sessions.summary("s1").await.unwrap().draft_count, Some(1));

    let restarted = manager(workspace.path());
    assert_eq!(restarted.drafts("s1").await.unwrap(), vec![draft.clone()]);
    let too_many = (0..6)
        .map(|index| genehub_proto::SessionDraft {
            id: format!("draft-{index}"),
            text: index.to_string(),
            attachments: vec![],
            forward: None,
        })
        .collect();
    assert!(restarted.replace_drafts("s1", too_many).await.is_err());
}

#[tokio::test]
async fn controller_proof_is_bound_to_one_existing_session_and_one_daemon_lifetime() {
    let workspace = tempfile::tempdir().unwrap();
    let sessions = manager(workspace.path());
    sessions.store.save_meta(&meta()).unwrap();

    let token = sessions.controller_token("s1");
    assert!(sessions.authenticate_controller("s1", &token).await);
    assert!(!sessions.authenticate_controller("missing", &token).await);
    assert!(!sessions.authenticate_controller("s1", "not-a-proof").await);

    let restarted = manager(workspace.path());
    assert!(restarted.summary("s1").await.is_ok());
    assert!(
        !restarted.authenticate_controller("s1", &token).await,
        "controller proof must not become durable project authority"
    );
}

/// One configurable adapter at the external Agent boundary. The variants retain
/// the previous fixtures' IDs, capabilities, catalogs and failure behavior.
enum TestAdapter {
    Amnesiac,
    Recorder(Arc<std::sync::Mutex<Option<String>>>),
    Import,
    Fork {
        setup: ForkSetup,
        chat_id_only: bool,
    },
}
struct ForkSetup {
    id: &'static str,
    native_fork: bool,
    prompts: Arc<std::sync::Mutex<Vec<PromptInput>>>,
    starts: Arc<std::sync::Mutex<Vec<Option<PersistHandle>>>>,
}
impl TestAdapter {
    fn fork(setup: ForkSetup) -> Self {
        Self::Fork {
            setup,
            chat_id_only: false,
        }
    }
    fn chat_id(setup: ForkSetup) -> Self {
        Self::Fork {
            setup,
            chat_id_only: true,
        }
    }
}
#[async_trait::async_trait]
impl crate::adapter::AgentAdapter for TestAdapter {
    fn id(&self) -> &str {
        match self {
            Self::Amnesiac => "amnesiac",
            Self::Recorder(_) => "recorder",
            Self::Import => "historian",
            Self::Fork { setup, .. } => setup.id,
        }
    }
    fn label(&self) -> &str {
        match self {
            Self::Amnesiac => "Amnesiac",
            Self::Recorder(_) => "Recorder",
            Self::Import => "Historian",
            Self::Fork { setup, .. } => setup.id,
        }
    }
    fn capabilities(&self) -> genehub_proto::Capabilities {
        match self {
            Self::Amnesiac => genehub_proto::Capabilities {
                resume: true,
                ..Default::default()
            },
            Self::Import => genehub_proto::Capabilities {
                resume: true,
                ..Default::default()
            },
            Self::Fork { setup, .. } => genehub_proto::Capabilities {
                fork: setup.native_fork,
                ..Default::default()
            },
            Self::Recorder(_) => Default::default(),
        }
    }
    fn accepts_resume(&self, handle: &PersistHandle) -> bool {
        !matches!(
            self,
            Self::Fork {
                chat_id_only: true,
                ..
            }
        ) || handle.value.get("chatId").is_some()
    }
    async fn probe(&self) -> genehub_proto::ProbeState {
        genehub_proto::ProbeState::Ready
    }
    async fn catalog(&self, _providers: &ProviderMap) -> genehub_proto::Catalog {
        if !matches!(self, Self::Fork { .. }) {
            return Default::default();
        }
        genehub_proto::Catalog {
            models: ["model", "model-alt"]
                .into_iter()
                .map(|id| genehub_proto::ModelInfo {
                    id: id.into(),
                    label: id.into(),
                    context_window: Some(10_000),
                    reasoning: true,
                    efforts: Vec::new(),
                    input_modalities: None,
                    supports_fast: false,
                })
                .collect(),
            modes: Vec::new(),
            commands: Vec::new(),
            runtime_axes: None,
            default_model: Some("model".into()),
            default_mode: None,
            default_effort: None,
        }
    }

    async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>> {
        match self {
            Self::Import => bail!("not needed by the import test"),
            Self::Amnesiac => {
                if config.resume.is_some() {
                    return Err(crate::rpc_error::failure(
                        genehub_proto::ErrorCode::NotFound,
                        "no such thread".to_owned(),
                    ));
                }
                Ok(Box::new(TestSession::blank()))
            }
            Self::Recorder(context) => {
                *context.lock().unwrap() = config.additional_system_prompt;
                Ok(Box::new(TestSession::blank()))
            }
            Self::Fork { setup, .. } => {
                setup.starts.lock().unwrap().push(config.resume);
                Ok(Box::new(TestSession::fork(
                    setup.id,
                    setup.native_fork,
                    setup.prompts.clone(),
                )))
            }
        }
    }
    async fn list_import_candidates(
        &self,
        _cwd: &std::path::Path,
        _limit: usize,
    ) -> Result<Option<Vec<crate::adapter::ImportCandidate>>> {
        if !matches!(self, Self::Import) {
            return Ok(None);
        }
        Ok(Some(vec![crate::adapter::ImportCandidate {
            source_id: "native-secret-42".into(),
            title: "Imported work".into(),
            preview: "first prompt".into(),
            updated_at_ms: 20,
            continuation: ImportContinuation::Native,
        }]))
    }

    async fn import_history(
        &self,
        _cwd: &std::path::Path,
        source_id: &str,
    ) -> Result<crate::adapter::ImportedHistory> {
        if !matches!(self, Self::Import) {
            return Err(crate::rpc_error::failure(
                genehub_proto::ErrorCode::Unsupported,
                "this agent does not support session import".to_owned(),
            ));
        }
        assert_eq!(source_id, "native-secret-42");
        Ok(crate::adapter::ImportedHistory {
            title: Some("Imported work".into()),
            created_at_ms: 10,
            updated_at_ms: 20,
            items: vec![TimelineItem::UserMessage {
                id: "import-user".into(),
                text: "first prompt".into(),
                attachments: Vec::new(),
            }],
            persist: Some(PersistHandle {
                agent_id: "historian".into(),
                value: serde_json::json!({ "sessionId": source_id }),
            }),
            continuation: ImportContinuation::Native,
            warnings: Vec::new(),
        })
    }
}

fn completed_turn(checkpoint: Option<&str>) -> Vec<TimelineItem> {
    vec![
        TimelineItem::UserMessage {
            id: "user-1".into(),
            text: "Investigate the failing deploy".into(),
            attachments: Vec::new(),
        },
        TimelineItem::AssistantMessage {
            id: "assistant-1".into(),
            text: "The health check path is stale".into(),
            received_at_ms: None,
        },
        TimelineItem::TurnSummary {
            id: "summary-1".into(),
            stats: TurnStats {
                turn_id: "source-turn".into(),
                outcome: TurnOutcome::Completed,
                started_at_ms: 1,
                finished_at_ms: 2,
                duration_ms: 1,
                usage: Usage::default(),
                tool_calls: 3,
                agent_id: None,
                model_id: None,
                fork_checkpoint: checkpoint.map(str::to_string),
            },
        },
    ]
}

#[tokio::test]
async fn routing_metadata_change_keeps_the_same_agent_context() {
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sessions = SessionManager::new(
        test_store(workspace.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::fork(ForkSetup {
            id: "source",
            native_fork: false,
            prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
            starts: starts.clone(),
        }))])),
        16,
    );
    let created = sessions
        .create_routed(
            "w1",
            workspace.path().to_path_buf(),
            "source",
            Some("model".into()),
            None,
            None,
            None,
            Default::default(),
            None,
            vec!["Flash".into()],
            Vec::new(),
        )
        .await
        .unwrap();
    *sessions.live(&created.id).await.unwrap().items.lock().await = completed_turn(None);

    let updated = sessions
        .switch_agent_routed(
            &created.id,
            SessionAgentTarget {
                agent_id: "source".into(),
                model_id: Some("model".into()),
                mode_id: None,
                effort_id: None,
                fast: None,
                runtime_values: Default::default(),
            },
            &ProviderMap::new(),
            vec!["Pro".into()],
            vec![crate::agent_routing::TAG_IMAGE.into()],
        )
        .await
        .unwrap();

    assert_eq!(updated.routing_tags, vec!["Pro"]);
    assert_eq!(updated.media_tags, vec![crate::agent_routing::TAG_IMAGE]);
    assert!(sessions
        .store
        .load_seed("w1", &created.id)
        .unwrap()
        .is_none());
    assert!(starts.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cross_agent_migration_keeps_session_and_replays_history_once() {
    let workspace = tempfile::tempdir().unwrap();
    let source_prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let source_starts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let target_prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let target_starts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sessions = SessionManager::new(
        test_store(workspace.path()),
        Arc::new(Registry::of(vec![
            Arc::new(TestAdapter::fork(ForkSetup {
                id: "source",
                native_fork: false,
                prompts: source_prompts.clone(),
                starts: source_starts.clone(),
            })),
            Arc::new(TestAdapter::fork(ForkSetup {
                id: "target",
                native_fork: false,
                prompts: target_prompts.clone(),
                starts: target_starts.clone(),
            })),
        ])),
        16,
    );
    let created = sessions
        .create_routed(
            "w1",
            workspace.path().to_path_buf(),
            "source",
            Some("model".into()),
            None,
            None,
            None,
            Default::default(),
            None,
            vec!["Flash".into()],
            Vec::new(),
        )
        .await
        .unwrap();
    *sessions.live(&created.id).await.unwrap().items.lock().await = completed_turn(None);
    {
        let live = sessions.live(&created.id).await.unwrap();
        let mut meta = live.meta.lock().await;
        meta.inbox.has_delivered = true;
        sessions.store.save_meta(&meta).unwrap();
    }

    let migrated = sessions
        .switch_agent_routed(
            &created.id,
            SessionAgentTarget {
                agent_id: "target".into(),
                model_id: Some("model".into()),
                mode_id: None,
                effort_id: None,
                fast: None,
                runtime_values: Default::default(),
            },
            &ProviderMap::new(),
            vec!["Pro".into()],
            Vec::new(),
        )
        .await
        .unwrap();

    assert_eq!(migrated.id, created.id);
    assert_eq!(migrated.agent_id, "target");
    let staged = sessions
        .store
        .load_seed("w1", &created.id)
        .unwrap()
        .expect("migration stages reconstructed history");
    assert_eq!(staged.state, ContextSeedState::Pending);
    assert_eq!(staged.target_agent_id.as_deref(), Some("target"));
    assert_eq!(staged.target_model_id.as_deref(), Some("model"));
    assert!(matches!(
        sessions.worker_continuation(&created.id).await,
        WorkerContinuation::Ready
    ));

    sessions
        .send(
            &created.id,
            "Continue the investigation".into(),
            Vec::new(),
            &ProviderMap::new(),
            None,
        )
        .await
        .unwrap();

    assert!(source_starts.lock().unwrap().is_empty());
    assert!(source_prompts.lock().unwrap().is_empty());
    assert_eq!(target_starts.lock().unwrap().len(), 1);
    let target = target_prompts.lock().unwrap();
    assert_eq!(target.len(), 1);
    assert!(target[0].text.contains("Investigate the failing deploy"));
    assert!(target[0].text.contains("The health check path is stale"));
    assert!(target[0].text.contains("Continue the investigation"));
    drop(target);
    assert_eq!(
        sessions
            .store
            .load_seed("w1", &created.id)
            .unwrap()
            .expect("applied migration seed remains auditable")
            .state,
        ContextSeedState::Applied
    );
}

#[tokio::test]
async fn an_unreadable_resume_handle_continues_from_genehub_history_once() {
    let workspace = tempfile::tempdir().unwrap();
    let prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let starts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sessions = SessionManager::new(
        test_store(workspace.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::chat_id(
            ForkSetup {
                id: "cursor",
                native_fork: false,
                prompts: prompts.clone(),
                starts: starts.clone(),
            },
        ))])),
        16,
    );
    let created = sessions
        .create_routed(
            "w1",
            workspace.path().to_path_buf(),
            "cursor",
            Some("model".into()),
            None,
            None,
            None,
            Default::default(),
            None,
            Vec::new(),
            Vec::new(),
        )
        .await
        .unwrap();
    {
        let live = sessions.live(&created.id).await.unwrap();
        *live.items.lock().await = completed_turn(None);
        let mut meta = live.meta.lock().await;
        meta.persist = Some(PersistHandle {
            agent_id: "cursor".into(),
            value: serde_json::json!({ "sessionId": "acp-session-1" }),
        });
        meta.inbox.has_delivered = true;
        sessions.store.save_meta(&meta).unwrap();
    }

    sessions
        .send(
            &created.id,
            "Continue the investigation".into(),
            Vec::new(),
            &ProviderMap::new(),
            None,
        )
        .await
        .unwrap();

    assert_eq!(
        *starts.lock().unwrap(),
        vec![None],
        "the ACP handle is not passed on"
    );
    {
        let sent = prompts.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert!(sent[0].text.contains("Investigate the failing deploy"));
        assert!(sent[0].text.contains("The health check path is stale"));
        assert!(sent[0].text.contains("Continue the investigation"));
    }
    let live = sessions.live(&created.id).await.unwrap();
    assert!(live.meta.lock().await.persist.is_none());
    assert_eq!(
        sessions
            .store
            .load_seed("w1", &created.id)
            .unwrap()
            .expect("the handover seed stays auditable")
            .state,
        ContextSeedState::Applied
    );
}

#[tokio::test]
async fn same_agent_model_switch_replays_accepted_history_once() {
    let workspace = tempfile::tempdir().unwrap();
    let prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let starts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sessions = SessionManager::new(
        test_store(workspace.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::fork(ForkSetup {
            id: "source",
            native_fork: false,
            prompts: prompts.clone(),
            starts: starts.clone(),
        }))])),
        16,
    );
    let created = sessions
        .create_routed(
            "w1",
            workspace.path().to_path_buf(),
            "source",
            Some("model".into()),
            None,
            None,
            None,
            Default::default(),
            None,
            vec!["Flash".into()],
            Vec::new(),
        )
        .await
        .unwrap();
    let live = sessions.live(&created.id).await.unwrap();
    *live.items.lock().await = completed_turn(None);
    {
        let mut meta = live.meta.lock().await;
        meta.inbox.has_delivered = true;
        sessions.store.save_meta(&meta).unwrap();
    }

    let migrated = sessions
        .switch_agent_routed(
            &created.id,
            SessionAgentTarget {
                agent_id: "source".into(),
                model_id: Some("model-alt".into()),
                mode_id: None,
                effort_id: None,
                fast: None,
                runtime_values: Default::default(),
            },
            &ProviderMap::new(),
            vec!["Pro".into()],
            Vec::new(),
        )
        .await
        .unwrap();
    assert_eq!(migrated.model_id.as_deref(), Some("model-alt"));
    assert!(matches!(
        sessions.worker_continuation(&created.id).await,
        WorkerContinuation::Ready
    ));

    sessions
        .send(
            &created.id,
            "Continue on the new model".into(),
            Vec::new(),
            &ProviderMap::new(),
            None,
        )
        .await
        .unwrap();

    assert_eq!(starts.lock().unwrap().len(), 1);
    let prompts = prompts.lock().unwrap();
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].text.contains("Investigate the failing deploy"));
    assert!(prompts[0].text.contains("Continue on the new model"));
    assert_eq!(
        sessions
            .store
            .load_seed("w1", &created.id)
            .unwrap()
            .unwrap()
            .state,
        ContextSeedState::Applied
    );
}

#[tokio::test]
async fn delivered_worker_without_matching_pending_migration_stays_blocked() {
    let workspace = tempfile::tempdir().unwrap();
    let sessions = manager(workspace.path());
    let mut record = meta();
    record.cwd = workspace.path().to_path_buf();
    record.inbox.has_delivered = true;
    sessions.store.save_meta(&record).unwrap();

    assert!(matches!(
        sessions.worker_continuation("s1").await,
        WorkerContinuation::Unavailable { .. }
    ));
    let mut seed = ContextSeed {
        state: ContextSeedState::Pending,
        text: "portable history".into(),
        target_agent_id: Some("genet".into()),
        target_model_id: None,
    };
    sessions.store.save_seed("w1", "s1", &seed).unwrap();
    assert!(matches!(
        sessions.worker_continuation("s1").await,
        WorkerContinuation::Ready
    ));

    seed.target_model_id = Some("wrong-model".into());
    sessions.store.save_seed("w1", "s1", &seed).unwrap();
    assert!(matches!(
        sessions.worker_continuation("s1").await,
        WorkerContinuation::Unavailable { .. }
    ));
    seed.target_model_id = None;
    seed.state = ContextSeedState::Applying;
    sessions.store.save_seed("w1", "s1", &seed).unwrap();
    assert!(matches!(
        sessions.worker_continuation("s1").await,
        WorkerContinuation::Unavailable { .. }
    ));
}

#[tokio::test]
async fn a_fork_carries_thumbnails_and_blob_refs_but_never_payloads() {
    let source_dir = tempfile::tempdir().unwrap();
    let source = SessionManager::new(
        test_store(source_dir.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::fork(ForkSetup {
            id: "source",
            native_fork: true,
            prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
            starts: Arc::new(std::sync::Mutex::new(Vec::new())),
        }))])),
        16,
    );
    let summary = source
        .create(
            "w1",
            source_dir.path().to_path_buf(),
            "source",
            None,
            None,
            None,
            None,
            Default::default(),
            None,
        )
        .await
        .unwrap();
    let live = source.live(&summary.id).await.unwrap();
    let mut items = completed_turn(None);
    items.insert(
        1,
        TimelineItem::ToolCall {
            id: "tool-1".into(),
            name: "Read".into(),
            status: ToolStatus::Ok,
            detail: ToolCallDetail::Overview {
                tool_kind: genehub_proto::ToolKind::Read,
                overview: "assets/logo.png".into(),
                input: "assets/logo.png".into(),
                output: String::new(),
            },
            images: vec![genehub_proto::ToolImage {
                alt: "Read: assets/logo.png".into(),
                mime: "image/png".into(),
                data_base64: None,
                thumb: Some(genehub_proto::ImageThumb {
                    mime: "image/jpeg".into(),
                    data_base64: "dGh1bWI=".into(),
                    width: 64,
                    height: 32,
                }),
                path: Some("assets/logo.png".into()),
            }],
            started_at_ms: None,
            finished_at_ms: None,
        },
    );
    *live.items.lock().await = items;
    let blob_ref = BlobRef {
        id: "ab".repeat(32),
        bytes: 48,
        at: "ab:0:48".into(),
    };
    live.blob_refs
        .lock()
        .await
        .insert("tool-1".to_string(), blob_ref.clone());

    let transfer = source
        .fork_export(&summary.id, "source-turn")
        .await
        .unwrap();
    let tool_row = transfer
        .blob_appendix
        .iter()
        .find(|row| row.item_id == "tool-1")
        .expect("the tool call has an appendix row");
    assert_eq!(tool_row.blob.as_ref(), Some(&blob_ref));
    let image_row = transfer
        .blob_appendix
        .iter()
        .find(|row| row.item_id == "tool-1:img:0")
        .expect("the image has an appendix row");
    assert_eq!(image_row.kind, genehub_proto::BlobKind::Image);
    assert_eq!(image_row.path.as_deref(), Some("assets/logo.png"));
    assert_eq!(
        image_row
            .thumb
            .as_ref()
            .map(|thumb| thumb.data_base64.as_str()),
        Some("dGh1bWI=")
    );
    // No payload crosses: nothing in the appendix or the items carries bytes.
    let encoded = serde_json::to_vec(&transfer).unwrap();
    assert!(!encoded
        .windows(9)
        .any(|window| window == b"aW1hZ2U".as_slice()));

    let target_dir = tempfile::tempdir().unwrap();
    let target_homes = crate::session::WorkspaceHomes::default();
    target_homes.attach("target-workspace", target_dir.path());
    let target = SessionManager::new(
        Store::new(target_homes),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::fork(ForkSetup {
            id: "target",
            native_fork: true,
            prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
            starts: Arc::new(std::sync::Mutex::new(Vec::new())),
        }))])),
        16,
    );
    let forked = target
        .fork_import(
            "target-workspace",
            target_dir.path().to_path_buf(),
            transfer,
            ForkTarget {
                agent_id: "target".into(),
                workspace_id: Some("target-workspace".into()),
                model_id: None,
                mode_id: None,
                effort_id: None,
                fast: None,
                runtime_values: Default::default(),
            },
            &ProviderMap::new(),
            false,
        )
        .await
        .unwrap();
    let persisted = target
        .store
        .load_fork_appendix("target-workspace", &forked.id)
        .unwrap();
    // One row for the tool call, one for its image.
    assert_eq!(persisted.len(), 2);
    assert!(persisted.iter().any(|row| row.item_id == "tool-1:img:0"));
}

#[tokio::test]
async fn cross_agent_fork_uses_a_bounded_seed_without_reusing_the_source_handle() {
    let dir = tempfile::tempdir().unwrap();
    let source_prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let source_starts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let target_prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let target_starts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sessions = SessionManager::new(
        test_store(dir.path()),
        Arc::new(Registry::of(vec![
            Arc::new(TestAdapter::fork(ForkSetup {
                id: "source",
                native_fork: true,
                prompts: source_prompts.clone(),
                starts: source_starts.clone(),
            })),
            Arc::new(TestAdapter::fork(ForkSetup {
                id: "target",
                native_fork: false,
                prompts: target_prompts.clone(),
                starts: target_starts.clone(),
            })),
        ])),
        16,
    );
    let source = sessions
        .create(
            "w1",
            dir.path().to_path_buf(),
            "source",
            None,
            None,
            None,
            None,
            Default::default(),
            Some("Deploy".into()),
        )
        .await
        .unwrap();
    let source_live = sessions.live(&source.id).await.unwrap();
    let inherited = completed_turn(Some("native-checkpoint"));
    *source_live.items.lock().await = inherited.clone();
    sessions
        .store
        .append_chat_items("w1", &source.id, &inherited)
        .unwrap();

    let inspection = sessions.inspect(&source.id, None).await.unwrap();
    assert_eq!(inspection.narrative_item_count, 3);
    assert_eq!(inspection.coverage.omitted_item_count, 0);
    assert!(inspection.layers.iter().any(|layer| layer == "blobs"));
    let exact = sessions
        .narrative_page(&source.id, None, Some("assistant-1"), None, Some(1))
        .await
        .unwrap();
    assert_eq!(exact.items.len(), 1);
    let context = sessions
        .session_context(&source.id, None, Some(2_048), false)
        .await
        .unwrap();
    assert!(context.text.contains("ghref:item"));
    assert!(context
        .retrieval_commands
        .iter()
        .any(|command| command.contains("session narrative")));
    assert!(!context.references.is_empty());

    let fork = sessions
        .fork(
            &source.id,
            "source-turn",
            Some(ForkTarget {
                agent_id: "target".into(),
                workspace_id: None,
                model_id: None,
                mode_id: None,
                effort_id: None,
                fast: None,
                runtime_values: Default::default(),
            }),
            &ProviderMap::new(),
        )
        .await
        .unwrap();
    assert_eq!(fork.agent_id, "target");
    let lineage = fork.lineage.as_ref().unwrap();
    assert_eq!(lineage.method, ForkMethod::ReconstructedContext);
    assert!(lineage.context.as_ref().unwrap().token_budget <= 3_500);
    let meta = sessions.store.load_meta("w1", &fork.id).unwrap();
    assert!(
        meta.persist.is_none(),
        "a cross-Agent handle must never leak"
    );
    assert_eq!(
        sessions
            .store
            .load_seed("w1", &fork.id)
            .unwrap()
            .unwrap()
            .state,
        ContextSeedState::Pending
    );

    sessions
        .send(
            &fork.id,
            "Continue with the fix".into(),
            Vec::new(),
            &ProviderMap::new(),
            None,
        )
        .await
        .unwrap();
    {
        let prompts = target_prompts.lock().unwrap();
        assert_eq!(prompts.len(), 1);
        assert!(prompts[0].text.contains("Investigate the failing deploy"));
        assert!(prompts[0].text.contains("<current-user-message>"));
        assert!(prompts[0].text.contains("Continue with the fix"));
    }
    assert_eq!(target_starts.lock().unwrap().as_slice(), &[None]);
    assert!(source_starts.lock().unwrap().is_empty());
    assert!(source_prompts.lock().unwrap().is_empty());
    assert_eq!(
        sessions
            .store
            .load_seed("w1", &fork.id)
            .unwrap()
            .unwrap()
            .state,
        ContextSeedState::Applied
    );
    let stored = sessions.store.load_chat("w1", &fork.id).unwrap();
    assert!(stored.items.iter().any(|item| {
        matches!(item, TimelineItem::UserMessage { text, .. } if text == "Continue with the fix")
    }));
    assert!(!stored.items.iter().any(|item| {
            matches!(item, TimelineItem::UserMessage { text, .. } if text.contains("genehub-chat-history"))
        }));

    // The capsule is a one-time bootstrap. Later turns go to the target
    // Agent as ordinary user messages and cannot pay the history cost a
    // second time.
    // The first turn's execution holds the session until a terminal event
    // retires it — in production the pump does that on TurnCompleted, but
    // the harness fake never emits one, so the test settles the turn
    // itself before sending again.
    let fork_live = sessions.live(&fork.id).await.unwrap();
    let mut owner = fork_live.execution.lock().await;
    fork_live
        .finish_execution(
            &mut owner,
            SessionEvent::TurnCompleted {
                turn_id: "turn-1".into(),
                usage: Usage::default(),
                fork_checkpoint: None,
            },
            false,
        )
        .await
        .unwrap();
    drop(owner);
    sessions
        .send(
            &fork.id,
            "Run the focused test".into(),
            Vec::new(),
            &ProviderMap::new(),
            None,
        )
        .await
        .unwrap();
    let prompts = target_prompts.lock().unwrap();
    assert_eq!(prompts.len(), 2);
    assert_eq!(prompts[1].text, "Run the focused test");
}

#[tokio::test]
async fn portable_fork_moves_visible_history_to_a_validated_workspace_without_a_checkpoint() {
    let source_dir = tempfile::tempdir().unwrap();
    let source = SessionManager::new(
        test_store(source_dir.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::fork(ForkSetup {
            id: "source",
            native_fork: true,
            prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
            starts: Arc::new(std::sync::Mutex::new(Vec::new())),
        }))])),
        16,
    );
    let summary = source
        .create(
            "w1",
            source_dir.path().to_path_buf(),
            "source",
            None,
            None,
            None,
            None,
            Default::default(),
            Some("Portable".into()),
        )
        .await
        .unwrap();
    let live = source.live(&summary.id).await.unwrap();
    let mut source_items = completed_turn(Some("source-machine-secret"));
    if let TimelineItem::UserMessage { attachments, .. } = &mut source_items[0] {
        attachments.push(Attachment {
            name: "screen.png".into(),
            mime: "image/png".into(),
            path: Some("/source/private/screen.png".into()),
            data_base64: Some("aW1hZ2U=".into()),
        });
    }
    *live.items.lock().await = source_items;

    let transfer = source
        .fork_export(&summary.id, "source-turn")
        .await
        .unwrap();
    assert!(matches!(
        transfer.items.last(),
        Some(TimelineItem::TurnSummary { stats, .. }) if stats.fork_checkpoint.is_none()
    ));
    assert!(matches!(
        transfer.items.first(),
        Some(TimelineItem::UserMessage { attachments, .. })
            if attachments[0].path.is_none() && attachments[0].data_base64.is_some()
    ));

    let target_dir = tempfile::tempdir().unwrap();
    let target_homes = crate::session::WorkspaceHomes::default();
    target_homes.attach("target-workspace", target_dir.path());
    let target = SessionManager::new(
        Store::new(target_homes),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::fork(ForkSetup {
            id: "target",
            native_fork: true,
            prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
            starts: Arc::new(std::sync::Mutex::new(Vec::new())),
        }))])),
        16,
    );
    let mismatch = target
        .fork_import(
            "other-workspace",
            target_dir.path().to_path_buf(),
            transfer.clone(),
            ForkTarget {
                agent_id: "target".into(),
                workspace_id: Some("target-workspace".into()),
                model_id: None,
                mode_id: None,
                effort_id: None,
                fast: None,
                runtime_values: Default::default(),
            },
            &ProviderMap::new(),
            false,
        )
        .await
        .unwrap_err();
    assert!(mismatch.to_string().contains("validated workspace"));

    let forked = target
        .fork_import(
            "target-workspace",
            target_dir.path().to_path_buf(),
            transfer,
            ForkTarget {
                agent_id: "target".into(),
                workspace_id: Some("target-workspace".into()),
                model_id: None,
                mode_id: None,
                effort_id: None,
                fast: None,
                runtime_values: Default::default(),
            },
            &ProviderMap::new(),
            false,
        )
        .await
        .unwrap();
    assert_eq!(forked.workspace_id, "target-workspace");
    assert_eq!(forked.agent_id, "target");
    assert_eq!(
        forked.lineage.as_ref().unwrap().method,
        ForkMethod::ReconstructedContext
    );
    let meta = target
        .store
        .load_meta("target-workspace", &forked.id)
        .unwrap();
    assert!(meta.persist.is_none());
    let seed = target
        .store
        .load_seed("target-workspace", &forked.id)
        .unwrap()
        .unwrap();
    assert!(seed.text.contains("remains on another machine"));
    assert!(!seed.text.contains("genet session inspect"));
    assert!(target
        .store
        .load_chat("target-workspace", &forked.id)
        .unwrap()
        .items
        .iter()
        .all(|item| !matches!(
            item,
            TimelineItem::TurnSummary { stats, .. } if stats.fork_checkpoint.is_some()
        )));
}

#[tokio::test]
async fn same_agent_with_a_checkpoint_keeps_the_native_fork_path() {
    let dir = tempfile::tempdir().unwrap();
    let starts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sessions = SessionManager::new(
        test_store(dir.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::fork(ForkSetup {
            id: "source",
            native_fork: true,
            prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
            starts: starts.clone(),
        }))])),
        16,
    );
    let source = sessions
        .create(
            "w1",
            dir.path().to_path_buf(),
            "source",
            Some("model".into()),
            None,
            None,
            None,
            Default::default(),
            None,
        )
        .await
        .unwrap();
    let source_live = sessions.live(&source.id).await.unwrap();
    *source_live.items.lock().await = completed_turn(Some("native-checkpoint"));

    let fork = sessions
        .fork(
            &source.id,
            "source-turn",
            Some(ForkTarget {
                agent_id: "source".into(),
                workspace_id: None,
                model_id: None,
                mode_id: None,
                effort_id: None,
                fast: None,
                runtime_values: Default::default(),
            }),
            &ProviderMap::new(),
        )
        .await
        .unwrap();
    assert_eq!(fork.lineage.unwrap().method, ForkMethod::NativeCheckpoint);
    let meta = sessions.store.load_meta("w1", &fork.id).unwrap();
    assert_eq!(meta.persist.as_ref().unwrap().agent_id, "source");
    assert!(sessions.store.load_seed("w1", &fork.id).unwrap().is_none());
    assert_eq!(starts.lock().unwrap().as_slice(), &[None]);
}

#[tokio::test]
async fn a_cross_channel_fork_reconstructs_when_the_source_session_is_owned() {
    let dir = tempfile::tempdir().unwrap();
    let holder = SessionManager::new(
        test_store(dir.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::fork(ForkSetup {
            id: "source",
            native_fork: true,
            prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
            starts: Arc::new(std::sync::Mutex::new(Vec::new())),
        }))])),
        16,
    );
    let source = holder
        .create(
            "w1",
            dir.path().to_path_buf(),
            "source",
            Some("model".into()),
            None,
            None,
            None,
            Default::default(),
            None,
        )
        .await
        .unwrap();
    let inherited = completed_turn(Some("native-checkpoint"));
    holder
        .store
        .append_chat_items("w1", &source.id, &inherited)
        .unwrap();

    let starts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let other = SessionManager::new(
        test_store(dir.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::fork(ForkSetup {
            id: "source",
            native_fork: true,
            prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
            starts: starts.clone(),
        }))])),
        16,
    );
    other.list(None, false).await.unwrap();
    let fork = other
        .fork(&source.id, "source-turn", None, &ProviderMap::new())
        .await
        .unwrap();

    assert_eq!(
        fork.lineage.unwrap().method,
        ForkMethod::ReconstructedContext
    );
    assert!(other.store.load_seed("w1", &fork.id).unwrap().is_some());
    assert!(starts.lock().unwrap().is_empty());
    holder
        .store
        .save_meta(&holder.store.load_meta("w1", &source.id).unwrap())
        .unwrap();
}

#[tokio::test]
async fn explicit_same_agent_without_a_checkpoint_reconstructs_but_legacy_fork_refuses() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = SessionManager::new(
        test_store(dir.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::fork(ForkSetup {
            id: "source",
            native_fork: true,
            prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
            starts: Arc::new(std::sync::Mutex::new(Vec::new())),
        }))])),
        16,
    );
    let source = sessions
        .create(
            "w1",
            dir.path().to_path_buf(),
            "source",
            Some("model".into()),
            None,
            None,
            None,
            Default::default(),
            None,
        )
        .await
        .unwrap();
    let source_live = sessions.live(&source.id).await.unwrap();
    *source_live.items.lock().await = completed_turn(None);

    let fork = sessions
        .fork(
            &source.id,
            "source-turn",
            Some(ForkTarget {
                agent_id: "source".into(),
                workspace_id: None,
                model_id: None,
                mode_id: None,
                effort_id: None,
                fast: None,
                runtime_values: Default::default(),
            }),
            &ProviderMap::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        fork.lineage.unwrap().method,
        ForkMethod::ReconstructedContext
    );
    assert!(sessions.store.load_seed("w1", &fork.id).unwrap().is_some());

    let error = sessions
        .fork(&source.id, "source-turn", None, &ProviderMap::new())
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("that turn has no Agent fork checkpoint"));
}

#[tokio::test]
async fn same_agent_without_native_fork_reconstructs_when_target_is_explicit() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = SessionManager::new(
        test_store(dir.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::fork(ForkSetup {
            id: "cursor",
            native_fork: false,
            prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
            starts: Arc::new(std::sync::Mutex::new(Vec::new())),
        }))])),
        16,
    );
    let source = sessions
        .create(
            "w1",
            dir.path().to_path_buf(),
            "cursor",
            Some("model".into()),
            None,
            None,
            None,
            Default::default(),
            None,
        )
        .await
        .unwrap();
    let source_live = sessions.live(&source.id).await.unwrap();
    *source_live.items.lock().await = completed_turn(None);

    let fork = sessions
        .fork(
            &source.id,
            "source-turn",
            Some(ForkTarget {
                agent_id: "cursor".into(),
                workspace_id: Some("w1".into()),
                model_id: None,
                mode_id: None,
                effort_id: None,
                fast: None,
                runtime_values: Default::default(),
            }),
            &ProviderMap::new(),
        )
        .await
        .unwrap();
    assert_eq!(fork.agent_id, "cursor");
    assert_eq!(
        fork.lineage.unwrap().method,
        ForkMethod::ReconstructedContext
    );
    assert!(sessions.store.load_seed("w1", &fork.id).unwrap().is_some());

    let error = sessions
        .fork(&source.id, "source-turn", None, &ProviderMap::new())
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("the cursor agent does not support forking"));
}

#[tokio::test]
async fn a_running_session_reconstructs_instead_of_native_fork() {
    let dir = tempfile::tempdir().unwrap();
    let starts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sessions = SessionManager::new(
        test_store(dir.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::fork(ForkSetup {
            id: "source",
            native_fork: true,
            prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
            starts: starts.clone(),
        }))])),
        16,
    );
    let source = sessions
        .create(
            "w1",
            dir.path().to_path_buf(),
            "source",
            Some("model".into()),
            None,
            None,
            None,
            Default::default(),
            None,
        )
        .await
        .unwrap();
    let source_live = sessions.live(&source.id).await.unwrap();
    *source_live.items.lock().await = completed_turn(Some("native-checkpoint"));
    *source_live.status.lock().await = SessionStatus::Running;

    let fork = sessions
        .fork(
            &source.id,
            "source-turn",
            Some(ForkTarget {
                agent_id: "source".into(),
                workspace_id: None,
                model_id: None,
                mode_id: None,
                effort_id: None,
                fast: None,
                runtime_values: Default::default(),
            }),
            &ProviderMap::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        fork.lineage.unwrap().method,
        ForkMethod::ReconstructedContext
    );
    assert!(sessions.store.load_seed("w1", &fork.id).unwrap().is_some());
    assert!(sessions
        .store
        .load_meta("w1", &fork.id)
        .unwrap()
        .persist
        .is_none());
    assert!(starts.lock().unwrap().is_empty());
    assert!(matches!(
        *source_live.status.lock().await,
        SessionStatus::Running
    ));
}

#[tokio::test]
async fn a_running_session_can_reconstruct_an_in_progress_turn() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = SessionManager::new(
        test_store(dir.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::fork(ForkSetup {
            id: "cursor",
            native_fork: false,
            prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
            starts: Arc::new(std::sync::Mutex::new(Vec::new())),
        }))])),
        16,
    );
    let source = sessions
        .create(
            "w1",
            dir.path().to_path_buf(),
            "cursor",
            Some("model".into()),
            None,
            None,
            None,
            Default::default(),
            None,
        )
        .await
        .unwrap();
    let source_live = sessions.live(&source.id).await.unwrap();
    *source_live.items.lock().await = vec![
        TimelineItem::UserMessage {
            id: "user-live".into(),
            text: "What can you help with?".into(),
            attachments: Vec::new(),
        },
        TimelineItem::AssistantMessage {
            id: "assistant-live".into(),
            text: "I can investigate errors".into(),
            received_at_ms: None,
        },
    ];
    *source_live.status.lock().await = SessionStatus::Waiting;

    let fork = sessions
        .fork(
            &source.id,
            "live-turn",
            Some(ForkTarget {
                agent_id: "cursor".into(),
                workspace_id: Some("w1".into()),
                model_id: None,
                mode_id: None,
                effort_id: None,
                fast: None,
                runtime_values: Default::default(),
            }),
            &ProviderMap::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        fork.lineage.unwrap().method,
        ForkMethod::ReconstructedContext
    );
    let items = sessions.store.load_chat("w1", &fork.id).unwrap().items;
    assert_eq!(items.len(), 2);
    assert!(matches!(
        items.last(),
        Some(TimelineItem::AssistantMessage { text, .. })
            if text == "I can investigate errors"
    ));

    let transfer = sessions.fork_export(&source.id, "live-turn").await.unwrap();
    assert_eq!(transfer.items.len(), 2);
}

#[tokio::test]
async fn import_discovery_is_opaque_two_stage_and_filters_durable_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = SessionManager::new(
        test_store(dir.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::Import)])),
        16,
    );

    let listing = sessions
        .list_imports("w1", dir.path().to_path_buf(), Some(20))
        .await
        .unwrap();
    let candidate = &listing.sources[0].candidates[0];
    assert!(candidate.candidate_id.starts_with("ic_"));
    assert!(
        !serde_json::to_string(&listing)
            .unwrap()
            .contains("native-secret-42"),
        "a provider handle crossed the RPC boundary"
    );

    let imported = sessions
        .import("w1", dir.path().to_path_buf(), &candidate.candidate_id)
        .await
        .unwrap();
    assert_eq!(imported.agent_id, "historian");
    assert_eq!(
        imported.imported.as_ref().unwrap().continuation,
        ImportContinuation::Native
    );
    let coverage = imported
        .imported
        .as_ref()
        .and_then(|origin| origin.coverage.as_ref())
        .expect("new imports report structured coverage");
    assert_eq!(coverage.source_item_count, Some(1));
    assert_eq!(coverage.retained_item_count, 1);
    assert_eq!(coverage.omitted_item_count, 0);
    assert_eq!(coverage.retrieval, RetrievalCapability::Genehub);
    assert_eq!(
        sessions.snapshot(&imported.id).await.unwrap().items.len(),
        1
    );

    let refreshed = sessions
        .list_imports("w1", dir.path().to_path_buf(), Some(20))
        .await
        .unwrap();
    assert!(refreshed.sources[0].candidates.is_empty());
    assert_eq!(refreshed.filtered_duplicates, 1);
}

#[test]
fn oversized_imports_keep_a_bounded_recent_window_that_can_fit_one_rpc() {
    let items = (0..(IMPORT_VISIBLE_ITEMS + 100))
        .map(|index| TimelineItem::AssistantMessage {
            id: format!("i-{index}"),
            text: "reply".into(),
            received_at_ms: None,
        })
        .collect();
    let (bounded, omitted, altered) = bound_imported_items(items);
    assert_eq!(omitted, 100);
    assert_eq!(altered, 0);
    assert!(matches!(
        bounded.first(),
        Some(TimelineItem::Compaction { .. })
    ));
    assert!(bounded.len() <= IMPORT_VISIBLE_ITEMS + 1);

    let huge = vec![TimelineItem::AssistantMessage {
        id: "huge".into(),
        text: "四".repeat(IMPORT_VISIBLE_BYTES),
        received_at_ms: None,
    }];
    let (bounded, omitted, altered) = bound_imported_items(huge);
    assert_eq!((omitted, altered), (0, 1));
    assert!(serde_json::to_vec(&bounded).unwrap().len() < IMPORT_VISIBLE_BYTES);

    let huge_tool = vec![TimelineItem::ToolCall {
        id: "huge-tool".into(),
        name: "external".into(),
        status: ToolStatus::Ok,
        detail: ToolCallDetail::Unknown {
            raw: serde_json::json!({ "payload": "x".repeat(IMPORT_VISIBLE_BYTES * 2) }),
        },
        images: vec![],
        started_at_ms: None,
        finished_at_ms: None,
    }];
    let (bounded, omitted, altered) = bound_imported_items(huge_tool);
    assert_eq!((omitted, altered), (0, 1));
    assert!(matches!(
        bounded.first(),
        Some(TimelineItem::Compaction { reason, .. })
            if reason.contains("单条历史记录过长")
    ));
    assert!(serde_json::to_vec(&bounded).unwrap().len() < IMPORT_VISIBLE_BYTES);
}

#[tokio::test]
async fn an_agent_that_cannot_resume_starts_over_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = SessionManager::new(
        test_store(dir.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::Amnesiac)])),
        16,
    );
    let stale = PersistHandle {
        agent_id: "amnesiac".into(),
        value: serde_json::json!({ "threadId": "gone" }),
    };
    sessions
        .store
        .save_meta(&SessionMeta {
            human_receipts: Vec::new(),
            inbox: Default::default(),
            execution_retired: false,
            execution_cleanup: None,
            activity: Default::default(),
            message_preview: None,
            latest_reply: None,
            drafts: vec![],
            agent_id: "amnesiac".into(),
            persist: Some(stale),
            ..meta()
        })
        .unwrap();

    let live = sessions.live("s1").await.unwrap();
    sessions
        .ensure_started(&live, &ProviderMap::new())
        .await
        .expect("a conversation whose thread is gone is stranded for good");

    let told = live.items.lock().await.iter().any(
        |item| matches!(item, TimelineItem::Error { message, .. } if message.contains("Amnesiac")),
    );
    assert!(
        told,
        "the agent answers with no memory of the conversation above and nothing says why"
    );
    assert_eq!(
        sessions.store.load_meta("w1", "s1").unwrap().persist,
        None,
        "a handle that just failed to resume names a thread that is gone"
    );
}

#[tokio::test]
async fn browser_preview_url_prefix_is_not_injected_but_path_guidance_is() {
    let dir = tempfile::tempdir().unwrap();
    let captured = Arc::new(std::sync::Mutex::new(None));
    let sessions = SessionManager::new(
        test_store(dir.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::Recorder(
            captured.clone(),
        ))])),
        16,
    );
    sessions
        .store
        .save_meta(&SessionMeta {
            human_receipts: Vec::new(),
            inbox: Default::default(),
            execution_retired: false,
            execution_cleanup: None,
            activity: Default::default(),
            message_preview: None,
            latest_reply: None,
            drafts: vec![],
            agent_id: "recorder".into(),
            ..meta()
        })
        .unwrap();
    let base = "https://app.example/relay-dev-2/assets/preview/v2/m_device/w1/r_project/";

    sessions
        .send("s1", "生成报告".into(), vec![], &ProviderMap::new(), None)
        .await
        .unwrap();

    let prompt = captured.lock().unwrap().clone();
    let prompt = prompt.expect("path-linking guidance should reach the adapter");
    assert!(
        !prompt.contains(base),
        "deployment-bound Preview prefixes must not become Agent system guidance"
    );
    assert!(
        prompt.contains("index.html") && prompt.contains("Never link a directory"),
        "Agents still need file-path linking rules, especially HTML entry files"
    );
    assert!(
        !prompt.contains("available_skills"),
        "unit tests without a skills dir must not invent a Skill catalog"
    );
    sessions.shutdown().await;
}

#[tokio::test]
async fn daemon_skills_are_injected_into_every_adapter_system_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let skills = tempfile::tempdir().unwrap();
    let captured = Arc::new(std::sync::Mutex::new(None));
    let sessions = SessionManager::new(
        test_store(dir.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::Recorder(
            captured.clone(),
        ))])),
        16,
    )
    .with_builtin_skills(skills.path(), Some(PathBuf::from("/opt/genehub/genet-dev")));
    sessions
        .store
        .save_meta(&SessionMeta {
            human_receipts: Vec::new(),
            inbox: Default::default(),
            execution_retired: false,
            execution_cleanup: None,
            activity: Default::default(),
            message_preview: None,
            latest_reply: None,
            drafts: vec![],
            agent_id: "recorder".into(),
            ..meta()
        })
        .unwrap();

    sessions
        .send(
            "s1",
            "查一下上一轮会话".into(),
            vec![],
            &ProviderMap::new(),
            None,
        )
        .await
        .unwrap();

    let prompt = captured.lock().unwrap().clone().expect("catalog");
    assert!(prompt.contains("index.html"));
    assert!(prompt.contains("genehub-session-history"));
    assert!(prompt.contains("genehub-html-preview"));
    assert!(prompt.contains("genehub-speech-runtime"));
    assert!(prompt.contains("/opt/genehub/genet-dev"));
    assert!(prompt.contains("<available_skills>"));
    assert!(prompt.contains("<location>"));
    sessions.shutdown().await;
}

/// A `Live` with its own throwaway store. The directory handle comes back
/// with it so the caller keeps it alive for the length of the test.
fn live_session(meta: SessionMeta) -> (Arc<Live>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let live = Arc::new(Live::new(meta, test_store(dir.path())));
    (live, dir)
}

#[tokio::test]
async fn a_renamed_session_keeps_the_name_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = manager(dir.path());
    sessions.store.save_meta(&meta()).unwrap();

    let summary = sessions.rename("s1", "  收尾发布  ").await.unwrap();

    assert_eq!(summary.title.as_deref(), Some("收尾发布"));
    assert_eq!(
        sessions
            .store
            .load_meta("w1", "s1")
            .unwrap()
            .title
            .as_deref(),
        Some("收尾发布"),
        "the new name only reached the copy in memory, so it is lost on restart"
    );
}

#[tokio::test]
async fn a_session_cannot_be_renamed_to_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = manager(dir.path());
    sessions.store.save_meta(&meta()).unwrap();

    assert!(
        sessions.rename("s1", "   ").await.is_err(),
        "a blank name is a row with nothing on it, and no way back to a real one"
    );
}

#[tokio::test]
async fn an_agent_title_replaces_the_first_prompt_title() {
    let (live, _dir) = live_session(SessionMeta {
        human_receipts: Vec::new(),
        inbox: Default::default(),
        execution_retired: false,
        execution_cleanup: None,
        activity: Default::default(),
        message_preview: None,
        latest_reply: None,
        drafts: vec![],
        title: Some("Fix the login redirect".into()),
        ..meta()
    });
    apply(
        &live,
        &SessionEvent::TitleChanged {
            title: "  修复登录跳转  ".into(),
        },
    )
    .await;
    assert_eq!(
        live.meta.lock().await.title.as_deref(),
        Some("修复登录跳转")
    );
    assert_eq!(
        live.store.load_meta("w1", "s1").unwrap().title.as_deref(),
        Some("修复登录跳转"),
        "the agent title only reached memory, so it is lost on restart"
    );
    assert!(
        !live.meta.lock().await.title_locked,
        "an extracted title must stay replaceable by a later extraction"
    );
}

#[tokio::test]
async fn a_catalog_heading_does_not_replace_the_first_prompt_title() {
    let (live, _dir) = live_session(SessionMeta {
        title: Some("genet-beta 更新到最新".into()),
        ..meta()
    });
    apply(
        &live,
        &SessionEvent::TitleChanged {
            title: "Skill Selection Guidance".into(),
        },
    )
    .await;
    assert_eq!(
        live.meta.lock().await.title.as_deref(),
        Some("genet-beta 更新到最新")
    );
}

#[tokio::test]
async fn list_rewrites_a_catalog_heading_to_the_first_user_line() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = manager(dir.path());
    let mut session = meta();
    session.title = Some("Skill Selection Guidance".into());
    sessions.store.save_meta(&session).unwrap();
    sessions
        .store
        .append_chat_items(
            "w1",
            "s1",
            &[TimelineItem::UserMessage {
                id: "u1".into(),
                text: "genet-beta 更新到最新".into(),
                attachments: vec![],
            }],
        )
        .unwrap();

    let listed = sessions.list(None, false).await.unwrap();
    assert_eq!(listed[0].title.as_deref(), Some("genet-beta 更新到最新"));
    assert_eq!(
        sessions
            .store
            .load_meta("w1", "s1")
            .unwrap()
            .title
            .as_deref(),
        Some("genet-beta 更新到最新")
    );
}

#[tokio::test]
async fn a_latin_agent_title_does_not_replace_a_cjk_prompt_title() {
    let (live, _dir) = live_session(SessionMeta {
        human_receipts: Vec::new(),
        inbox: Default::default(),
        execution_retired: false,
        execution_cleanup: None,
        activity: Default::default(),
        message_preview: None,
        latest_reply: None,
        drafts: vec![],
        title: Some("生成三张风景画，简笔风".into()),
        ..meta()
    });
    apply(
        &live,
        &SessionEvent::TitleChanged {
            title: "Sketchy Scenery Creator".into(),
        },
    )
    .await;
    assert_eq!(
        live.meta.lock().await.title.as_deref(),
        Some("生成三张风景画，简笔风")
    );
}

#[tokio::test]
async fn an_agent_title_does_not_replace_a_name_the_user_typed() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = manager(dir.path());
    sessions.store.save_meta(&meta()).unwrap();
    sessions.rename("s1", "我起的名字").await.unwrap();
    let live = sessions.live("s1").await.unwrap();

    apply(
        &live,
        &SessionEvent::TitleChanged {
            title: "Agent 想改的名字".into(),
        },
    )
    .await;

    assert_eq!(live.meta.lock().await.title.as_deref(), Some("我起的名字"));
    assert!(
        live.meta.lock().await.title_locked,
        "rename must lock the name so the next agent title cannot undo it"
    );
    assert_eq!(
        sessions
            .store
            .load_meta("w1", "s1")
            .unwrap()
            .title
            .as_deref(),
        Some("我起的名字")
    );
}

#[tokio::test]
async fn a_renamed_session_is_not_renamed_again_by_its_first_message() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = manager(dir.path());
    sessions.store.save_meta(&meta()).unwrap();
    sessions.rename("s1", "我起的名字").await.unwrap();

    // The condition `send` uses before naming a session from what was said.
    let named = sessions
        .live("s1")
        .await
        .unwrap()
        .meta
        .lock()
        .await
        .title
        .is_some();

    assert!(
        named,
        "the daemon would overwrite the user's title with the first message"
    );
}

#[tokio::test]
async fn deleting_a_session_takes_its_timeline_and_scratch_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = manager(dir.path());
    sessions.store.save_meta(&meta()).unwrap();
    sessions
        .store
        .append_chat_items("w1", "s1", &[item("a", "hi")])
        .unwrap();
    let scratch = sessions.store.scratch_dir("w1", "s1").unwrap();
    std::fs::create_dir_all(&scratch).unwrap();

    sessions.delete("s1").await.unwrap();

    assert!(sessions.store.list_meta().unwrap().is_empty());
    assert!(sessions.store.load_chat("w1", "s1").is_err());
    assert!(
        !scratch.exists(),
        "the agent's own copy of the conversation outlived the delete"
    );
    assert!(dir.path().join(".genethub/tombstones/s1.json").is_file());
}

#[tokio::test]
async fn deleting_a_session_twice_is_not_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = manager(dir.path());
    sessions.store.save_meta(&meta()).unwrap();

    sessions.delete("s1").await.unwrap();

    assert!(
        sessions.delete("s1").await.is_ok(),
        "two windows deleting the same row would show the second one an error"
    );
}

#[tokio::test]
async fn a_tombstone_blocks_reload_while_the_session_files_remain() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = manager(dir.path());
    sessions.store.save_meta(&meta()).unwrap();
    sessions.live("s1").await.unwrap();
    sessions.store.mark_deleted("w1", "s1").unwrap();
    sessions.sessions.write().await.remove("s1");
    assert!(dir.path().join(".genethub/sessions/s1/meta.json").is_file());
    assert!(sessions.live("s1").await.is_err());
}

#[tokio::test]
async fn a_tombstone_hides_residual_files_and_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = manager(dir.path());
    sessions.store.save_meta(&meta()).unwrap();
    let saved = std::fs::read(dir.path().join(".genethub/sessions/s1/meta.json")).unwrap();

    sessions.delete("s1").await.unwrap();
    let residual = dir.path().join(".genethub/sessions/s1");
    std::fs::create_dir_all(&residual).unwrap();
    std::fs::write(residual.join("meta.json"), saved).unwrap();

    let restarted = manager(dir.path());
    assert!(restarted.list(None, false).await.unwrap().is_empty());
    let refused = restarted.store.save_meta(&meta()).unwrap_err();
    assert!(
        refused
            .downcast_ref::<super::store::SessionDeleted>()
            .is_some(),
        "a physically residual deleted session could be resurrected: {refused}"
    );
    restarted.delete("s1").await.unwrap();
    assert!(!residual.exists(), "retry did not collect residual files");
}

#[tokio::test]
async fn an_item_is_upserted_rather_than_duplicated() {
    let (live, _store_dir) = live_session(meta());
    apply(
        &live,
        &SessionEvent::Item {
            turn_id: "t".into(),
            item: item("a", ""),
        },
    )
    .await;
    apply(
        &live,
        &SessionEvent::Item {
            turn_id: "t".into(),
            item: item("a", "final"),
        },
    )
    .await;

    let items = live.items.lock().await;
    assert_eq!(items.len(), 1);
    match &items[0] {
        TimelineItem::AssistantMessage {
            id,
            text,
            received_at_ms,
        } => {
            assert_eq!(id, "a");
            assert_eq!(text, "final");
            assert!(received_at_ms.is_some());
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn a_bare_tool_update_inherits_the_card_it_replaces() {
    // ACP shape: the initial event carries title/kind, the completion
    // update only carries status and rawOutput. The update must not blank
    // the card the initial event filled in.
    let (live, _store_dir) = live_session(meta());
    apply(
        &live,
        &SessionEvent::Item {
            turn_id: "t".into(),
            item: TimelineItem::ToolCall {
                id: "call-1".into(),
                name: "Read File".into(),
                status: ToolStatus::Running,
                detail: ToolCallDetail::Read {
                    path: "src/main.rs".into(),
                    content: String::new(),
                    truncated: false,
                },
                images: vec![],
                started_at_ms: None,
                finished_at_ms: None,
            },
        },
    )
    .await;
    apply(
        &live,
        &SessionEvent::Item {
            turn_id: "t".into(),
            item: TimelineItem::ToolCall {
                id: "call-1".into(),
                name: String::new(),
                status: ToolStatus::Ok,
                detail: ToolCallDetail::Overview {
                    tool_kind: genehub_proto::ToolKind::Other,
                    overview: String::new(),
                    input: String::new(),
                    output: "fn main() {}".into(),
                },
                images: vec![],
                started_at_ms: None,
                finished_at_ms: None,
            },
        },
    )
    .await;

    let items = live.items.lock().await;
    assert_eq!(items.len(), 1);
    match &items[0] {
        TimelineItem::ToolCall { name, detail, .. } => {
            assert_eq!(name, "Read File");
            assert_eq!(
                detail,
                &ToolCallDetail::Read {
                    path: "src/main.rs".into(),
                    content: "fn main() {}".into(),
                    truncated: false,
                }
            );
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn text_deltas_accumulate_onto_the_open_item() {
    let (live, _store_dir) = live_session(meta());
    apply(
        &live,
        &SessionEvent::Item {
            turn_id: "t".into(),
            item: item("a", ""),
        },
    )
    .await;
    for delta in ["he", "llo"] {
        apply(
            &live,
            &SessionEvent::ItemDelta {
                turn_id: "t".into(),
                item_id: "a".into(),
                delta: ItemDelta::Text {
                    delta: delta.into(),
                },
            },
        )
        .await;
    }
    let items = live.items.lock().await;
    match &items[0] {
        TimelineItem::AssistantMessage {
            id,
            text,
            received_at_ms,
        } => {
            assert_eq!(id, "a");
            assert_eq!(text, "hello");
            assert!(received_at_ms.is_some());
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn a_delta_for_an_unknown_item_is_dropped_not_invented() {
    let (live, _store_dir) = live_session(meta());
    apply(
        &live,
        &SessionEvent::ItemDelta {
            turn_id: "t".into(),
            item_id: "ghost".into(),
            delta: ItemDelta::Text { delta: "x".into() },
        },
    )
    .await;
    assert!(live.items.lock().await.is_empty());
}

#[tokio::test]
async fn tool_status_deltas_update_status_and_detail_in_place() {
    let (live, _store_dir) = live_session(meta());
    apply(
        &live,
        &SessionEvent::Item {
            turn_id: "t".into(),
            item: TimelineItem::ToolCall {
                id: "c".into(),
                name: "bash".into(),
                status: ToolStatus::Pending,
                detail: ToolCallDetail::Shell {
                    command: "ls".into(),
                    output: String::new(),
                    exit_code: None,
                },
                images: vec![],
                started_at_ms: None,
                finished_at_ms: None,
            },
        },
    )
    .await;
    apply(
        &live,
        &SessionEvent::ItemDelta {
            turn_id: "t".into(),
            item_id: "c".into(),
            delta: ItemDelta::ToolStatus {
                status: ToolStatus::Running,
                detail: None,
                images: vec![],
            },
        },
    )
    .await;
    let settled = live.items.lock().await[0].clone();
    match &settled {
        TimelineItem::ToolCall { status, detail, .. } => {
            assert_eq!(*status, ToolStatus::Running);
            assert!(matches!(detail, ToolCallDetail::Shell { command, .. } if command == "ls"));
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn sequence_numbers_are_dense_and_start_at_one() {
    let (live, _store_dir) = live_session(meta());
    for index in 1..=3 {
        let event = live
            .publish(SessionEvent::TurnStarted {
                turn_id: "t".into(),
                started_at_ms: 1,
            })
            .await;
        assert_eq!(event.seq, index);
    }
}

#[tokio::test]
async fn pending_permissions_appear_in_the_snapshot_and_clear_on_answer() {
    let (live, _store_dir) = live_session(meta());
    let request = PermissionRequest {
        summary: None,
        description: None,
        author: None,
        id: "p1".into(),
        kind: PermissionRequestKind::Permission,
        title: "Write file".into(),
        tool_call_id: None,
        options: vec![],
        questions: None,
    };
    apply(
        &live,
        &SessionEvent::PermissionRequested {
            request: request.clone(),
        },
    )
    .await;
    assert_eq!(live.snapshot().await.unwrap().pending_permissions.len(), 1);
    assert_eq!(*live.status.lock().await, SessionStatus::Waiting);

    apply(
        &live,
        &SessionEvent::PermissionResolved {
            request_id: "p1".into(),
            outcome: PermissionOutcome::Canceled,
        },
    )
    .await;
    assert!(live
        .snapshot()
        .await
        .unwrap()
        .pending_permissions
        .is_empty());
    assert_eq!(*live.status.lock().await, SessionStatus::Idle);
}

/// Regression: a Human wait must release the provider process, even if
/// the CLI's caller would otherwise stay attached indefinitely.
#[tokio::test]
async fn cli_requested_plan_approval_stops_before_presenting_the_card() {
    let workspace = tempfile::tempdir().unwrap();
    let sessions = Arc::new(manager(workspace.path()));
    sessions.store.save_meta(&meta()).unwrap();
    let live = sessions.live("s1").await.unwrap();
    let interrupted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    *live.agent.lock().await = Some(Arc::new(TestSession::stopping(
        interrupted.clone(),
        closed.clone(),
    )));
    live.begin_round(None, "t-original", "u-original").await;
    let request = interaction(PermissionRequestKind::PlanApproval);
    sessions
        .request_project_approval("s1", request.clone())
        .await
        .unwrap();
    assert!(interrupted.load(Ordering::SeqCst));
    assert!(closed.load(Ordering::SeqCst));
    assert!(live.agent().await.is_none());
    assert_eq!(
        sessions.summary("s1").await.unwrap().status,
        SessionStatus::Waiting
    );
    assert_eq!(
        sessions
            .store
            .load_meta("w1", "s1")
            .unwrap()
            .human_wait
            .as_ref()
            .and_then(|wait| wait.request.as_ref())
            .unwrap()
            .id,
        request.id
    );
    assert!(live
        .active_round
        .lock()
        .await
        .as_ref()
        .unwrap()
        .outcome
        .is_none());
}

#[tokio::test]
async fn workflow_question_is_durable_and_missing_authority_blocks_delivery() {
    let workspace = tempfile::tempdir().unwrap();
    let sessions = manager(workspace.path());
    sessions.store.save_meta(&meta()).unwrap();
    let mut request = interaction(PermissionRequestKind::Question);
    request.id = "workflow-human-s1".into();
    sessions
        .request_workflow_question("s1", request.clone())
        .await
        .unwrap();
    sessions
        .request_workflow_question("s1", request.clone())
        .await
        .unwrap();
    let live = sessions.live("s1").await.unwrap();
    assert_eq!(live.snapshot().await.unwrap().pending_permissions.len(), 1);
    assert_eq!(
        sessions
            .store
            .load_meta("w1", "s1")
            .unwrap()
            .human_wait
            .as_ref()
            .and_then(|wait| wait.request.as_ref())
            .unwrap()
            .id,
        request.id
    );
    let outcome = PermissionOutcome::Selected {
        option_id: "yes".into(),
    };
    let error = sessions
        .respond_permission("s1", &request.id, outcome.clone(), &ProviderMap::new())
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("Workflow approval authority unavailable"));
    assert!(sessions
        .human_wait_of("s1")
        .await
        .unwrap()
        .and_then(|wait| wait.decision)
        .is_some_and(|decision| decision.outcome == outcome));
    sessions
        .request_workflow_question("s1", request)
        .await
        .unwrap();
    assert!(live
        .snapshot()
        .await
        .unwrap()
        .pending_permissions
        .is_empty());
}

/// Regression for the detached CLI: delivery is driven by the persisted
/// decision, independent of whether the previous adapter turn had ended.
#[tokio::test]
async fn a_plan_approval_queues_one_continuation_without_a_waiter() {
    let workspace = tempfile::tempdir().unwrap();
    let sessions = manager(workspace.path());
    sessions.store.save_meta(&meta()).unwrap();
    let live = sessions.live("s1").await.unwrap();
    live.begin_round(None, "t-original", "u-original").await;
    let request = interaction(PermissionRequestKind::PlanApproval);
    stop_agent_for_interaction(&live, &sessions.store, &request, false)
        .await
        .unwrap();
    let prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
    *live.agent.lock().await = Some(Arc::new(TestSession::recording(prompts.clone())));
    let outcome = PermissionOutcome::Selected {
        option_id: "yes".into(),
    };
    sessions
        .respond_permission("s1", &request.id, outcome.clone(), &ProviderMap::new())
        .await
        .unwrap();
    assert!(
        prompts.lock().unwrap().is_empty(),
        "Human acknowledgement is independent of provider execution"
    );
    assert!(sessions
        .store
        .load_meta("w1", "s1")
        .unwrap()
        .human_wait
        .as_ref()
        .and_then(|wait| wait.decision.as_ref())
        .is_some());
    sessions
        .respond_permission("s1", &request.id, outcome, &ProviderMap::new())
        .await
        .unwrap();
    deliver_decision(&sessions, &live, &ProviderMap::new())
        .await
        .unwrap();
    deliver_decision(&sessions, &live, &ProviderMap::new())
        .await
        .unwrap();
    assert_eq!(prompts.lock().unwrap().len(), 1);
    let round = live.active_round.lock().await.clone().unwrap();
    assert_eq!(round.adapter_turn_ids, vec!["t-original", "t-resumed"]);
    assert!(round.outcome.is_none());
}

#[tokio::test]
async fn a_new_interaction_replaces_a_stale_one() {
    let (live, _store_dir) = live_session(meta());
    for id in ["p1", "p2"] {
        apply(
            &live,
            &SessionEvent::PermissionRequested {
                request: PermissionRequest {
                    summary: None,
                    description: None,
                    author: None,
                    id: id.into(),
                    kind: PermissionRequestKind::Permission,
                    title: "Approval".into(),
                    tool_call_id: None,
                    options: vec![],
                    questions: None,
                },
            },
        )
        .await;
    }

    apply(
        &live,
        &SessionEvent::PermissionResolved {
            request_id: "p1".into(),
            outcome: PermissionOutcome::Canceled,
        },
    )
    .await;

    let snapshot = live.snapshot().await.unwrap();
    assert_eq!(snapshot.pending_permissions.len(), 1);
    assert_eq!(snapshot.pending_permissions[0].id, "p2");
    assert_eq!(*live.status.lock().await, SessionStatus::Waiting);
}

fn interaction(kind: PermissionRequestKind) -> PermissionRequest {
    PermissionRequest {
        summary: None,
        description: None,
        author: None,
        id: "p1".into(),
        kind,
        title: "Continue?".into(),
        tool_call_id: None,
        options: vec![
            genehub_proto::PermissionOption {
                id: "yes".into(),
                label: "Yes".into(),
                kind: PermissionOptionKind::AllowOnce,
            },
            genehub_proto::PermissionOption {
                id: "no".into(),
                label: "No".into(),
                kind: PermissionOptionKind::Reject,
            },
        ],
        questions: None,
    }
}

#[tokio::test]
async fn an_interaction_is_persisted_before_the_agent_process_is_closed() {
    let dir = tempfile::tempdir().unwrap();
    let store = test_store(dir.path());
    let (live, _store_dir) = live_session(meta());
    let interrupted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    *live.agent.lock().await = Some(Arc::new(TestSession::stopping(
        interrupted.clone(),
        closed.clone(),
    )));
    let request = interaction(PermissionRequestKind::Permission);

    stop_agent_for_interaction(&live, &store, &request, false)
        .await
        .unwrap();

    assert!(live.agent.lock().await.is_none());
    assert!(interrupted.load(std::sync::atomic::Ordering::SeqCst));
    assert!(closed.load(std::sync::atomic::Ordering::SeqCst));
    let restored = store.load_meta("w1", "s1").unwrap();
    assert_eq!(
        restored
            .human_wait
            .as_ref()
            .and_then(|wait| wait.request.as_ref())
            .unwrap()
            .id,
        "p1"
    );
    assert!(restored.human_wait.as_ref().unwrap().decision.is_none());
    assert_eq!(
        restored.persist.unwrap().value["sessionId"],
        serde_json::json!("native-1")
    );
}

#[test]
fn permission_grants_resume_elevated_but_rejections_do_not_resume() {
    let request = interaction(PermissionRequestKind::Permission);
    let grant = continuation_for(
        &request,
        &PermissionOutcome::Selected {
            option_id: "yes".into(),
        },
    )
    .unwrap()
    .expect("an allow option resumes");
    assert!(grant.elevated);
    assert!(grant.prompt.contains("Yes"));
    assert!(continuation_for(
        &request,
        &PermissionOutcome::Selected {
            option_id: "no".into(),
        },
    )
    .unwrap()
    .is_none());
}

#[test]
fn answers_resume_without_changing_the_permission_mode() {
    let request = interaction(PermissionRequestKind::Question);
    let continuation = continuation_for(
        &request,
        &PermissionOutcome::Selected {
            option_id: "no".into(),
        },
    )
    .unwrap()
    .expect("a question answer resumes");
    assert!(!continuation.elevated);
    assert!(continuation.prompt.contains("No"));
}

#[test]
fn structured_answers_all_survive_the_stop_and_resume_boundary() {
    let mut request = interaction(PermissionRequestKind::Question);
    request.questions = Some(vec![
        genehub_proto::InteractionQuestion {
            id: "environment".into(),
            prompt: "Where should this ship?".into(),
            allow_multiple: false,
            allow_freeform: false,
            options: vec![genehub_proto::InteractionOption {
                id: "beta".into(),
                label: "Beta".into(),
            }],
        },
        genehub_proto::InteractionQuestion {
            id: "note".into(),
            prompt: "Anything else?".into(),
            allow_multiple: false,
            allow_freeform: true,
            options: vec![],
        },
    ]);
    let continuation = continuation_for(
        &request,
        &PermissionOutcome::Answered {
            answers: vec![
                genehub_proto::InteractionAnswer {
                    question_id: "environment".into(),
                    selected_option_ids: vec!["beta".into()],
                    freeform_text: None,
                },
                genehub_proto::InteractionAnswer {
                    question_id: "note".into(),
                    selected_option_ids: vec![],
                    freeform_text: Some("Keep the rollback switch".into()),
                },
            ],
        },
    )
    .unwrap()
    .expect("complete answers resume");
    assert!(!continuation.elevated);
    assert!(continuation
        .prompt
        .contains("Where should this ship?: Beta"));
    assert!(continuation.prompt.contains("Keep the rollback switch"));
}

#[test]
fn structured_answers_are_validated_at_the_daemon_boundary() {
    let mut request = interaction(PermissionRequestKind::Question);
    request.questions = Some(vec![genehub_proto::InteractionQuestion {
        id: "environment".into(),
        prompt: "Where should this ship?".into(),
        allow_multiple: false,
        allow_freeform: false,
        options: vec![
            genehub_proto::InteractionOption {
                id: "beta".into(),
                label: "Beta".into(),
            },
            genehub_proto::InteractionOption {
                id: "official".into(),
                label: "Official".into(),
            },
        ],
    }]);
    let outcome = |selected_option_ids, freeform_text| PermissionOutcome::Answered {
        answers: vec![genehub_proto::InteractionAnswer {
            question_id: "environment".into(),
            selected_option_ids,
            freeform_text,
        }],
    };

    assert!(continuation_for(
        &request,
        &outcome(vec!["beta".into(), "official".into()], None),
    )
    .err()
    .expect("multiple choices must be rejected")
    .to_string()
    .contains("only one option"));
    assert!(
        continuation_for(&request, &outcome(vec![], Some("somewhere else".into())),)
            .err()
            .expect("free-form input must be rejected")
            .to_string()
            .contains("does not accept a free-form answer")
    );
}

#[test]
fn a_plan_rejection_resumes_only_to_confirm_zero_mutation() {
    let request = interaction(PermissionRequestKind::PlanApproval);
    let rejected = continuation_for(
        &request,
        &PermissionOutcome::Selected {
            option_id: "no".into(),
        },
    )
    .unwrap()
    .expect("a plan rejection resumes for a zero-change acknowledgement");
    assert!(!rejected.elevated);
    assert!(rejected.prompt.contains("Do not apply"));
    let approved = continuation_for(
        &request,
        &PermissionOutcome::Selected {
            option_id: "yes".into(),
        },
    )
    .unwrap()
    .expect("approval resumes");
    assert!(!approved.elevated);
    assert!(approved.prompt.contains("Continue?"));
}

#[tokio::test]
async fn mode_changes_cannot_bypass_a_waiting_interaction() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, _, _) = wired(dir.path()).await;
    let live = sessions.live("s1").await.unwrap();
    {
        let mut meta = live.meta.lock().await;
        crate::session::store::install_human_wait(
            &mut meta,
            interaction(PermissionRequestKind::Question),
            false,
        );
    }

    let error = sessions
        .set_mode("s1", "agent", &ProviderMap::new())
        .await
        .expect_err("the question must be resolved first");
    assert!(error.to_string().contains("pending Agent interaction"));
}

#[tokio::test]
async fn a_persisted_interaction_rehydrates_as_waiting_without_an_agent() {
    let mut stored = meta();
    crate::session::store::install_human_wait(
        &mut stored,
        interaction(PermissionRequestKind::Permission),
        false,
    );
    let (live, _store_dir) = live_session(stored);
    let live = &*live;
    let snapshot = live.snapshot().await.unwrap();
    assert_eq!(snapshot.summary.status, SessionStatus::Waiting);
    assert_eq!(snapshot.pending_permissions.len(), 1);
    assert!(live.agent.lock().await.is_none());
}

#[tokio::test]
async fn a_failed_turn_stays_visible_as_failed_but_remains_retryable() {
    let (live, _store_dir) = live_session(meta());
    apply(
        &live,
        &SessionEvent::TurnFailed {
            turn_id: "t".into(),
            error: TurnError {
                code: TurnErrorCode::RateLimited,
                message: "slow down".into(),
            },
        },
    )
    .await;
    assert_eq!(*live.status.lock().await, SessionStatus::Failed);
}

#[tokio::test]
async fn only_settled_non_prompt_items_are_written_at_the_end_of_a_turn() {
    let dir = tempfile::tempdir().unwrap();
    let store = test_store(dir.path());
    let (live, _store_dir) = live_session(meta());

    for event in [
        SessionEvent::Item {
            turn_id: "t".into(),
            item: TimelineItem::UserMessage {
                id: "u".into(),
                text: "hi".into(),
                attachments: vec![],
            },
        },
        SessionEvent::Item {
            turn_id: "t".into(),
            item: item("a", "answer"),
        },
    ] {
        apply(&live, &event).await;
    }
    flush_turn(&live, &store).await.unwrap();

    let written = store.load_chat("w1", "s1").unwrap().items;
    assert_eq!(written.len(), 1, "the prompt was persisted on arrival");
    assert_eq!(written[0].id(), "a");
}

#[tokio::test]
async fn the_replay_buffer_is_bounded() {
    let (live, _store_dir) = live_session(meta());
    for _ in 0..10 {
        live.publish(SessionEvent::TurnStarted {
            turn_id: "t".into(),
            started_at_ms: 1,
        })
        .await;
        live.trim_replay(4).await;
    }
    let replay = live.replay.lock().await;
    let (length, newest, oldest) = (
        replay.len(),
        replay.back().unwrap().seq,
        replay.front().unwrap().seq,
    );
    assert_eq!(length, 4);
    assert_eq!(newest, 10, "the newest is kept");
    assert_eq!(oldest, 7, "the oldest is dropped");
}

#[tokio::test]
async fn usage_rides_along_on_turn_completion() {
    let (live, _store_dir) = live_session(meta());
    let event = live
        .publish(SessionEvent::TurnCompleted {
            turn_id: "t".into(),
            usage: Usage {
                input_tokens: 10,
                ..Usage::default()
            },
            fork_checkpoint: None,
        })
        .await;
    match event.event {
        SessionEvent::TurnCompleted { usage, .. } => assert_eq!(usage.input_tokens, 10),
        other => panic!("unexpected {other:?}"),
    }
}

/// Runs the pump against a scripted agent and collects everything the
/// clients would see until the turn ends, plus what landed on disk.
async fn pumped(
    script: Vec<SessionEvent>,
) -> (
    Vec<SessionEvent>,
    Vec<TimelineItem>,
    tokio::task::JoinHandle<()>,
    crate::adapter::EventTx,
    Store,
    tempfile::TempDir,
) {
    let dir = tempfile::tempdir().unwrap();
    let store = test_store(dir.path());
    let live = Arc::new(Live::new(meta(), store.clone()));
    // Work only reaches disk through a round's trunk files, and in
    // production `session.send` always opens one before the agent runs.
    live.begin_round(None, "t", "u0").await;
    let mut execution = live.claim_execution(None).await.unwrap().unwrap();
    execution.turn_id = Some("t".into());
    execution.phase = ExecutionPhase::Running;
    execution.ready.send_replace(true);
    *live.execution.lock().await = Some(execution);
    let (agent_events, agent_rx) = crate::adapter::EventTx::channel();
    let mut seen = live.events.subscribe();
    let pump = tokio::spawn(pump_events(
        live.clone(),
        agent_rx,
        store.clone(),
        64,
        crate::processes::Processes::new(),
        Arc::new(Diagnostics::new()),
        Some(crate::project_control::Broker::new(dir.path()).unwrap()),
    ));
    for event in script {
        agent_events.send(event).expect("the pump is listening");
    }
    let mut wire = Vec::new();
    loop {
        let event = seen.recv().await.expect("the pump is running").event;
        let ended = matches!(event, SessionEvent::TurnCompleted { .. });
        wire.push(event);
        if ended {
            break;
        }
    }
    // The flush rides on the settle event, which was just observed — but
    // only observed on its way out, so give the pump its turn.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let on_disk = store.load_chat("w1", "s1").unwrap().items;
    (wire, on_disk, pump, agent_events, store, dir)
}

/// Every work row of a round, in order, as stored. The round layer is the
/// only way to work back to a tool call or a thinking block now: the
/// narrative log does not carry them.
fn stored_blobs(store: &Store, ord: u32) -> Vec<genehub_proto::BlobOverview> {
    store
        .load_trunk_index("w1", "s1", ord)
        .unwrap()
        .iter()
        .flat_map(|summary| store.load_trunk("w1", "s1", ord, summary).unwrap().batches)
        .flat_map(|batch| batch.blobs)
        .collect()
}

/// A thinking block streams one delta per token; what reaches the wire is
/// its first sentence, republished only while that sentence is still
/// growing. Forty tokens must not be forty messages.
#[tokio::test]
async fn thinking_reaches_the_wire_as_one_sentence_not_one_message_per_token() {
    let mut script = vec![
        SessionEvent::TurnStarted {
            turn_id: "t".into(),
            started_at_ms: 1,
        },
        SessionEvent::Item {
            turn_id: "t".into(),
            item: TimelineItem::Reasoning {
                id: "r".into(),
                text: String::new(),
                received_at_ms: None,
            },
        },
    ];
    for _ in 0..40 {
        script.push(SessionEvent::ItemDelta {
            turn_id: "t".into(),
            item_id: "r".into(),
            delta: ItemDelta::Text {
                delta: "abc ".into(),
            },
        });
    }
    script.push(SessionEvent::TurnCompleted {
        turn_id: "t".into(),
        usage: Usage::default(),
        fork_checkpoint: None,
    });

    let (wire, on_disk, pump, agent_events, store, _dir) = pumped(script).await;
    drop(agent_events);
    pump.await.unwrap();

    let reasoning_updates = wire
        .iter()
        .filter(|event| {
            matches!(
                event,
                SessionEvent::Item {
                    item: TimelineItem::Reasoning { .. },
                    ..
                }
            )
        })
        .count();
    assert!(
        reasoning_updates <= 8,
        "forty tokens became {reasoning_updates} messages"
    );
    assert!(
        !wire.iter().any(|event| matches!(
            event,
            SessionEvent::ItemDelta { item_id, .. } if item_id == "r"
        )),
        "a thinking delta leaked onto the wire"
    );
    for event in &wire {
        if let SessionEvent::Item {
            item: TimelineItem::Reasoning { text, .. },
            ..
        } = event
        {
            assert!(
                text.chars().count() <= overview::REASONING_CHARS,
                "more than the overview reached the wire: {text:?}"
            );
        }
    }
    assert!(
        on_disk.iter().all(|item| item.id() != "r"),
        "thinking belongs to the round layer, not to the session narrative"
    );
    let persisted = stored_blobs(&store, 0)
        .into_iter()
        .find(|blob| blob.item_id == "r")
        .expect("the thinking block is stored as a work row");
    assert_eq!(persisted.kind, genehub_proto::BlobKind::Reasoning);
    assert_eq!(
        persisted.overview.chars().count(),
        overview::REASONING_CHARS
    );
}

/// A shell command's output is the heaviest ordinary payload there is.
/// The card keeps only three short strings; the wall of text goes no
/// further than the agent.
#[tokio::test]
async fn a_tool_calls_payload_stays_behind_the_access_layer() {
    let output = "a line of build output\n".repeat(500);
    let (wire, on_disk, pump, agent_events, store, _dir) = pumped(vec![
        SessionEvent::TurnStarted {
            turn_id: "t".into(),
            started_at_ms: 1,
        },
        SessionEvent::Item {
            turn_id: "t".into(),
            item: TimelineItem::ToolCall {
                id: "c".into(),
                name: "Shell".into(),
                status: ToolStatus::Ok,
                detail: ToolCallDetail::Shell {
                    command: "cargo build --workspace".into(),
                    output,
                    exit_code: Some(0),
                },
                images: vec![],
                started_at_ms: None,
                finished_at_ms: None,
            },
        },
        SessionEvent::TurnCompleted {
            turn_id: "t".into(),
            usage: Usage {
                input_tokens: 120,
                output_tokens: 34,
                cache_read_tokens: 80,
                ..Usage::default()
            },
            fork_checkpoint: Some("agent-turn-7".into()),
        },
    ])
    .await;
    drop(agent_events);
    pump.await.unwrap();

    for event in &wire {
        if let SessionEvent::Item {
            item: TimelineItem::ToolCall { detail, .. },
            ..
        } = event
        {
            match detail {
                ToolCallDetail::Overview {
                    overview,
                    input,
                    output,
                    ..
                } => {
                    assert_eq!(overview, "cargo build --workspace");
                    assert_eq!(input, "cargo build --workspace");
                    assert_eq!(output.lines().count(), 5);
                    assert_eq!(output.lines().next(), Some("a line of build output"));
                    assert_eq!(output.lines().last(), Some("a line of build output"));
                    assert!(overview.chars().count() <= overview::SUMMARY_CHARS);
                    assert!(input.chars().count() <= overview::TOOL_LINE_CHARS);
                    assert!(output
                        .lines()
                        .all(|line| line.chars().count() <= overview::TOOL_LINE_CHARS));
                }
                other => panic!("unexpected {other:?}"),
            }
        }
    }
    let stats = on_disk
        .iter()
        .find_map(|item| match item {
            TimelineItem::TurnSummary { stats, .. } => Some(stats),
            _ => None,
        })
        .expect("the completed turn keeps its statistics");
    assert_eq!(stats.usage.input_tokens, 120);
    assert_eq!(stats.usage.output_tokens, 34);
    assert_eq!(stats.usage.cache_read_tokens, 80);
    assert_eq!(stats.tool_calls, 1);
    assert_eq!(stats.fork_checkpoint.as_deref(), Some("agent-turn-7"));
    let size = serde_json::to_string(&on_disk).unwrap().len();
    assert!(size < 1_000, "the log kept the payload ({size} bytes)");
    // The work row itself is the index: it carries the locator, and no
    // separate blob index is consulted to get from item to payload.
    let blob_ref = stored_blobs(&store, 0)
        .into_iter()
        .find(|blob| blob.item_id == "c")
        .and_then(|blob| blob.blob)
        .expect("the compact row points at source-preserved content");
    let blob = store
        .get_blob("w1", "s1", &blob_ref)
        .unwrap()
        .expect("the content-addressed blob is retrievable");
    assert!(
        blob.value.to_string().len() > 10_000,
        "the source output was not replaced by its overview"
    );
}

// -- ActiveRound: round vs. turn (docs/agent-analysis-substrate-proposal.md §3.2) --
//
// The pure decision logic (`begin_round`, `continue_round`, `settle_round`)
// is tested directly against a bare `Live`, the same way `apply` is above.
// A handful of tests then drive the whole thing through `SessionManager`
// with a scriptable fake in place of a real adapter — the registry only
// ever gets asked for a real process when `live.agent` is empty, so a
// fake dropped in ahead of time keeps `send` and `respond_permission`
// running their real logic without spawning anything.

#[tokio::test]
async fn a_round_opens_on_the_first_adapter_turn() {
    let (live, _store_dir) = live_session(meta());
    let superseded = live.begin_round(None, "t0", "u0").await;
    assert!(superseded.is_none(), "nothing was open to cut short");

    let round = live
        .active_round
        .lock()
        .await
        .clone()
        .expect("a round was opened");
    assert_eq!(round.adapter_turn_ids, vec!["t0".to_string()]);
    assert!(round.outcome.is_none());
}

#[tokio::test]
async fn a_send_without_continues_round_supersedes_the_dangling_round_it_replaces() {
    let (live, _store_dir) = live_session(meta());
    live.begin_round(None, "t0", "u0").await;
    let first_round_id = live
        .active_round
        .lock()
        .await
        .as_ref()
        .unwrap()
        .round_id
        .clone();

    let superseded = live
        .begin_round(None, "t1", "u1")
        .await
        .expect("the dangling round was cut short");
    assert_eq!(superseded.round_id, first_round_id);
    assert_eq!(superseded.outcome, Some(RoundOutcome::Superseded));
    assert_eq!(superseded.adapter_turn_ids, vec!["t0".to_string()]);
    assert_eq!(
        superseded.user_item_id.as_deref(),
        Some("u0"),
        "the superseded round keeps the message that opened it"
    );

    let current = live.active_round.lock().await.clone().unwrap();
    assert_ne!(
        current.round_id, first_round_id,
        "a fresh round must replace the superseded one"
    );
    assert_eq!(current.adapter_turn_ids, vec!["t1".to_string()]);
}

#[tokio::test]
async fn a_send_with_a_matching_continues_round_folds_into_the_same_round() {
    let (live, _store_dir) = live_session(meta());
    live.begin_round(None, "t0", "u0").await;
    let round_id = live
        .active_round
        .lock()
        .await
        .as_ref()
        .unwrap()
        .round_id
        .clone();

    let superseded = live.begin_round(Some(&round_id), "t1", "u1").await;
    assert!(
        superseded.is_none(),
        "a matching continuesRound must not cut the round short"
    );

    let round = live.active_round.lock().await.clone().unwrap();
    assert_eq!(round.round_id, round_id, "the round id must not change");
    assert_eq!(
        round.adapter_turn_ids,
        vec!["t0".to_string(), "t1".to_string()],
        "the new adapter turn must fold into the same round"
    );
    assert_eq!(
        round.user_item_id.as_deref(),
        Some("u0"),
        "the round is still the one the first message opened"
    );
    assert!(
        live.open_trunk_items.lock().await.is_empty(),
        "a user message is narrative, not work: it never enters a trunk"
    );
}

#[tokio::test]
async fn a_continues_round_naming_an_unknown_round_starts_a_fresh_one() {
    let (live, _store_dir) = live_session(meta());
    live.begin_round(None, "t0", "u0").await;
    let real_round_id = live
        .active_round
        .lock()
        .await
        .as_ref()
        .unwrap()
        .round_id
        .clone();

    let superseded = live
        .begin_round(Some("r_does_not_exist"), "t1", "u1")
        .await
        .expect("the real dangling round is still cut short");
    assert_eq!(superseded.round_id, real_round_id);
    assert_eq!(superseded.user_item_id.as_deref(), Some("u0"));

    let current = live.active_round.lock().await.clone().unwrap();
    assert_ne!(
        current.round_id, real_round_id,
        "an unrecognized continuesRound must not be trusted"
    );
    assert_eq!(current.adapter_turn_ids, vec!["t1".to_string()]);
}

#[tokio::test]
async fn a_settled_round_is_replaced_quietly_not_marked_superseded_again() {
    let (live, _store_dir) = live_session(meta());
    live.begin_round(None, "t0", "u0").await;
    let round_id = live
        .active_round
        .lock()
        .await
        .as_ref()
        .unwrap()
        .round_id
        .clone();
    assert!(live
        .settle_round(Settling::Kernel, RoundOutcome::Completed)
        .await
        .is_some());

    // A stale continuesRound for a round that already finished on its own
    // must not reopen it, and must not be reported as "cut short" —
    // nothing was taken from it, it had already ended.
    let superseded = live.begin_round(Some(&round_id), "t1", "u1").await;
    assert!(superseded.is_none());

    let current = live.active_round.lock().await.clone().unwrap();
    assert_ne!(current.round_id, round_id);
    assert!(current.outcome.is_none());
}

/// Sequence numbers are a promise about order, so something has to keep it.
///
/// Several tasks publish to one session at once: the event pump, a stop
/// that escalated past a deaf agent, the call that started the turn. When
/// the number was taken outside the lock that orders the replay buffer, two
/// of them could take 5 and 6 and arrive in the other order — and a client
/// asking to be caught up would be handed the session's history in an order
/// that never happened.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_publishers_leave_the_replay_in_sequence() {
    let (live, _store_dir) = live_session(meta());

    let mut publishers = Vec::new();
    for n in 0..256 {
        let live = live.clone();
        publishers.push(tokio::spawn(async move {
            live.publish(SessionEvent::TurnProgress {
                turn_id: format!("t{n}"),
                usage: Usage::default(),
            })
            .await;
        }));
    }
    for publisher in publishers {
        publisher.await.expect("a publisher panicked");
    }

    let replay = live.replay.lock().await;
    let seqs: Vec<u64> = replay.iter().map(|event| event.seq).collect();
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    assert_eq!(
        seqs, sorted,
        "the replay buffer holds the session's own history out of order"
    );
    assert_eq!(seqs.len(), 256, "an event went missing");
}

/// The straggler.
///
/// A round folds several adapter turns, so "a terminal arrived" and "the
/// turn this round is running has ended" are different facts. Nothing in
/// the kernel used to tell them apart, and two adapters cannot: claude's
/// `result` frame carries no turn id, so it stamps whichever turn is
/// current when the frame arrives. Acting on a straggler ends the turn the
/// user is watching because of one they already cancelled.
#[tokio::test]
async fn a_terminal_from_a_superseded_turn_does_not_end_the_one_running() {
    let (live, _store_dir) = live_session(meta());
    live.begin_round(None, "t0", "u0").await;
    live.continue_round("t1").await;

    assert!(
        live.settle_round(Settling::Turn("t0"), RoundOutcome::Completed)
            .await
            .is_none(),
        "a terminal naming the superseded turn settled the round"
    );
    assert!(
        live.active_round
            .lock()
            .await
            .as_ref()
            .expect("the round is still there")
            .outcome
            .is_none(),
        "the round was closed by a turn it is no longer running"
    );

    // And the turn that is running still ends it, or the fence would be a
    // freeze of its own.
    let settled = live
        .settle_round(Settling::Turn("t1"), RoundOutcome::Completed)
        .await
        .expect("the running turn must still be able to end its round");
    assert_eq!(settled.outcome, Some(RoundOutcome::Completed));
}

#[tokio::test]
async fn settle_round_is_idempotent() {
    let (live, _store_dir) = live_session(meta());
    live.begin_round(None, "t0", "u0").await;

    let settled = live
        .settle_round(Settling::Kernel, RoundOutcome::Completed)
        .await
        .expect("the round was open");
    assert_eq!(settled.user_item_id.as_deref(), Some("u0"));
    assert!(
        live.settle_round(Settling::Kernel, RoundOutcome::Failed)
            .await
            .is_none(),
        "a round cannot be settled twice"
    );

    let round = live.active_round.lock().await.clone().unwrap();
    assert_eq!(
        round.outcome,
        Some(RoundOutcome::Completed),
        "the first outcome wins"
    );
}

#[test]
fn llm_rounds_fold_each_adapter_turn_into_the_round_base() {
    let mut rounds = LlmRounds::default();
    rounds.observe("t1", 1);
    rounds.observe("t1", 3);
    assert_eq!(rounds.cumulative(), 3);
    // A new adapter turn of the same round restarts its counter at zero.
    rounds.observe("t2", 1);
    assert_eq!(rounds.cumulative(), 4);
    rounds.observe("t2", 2);
    assert_eq!(rounds.cumulative(), 5);
    // A late frame from the finished turn cannot fold the base twice.
    rounds.observe("t1", 9);
    assert_eq!(rounds.cumulative(), 5);
    // A fresh round starts from zero.
    rounds.clear();
    rounds.observe("t3", 1);
    assert_eq!(rounds.cumulative(), 1);
}

#[tokio::test]
async fn blocked_time_is_folded_in_when_the_round_resumes_or_ends() {
    let (live, _store_dir) = live_session(meta());
    live.begin_round(None, "t0", "u0").await;
    live.round_blocked().await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    live.continue_round("t1").await;

    let round = live.active_round.lock().await.clone().unwrap();
    assert!(round.blocked_since_ms.is_none(), "the pause is over");
    assert!(
        round.blocked_ms >= 15,
        "the wait should be counted, got {}ms",
        round.blocked_ms
    );
    assert_eq!(
        round.adapter_turn_ids,
        vec!["t0".to_string(), "t1".to_string()]
    );

    live.round_blocked().await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    live.settle_round(Settling::Kernel, RoundOutcome::Canceled)
        .await;
    let round = live.active_round.lock().await.clone().unwrap();
    assert!(
        round.blocked_ms >= 30,
        "a second pause must add to the running total, got {}ms",
        round.blocked_ms
    );
}

/// Wires a session the way `ensure_started` would, but with a
/// `TestSession` in place of a real adapter and its pump already
/// running — so `SessionManager::send` and `respond_permission` run
/// their real logic end to end, only the process at the bottom is fake.
async fn wired(
    root: &std::path::Path,
) -> (SessionManager, crate::adapter::EventTx, Arc<AtomicU64>) {
    let sessions = manager(root);
    sessions.store.save_meta(&meta()).unwrap();
    let live = sessions.live("s1").await.unwrap();
    // Match the production adapter buffer: pagination tests deliberately
    // send more than 64 events and are not overflow tests.
    let (events, events_rx) = crate::adapter::EventTx::channel();
    let turn_ids = Arc::new(AtomicU64::new(0));
    *live.agent.lock().await = Some(Arc::new(TestSession::sharing(
        events.clone(),
        turn_ids.clone(),
    )));
    let pump = tokio::spawn(pump_events(
        live.clone(),
        events_rx,
        sessions.store.clone(),
        64,
        sessions.processes(),
        sessions.diagnostics.clone(),
        sessions.project_control.clone(),
    ));
    *live.pump.lock().await = Some(pump);
    (sessions, events, turn_ids)
}

/// Waits for the event pump to reach a state, rather than guessing how
/// long it takes to get there.
///
/// The pump is its own task, so a test that just sent an event has to wait
/// for it. A fixed sleep is a guess that holds when the test runs alone and
/// breaks when the whole suite competes for the machine — which is how this
/// helper came to exist. The ceiling is generous because it only has to
/// catch a pump that will never arrive, not a slow one.
async fn eventually(expected: &str, mut reached: impl AsyncFnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !reached().await {
        assert!(
            std::time::Instant::now() < deadline,
            "the event pump never {expected}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// The session states a call published, including a failed handover.
fn statuses(seen: &mut broadcast::Receiver<SequencedEvent>) -> Vec<SessionStatus> {
    let mut out = Vec::new();
    while let Ok(event) = seen.try_recv() {
        match event.event {
            SessionEvent::SessionStatusChanged { status } => out.push(status),
            SessionEvent::TurnFailed { .. } => out.push(SessionStatus::Failed),
            _ => {}
        }
    }
    out
}

/// Starting an agent takes time the wire used to say nothing about. Until
/// `TurnStarted` arrived — behind a process spawn and a handshake, seconds
/// for a third-party CLI — every other client still saw an idle session, so
/// it offered a send button for it and got this call's own refusal back.
#[tokio::test]
async fn send_says_the_session_is_busy_before_it_reaches_the_agent() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, _events, _) = wired(dir.path()).await;
    let providers = ProviderMap::new();
    let live = sessions.live("s1").await.unwrap();
    let mut seen = live.events.subscribe();

    sessions
        .send("s1", "hello".into(), vec![], &providers, None)
        .await
        .expect("accepted");

    let mut published = Vec::new();
    while let Ok(event) = seen.try_recv() {
        published.push(event.event);
    }
    let busy = published
        .iter()
        .position(|event| {
            matches!(
                event,
                SessionEvent::SessionStatusChanged {
                    status: SessionStatus::Running
                }
            )
        })
        .expect("the busy status reached the clients");
    let prompt = published
        .iter()
        .position(|event| {
            matches!(
                event,
                SessionEvent::Item {
                    item: TimelineItem::UserMessage { .. },
                    ..
                }
            )
        })
        .expect("the prompt reached the clients");
    assert!(
        busy < prompt,
        "the session must be known to be busy before anything else, got {published:?}"
    );
}

/// And withdrawn when it turns out nothing is running after all, or every
/// client keeps a busy session that will never finish.
#[tokio::test]
async fn a_refused_handover_withdraws_the_busy_status() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, events, _) = wired(dir.path()).await;
    let providers = ProviderMap::new();
    let live = sessions.live("s1").await.unwrap();
    *live.agent.lock().await = Some(Arc::new(TestSession::refusing(events.clone())));
    let mut seen = live.events.subscribe();

    sessions
        .send("s1", "hello".into(), vec![], &providers, None)
        .await
        .expect_err("the handover failed");

    assert_eq!(
        statuses(&mut seen),
        vec![SessionStatus::Running, SessionStatus::Failed]
    );
    assert_eq!(*live.status.lock().await, SessionStatus::Failed);
}

#[tokio::test]
async fn a_round_completes_with_a_single_adapter_turn() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, events, _) = wired(dir.path()).await;
    let providers = ProviderMap::new();

    let turn_id = sessions
        .send("s1", "hello".into(), vec![], &providers, None)
        .await
        .expect("accepted");
    events
        .send(SessionEvent::TurnStarted {
            turn_id: turn_id.clone(),
            started_at_ms: 1,
        })
        .unwrap();
    events
        .send(SessionEvent::TurnCompleted {
            turn_id: turn_id.clone(),
            usage: Usage::default(),
            fork_checkpoint: None,
        })
        .unwrap();
    let live = sessions.live("s1").await.unwrap();
    eventually("settled the round", async || {
        live.active_round
            .lock()
            .await
            .as_ref()
            .is_some_and(|round| round.outcome.is_some())
    })
    .await;

    let round = live
        .active_round
        .lock()
        .await
        .clone()
        .expect("a round was opened");
    assert_eq!(round.adapter_turn_ids, vec![turn_id.clone()]);
    assert_eq!(round.outcome, Some(RoundOutcome::Completed));

    let on_disk = sessions.store.load_chat("w1", "s1").unwrap().items;
    let user_item_id = on_disk
        .iter()
        .find_map(|item| match item {
            TimelineItem::UserMessage { id, .. } => Some(id.clone()),
            _ => None,
        })
        .expect("the prompt was written to disk");

    let rounds = sessions.store.load_chat("w1", "s1").unwrap().rounds;
    assert_eq!(rounds.len(), 1, "one settled round must be ledgered");
    assert_eq!(rounds[0].round_id, round.round_id);
    assert_eq!(rounds[0].outcome, Some(RoundOutcome::Completed));
    assert_eq!(rounds[0].adapter_turn_ids, vec![turn_id]);
    assert_eq!(rounds[0].user_item_id.as_ref(), Some(&user_item_id));
    assert!(!rounds[0].synthesized, "a live round is never synthesized");
}

fn tool_call(id: &str, name: &str) -> TimelineItem {
    TimelineItem::ToolCall {
        id: id.into(),
        name: name.into(),
        status: ToolStatus::Ok,
        detail: ToolCallDetail::Shell {
            command: name.into(),
            output: String::new(),
            exit_code: Some(0),
        },
        images: vec![],
        started_at_ms: None,
        finished_at_ms: None,
    }
}

/// End-to-end proof that trunk pagination (§3.2 direction three, §8 step
/// 3) actually reaches the ledger: a monologue that arrives after some
/// tool calls closes a trunk, and the round settling closes whatever
/// trunk was still open — nothing accumulated since the last boundary is
/// silently dropped.
#[tokio::test]
async fn a_monologue_boundary_mid_round_produces_two_ledgered_trunks() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, events, _) = wired(dir.path()).await;
    let providers = ProviderMap::new();

    let turn_id = sessions
        .send("s1", "do a bunch of stuff".into(), vec![], &providers, None)
        .await
        .expect("accepted");
    events
        .send(SessionEvent::TurnStarted {
            turn_id: turn_id.clone(),
            started_at_ms: 1,
        })
        .unwrap();
    for event in [
        SessionEvent::Item {
            turn_id: turn_id.clone(),
            item: item("a1", "reading the config first"),
        },
        SessionEvent::Item {
            turn_id: turn_id.clone(),
            item: tool_call("t1", "read_file"),
        },
        SessionEvent::Item {
            turn_id: turn_id.clone(),
            item: tool_call("t2", "read_file"),
        },
        SessionEvent::Item {
            turn_id: turn_id.clone(),
            item: item("a2", "now applying the change"),
        },
    ] {
        events.send(event).unwrap();
    }
    events
        .send(SessionEvent::TurnCompleted {
            turn_id: turn_id.clone(),
            usage: Usage::default(),
            fork_checkpoint: None,
        })
        .unwrap();
    eventually("persisted the narrated trunk", async || {
        let Ok(chat) = sessions.store.load_chat("w1", "s1") else {
            return false;
        };
        let Ok(trunks) = sessions.store.load_trunk_index("w1", "s1", 0) else {
            return false;
        };
        chat.rounds
            .first()
            .is_some_and(|round| round.trunk_count == 1)
            && trunks.len() == 1
    })
    .await;

    let rounds = sessions.store.load_chat("w1", "s1").unwrap().rounds;
    assert_eq!(rounds.len(), 1, "one settled round must be ledgered");
    let trunks = sessions.store.load_trunk_index("w1", "s1", 0).unwrap();
    assert_eq!(rounds[0].trunk_count, 1);
    assert_eq!(
        trunks.len(),
        1,
        "monologues divide visible batches; the trunk remains bounded by its blob cap"
    );
    assert_eq!(trunks[0].index, 0);
    assert_eq!(trunks[0].first_item_id, "a1");
    assert_eq!(trunks[0].blob_count, 2);
    assert_eq!(trunks[0].title, "reading the config first");
    assert_eq!(trunks[0].batches.len(), 2);
    assert_eq!(trunks[0].batches[0].blob_count, 2);
    assert_eq!(trunks[0].batches[1].blob_count, 0);
}

/// A round that never narrates still gets paginated: the 64-tool batch cap
/// protects the byte budget during long runs with no monologue or useful
/// thinking boundary, while the trunk threshold remains soft.
#[tokio::test]
async fn a_round_with_no_monologue_at_all_paginates_after_the_soft_threshold() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, events, _) = wired(dir.path()).await;
    let providers = ProviderMap::new();

    let turn_id = sessions
        .send("s1", "run a lot of tools".into(), vec![], &providers, None)
        .await
        .expect("accepted");
    events
        .send(SessionEvent::TurnStarted {
            turn_id: turn_id.clone(),
            started_at_ms: 1,
        })
        .unwrap();
    for i in 0..132u32 {
        events
            .send(SessionEvent::TurnProgress {
                turn_id: turn_id.clone(),
                usage: Usage {
                    llm_rounds: u64::from(i + 1),
                    ..Usage::default()
                },
            })
            .unwrap();
        events
            .send(SessionEvent::Item {
                turn_id: turn_id.clone(),
                item: tool_call(&format!("t{i}"), "grep"),
            })
            .unwrap();
        if i % 16 == 15 {
            tokio::task::yield_now().await;
        }
    }
    events
        .send(SessionEvent::TurnCompleted {
            turn_id: turn_id.clone(),
            usage: Usage::default(),
            fork_checkpoint: None,
        })
        .unwrap();
    eventually("persisted both paginated trunks", async || {
        let Ok(chat) = sessions.store.load_chat("w1", "s1") else {
            return false;
        };
        let Ok(trunks) = sessions.store.load_trunk_index("w1", "s1", 0) else {
            return false;
        };
        let done = chat
            .rounds
            .first()
            .is_some_and(|round| round.trunk_count == 2)
            && trunks.len() == 2
            && trunks[1].blob_count == 4;
        done
    })
    .await;

    let rounds = sessions.store.load_chat("w1", "s1").unwrap().rounds;
    let trunks = sessions.store.load_trunk_index("w1", "s1", 0).unwrap();
    assert_eq!(rounds[0].trunk_count, 2);
    assert_eq!(
        trunks.len(),
        2,
        "132 tool calls split after the threshold-crossing batch: {trunks:?}"
    );
    assert_eq!(
        trunks[0].batches.len(),
        2,
        "trunks: {:?}",
        trunks
            .iter()
            .map(|trunk| {
                (
                    trunk.index,
                    trunk.blob_count,
                    trunk.llm_rounds,
                    trunk
                        .batches
                        .iter()
                        .map(|batch| (batch.blob_count, batch.llm_rounds))
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<Vec<_>>()
    );
    assert_eq!(
        trunks[0].llm_rounds,
        Some(128),
        "trunks: {:?}",
        trunks
            .iter()
            .map(|trunk| {
                (
                    trunk.index,
                    trunk.blob_count,
                    trunk.llm_rounds,
                    trunk
                        .batches
                        .iter()
                        .map(|batch| (batch.blob_count, batch.llm_rounds))
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<Vec<_>>()
    );
    assert_eq!(trunks[0].blob_count, 128);
    assert_eq!(trunks[1].blob_count, 4);
    assert_eq!(trunks[1].batches.len(), 1);
    assert_eq!(trunks[1].llm_rounds, Some(4));
}

/// A permission resume (or any client-declared continuation) starts a new
/// adapter turn whose `llmRounds` counts from zero again. The trunk
/// builder must still see a round-cumulative counter, or everything after
/// the resume stops counting until the new turn passes the old high-water
/// mark.
#[tokio::test]
async fn llm_rounds_stay_cumulative_when_a_continued_turn_restarts_the_counter() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, events, turn_ids) = wired(dir.path()).await;
    let providers = ProviderMap::new();

    let turn1 = sessions
        .send("s1", "start".into(), vec![], &providers, None)
        .await
        .expect("accepted");
    events
        .send(SessionEvent::TurnStarted {
            turn_id: turn1.clone(),
            started_at_ms: 1,
        })
        .unwrap();
    for i in 0..3u32 {
        events
            .send(SessionEvent::TurnProgress {
                turn_id: turn1.clone(),
                usage: Usage {
                    llm_rounds: u64::from(i + 1),
                    ..Usage::default()
                },
            })
            .unwrap();
        events
            .send(SessionEvent::Item {
                turn_id: turn1.clone(),
                item: tool_call(&format!("a{i}"), "grep"),
            })
            .unwrap();
    }
    // A permission interrupt cancels the adapter turn but leaves the
    // round open for the resume.
    events
        .send(SessionEvent::TurnCanceled {
            turn_id: turn1.clone(),
        })
        .unwrap();
    let live = sessions.live("s1").await.unwrap();
    eventually("released the interrupted turn", async || {
        *live.status.lock().await == genehub_proto::SessionStatus::Idle
    })
    .await;
    let round_id = live
        .active_round
        .lock()
        .await
        .as_ref()
        .expect("the interrupted round is left dangling")
        .round_id
        .clone();
    // The cancel retired the agent together with its pump — the interrupt
    // teardown owns both now. A continued round would start a fresh agent
    // through ensure_started; with an empty registry the test stands in
    // with a new fake on the same channel and re-arms the pump itself.
    *live.agent.lock().await = Some(Arc::new(TestSession::sharing(
        events.clone(),
        turn_ids.clone(),
    )));
    let pump = tokio::spawn(pump_events(
        live.clone(),
        events.reseat(),
        sessions.store.clone(),
        64,
        sessions.processes(),
        sessions.diagnostics.clone(),
        sessions.project_control.clone(),
    ));
    *live.pump.lock().await = Some(pump);
    let turn2 = sessions
        .send(
            "s1",
            "approved, keep going".into(),
            vec![],
            &providers,
            Some(round_id),
        )
        .await
        .expect("accepted");
    events
        .send(SessionEvent::TurnStarted {
            turn_id: turn2.clone(),
            started_at_ms: 2,
        })
        .unwrap();
    // The resumed adapter turn counts its own LLM rounds from 1 again.
    for i in 0..2u32 {
        events
            .send(SessionEvent::TurnProgress {
                turn_id: turn2.clone(),
                usage: Usage {
                    llm_rounds: u64::from(i + 1),
                    ..Usage::default()
                },
            })
            .unwrap();
        events
            .send(SessionEvent::Item {
                turn_id: turn2.clone(),
                item: tool_call(&format!("b{i}"), "grep"),
            })
            .unwrap();
    }
    events
        .send(SessionEvent::TurnCompleted {
            turn_id: turn2.clone(),
            usage: Usage::default(),
            fork_checkpoint: None,
        })
        .unwrap();

    eventually("persisted the continued round's trunk", async || {
        let Ok(chat) = sessions.store.load_chat("w1", "s1") else {
            return false;
        };
        chat.rounds
            .first()
            .is_some_and(|round| round.trunk_count == 1)
    })
    .await;

    let trunks = sessions.store.load_trunk_index("w1", "s1", 0).unwrap();
    assert_eq!(trunks.len(), 1, "trunks: {trunks:?}");
    assert_eq!(trunks[0].blob_count, 5);
    assert_eq!(
        trunks[0].llm_rounds,
        Some(5),
        "the resumed turn's two rounds add to the interrupted turn's three: {:?}",
        trunks
            .iter()
            .map(|trunk| {
                (
                    trunk.index,
                    trunk.blob_count,
                    trunk.llm_rounds,
                    trunk
                        .batches
                        .iter()
                        .map(|batch| (batch.blob_count, batch.llm_rounds))
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn layered_open_omits_historical_work_and_prefetches_only_the_last_trunk() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, events, _) = wired(dir.path()).await;
    let providers = ProviderMap::new();
    let turn_id = sessions
        .send("s1", "inspect".into(), vec![], &providers, None)
        .await
        .unwrap();
    events
        .send(SessionEvent::TurnStarted {
            turn_id: turn_id.clone(),
            started_at_ms: 1,
        })
        .unwrap();
    events
        .send(SessionEvent::Item {
            turn_id: turn_id.clone(),
            item: item("a1", "先读取配置。然后修改"),
        })
        .unwrap();
    events
        .send(SessionEvent::Item {
            turn_id: turn_id.clone(),
            item: TimelineItem::ToolCall {
                id: "c1".into(),
                name: "read".into(),
                status: ToolStatus::Ok,
                detail: ToolCallDetail::Read {
                    path: "config.json".into(),
                    content: "raw source content".repeat(100),
                    truncated: false,
                },
                images: vec![],
                started_at_ms: None,
                finished_at_ms: None,
            },
        })
        .unwrap();
    events
        .send(SessionEvent::TurnCompleted {
            turn_id,
            usage: Usage::default(),
            fork_checkpoint: None,
        })
        .unwrap();
    eventually("persisted the expanded trunk and its blob", async || {
        let Ok(index) = sessions.store.load_trunk_index("w1", "s1", 0) else {
            return false;
        };
        let Some(summary) = index.last() else {
            return false;
        };
        let Ok(trunk) = sessions.store.load_trunk("w1", "s1", 0, summary) else {
            return false;
        };
        trunk
            .batches
            .iter()
            .flat_map(|batch| &batch.blobs)
            .any(|blob| blob.blob.is_some())
    })
    .await;

    let (snapshot, replayed, reset, _) = sessions.subscribe("s1", Some(0), true).await.unwrap();
    assert!(reset);
    assert!(
        replayed.is_empty(),
        "layered open must not replay work history"
    );
    assert!(snapshot.items.iter().all(|item| !matches!(
        item,
        TimelineItem::ToolCall { .. } | TimelineItem::Reasoning { .. }
    )));
    let rounds = snapshot.rounds.expect("session layer includes rounds");
    assert_eq!(rounds.len(), 1);
    let expanded = snapshot
        .expanded_round
        .expect("the requested last round is prefetched");
    assert_eq!(expanded.trunks.len(), 1);
    assert_eq!(expanded.trunks[0].batches.len(), 1);
    let trunk = expanded
        .expanded_trunk
        .expect("last trunk details are present");
    assert_eq!(trunk.batches[0].blobs.len(), 1);
    assert_eq!(
            trunk.batches[0].monologue.as_deref(),
            Some("先读取配置。然后修改"),
            "process narration belongs to the expanded batch rather than being reconstructed by the client"
        );
    let reference = trunk.batches[0].blobs[0]
        .blob
        .clone()
        .expect("the compact blob row addresses source content");
    let payload = sessions.blob("s1", &reference).await.unwrap();
    assert!(payload.value.to_string().contains("raw source content"));
}

#[tokio::test]
async fn trunk_index_pages_backward_without_repeating_the_round_payload() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, _events, _) = wired(dir.path()).await;
    sessions
        .store
        .append_round(
            "w1",
            "s1",
            &RoundRecord {
                schema_version: rounds::SCHEMA_VERSION,
                round_id: "r-many".into(),
                ord: 0,
                user_item_id: None,
                started_at_ms: 1,
                ended_at_ms: 2,
                outcome: Some(RoundOutcome::Completed),
                adapter_turn_ids: vec!["t1".into()],
                blocked_ms: 0,
                synthesized: false,
                trunk_count: 25,
            },
        )
        .unwrap();
    for index in 0..25 {
        sessions
            .store
            .write_trunk(
                "w1",
                "s1",
                0,
                &RoundTrunk {
                    summary: TrunkSummary {
                        index,
                        first_item_id: format!("i{index}"),
                        blob_count: 100,
                        title: format!("阶段 {index}"),
                        batches: vec![],
                        llm_rounds: None,
                        started_at_ms: None,
                        duration_ms: None,
                        tool_duration_ms: None,
                    },
                    batches: vec![],
                },
            )
            .unwrap();
    }

    // A cold open, so the session layer reads the record just written
    // rather than the empty one it has in memory.
    sessions.sessions.write().await.clear();
    let recent = sessions
        .round_layer("s1", "r-many", None, Some(20))
        .await
        .unwrap();
    assert_eq!(recent.trunks.first().unwrap().index, 5);
    assert_eq!(recent.trunks.last().unwrap().index, 24);
    assert_eq!(recent.next_cursor.as_deref(), Some("before:5"));
    let older = sessions
        .round_layer("s1", "r-many", recent.next_cursor.as_deref(), Some(20))
        .await
        .unwrap();
    assert_eq!(older.trunks.len(), 5);
    assert_eq!(older.trunks.first().unwrap().index, 0);
    assert!(older.next_cursor.is_none());
}

#[tokio::test]
async fn round_trunks_batch_get_returns_trunks_in_request_order() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, _events, _) = wired(dir.path()).await;
    sessions
        .store
        .append_round(
            "w1",
            "s1",
            &RoundRecord {
                schema_version: rounds::SCHEMA_VERSION,
                round_id: "r-batch".into(),
                ord: 0,
                user_item_id: None,
                started_at_ms: 1,
                ended_at_ms: 2,
                outcome: Some(RoundOutcome::Completed),
                adapter_turn_ids: vec!["t1".into()],
                blocked_ms: 0,
                synthesized: false,
                trunk_count: 3,
            },
        )
        .unwrap();
    for index in 0..3 {
        sessions
            .store
            .write_trunk(
                "w1",
                "s1",
                0,
                &RoundTrunk {
                    summary: TrunkSummary {
                        index,
                        first_item_id: format!("i{index}"),
                        blob_count: 0,
                        title: format!("阶段 {index}"),
                        batches: vec![],
                        llm_rounds: None,
                        started_at_ms: None,
                        duration_ms: None,
                        tool_duration_ms: None,
                    },
                    batches: vec![],
                },
            )
            .unwrap();
    }
    sessions.sessions.write().await.clear();

    let trunks = sessions
        .round_trunks(
            "s1",
            &[
                TrunkLocator {
                    round_id: "r-batch".into(),
                    trunk_index: 2,
                },
                TrunkLocator {
                    round_id: "r-batch".into(),
                    trunk_index: 0,
                },
            ],
        )
        .await
        .unwrap();
    assert_eq!(trunks.len(), 2);
    assert_eq!(
        trunks[0].summary.index, 2,
        "responses align with request order"
    );
    assert_eq!(trunks[1].summary.index, 0);
}

#[tokio::test]
async fn round_trunks_batch_get_is_all_or_nothing_and_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, _events, _) = wired(dir.path()).await;

    let missing = sessions
        .round_trunks(
            "s1",
            &[TrunkLocator {
                round_id: "r-absent".into(),
                trunk_index: 0,
            }],
        )
        .await;
    assert!(
        missing.is_err(),
        "any unknown locator fails the whole batch"
    );

    let oversized: Vec<TrunkLocator> = (0..65)
        .map(|trunk_index| TrunkLocator {
            round_id: "r-batch".into(),
            trunk_index,
        })
        .collect();
    let refused = sessions.round_trunks("s1", &oversized).await;
    assert!(refused.is_err(), "batches beyond the bound are rejected");
}

#[tokio::test]
async fn blobs_batch_get_returns_payloads_in_request_order() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, _events, _) = wired(dir.path()).await;
    let first = sessions
        .store
        .put_blob("w1", "s1", serde_json::json!({"n": 1}))
        .unwrap();
    let second = sessions
        .store
        .put_blob("w1", "s1", serde_json::json!({"n": 2}))
        .unwrap();

    let payloads = sessions
        .blobs("s1", &[second.clone(), first.clone()])
        .await
        .unwrap();
    assert_eq!(payloads.len(), 2);
    assert_eq!(payloads[0].value, serde_json::json!({"n": 2}));
    assert_eq!(payloads[1].value, serde_json::json!({"n": 1}));

    let mut tampered = first.clone();
    tampered.id = "0".repeat(tampered.id.len());
    assert!(sessions.blobs("s1", &[first, tampered]).await.is_err());
}

/// The proposal's central claim: an approval mid-turn is not a new round,
/// even though it is two adapter turns, two `TurnSummary`s and — before
/// this — two independent stories about what happened.
#[tokio::test]
async fn approving_a_permission_stitches_the_same_round_across_two_adapter_turns() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, events, turn_ids) = wired(dir.path()).await;
    let providers = ProviderMap::new();

    let first_turn = sessions
        .send("s1", "do the thing".into(), vec![], &providers, None)
        .await
        .expect("accepted");
    events
        .send(SessionEvent::TurnStarted {
            turn_id: first_turn.clone(),
            started_at_ms: 1,
        })
        .unwrap();

    let request = interaction(PermissionRequestKind::Permission);
    events
        .send(SessionEvent::PermissionRequested {
            request: request.clone(),
        })
        .unwrap();
    let live = sessions.live("s1").await.unwrap();
    eventually("recorded the permission request", async || {
        !live.visible_permissions().await.is_empty()
    })
    .await;

    let request_id = live.visible_permissions().await[0].id.clone();
    let round_id_before = {
        let round = live.active_round.lock().await;
        let round = round.as_ref().expect("a round is open, just blocked");
        assert_eq!(round.adapter_turn_ids, vec![first_turn.clone()]);
        assert!(round.outcome.is_none(), "blocked is not settled");
        round.round_id.clone()
    };

    // The real pump broke its loop for the interaction, same as
    // `stop_agent_for_interaction` does against a real adapter. A fresh
    // fake stands in for whatever `ensure_started_in_mode` would really
    // start on approval, sharing the turn-id counter so the ids stay
    // distinct across the "restart".
    *live.agent.lock().await = Some(Arc::new(TestSession::sharing(
        events.clone(),
        turn_ids.clone(),
    )));
    let pump = tokio::spawn(pump_events(
        live.clone(),
        events.reseat(),
        sessions.store.clone(),
        64,
        sessions.processes(),
        sessions.diagnostics.clone(),
        sessions.project_control.clone(),
    ));
    *live.pump.lock().await = Some(pump);

    sessions
        .respond_permission(
            "s1",
            &request_id,
            PermissionOutcome::Selected {
                option_id: "yes".into(),
            },
            &providers,
        )
        .await
        .expect("an allow option resumes");

    deliver_decision(&sessions, &live, &providers)
        .await
        .unwrap();

    let second_turn = {
        let round = live.active_round.lock().await;
        let round = round.as_ref().unwrap();
        assert_eq!(
            round.round_id, round_id_before,
            "an approval must not cut a new round"
        );
        assert_eq!(
            round.adapter_turn_ids.len(),
            2,
            "the resumed turn must fold into the same round"
        );
        assert!(round.blocked_since_ms.is_none(), "resumed, so unblocked");
        round.adapter_turn_ids[1].clone()
    };
    assert_ne!(second_turn, first_turn);

    events
        .send(SessionEvent::TurnStarted {
            turn_id: second_turn.clone(),
            started_at_ms: 1,
        })
        .unwrap();
    events
        .send(SessionEvent::TurnCompleted {
            turn_id: second_turn,
            usage: Usage::default(),
            fork_checkpoint: None,
        })
        .unwrap();
    eventually("settled the resumed round", async || {
        live.active_round
            .lock()
            .await
            .as_ref()
            .is_some_and(|round| round.outcome.is_some())
    })
    .await;

    let round = live.active_round.lock().await.clone().unwrap();
    assert_eq!(round.round_id, round_id_before);
    assert_eq!(round.outcome, Some(RoundOutcome::Completed));
    assert!(
        round.blocked_ms >= 0,
        "the wait for the approval was tracked"
    );

    let rounds = sessions.store.load_chat("w1", "s1").unwrap().rounds;
    assert_eq!(
        rounds.len(),
        1,
        "two adapter turns stitched into one round must ledger as one record, not two"
    );
    assert_eq!(rounds[0].round_id, round_id_before);
    assert_eq!(rounds[0].adapter_turn_ids.len(), 2);
    assert_eq!(rounds[0].outcome, Some(RoundOutcome::Completed));
}

#[tokio::test]
async fn denying_a_permission_settles_the_round_without_a_continuation() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, events, _) = wired(dir.path()).await;
    let providers = ProviderMap::new();

    let turn_id = sessions
        .send("s1", "do the thing".into(), vec![], &providers, None)
        .await
        .expect("accepted");
    events
        .send(SessionEvent::TurnStarted {
            turn_id,
            started_at_ms: 1,
        })
        .unwrap();
    let request = interaction(PermissionRequestKind::Permission);
    events
        .send(SessionEvent::PermissionRequested {
            request: request.clone(),
        })
        .unwrap();
    let live = sessions.live("s1").await.unwrap();
    eventually("recorded the permission request", async || {
        !live.visible_permissions().await.is_empty()
    })
    .await;

    let request_id = live.visible_permissions().await[0].id.clone();
    sessions
        .respond_permission(
            "s1",
            &request_id,
            PermissionOutcome::Selected {
                option_id: "no".into(),
            },
            &providers,
        )
        .await
        .expect("a reject resolves without resuming");
    deliver_decision(&sessions, &live, &providers)
        .await
        .unwrap();

    let round = live.active_round.lock().await.clone().unwrap();
    assert_eq!(
        round.outcome,
        Some(RoundOutcome::Canceled),
        "no continuation means the round is done, not dangling"
    );

    let rounds = sessions.store.load_chat("w1", "s1").unwrap().rounds;
    assert_eq!(rounds.len(), 1);
    assert_eq!(rounds[0].outcome, Some(RoundOutcome::Canceled));
}

/// The one case the daemon truly cannot decide on its own: the user
/// pressed stop, then said something else. `continuesRound` is the
/// client's explicit word for "same request".
#[tokio::test]
async fn an_interrupted_round_is_continued_when_the_next_send_names_it() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, events, turn_ids) = wired(dir.path()).await;
    let providers = ProviderMap::new();

    let first_turn = sessions
        .send("s1", "count to 500".into(), vec![], &providers, None)
        .await
        .expect("accepted");
    events
        .send(SessionEvent::TurnStarted {
            turn_id: first_turn.clone(),
            started_at_ms: 1,
        })
        .unwrap();
    events
        .send(SessionEvent::TurnCanceled {
            turn_id: first_turn.clone(),
        })
        .unwrap();
    let live = sessions.live("s1").await.unwrap();
    eventually("released the interrupted turn", async || {
        *live.status.lock().await == genehub_proto::SessionStatus::Idle
    })
    .await;

    assert_eq!(
        *live.status.lock().await,
        genehub_proto::SessionStatus::Idle,
        "interrupted, so usable again"
    );
    let dangling_round_id = live
        .active_round
        .lock()
        .await
        .as_ref()
        .expect("the round from the interrupted turn is left dangling")
        .round_id
        .clone();

    // Cancellation retires the process. Install the next fake instance,
    // just as the production registry starts a fresh resumable adapter.
    *live.agent.lock().await = Some(Arc::new(TestSession::sharing(events.clone(), turn_ids)));
    let second_turn = sessions
        .send(
            "s1",
            "continue".into(),
            vec![],
            &providers,
            Some(dangling_round_id.clone()),
        )
        .await
        .expect("accepted");

    let round = live.active_round.lock().await.clone().unwrap();
    assert_eq!(
        round.round_id, dangling_round_id,
        "the same round continues"
    );
    assert_eq!(round.adapter_turn_ids, vec![first_turn, second_turn]);

    let recorded = sessions.store.load_chat("w1", "s1").unwrap().rounds;
    assert_eq!(
        recorded.len(),
        1,
        "a continued round stays one record, not one per adapter turn"
    );
    assert_eq!(recorded[0].round_id, dangling_round_id);
    assert_eq!(
        recorded[0].outcome, None,
        "the round is on disk from the moment it opens, and still open"
    );
}

/// Without that signal, the daemon must not guess: the dangling round is
/// cut loose and a new one starts, even though nothing else about this
/// message looks any different from a real continuation.
#[tokio::test]
async fn an_interrupted_round_is_superseded_by_a_plain_new_message() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, events, turn_ids) = wired(dir.path()).await;
    let providers = ProviderMap::new();

    let first_turn = sessions
        .send("s1", "count to 500".into(), vec![], &providers, None)
        .await
        .expect("accepted");
    events
        .send(SessionEvent::TurnStarted {
            turn_id: first_turn.clone(),
            started_at_ms: 1,
        })
        .unwrap();
    events
        .send(SessionEvent::TurnCanceled {
            turn_id: first_turn,
        })
        .unwrap();
    let live = sessions.live("s1").await.unwrap();
    eventually("released the interrupted turn", async || {
        *live.status.lock().await == genehub_proto::SessionStatus::Idle
    })
    .await;

    let dangling_round_id = live
        .active_round
        .lock()
        .await
        .as_ref()
        .unwrap()
        .round_id
        .clone();

    // Cancellation retires the process. Install the next fake instance,
    // just as the production registry starts a fresh resumable adapter.
    *live.agent.lock().await = Some(Arc::new(TestSession::sharing(events.clone(), turn_ids)));
    let second_turn = sessions
        .send("s1", "what's the weather".into(), vec![], &providers, None)
        .await
        .expect("accepted");

    let round = live.active_round.lock().await.clone().unwrap();
    assert_ne!(
        round.round_id, dangling_round_id,
        "no continuesRound means a fresh round, not a guess"
    );
    assert_eq!(round.adapter_turn_ids, vec![second_turn]);

    let rounds = sessions.store.load_chat("w1", "s1").unwrap().rounds;
    assert_eq!(
        rounds.len(),
        2,
        "the superseded round and the one that replaced it are both on disk"
    );
    assert_eq!(rounds[0].round_id, dangling_round_id);
    assert_eq!(
        rounds[0].outcome,
        Some(RoundOutcome::Superseded),
        "the superseded round must be recorded even though it never got a terminal adapter event"
    );
    assert_eq!(rounds[1].round_id, round.round_id);
    assert_eq!(rounds[1].outcome, None, "the replacement is still running");
}

/// The fallback `TurnCompleted`/`TurnFailed`/`TurnCanceled` do not cover:
/// the adapter's process disappears without saying anything at all. This
/// is also, on purpose, a round that produced exactly one item before
/// the crash — the "space round"-adjacent case §3.2 calls out as the one
/// most likely to be silently dropped.
#[tokio::test]
async fn a_channel_that_closes_mid_turn_settles_the_dangling_round_and_flushes_what_it_produced() {
    let dir = tempfile::tempdir().unwrap();
    let (sessions, events, _) = wired(dir.path()).await;
    let providers = ProviderMap::new();
    let live = sessions.live("s1").await.unwrap();

    let turn_id = sessions
        .send("s1", "hello".into(), vec![], &providers, None)
        .await
        .expect("accepted");
    events
        .send(SessionEvent::Item {
            turn_id,
            item: item("a", "partial answer"),
        })
        .unwrap();

    // The adapter's sender vanishes without a terminal event: a crashed
    // process, not a graceful stop. Both clones have to go — the test's
    // and the fake session's — for the channel to actually close.
    live.agent.lock().await.take();
    drop(events);
    eventually("noticed the adapter was gone", async || {
        live.active_round
            .lock()
            .await
            .as_ref()
            .is_some_and(|round| round.outcome.is_some())
    })
    .await;

    let round = live
        .active_round
        .lock()
        .await
        .clone()
        .expect("the round from `send` is still there");
    assert_eq!(round.outcome, Some(RoundOutcome::Failed));
    assert_eq!(
        *live.status.lock().await,
        genehub_proto::SessionStatus::Failed,
        "a session must not stay stuck on Running with no process left"
    );

    let on_disk = sessions.store.load_chat("w1", "s1").unwrap().items;
    assert!(
        on_disk.iter().any(|stored| stored.id() == "a"),
        "the item produced before the crash must still reach disk"
    );

    let rounds = sessions.store.load_chat("w1", "s1").unwrap().rounds;
    assert_eq!(
        rounds.len(),
        1,
        "the empty-looking round must still be ledgered"
    );
    assert_eq!(rounds[0].outcome, Some(RoundOutcome::Failed));
    assert!(
        rounds[0].user_item_id.is_some(),
        "the round must still name the request it was answering"
    );
}

/// Sessions belong to the code they are about, so they are written inside
/// the workspace rather than in the daemon's data directory — and the
/// directory they land in keeps itself out of the project's own history.
#[tokio::test]
async fn a_session_is_written_inside_its_workspace_without_showing_up_in_it() {
    let workspace = tempfile::tempdir().unwrap();
    let sessions = manager(workspace.path());

    sessions.store.save_meta(&meta()).unwrap();
    sessions
        .store
        .append_chat_items("w1", "s1", &[item("a", "hi")])
        .unwrap();

    let home = workspace.path().join(".genethub");
    let session = home.join("sessions").join("s1");
    assert!(
        session.join("chat.jsonl").exists(),
        "the conversation is kept with the project it is about"
    );
    assert_eq!(
        std::fs::read_to_string(home.join(".gitignore")).unwrap(),
        "*\n",
        "a user's own `git status` must not fill up with session files"
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        // Every level, not just the outermost: this lives in the user's own
        // folder, whose permissions are theirs to loosen.
        for directory in [&home, &home.join("sessions"), &session] {
            assert_eq!(
                directory.metadata().unwrap().permissions().mode() & 0o777,
                0o700,
                "{} is readable by other local accounts",
                directory.display()
            );
        }
    }
}

#[tokio::test]
async fn another_build_of_genehub_finds_the_sessions_in_a_shared_project() {
    let workspace = tempfile::tempdir().unwrap();
    let beta = manager(workspace.path());
    beta.store.save_meta(&meta()).unwrap();
    beta.store
        .append_chat_items("w1", "s1", &[item("a", "hi")])
        .unwrap();

    let written = std::fs::read_to_string(
        workspace
            .path()
            .join(".genethub/sessions/s1")
            .join("meta.json"),
    )
    .unwrap();
    assert!(
        !written.contains("workspaceId"),
        "an id minted by this installation means nothing to the next one: {written}"
    );
    assert!(
        written.contains(&format!("\"format\": {SESSION_FORMAT}")),
        "nothing says what shape this was written in: {written}"
    );

    // The other build knows the same folder under an id of its own: the id
    // is minted per installation, the folder is the durable fact.
    let release = SessionManager::new(
        {
            let homes = crate::session::WorkspaceHomes::default();
            homes.attach("w_other", workspace.path());
            Store::new(homes)
        },
        Arc::new(Registry::new(&std::collections::BTreeMap::new())),
        16,
    );

    let listed = release.list(Some("w_other"), false).await.unwrap();
    assert_eq!(
        listed.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        ["s1"],
        "a conversation stored in the project was invisible to the other build"
    );
    assert_eq!(
        release.snapshot("s1").await.unwrap().items.len(),
        1,
        "the other build listed the conversation but could not read it"
    );
}

#[tokio::test]
async fn a_session_from_a_newer_build_is_listed_but_refused() {
    let workspace = tempfile::tempdir().unwrap();
    let sessions = manager(workspace.path());
    sessions.store.save_meta(&meta()).unwrap();

    let meta_path = workspace
        .path()
        .join(".genethub/sessions/s1")
        .join("meta.json");
    let written = SESSION_FORMAT + 1;
    std::fs::write(
        &meta_path,
        format!(r#"{{"format":{written},"title":"来自未来","whatIsThis":[1,2]}}"#),
    )
    .unwrap();

    let listed = sessions.list(None, false).await.unwrap();
    let [session] = listed.as_slice() else {
        panic!("a conversation in the user's own folder vanished from the list: {listed:?}");
    };
    assert_eq!(session.title.as_deref(), Some("来自未来"));
    assert_eq!(
        session.unsupported,
        Some(genehub_proto::UnsupportedFormat {
            written,
            supported: SESSION_FORMAT,
        }),
        "the row gives the user no way to tell why it will not open"
    );

    let refused = sessions.snapshot("s1").await.unwrap_err().to_string();
    assert!(
        refused.contains(&written.to_string()),
        "reading a layout this build predates would show the wrong thing: {refused}"
    );
}

#[tokio::test]
async fn builds_share_a_project_but_only_one_writes_each_session() {
    let workspace = tempfile::tempdir().unwrap();
    let holder = manager(workspace.path());
    holder.store.save_meta(&meta()).unwrap();

    let other = manager(workspace.path());
    let mut independent = meta();
    independent.id = "s2".into();
    independent.title = Some("independent".into());
    other.store.save_meta(&independent).unwrap();
    assert!(
        workspace
            .path()
            .join(".genethub/sessions/s2/meta.json")
            .is_file(),
        "another channel could not create or write an independent session"
    );

    let refused = other.store.save_meta(&meta()).unwrap_err().to_string();
    assert!(
        refused.contains(crate::channel::PRODUCT),
        "the second build must name who is writing the session: {refused}"
    );
    assert!(
        refused.contains("Fork from a completed turn"),
        "the refusal gives no continuation path: {refused}"
    );
    assert_eq!(
        other.list(None, false).await.unwrap().len(),
        2,
        "losing the write lock must not hide the conversations"
    );

    drop(holder);
    // Claiming is retried on every write, so writing resumes on its own
    // rather than at the next restart. Given a moment, because a child
    // process spawned anywhere in this test binary briefly inherits the
    // descriptor the departing build was holding.
    let mut resumed = other.store.save_meta(&meta());
    for _ in 0..40 {
        if resumed.is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        resumed = other.store.save_meta(&meta());
    }
    resumed.expect("the second build had to be restarted to write the session again");
}

#[test]
fn stale_runtime_choices_are_reconciled_before_agent_start() {
    let mut session = meta();
    session.model_id = Some("grok-4.6[effort=high,fast=false]".into());
    session.mode_id = Some("withdrawn-mode".into());
    session.effort_id = Some("withdrawn-effort".into());
    session.runtime_values.insert("fast".into(), "max".into());
    session
        .runtime_values
        .insert("withdrawn-axis".into(), "on".into());

    let catalog = Catalog {
        models: vec![genehub_proto::ModelInfo {
            id: "grok-4.6".into(),
            label: "Grok 4.6".into(),
            context_window: None,
            reasoning: true,
            efforts: vec!["medium".into(), "high".into()],
            input_modalities: None,
            supports_fast: true,
        }],
        modes: vec![genehub_proto::ModeInfo {
            id: "agent".into(),
            label: "Agent".into(),
            description: None,
            unattended: false,
        }],
        commands: Vec::new(),
        runtime_axes: Some(vec![genehub_proto::RuntimeAxisInfo {
            id: "fast".into(),
            label: "Fast".into(),
            description: None,
            values: vec![
                genehub_proto::RuntimeAxisValue {
                    id: "standard".into(),
                    label: "标准".into(),
                    description: None,
                },
                genehub_proto::RuntimeAxisValue {
                    id: "fast".into(),
                    label: "快速".into(),
                    description: None,
                },
                genehub_proto::RuntimeAxisValue {
                    id: "max".into(),
                    label: "极速".into(),
                    description: None,
                },
            ],
            default_value: Some("standard".into()),
        }]),
        default_model: Some("grok-4.6".into()),
        default_mode: Some("agent".into()),
        default_effort: Some("medium".into()),
    };

    assert!(normalize_runtime_selection(&mut session, &catalog,));
    assert_eq!(session.model_id.as_deref(), Some("grok-4.6"));
    assert_eq!(session.mode_id.as_deref(), Some("agent"));
    assert_eq!(session.effort_id.as_deref(), Some("medium"));
    assert_eq!(
        session.runtime_values.get("fast").map(String::as_str),
        Some("max")
    );
    assert!(!session.runtime_values.contains_key("withdrawn-axis"));
}

#[test]
fn a_catalog_probe_failure_does_not_erase_opaque_runtime_choices() {
    let mut session = meta();
    session.model_id = Some("agent-owned-model".into());
    session.effort_id = Some("agent-owned-effort".into());
    session.runtime_values.insert("fast".into(), "max".into());
    let before = session.clone();

    assert!(!normalize_runtime_selection(
        &mut session,
        &Catalog::default(),
    ));
    assert_eq!(session.model_id, before.model_id);
    assert_eq!(session.effort_id, before.effort_id);
    assert_eq!(session.runtime_values, before.runtime_values);
}

#[tokio::test]
async fn set_fast_validates_adapter_and_model_capabilities() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = SessionManager::new(
        test_store(dir.path()),
        Arc::new(Registry::of(vec![Arc::new(TestAdapter::Amnesiac)])),
        16,
    );
    let summary = sessions
        .create(
            "w1",
            dir.path().to_path_buf(),
            "amnesiac",
            None,
            None,
            None,
            None,
            Default::default(),
            None,
        )
        .await
        .unwrap();

    // Amnesiac does not have set_fast capability
    let err = sessions
        .set_fast(&summary.id, true, &ProviderMap::new())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("does not support fast mode"));
}

#[tokio::test]
async fn event_pump_records_agent_failure_without_the_runtime_message() {
    let dir = tempfile::tempdir().unwrap();
    let store = test_store(dir.path());
    let live = Arc::new(Live::new(meta(), store.clone()));
    live.begin_round(None, "t", "u0").await;
    let mut execution = live.claim_execution(None).await.unwrap().unwrap();
    execution.turn_id = Some("t".into());
    execution.phase = ExecutionPhase::Running;
    execution.ready.send_replace(true);
    *live.execution.lock().await = Some(execution);
    let (agent_events, agent_rx) = crate::adapter::EventTx::channel();
    let mut seen = live.events.subscribe();
    let diagnostics = Arc::new(Diagnostics::new());
    let pump = tokio::spawn(pump_events(
        live,
        agent_rx,
        store,
        64,
        crate::processes::Processes::new(),
        diagnostics.clone(),
        Some(crate::project_control::Broker::new(dir.path()).unwrap()),
    ));

    agent_events
        .send(SessionEvent::TurnStarted {
            turn_id: "t".into(),
            started_at_ms: now_ms(),
        })
        .unwrap();
    agent_events
        .send(SessionEvent::TurnFailed {
            turn_id: "t".into(),
            error: genehub_proto::TurnError {
                code: TurnErrorCode::RateLimited,
                message: "secret prompt and provider response".into(),
            },
        })
        .unwrap();
    loop {
        if matches!(
            seen.recv().await.unwrap().event,
            SessionEvent::TurnFailed { .. }
        ) {
            break;
        }
    }

    let snapshot = diagnostics.snapshot(
        "test",
        &genehub_proto::HubStatus::Unpaired,
        &genehub_proto::RemoteAccess {
            relay_url: None,
            rendezvous_url: None,
            online: false,
        },
    );
    let encoded = serde_json::to_string(&snapshot).unwrap();
    assert!(snapshot.events.iter().any(|event| {
        event.component == "agent"
            && event.operation == "turn"
            && event.outcome == "error"
            && event.code.as_deref() == Some("rateLimited")
    }));
    assert!(!encoded.contains("secret prompt"));
    pump.abort();
}

#[tokio::test]
async fn turn_summary_records_starting_runtime_across_in_flight_model_changes() {
    let dir = tempfile::tempdir().unwrap();
    let store = test_store(dir.path());
    let mut session_meta = meta();
    session_meta.agent_id = "codex".into();
    session_meta.model_id = Some("model-a".into());
    let live = Arc::new(Live::new(session_meta, store.clone()));
    live.begin_round(None, "t1", "u0").await;
    let mut execution = live.claim_execution(None).await.unwrap().unwrap();
    execution.turn_id = Some("t1".into());
    execution.phase = ExecutionPhase::Running;
    execution.ready.send_replace(true);
    *live.execution.lock().await = Some(execution);

    let (agent_events, agent_rx) = crate::adapter::EventTx::channel();
    let mut seen = live.events.subscribe();
    let diagnostics = Arc::new(Diagnostics::new());

    let pump = tokio::spawn(pump_events(
        live.clone(),
        agent_rx,
        store,
        64,
        crate::processes::Processes::new(),
        diagnostics.clone(),
        None,
    ));

    // Start turn with model-a
    agent_events
        .send(SessionEvent::TurnStarted {
            turn_id: "t1".into(),
            started_at_ms: now_ms(),
        })
        .unwrap();

    // Wait until pump_events has processed TurnStarted
    loop {
        if matches!(
            seen.recv().await.unwrap().event,
            SessionEvent::TurnStarted { .. }
        ) {
            break;
        }
    }

    // While turn is running, model changes to model-b in live meta
    {
        let mut meta = live.meta.lock().await;
        meta.model_id = Some("model-b".into());
    }

    // Turn completes
    agent_events
        .send(SessionEvent::TurnCompleted {
            turn_id: "t1".into(),
            usage: Usage::default(),
            fork_checkpoint: None,
        })
        .unwrap();

    let turn_summary_stats;
    loop {
        let event = seen.recv().await.unwrap().event;
        if let SessionEvent::Item {
            item: TimelineItem::TurnSummary { stats, .. },
            ..
        } = event
        {
            turn_summary_stats = stats;
            break;
        }
    }

    let stats = turn_summary_stats;
    assert_eq!(stats.turn_id, "t1");
    assert_eq!(stats.agent_id.as_deref(), Some("codex"));
    // Must be model-a from when the turn started, NOT model-b
    assert_eq!(stats.model_id.as_deref(), Some("model-a"));

    pump.abort();
}

type RecordedPrompts = Arc<std::sync::Mutex<Vec<PromptInput>>>;

enum SessionBehavior {
    Blank,
    Fork {
        id: &'static str,
        native: bool,
        prompts: RecordedPrompts,
    },
    Stop {
        interrupted: Arc<AtomicBool>,
        closed: Arc<AtomicBool>,
    },
    Record(RecordedPrompts),
    Driven {
        refuses: bool,
    },
}

/// One configurable session fixture. Behavior-specific facts are configured
/// explicitly; the common adapter contract is implemented only once.
struct TestSession {
    behavior: SessionBehavior,
    events: Option<crate::adapter::EventTx>,
    next_turn: Arc<AtomicU64>,
}

impl TestSession {
    fn new(behavior: SessionBehavior) -> Self {
        Self {
            behavior,
            events: None,
            next_turn: Arc::default(),
        }
    }
    fn blank() -> Self {
        Self::new(SessionBehavior::Blank)
    }
    fn fork(id: &'static str, native: bool, prompts: RecordedPrompts) -> Self {
        Self::new(SessionBehavior::Fork {
            id,
            native,
            prompts,
        })
    }
    fn stopping(interrupted: Arc<AtomicBool>, closed: Arc<AtomicBool>) -> Self {
        Self::new(SessionBehavior::Stop {
            interrupted,
            closed,
        })
    }
    fn recording(prompts: RecordedPrompts) -> Self {
        Self::new(SessionBehavior::Record(prompts))
    }
    fn sharing(events: crate::adapter::EventTx, next_turn: Arc<AtomicU64>) -> Self {
        Self {
            behavior: SessionBehavior::Driven { refuses: false },
            events: Some(events),
            next_turn,
        }
    }
    fn refusing(events: crate::adapter::EventTx) -> Self {
        Self {
            behavior: SessionBehavior::Driven { refuses: true },
            events: Some(events),
            next_turn: Arc::default(),
        }
    }
    fn settings(&self) -> Result<()> {
        match self.behavior {
            SessionBehavior::Blank | SessionBehavior::Fork { .. } => Ok(()),
            _ => bail!("not used"),
        }
    }
}

#[async_trait::async_trait]
impl AgentSession for TestSession {
    fn events(&self) -> crate::adapter::EventRx {
        let _held = &self.events;
        crate::adapter::EventTx::channel().1
    }
    async fn send(&self, input: PromptInput) -> Result<String> {
        match &self.behavior {
            SessionBehavior::Blank => Ok("t1".into()),
            SessionBehavior::Fork { prompts, .. } => {
                let mut prompts = prompts.lock().unwrap();
                prompts.push(input);
                Ok(format!("turn-{}", prompts.len()))
            }
            SessionBehavior::Stop { .. } => bail!("not used"),
            SessionBehavior::Record(prompts) => {
                prompts.lock().unwrap().push(input);
                Ok("t-resumed".into())
            }
            SessionBehavior::Driven { refuses: true } => {
                bail!("the agent stopped before it was ready")
            }
            SessionBehavior::Driven { refuses: false } => Ok(format!(
                "t{}",
                self.next_turn.fetch_add(1, Ordering::SeqCst)
            )),
        }
    }
    async fn interrupt(&self) -> Result<()> {
        if let SessionBehavior::Stop { interrupted, .. } = &self.behavior {
            interrupted.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
    async fn close(&self) -> Result<()> {
        if let SessionBehavior::Stop { closed, .. } = &self.behavior {
            closed.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
    async fn set_model(&self, _model_id: &str) -> Result<()> {
        self.settings()
    }
    async fn set_mode(&self, _mode_id: &str) -> Result<()> {
        self.settings()
    }
    async fn fork(&self, checkpoint: &str) -> Result<PersistHandle> {
        if let SessionBehavior::Fork { id, native, .. } = &self.behavior {
            if !native {
                bail!("native fork disabled");
            }
            Ok(PersistHandle {
                agent_id: (*id).into(),
                value: serde_json::json!({"checkpoint":checkpoint}),
            })
        } else {
            return Err(crate::rpc_error::failure(
                genehub_proto::ErrorCode::Unsupported,
                "this agent does not support forking".to_owned(),
            ));
        }
    }
    fn persistence(&self) -> Option<PersistHandle> {
        matches!(self.behavior, SessionBehavior::Stop { .. }).then(|| PersistHandle {
            agent_id: "fake".into(),
            value: serde_json::json!({"sessionId":"native-1"}),
        })
    }
}
