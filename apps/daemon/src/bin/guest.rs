//! WASI guest entry for the same `genet-daemon` crate.
//!
//! Native product still enters through `genet daemon run`. This binary exists
//! so `wasm32-wasip2` can produce a Component the shell loads with
//! `from_binary`.

#[cfg(target_family = "wasm")]
#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = genet_daemon::run::run().await {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

#[cfg(not(target_family = "wasm"))]
fn main() {
    eprintln!("genehub-daemon is the wasm32-wasip2 guest; run `genet daemon run` on the host");
    std::process::exit(2);
}
