use super::*;

impl SessionManager {
    pub(crate) async fn withdraw_workflow_question(
        &self,
        session_id: &str,
        request_id: &str,
    ) -> Result<()> {
        let live = self.live(session_id).await?;
        let _interaction = live.interaction_lock.lock().await;
        let mut meta = live.meta.lock().await;
        if let Some(outcome) = meta
            .human_receipts
            .iter()
            .find(|r| r.id == request_id)
            .map(|r| &r.outcome)
        {
            if *outcome == PermissionOutcome::Canceled {
                return Ok(());
            }
            bail!("Human decision already recorded; cannot withdraw an answered proposal");
        }
        let wait = meta
            .human_wait
            .as_ref()
            .filter(|w| w.id == request_id)
            .ok_or_else(|| anyhow!("pending Workflow question changed; read the current card"))?;
        if wait.decision.is_some() {
            bail!("Human decision already recorded; cannot withdraw an answered proposal");
        }
        if !matches!(
            wait.origin,
            crate::session::store::WaitOrigin::Workflow { .. }
        ) {
            bail!("only an unanswered Workflow proposal may be withdrawn");
        }
        let request = wait
            .request
            .clone()
            .ok_or_else(|| anyhow!("Workflow question has no request"))?;
        let mut next = meta.clone();
        crate::session::store::decide_human_wait(
            &mut next,
            request,
            PermissionOutcome::Canceled,
            false,
        );
        crate::session::store::retain_human_receipt(&mut next, request_id);
        next.human_wait = None;
        self.store.save_meta(&next)?;
        *meta = next;
        drop(meta);
        let event = SessionEvent::PermissionResolved {
            request_id: request_id.into(),
            outcome: PermissionOutcome::Canceled,
        };
        apply(&live, &event).await;
        live.publish(event).await;
        Ok(())
    }

    pub(crate) async fn workflow_question_outcome(
        &self,
        session_id: &str,
        request_id: &str,
    ) -> Result<Option<PermissionOutcome>> {
        let live = self.live(session_id).await?;
        let meta = live.meta.lock().await;
        let decided = meta
            .human_wait
            .as_ref()
            .filter(|wait| wait.id == request_id)
            .and_then(|wait| wait.decision.as_ref())
            .map(|decision| decision.outcome.clone());
        Ok(decided.or_else(|| {
            meta.human_receipts
                .iter()
                .find(|receipt| receipt.id == request_id)
                .map(|receipt| receipt.outcome.clone())
        }))
    }

