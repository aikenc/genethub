//! Entrypoint for tasks scheduled by the main daemon component.

pub async fn run(entry: &str, arguments: Vec<String>) -> Result<(), String> {
    match (entry, arguments.as_slice()) {
        ("preview" | "preview-executor", [cert, key, suffix]) => crate::preview_data::run_guest(
            cert,
            key,
            suffix,
            crate::preview_data::guest_control::Port::Thread,
            entry == "preview",
        )
        .await
        .map_err(|error| format!("{error:#}")),
        _ => Err(format!("unknown background worker entry: {entry}")),
    }
}
