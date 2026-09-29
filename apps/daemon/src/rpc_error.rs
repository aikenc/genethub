//! Protocol classification belongs at the source, independent of localized text.
#[derive(Debug)]
pub(crate) struct RpcFailure {
    pub code: genehub_proto::ErrorCode,
    message: String,
}
impl std::fmt::Display for RpcFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for RpcFailure {}
pub(crate) fn failure(code: genehub_proto::ErrorCode, message: String) -> anyhow::Error {
    RpcFailure { code, message }.into()
}