    pub async fn respond_permission(
        &self,
        session_id: &str,
        request_id: &str,
        outcome: PermissionOutcome,
        _providers: &ProviderMap,
    ) -> Result<()> {
        let live = self.live(session_id).await?;
        let _interaction = live.interaction_lock.lock().await;
        let previous = live.meta.lock().await.human_wait.clone();
        if previous.as_ref().is_none_or(|wait| wait.id != request_id) {
            if let Some(receipt) = live
                .meta
                .lock()
                .await
                .human_receipts
                .iter()
                .find(|receipt| receipt.id == request_id)
            {
                if receipt.outcome != outcome {
                    return Err(crate::rpc_error::failure(
                        genehub_proto::ErrorCode::Conflict,
                        "this interaction already has a different Human decision".into(),
                    ));
                }
                return Ok(());
            }
        }
        if let Some(wait) = previous {
            if wait.id == request_id {
                if let Some(decision) = &wait.decision {
                    if decision.outcome != outcome {
                        return Err(crate::rpc_error::failure(
                            genehub_proto::ErrorCode::Conflict,
                            "this interaction already has a different Human decision".into(),
                        ));
                    }
                    if matches!(
                        wait.origin,
                        crate::session::store::WaitOrigin::Project { .. }
                    ) {
                        self.project_control
                            .as_ref()
                            .ok_or_else(|| anyhow!("project approval authority unavailable"))?
                            .record_human_response(session_id, request_id, &outcome)
                            .await?;
                    }
                    self.record_workflow_response(&live, &wait, &outcome)
                        .await?;
                    if *live.status.lock().await == SessionStatus::Failed {
                        let mut meta = live.meta.lock().await;
                        let mut next = meta.clone();
                        next.inbox.set_pause(None);
                        next.inbox.error = None;
                        self.store.save_meta(&next)?;
                        *meta = next;
                        *live.status.lock().await = SessionStatus::Waiting;
                    }
                    self.queue_human_input(&live).await?;
                    return Ok(());
                }
            }
        }
        let request = live
            .meta
            .lock()
            .await
            .human_wait
            .as_ref()
            .filter(|wait| wait.id == request_id && wait.decision.is_none())
            .and_then(|wait| wait.request.clone())
            .ok_or_else(|| anyhow!("no pending interaction called '{request_id}'"))?;

        let continues = continuation_for(&request, &outcome)?.is_some();
        let project_approval = live
            .meta
            .lock()
            .await
            .human_wait
            .as_ref()
            .is_some_and(|wait| {
                matches!(
                    wait.origin,
                    crate::session::store::WaitOrigin::Project { .. }
                )
            });
        if project_approval {
            self.project_control
                .as_ref()
                .ok_or_else(|| anyhow!("project approval authority unavailable"))?
                .validate_human_response(session_id, request_id, &outcome)
                .await?;
        }
        let mut meta = live.meta.lock().await;
        let mut next = meta.clone();
        next.format = SESSION_FORMAT;
        crate::session::store::decide_human_wait(
            &mut next,
            request.clone(),
            outcome.clone(),
            project_approval,
        );
        // An explicit accepted answer is a new continuation instruction.
        // Ordinary Workflow notices still respect an existing inbox pause.
        // Persist this once with the answer; replaying a receipt must not
        // undo a later user stop. Cancelling a question is not a resume.
        if continues {
            next.inbox.set_pause(None);
            next.inbox.error = None;
        }
        self.store.save_meta(&next)?;
        *meta = next;
        drop(meta);
        if project_approval {
            self.project_control
                .as_ref()
                .expect("validated project authority")
                .record_human_response(session_id, request_id, &outcome)
                .await?;
        }
        let decided = live
            .meta
            .lock()
            .await
            .human_wait
            .clone()
            .expect("decision was persisted");
        self.record_workflow_response(&live, &decided, &outcome)
            .await?;
        self.queue_human_input(&live).await?;
        let resolved = SessionEvent::PermissionResolved {
            request_id: request_id.into(),
            outcome,
        };
        apply(&live, &resolved).await;
        live.publish(resolved).await;
        if live.execution.lock().await.is_none() {
            *live.status.lock().await = SessionStatus::Waiting;
            live.publish(SessionEvent::SessionStatusChanged {
                status: SessionStatus::Waiting,
            })
            .await;
        }
        tracing::info!(
            event = "human_continuation_queued",
            session = session_id,
            request = request_id
        );
        Ok(())
    }

    async fn record_workflow_response(
        &self,
        live: &Live,
        wait: &crate::session::store::HumanWait,
        outcome: &PermissionOutcome,
    ) -> Result<()> {
        let meta = live.meta.lock().await;
        let project_root = self.store.workspace_root(&meta.workspace_id)?;
        let crate::session::store::WaitOrigin::Workflow { run_id } = &wait.origin else {
            return Ok(());
        };
        let data_root = self
            .workflow_data_root
            .as_ref()
            .ok_or_else(|| anyhow!("Workflow approval authority unavailable"))?;
        crate::workflow::record_human_response(
            data_root,
            &meta.workspace_id,
            &project_root,
            run_id,
            &meta.id,
            &wait.id,
            outcome,
        )
    }

    /// Persist and stop before exposing the Human card. The CLI is a submission,
    /// never a waiter or an approval result channel.
    pub async fn request_project_approval(
        &self,
        session_id: &str,
        mut request: PermissionRequest,
    ) -> Result<()> {
        crate::session::store::normalize_human_request(
            &mut request,
            crate::session::store::WaitAuthor::Daemon,
        );
        if request.kind != PermissionRequestKind::PlanApproval {
            bail!("expected a daemon-authored plan approval");
        }
        let live = self.live(session_id).await?;
        let _interaction = live.interaction_lock.lock().await;
        {
            let pending = live.visible_permissions().await;
            if pending.iter().any(|p| p.id == request.id) {
                return Ok(());
            }
            if !pending.is_empty() {
                bail!("answer or cancel the pending Agent interaction first");
            }
        }
        if let Err(error) = stop_agent_for_interaction(&live, &self.store, &request, true).await {
            let message = format!("{error:#}");
            fail_human_pause(&live, &self.store, error).await;
            return Err(anyhow!(message));
        }
        // Stop and drain the same writer before releasing this execution.
        live.stop_pump().await?;
        let mut owner = live.execution.lock().await;
        let turn = owner
            .as_ref()
            .and_then(|execution| execution.turn_id.clone());
        if let Some(turn_id) = turn {
            live.publish(SessionEvent::TurnCanceled { turn_id }).await;
        }
        live.finish_execution(
            &mut owner,
            SessionEvent::PermissionRequested { request },
            false,
        )
        .await?;
        Ok(())
    }

