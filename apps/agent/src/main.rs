//! Native shim over `genet_agent::run`. The v2 product loads this same code
//! through the `agent-run` export of the single wasm component instead; this
//! binary remains as a native debugging entry.

// The guest has one thread and no way to make another, so the runtime it
// asks for has to say so.
#[cfg_attr(not(target_family = "wasm"), tokio::main)]
#[cfg_attr(target_family = "wasm", tokio::main(flavor = "current_thread"))]
async fn main() {
    std::process::exit(genet_agent::run().await);
}
