//! Imports the shell provides because WASI cannot. Guest-only.
//!
//! The world is `daemon`: the single v2 component exports `run` / `agent-run`
//! and takes these imports in both. This is the only `generate!` of that
//! world. `apps/guest` implements `Guest` and calls the public `export!`.
//! Generating the same world twice embeds two component-type sections; fat
//! LTO happened to merge them, iterate / no-LTO cannot.

wit_bindgen::generate!({
    path: "../../wit",
    world: "daemon",
    pub_export_macro: true,
    default_bindings_module: "genet_wasi::wit",
});