    /// Daemon-authored Workflow handoffs use the same durable native question
    /// path as Agent questions. The normal PM Session is controlled by Human.
    pub(crate) async fn request_workflow_question(
        &self,
        session_id: &str,
        request: PermissionRequest,
    ) -> Result<()> {
        self.request_workflow_question_inner(session_id, None, request)
            .await
    }

    pub(crate) async fn request_workflow_question_for_run(
        &self,
        session_id: &str,
        run_id: &str,
        request: PermissionRequest,
    ) -> Result<()> {
        self.request_workflow_question_inner(session_id, Some(run_id), request)
            .await
    }

    async fn request_workflow_question_inner(
        &self,
        session_id: &str,
        run_id: Option<&str>,
        mut request: PermissionRequest,
    ) -> Result<()> {
        crate::session::store::normalize_human_request(
            &mut request,
            crate::session::store::WaitAuthor::Daemon,
        );
        if request.kind != PermissionRequestKind::Question {
            bail!("expected a Workflow question");
        }
        let live = self.live(session_id).await?;
        let _interaction = live.interaction_lock.lock().await;
        if let Some(run_id) = run_id {
            let meta = live.meta.lock().await;
            let data_root = self
                .workflow_data_root
                .as_ref()
                .ok_or_else(|| anyhow!("Workflow approval authority unavailable"))?;
            if !crate::workflow::human_question_pending(
                data_root,
                &meta.workspace_id,
                &self.store.workspace_root(&meta.workspace_id)?,
                run_id,
                session_id,
                &request.id,
            )? {
                return Ok(());
            }
        }

        {
            let pending = live.visible_permissions().await;
            if pending.iter().any(|item| item.id == request.id) {
                return Ok(());
            }
            if !pending.is_empty() {
                bail!("answer the current Human interaction before this Workflow question");
            }
        }
        if live
            .meta
            .lock()
            .await
            .human_wait
            .as_ref()
            .is_some_and(|wait| wait.id == request.id && wait.decision.is_some())
        {
            return Ok(());
        }
        if let Err(error) = stop_agent_for_interaction_with_origin(
            &live,
            &self.store,
            &request,
            false,
            Some(crate::session::store::WaitOrigin::Workflow {
                run_id: run_id.map(str::to_owned).unwrap_or_else(|| {
                    request
                        .id
                        .strip_prefix("workflow-human-")
                        .unwrap_or(&request.id)
                        .split("-decision-")
                        .next()
                        .unwrap_or(&request.id)
                        .to_string()
                }),
            }),
        )
        .await
        {
            let message = format!("{error:#}");
            fail_human_pause(&live, &self.store, error).await;
            return Err(anyhow!(message));
        }
        live.stop_pump().await?;
        let mut owner = live.execution.lock().await;
        if let Some(turn_id) = owner
            .as_ref()
            .and_then(|execution| execution.turn_id.clone())
        {
            live.publish(SessionEvent::TurnCanceled { turn_id }).await;
        }
        live.finish_execution(
            &mut owner,
            SessionEvent::PermissionRequested { request },
            false,
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn human_origin_of(
        &self,
        session_id: &str,
        request_id: &str,
    ) -> Result<Option<crate::session::store::WaitOrigin>> {
        let live = self.live(session_id).await?;
        let meta = live.meta.lock().await;
        Ok(meta
            .human_wait
            .as_ref()
            .filter(|wait| wait.id == request_id)
            .map(|wait| wait.origin.clone())
            .or_else(|| {
                meta.human_receipts
                    .iter()
                    .find(|receipt| receipt.id == request_id)
                    .map(|receipt| receipt.origin.clone())
            }))
    }

    #[cfg(test)]
    pub(crate) async fn human_wait_of(
        &self,
        session_id: &str,
    ) -> Result<Option<crate::session::store::HumanWait>> {
        let live = self.live(session_id).await?;
        let wait = live.meta.lock().await.human_wait.clone();
        Ok(wait)
    }

    pub(crate) async fn cancel_workflow_question(
        &self,
        session_id: &str,
        request_id: &str,
    ) -> Result<()> {
        let live = match self.live(session_id).await {
            Ok(live) => live,
            Err(error) if error.is::<SessionMissing>() => return Ok(()),
            Err(error) => return Err(error),
        };
        let _interaction = live.interaction_lock.lock().await;
        if live
            .meta
            .lock()
            .await
            .human_wait
            .as_ref()
            .is_some_and(|wait| wait.id == request_id && wait.decision.is_none())
        {
            cancel_human_continuation(&live, &self.store).await?;
        }
        Ok(())
    }

    /// Called under the interaction lock by either delivery path. Authority is
    /// recorded once; a chat input can carry an already accepted decision, but
    /// can never synthesize one from a pending card.
    pub(super) async fn prepare_human_delivery(
        &self,
        live: &Arc<Live>,
    ) -> Result<Option<(String, Continuation)>> {
        let Some(wait) = live
            .meta
            .lock()
            .await
            .human_wait
            .clone()
            .filter(|wait| wait.decision.is_some() && wait.request.is_some())
        else {
            return Ok(None);
        };
        let request = wait.request.clone().expect("filtered");
        let outcome = wait.decision.as_ref().expect("filtered").outcome.clone();
        let project = matches!(
            wait.origin,
            crate::session::store::WaitOrigin::Project { .. }
        );
        if project {
            let session = live.meta.lock().await.id.clone();
            self.project_control
                .as_ref()
                .ok_or_else(|| anyhow!("project approval authority unavailable"))?
                .record_human_response(&session, &request.id, &outcome)
                .await?;
        }
        self.record_workflow_response(live, &wait, &outcome).await?;
        if let Some(continuation) = continuation_for_wait(&wait)? {
            Ok(Some((request.id, continuation)))
        } else {
            // Denial cancels the interrupted task, not future queued messages.
            let turns = live
                .active_round
                .lock()
                .await
                .as_ref()
                .map(|round| round.adapter_turn_ids.clone())
                .unwrap_or_default();
            let mut meta = live.meta.lock().await;
            let mut next = meta.clone();
            for entry in &mut next.inbox.entries {
                if entry.state == "sent"
                    && entry
                        .turn_id
                        .as_ref()
                        .is_some_and(|turn| turns.contains(turn))
                {
                    entry.state = "handled".into();
                }
            }
            self.store.save_meta(&next)?;
            *meta = next;
            drop(meta);
            clear_human_wait(live, &self.store, &request.id).await?;
            if let Some(round) = live
                .settle_round(Settling::Kernel, RoundOutcome::Canceled)
                .await
            {
                persist_round(live, round).await;
            }
            *live.status.lock().await = SessionStatus::Idle;
            Ok(None)
        }
    }

    /// Formal decisions carry a durable execution obligation independently of
    /// the card: delivery ACK retires the card, completion retires this entry.
    pub(super) async fn queue_human_input(&self, live: &Arc<Live>) -> Result<()> {
        let wait = live.meta.lock().await.human_wait.clone();
        let Some(wait) = wait.filter(|wait| wait.decision.is_some()) else {
            return Ok(());
        };
        let Some(continuation) = continuation_for_wait(&wait)? else {
            return Ok(());
        };
        let round_id = live
            .active_round
            .lock()
            .await
            .as_ref()
            .filter(|round| round.outcome.is_none())
            .map(|round| round.round_id.clone());
        let _admission = live.inbox_lock.lock().await;
        let mut meta = live.meta.lock().await;
        let id = format!("decision_{:x}", Sha256::digest(wait.id.as_bytes()));
        if meta
            .inbox
            .entries
            .iter()
            .any(|entry| entry.message_id == id)
        {
            return Ok(());
        }
        let mut next = meta.clone();
        super::inbox::retain_receipt_window(&mut next.inbox);
        next.inbox.entries.push(crate::session::store::InboxEntry {
            message_id: id,
            received_at_ms: now_ms(),
            digest: format!("{:x}", Sha256::digest(continuation.prompt.as_bytes())),
            source: "human".into(),
            task_run_id: None,
            state: "queued".into(),
            turn_id: None,
            kernel_input: Some(continuation.prompt),
            continues_round: round_id,
        });
        super::inbox::retain_receipt_window(&mut next.inbox);
        next.inbox.set_pause(None);
        next.inbox.error = None;
        self.store.save_meta(&next)?;
        *meta = next;
        Ok(())
    }

    pub(crate) async fn pending_questions(
        &self,
        session_id: &str,
    ) -> Result<Vec<PermissionRequest>> {
        let live = self.live(session_id).await?;
        let requests = live.visible_permissions().await;
        Ok(requests.into_iter().take(16).collect())
    }

    pub async fn pending_permission_kind(
        &self,
        session_id: &str,
        request_id: &str,
    ) -> Result<Option<PermissionRequestKind>> {
        let live = self.live(session_id).await?;
        let kind = live
            .visible_permissions()
            .await
            .into_iter()
            .find(|request| request.id == request_id)
            .map(|request| request.kind);
        let answer = kind.or(live
            .meta
            .lock()
            .await
            .human_wait
            .as_ref()
            .filter(|wait| wait.id == request_id)
            .and_then(|wait| wait.request.as_ref())
            .map(|request| request.kind));
        Ok(answer)
    }
}

fn continuation_for_wait(wait: &crate::session::store::HumanWait) -> Result<Option<Continuation>> {
    let (Some(request), Some(decision)) = (&wait.request, &wait.decision) else {
        return Ok(None);
    };
    let mut continuation = continuation_for(request, &decision.outcome)?;
    if let Some(continuation) = &mut continuation {
        if matches!(
            wait.origin,
            crate::session::store::WaitOrigin::Project { .. }
        ) {
            continuation.prompt.push_str(&format!(
                "\nDurable GeneHub interaction {}. Plan details:\n{}\nOnly if approved, use action ID {} for the mutation and any retry. Inspect existing results before acting; completed mutations must not be repeated.",
                request.id, request.description.as_deref().unwrap_or(""), request.id));
        }
    }
    Ok(continuation)
}

pub(super) fn continuation_for(
    request: &PermissionRequest,
    outcome: &PermissionOutcome,
) -> Result<Option<Continuation>> {
    match request.kind {
        PermissionRequestKind::Permission => {
            let Some(option) = selected_option(request, outcome)? else {
                return Ok(None);
            };
            if option.kind == PermissionOptionKind::Reject {
                return Ok(None);
            }
            Ok(Some(Continuation {
                elevated: true,
                prompt: format!(
                    "The user approved the interrupted permission request: {}. Resume the original \
                     task from the current conversation state and do not repeat completed work.",
                    option.label
                ),
            }))
        }
        PermissionRequestKind::PlanApproval => {
            let Some(option) = selected_option(request, outcome)? else {
                return Ok(None);
            };
            if option.kind == PermissionOptionKind::Reject {
                return Ok(Some(Continuation {
                    elevated: false,
                    prompt: format!(
                        "The user rejected the interrupted plan '{}'. Do not apply it or perform any of its mutations. Briefly confirm that no changes were made, then stop unless the user gives a different goal.",
                        request.title
                    ),
                }));
            }
            Ok(Some(Continuation {
                elevated: false,
                prompt: format!(
                    "The user approved the interrupted plan '{}'. Continue implementing that plan \
                     from the current conversation state and do not repeat completed work.",
                    request.title
                ),
            }))
        }
        PermissionRequestKind::Question => {
            let answer = question_answer(request, outcome)?;
            let Some(answer) = answer else {
                return Ok(None);
            };
            Ok(Some(Continuation {
                elevated: false,
                prompt: format!(
                    "The user answered the interrupted questions:\n{answer}\nResume the original \
                     task from the current conversation state and do not repeat completed work."
                ),
            }))
        }
    }
}

pub(super) fn selected_option<'a>(
    request: &'a PermissionRequest,
    outcome: &PermissionOutcome,
) -> Result<Option<&'a genehub_proto::PermissionOption>> {
    let PermissionOutcome::Selected { option_id } = outcome else {
        return Ok(None);
    };
    request
        .options
        .iter()
        .find(|option| option.id == *option_id)
        .map(Some)
        .ok_or_else(|| anyhow!("'{option_id}' is not an option for this interaction"))
}

