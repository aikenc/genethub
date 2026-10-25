//! Native updater's local daemon handoff; no downloads run in this invocation.
use super::{fail, ok, EXIT_FAILED};
use genet_frontdoor::managed_update as records;
use serde_json::json;
use std::sync::OnceLock;

pub(crate) fn runtime() -> records::RuntimeIdentity {
    static INSTANCE: OnceLock<String> = OnceLock::new();
    records::RuntimeIdentity {
        channel: crate::channel::CHANNEL.into(),
        instance_id: INSTANCE
            .get_or_init(|| uuid::Uuid::new_v4().to_string())
            .clone(),
        pid: crate::host_pid::current(),
        app_version: crate::version::app_version(),
        component_version: crate::version::product_version(),
        component_sha256: std::env::var("GENEHUB_COMPONENT_SHA256").ok(),
    }
}
pub async fn update(args: &[String]) -> i32 {
    let result: anyhow::Result<serde_json::Value> = async {
        let state=super::local_state().map_err(anyhow::Error::msg)?;
        match args.first().map(String::as_str) {
            Some("runtime") if args.len()==1 => Ok(serde_json::to_value(runtime())?),
            Some("bind") if args.len()==2 => {
                let dir=records::job(&state.paths.root,&args[1])?;
                let request:records::Request=records::read(&dir.join("request.json"))?;
                anyhow::ensure!(request.schema=="genehub.update-request.v1" && request.channel==crate::channel::CHANNEL,"update request channel/schema mismatch");
                if let Some(id)=&request.resume_session {
                    if let Some(caller)=super::caller_principal().session_controller_id() {
                        anyhow::ensure!(caller==id,"update continuation must name the calling Session");
                    }
                    state.sessions.bind_update(&state,&request).await?;
                }
                Ok(json!({"requestId":request.request_id,"accepted":true}))
            }
            Some("reload") if args.len()==2 => {
                let dir=records::job(&state.paths.root,&args[1])?;
                let request:records::Request=records::read(&dir.join("request.json"))?;
                anyhow::ensure!(request.channel==crate::channel::CHANNEL,"update channel mismatch");
                state.reload.notify_one();
                Ok(json!({"requestId":request.request_id,"reloading":true}))
            }
            _ => anyhow::bail!("use the native CLI: update check|live|app|status; runtime is a read-only daemon identity"),
        }
    }.await;
    match result {
        Ok(data) => ok(json!({"schema":"genet.cli/v1","type":"update.runtime","data":data})),
        Err(error) => fail("updateFailed", &format!("{error:#}"), EXIT_FAILED),
    }
}
