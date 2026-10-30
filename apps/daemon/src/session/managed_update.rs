//! Update handoff joins the existing inbox dispatcher, never a second sender.
use super::*;
use crate::state::Shared;
use genet_frontdoor::managed_update as records;
use records::{Continuation, Progress, Request};

impl SessionManager {
    pub(crate) async fn bind_update(&self, state: &Shared, request: &Request) -> Result<()> {
        let id = request
            .resume_session
            .as_ref()
            .ok_or_else(|| anyhow!("update has no continuation Session"))?;
        let live = self.live(id).await?;
        let _interaction = live.interaction_lock.lock().await;
        let meta = live.meta.lock().await;
        anyhow::ensure!(
            !meta.inbox.paused
                && *live.status.lock().await != SessionStatus::Closed
                && !live.closing.load(Ordering::SeqCst),
            "original Session was explicitly paused or closed"
        );
        let path = records::session_file(&state.paths.root, id)?;
        if let Ok(prior) = records::read::<Continuation>(&path) {
            if prior.request_id == request.request_id {
                return Ok(());
            }
            anyhow::ensure!(
                !matches!(prior.state.as_str(), "waiting" | "ready"),
                "Session already has an unfinished update handoff"
            );
        }
        records::write_continuation(
            &state.paths.root,
            &Continuation {
                request_id: request.request_id.clone(),
                session_id: id.clone(),
                state: "waiting".into(),
                error: None,
            },
        )
    }
    /// Returns true only while this Session is awaiting its update result.
    pub(super) async fn update_blocks_delivery(
        &self,
        state: &Shared,
        live: &Arc<Live>,
        session_id: &str,
    ) -> bool {
        // No new Session lock or metadata clone on normal delivery. Only an
        // actual waiting handoff joins the lifecycle of this Session.
        let Ok(path) = records::session_file(&state.paths.root, session_id) else {
            return false;
        };
        let Ok(mut c) = records::read::<Continuation>(&path) else {
            return false;
        };
        if c.state != "waiting" {
            return false;
        }
        let meta = live.meta.lock().await.clone();
        let result:Result<bool>=async {
            let dir=records::job(&state.paths.root,&c.request_id)?;
            let request:Request=records::read(&dir.join("request.json"))?;
            let progress:Progress=records::read(&dir.join("progress.json"))?;
            let closing=live.closing.load(Ordering::SeqCst);
            if meta.inbox.paused || (!closing && *live.status.lock().await==SessionStatus::Closed) {
                c.state="skipped".into();records::write_continuation(&state.paths.root,&c)?;return Ok(false);
            }
            // An old guest draining for reload is not a Human pause/close.
            // Leave its handoff for the next instance instead of retiring it.
            if closing {return Ok(true);}
            if !progress.terminal() {
                let heartbeat=records::read::<serde_json::Value>(&dir.join("heartbeat.json")).ok()
                    .and_then(|v|v["atMs"].as_u64()).unwrap_or(request.created_at_ms);
                if records::now_ms().saturating_sub(heartbeat)<120_000 {return Ok(true);}
                anyhow::bail!("update worker stopped reporting progress; inspect the original request before any retry");
            }
            let current=crate::cli_front::update_runtime();
            if current.instance_id==request.from.instance_id {
                // Preparation failed or there was no newer version. The
                // original execution still owns its input; do not send twice.
                c.state="notInterrupted".into();records::write_continuation(&state.paths.root,&c)?;return Ok(false);
            }
            if let Some(running)=&progress.running {
                anyhow::ensure!(running.instance_id==current.instance_id && running.component_version==current.component_version && running.app_version==current.app_version,"update result belongs to a different running daemon instance");
            }
            let has_inputs=meta.inbox.entries.iter().any(|e|matches!(e.state.as_str(),"queued"|"sent"));
            if !has_inputs {
                self.accept_input(&meta.id,format!("update-{:x}",Sha256::digest(c.request_id.as_bytes())),
                    format!("Software update {} has finished. Inspect its recorded result, then continue the original conversation goal. Do not repeat the installation.",c.request_id),
                    Vec::new(),None,"system",None).await?;
            }
            c.state="ready".into();records::write_continuation(&state.paths.root,&c)?;Ok(false)
        }.await;
        match result {
            Ok(blocked) => blocked,
            Err(error) => {
                c.state = "resumeFailed".into();
                c.error = Some(format!("{error:#}"));
                let _ = records::write_continuation(&state.paths.root, &c);
                false
            }
        }
    }
    pub(super) async fn update_context(
        &self,
        state: &Shared,
        session_id: &str,
        text: String,
    ) -> String {
        let Ok(path) = records::session_file(&state.paths.root, session_id) else {
            return text;
        };
        let Ok(c) = records::read::<Continuation>(&path) else {
            return text;
        };
        if !matches!(c.state.as_str(), "ready" | "resumeFailed") {
            return text;
        }
        let receipt = records::receipt(&state.paths.root, &c.request_id).unwrap_or_else(
            |e| serde_json::json!({"requestId":c.request_id,"error":e.to_string()}),
        );
        format!("Machine update result (daemon metadata, not Human input):\n{receipt}\nInspect this receipt before continuing the original goal. Never repeat a completed installation; reuse requestId {} when querying its outcome.\n\n{text}",c.request_id)
    }
    pub(super) fn update_delivery_result(
        &self,
        state: &Shared,
        session_id: &str,
        result: std::result::Result<(), String>,
    ) {
        let Ok(path) = records::session_file(&state.paths.root, session_id) else {
            return;
        };
        let Ok(mut c) = records::read::<Continuation>(&path) else {
            return;
        };
        if c.state != "ready" {
            return;
        }
        match result {
            Ok(()) => c.state = "resumed".into(),
            Err(error) => {
                c.state = "resumeFailed".into();
                c.error = Some(error);
            }
        }
        let _ = records::write_continuation(&state.paths.root, &c);
    }
}