pub(super) fn question_answer(
    request: &PermissionRequest,
    outcome: &PermissionOutcome,
) -> Result<Option<String>> {
    if let PermissionOutcome::Selected { option_id } = outcome {
        if request.options.is_empty() {
            let questions = request.questions.as_deref().unwrap_or_default();
            if let [question] = questions {
                let matches = question
                    .options
                    .iter()
                    .filter(|option| option.id == *option_id || option.label == *option_id)
                    .collect::<Vec<_>>();
                if let [option] = matches.as_slice() {
                    return Ok(Some(format!("- {}: {}", question.prompt, option.label)));
                }
            }
            bail!("'{option_id}' is not a unique option for this question");
        }
    }
    if let Some(option) = selected_option(request, outcome)? {
        return Ok(Some(format!("- {}: {}", request.title, option.label)));
    }
    let PermissionOutcome::Answered { answers } = outcome else {
        return Ok(None);
    };
    let mut lines = Vec::new();
    for question in request.questions.as_deref().unwrap_or_default() {
        let answer = answers
            .iter()
            .find(|answer| answer.question_id == question.id)
            .ok_or_else(|| anyhow!("question '{}' was not answered", question.id))?;
        if !question.allow_multiple && answer.selected_option_ids.len() > 1 {
            return Err(anyhow!(
                "question '{}' accepts only one option",
                question.id
            ));
        }
        let mut values = Vec::new();
        for option_id in &answer.selected_option_ids {
            let option = question
                .options
                .iter()
                .find(|option| option.id == *option_id)
                .ok_or_else(|| {
                    anyhow!(
                        "'{option_id}' is not an option for question '{}'",
                        question.id
                    )
                })?;
            values.push(option.label.clone());
        }
        let freeform = answer
            .freeform_text
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty());
        if freeform.is_some() && !question.allow_freeform {
            return Err(crate::rpc_error::failure(
                genehub_proto::ErrorCode::Unsupported,
                format!(
                    "question '{}' does not accept a free-form answer",
                    question.id
                ),
            ));
        }
        if let Some(text) = freeform {
            values.push(text.to_string());
        }
        if values.is_empty() {
            return Err(anyhow!("question '{}' has no answer", question.id));
        }
        lines.push(format!("- {}: {}", question.prompt, values.join(", ")));
    }
    Ok((!lines.is_empty()).then(|| lines.join("\n")))
}

