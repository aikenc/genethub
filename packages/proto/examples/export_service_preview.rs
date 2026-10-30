//! Generate the Service Preview public TypeScript projection without a test run.
use genehub_proto::{
    RemoteDesktopInput, RemoteDesktopLease, RemoteDesktopSession, ServicePreviewPageState,
};
use ts_rs::TS;
fn main() -> Result<(), ts_rs::ExportError> {
    let output = concat!(env!("CARGO_MANIFEST_DIR"), "/bindings");
    ServicePreviewPageState::export_all_to(output)?;
    RemoteDesktopInput::export_all_to(output)?;
    RemoteDesktopLease::export_all_to(output)?;
    RemoteDesktopSession::export_all_to(output)
}
