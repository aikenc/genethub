//! Guest-side calls into the host-owned signed update import.

use genehub_proto::UpdateStatus;

#[cfg(target_family = "wasm")]
pub fn check() -> Result<UpdateStatus, String> {
    let status = genet_wasi::wit::genehub::host::logic_update::check()?;
    Ok(UpdateStatus {
        current: status.current_revision.to_string(),
        latest: status.latest_revision.map(|value| value.to_string()),
        newer: status.newer,
        url: None,
        download_url: None,
        problem: status.problem,
    })
}

#[cfg(not(target_family = "wasm"))]
pub fn check() -> Result<UpdateStatus, String> {
    Err("自动更新尚未启用：请从官方发布页手动下载，并核对 SHA256SUMS".to_string())
}

#[cfg(target_family = "wasm")]
pub fn apply(request_id: &str) -> Result<(), String> {
    genet_wasi::wit::genehub::host::logic_update::apply(request_id)
}

#[cfg(not(target_family = "wasm"))]
pub fn apply(_request_id: &str) -> Result<(), String> {
    Err("自动更新尚未启用：请从官方发布页手动下载，并核对 SHA256SUMS".to_string())
}