pub(super) async fn stop_agent_for_interaction(
    live: &Arc<Live>,
    store: &Store,
    request: &PermissionRequest,
    project_approval: bool,
) -> Result<()> {
    stop_agent_for_interaction_with_origin(live, store, request, project_approval, None).await
}

pub(super) async fn stop_agent_for_interaction_with_origin(
    live: &Arc<Live>,
    store: &Store,
    request: &PermissionRequest,
    project_approval: bool,
    origin: Option<crate::session::store::WaitOrigin>,
) -> Result<()> {
    if live
        .meta
        .lock()
        .await
        .human_wait
        .as_ref()
        .is_some_and(|wait| wait.id != request.id && wait.decision.is_none())
    {
        bail!("a Human request is already pending; the new request cannot replace it");
    }
    live.card_held.store(true, Ordering::SeqCst);
    let _retirement = live.retirement.lock().await;
    let agent = live.agent().await;
    let persist = agent.as_ref().and_then(|agent| agent.persistence());
    {
        let mut meta = live.meta.lock().await;
        let mut next = meta.clone();
        if let Some(persist) = persist {
            next.persist = Some(persist);
        }
        next.format = SESSION_FORMAT;
        crate::session::store::install_human_wait(&mut next, request.clone(), project_approval);
        if let (Some(wait), Some(origin)) = (next.human_wait.as_mut(), origin) {
            wait.origin = origin;
            wait.author = crate::session::store::WaitAuthor::Daemon;
        }
        next.updated_at_ms = now_ms();
        store
            .save_meta(&next)
            .context("persisting Human pause before stopping Agent")?;
        *meta = next;
    }
    live.round_blocked().await;
    // Set Waiting before interrupt so a terminal event cannot complete the
    // business round while its Human interaction is being installed.
    *live.status.lock().await = SessionStatus::Waiting;
    if let Some(execution) = live.execution.lock().await.as_mut() {
        execution.phase = ExecutionPhase::Stopping;
    }
    if let Some(agent) = agent {
        let _ = tokio::time::timeout(Duration::from_secs(5), agent.interrupt()).await;
        close_current_agent(live).await?;
    }
    cancel_open_tools(live).await;
    // The durable request above fences the retiring turn. Expose its card
    // only after the Agent process is gone, including to snapshot readers.
    live.card_held.store(false, Ordering::SeqCst);
    *live.status.lock().await = SessionStatus::Waiting;
    tracing::info!(event = "human_interaction_stopped", request = %request.id);
    Ok(())
}

