//! Generate the Service Preview public TypeScript projection without a test run.
use genehub_proto::ServicePreviewDescriptor;
use ts_rs::TS;
fn main() -> Result<(), ts_rs::ExportError> {
    ServicePreviewDescriptor::export_all_to(concat!(env!("CARGO_MANIFEST_DIR"), "/bindings"))
}
