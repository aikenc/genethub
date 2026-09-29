use super::*;

/// Retire resources before releasing the execution claim. No newer send can
/// enter while close awaits; the session lock itself stays available to reads
/// and stop. A failed close keeps both the handle and the claim for retry.
pub(super) async fn retire_execution(
    live: &Arc<Live>,
    id: u64,
    error: Option<String>,
    closed: bool,
) -> Result<()> {
    {
        let mut owner = live.execution.lock().await;
        let Some(execution) = owner.as_mut().filter(|execution| execution.id == id) else {
            return Ok(());
        };
        execution.phase = ExecutionPhase::Stopping;
        execution.cancel.send_replace(true);
        execution.ready.send_replace(true);
    }
    if let Err(error) = live.stop_pump().await {
        report_cleanup_failure(live, &error).await;
        return Err(error);
    }
    // Joining a pump cannot hold retirement: a terminal already being handled
    // by that pump may itself be waiting to close the agent under this lock.
    let _retirement = live.retirement.lock().await;
    {
        let mut owner = live.execution.lock().await;
        if owner.as_ref().is_none_or(|execution| execution.id != id) {
            if closed && owner.is_none() {
                live.finish_execution(
                    &mut owner,
                    SessionEvent::SessionStatusChanged {
                        status: SessionStatus::Closed,
                    },
                    true,
                )
                .await?;
            }
            return Ok(());
        }
    }
    close_current_agent(live).await?;
    let mut owner = live.execution.lock().await;
    if owner.as_ref().is_none_or(|execution| execution.id != id) {
        return Ok(());
    }
    let turn_id = owner
        .as_ref()
        .and_then(|execution| execution.turn_id.clone())
        .unwrap_or_default();
    let event = match error {
        Some(message) => SessionEvent::TurnFailed {
            turn_id,
            error: genehub_proto::TurnError {
                code: TurnErrorCode::Internal,
                message,
            },
        },
        None => SessionEvent::TurnCanceled { turn_id },
    };
    live.finish_execution(&mut owner, event, closed).await
}

/// The caller holds retirement, never the execution lock, during agent IO.
pub(super) async fn close_current_agent(live: &Arc<Live>) -> Result<()> {
    let agent = live.agent().await;
    if let Some(agent) = agent {
        if let Err(error) = tokio::time::timeout(Duration::from_secs(8), agent.close())
            .await
            .unwrap_or_else(|_| Err(anyhow!("agent close timed out")))
        {
            report_cleanup_failure(live, &error).await;
            return Err(error);
        }
        live.agent.lock().await.take();
    }
    Ok(())
}

pub(super) async fn report_cleanup_failure(live: &Arc<Live>, error: &anyhow::Error) {
    let mut owner = live.execution.lock().await;
    if let Some(execution) = owner.as_mut() {
        execution.phase = ExecutionPhase::CleanupFailed;
    }
    // Keep Stop available. A cleanup error is not permission to send
    // another prompt into an execution whose process is still owned.
    *live.status.lock().await = SessionStatus::Running;
    live.publish(SessionEvent::SessionStatusChanged {
        status: SessionStatus::Running,
    })
    .await;
    live.publish(SessionEvent::Item {
        turn_id: owner
            .as_ref()
            .and_then(|execution| execution.turn_id.clone())
            .unwrap_or_default(),
        item: TimelineItem::Error {
            id: format!("cleanup-{}", now_ms()),
            message: format!("无法确认停止，请重试停止：{error}"),
        },
    })
    .await;
}

pub(super) async fn cancel_open_tools(live: &Arc<Live>) {
    let tools: Vec<_> = live
        .items
        .lock()
        .await
        .iter()
        .filter_map(|item| match item {
            TimelineItem::ToolCall {
                id,
                status: ToolStatus::Pending | ToolStatus::Running,
                ..
            } => Some(id.clone()),
            _ => None,
        })
        .collect();
    for item_id in tools {
        let event = SessionEvent::ItemDelta {
            turn_id: String::new(),
            item_id,
            delta: ItemDelta::ToolStatus {
                status: ToolStatus::Canceled,
                detail: None,
                images: Vec::new(),
            },
        };
        apply(live, &event).await;
        live.publish(event).await;
    }
}
