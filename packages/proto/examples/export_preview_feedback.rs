//! Generate preview feedback and updated RPC types without running tests.
use genehub_proto::*;
use ts_rs::TS;
fn main() -> Result<(), ts_rs::ExportError> {
    let directory = concat!(env!("CARGO_MANIFEST_DIR"), "/bindings");
    Request::export_all_to(directory)?;
    Reply::export_all_to(directory)?;
    AgentCapability::export_all_to(directory)?;
    AssetPreviewError::export_all_to(directory)?;
    AssetPreviewKind::export_all_to(directory)?;
    AssetPreviewMetadata::export_all_to(directory)?;
    AssetPreviewRequest::export_all_to(directory)?;
    Confinement::export_all_to(directory)?;
    DeviceAuth::export_all_to(directory)?;
    ErrorCode::export_all_to(directory)?;
    ExchangeRequestHead::export_all_to(directory)?;
    ExchangeResponseHead::export_all_to(directory)?;
    InviteAuth::export_all_to(directory)?;
    NoticeLevel::export_all_to(directory)?;
    PeerAuth::export_all_to(directory)?;
    PeerHello::export_all_to(directory)?;
    PeerWelcome::export_all_to(directory)?;
    ProtocolError::export_all_to(directory)?;
    ProtocolIdentity::export_all_to(directory)?;
    RtcNegotiationRequest::export_all_to(directory)?;
    RtcNegotiationResponse::export_all_to(directory)?;
    ServerFrame::export_all_to(directory)?;
    ShellFrame::export_all_to(directory)?;
    ShellRunRequest::export_all_to(directory)?;
    SpeechCancelReason::export_all_to(directory)?;
    SpeechCompleted::export_all_to(directory)?;
    SpeechContextUpdate::export_all_to(directory)?;
    SpeechFailure::export_all_to(directory)?;
    SpeechFailureCode::export_all_to(directory)?;
    SpeechPartial::export_all_to(directory)?;
    SpeechReady::export_all_to(directory)?;
    SpeechRuntimeCapabilities::export_all_to(directory)?;
    SpeechSegment::export_all_to(directory)?;
    SpeechSegmentBoundary::export_all_to(directory)?;
    SpeechSegmentBoundaryKind::export_all_to(directory)?;
    SpeechSpanAlternative::export_all_to(directory)?;
    SpeechStart::export_all_to(directory)?;
    SpeechUncertainSpan::export_all_to(directory)?;
    WorkflowRequestBudgetSnapshot::export_all_to(directory)?;
    WorkspaceFileSource::export_all_to(directory)?;
    WorkspaceFileSourceKind::export_all_to(directory)?;
    Ok(())
}