pub(super) async fn cancel_human_continuation(live: &Arc<Live>, store: &Store) -> Result<()> {
    let mut meta = live.meta.lock().await;
    let mut next = meta.clone();
    let pending = next.human_wait.as_ref().and_then(|wait| {
        if wait.decision.is_none() {
            wait.request.clone()
        } else {
            None
        }
    });
    next.human_wait = None;

    // Logical deletion already owns the durable outcome. Cleanup must not
    // attempt a metadata write across that tombstone.
    if !store.is_tombstoned(&next.workspace_id, &next.id) {
        store.save_meta(&next)?;
    }
    *meta = next;
    drop(meta);
    live.card_held.store(false, Ordering::SeqCst);
    if let Some(request) = pending {
        let event = SessionEvent::PermissionResolved {
            request_id: request.id,
            outcome: PermissionOutcome::Canceled,
        };
        apply(live, &event).await;
        live.publish(event).await;
    }
    Ok(())
}

pub(super) async fn fail_human_pause(live: &Arc<Live>, _store: &Store, error: anyhow::Error) {
    live.card_held.store(false, Ordering::SeqCst);
    tracing::error!(%error, "could not persist or stop Human interaction");
    let _retirement = live.retirement.lock().await;
    if close_current_agent(live).await.is_err() {
        return;
    }
    cancel_open_tools(live).await;
    let mut owner = live.execution.lock().await;
    let turn_id = owner
        .as_ref()
        .and_then(|execution| execution.turn_id.clone())
        .unwrap_or_default();
    let event = SessionEvent::TurnFailed {
        turn_id,
        error: genehub_proto::TurnError {
            code: TurnErrorCode::Internal,
            message: format!("无法完成待确认暂停，请检查请求与恢复状态：{error:#}"),
        },
    };
    if let Err(save_error) = live.finish_execution(&mut owner, event, false).await {
        tracing::error!(%save_error, "could not commit failed Human pause");
    }
}

pub(super) async fn clear_human_wait(live: &Live, store: &Store, request_id: &str) -> Result<()> {
    let mut meta = live.meta.lock().await;
    let mut next = meta.clone();
    if next
        .human_wait
        .as_ref()
        .is_some_and(|wait| wait.id == request_id)
    {
        crate::session::store::retain_human_receipt(&mut next, request_id);
        next.human_wait = None;
    }

    store.save_meta(&next)?;
    *meta = next;
    Ok(())
}

/// Once the agent acknowledged the input, a failed metadata write cannot undo
/// delivery or replay the decision. Retain the in-memory update for the pump's
/// next durable flush, as for ordinary accepted inbox messages.
pub(super) async fn acknowledge_human_delivery(live: &Live, store: &Store, request_id: &str) {
    let mut meta = live.meta.lock().await;
    if meta
        .human_wait
        .as_ref()
        .is_some_and(|wait| wait.id == request_id)
    {
        crate::session::store::retain_human_receipt(&mut meta, request_id);
        meta.human_wait = None;
        if let Err(error) = store.save_meta(&meta) {
            live.deferred_meta.store(true, Ordering::SeqCst);
            tracing::warn!(%error, "agent accepted Human decision; metadata will be retried");
        }
    }
}
