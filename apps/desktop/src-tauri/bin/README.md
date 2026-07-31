# bin/

The daemon binary is copied here before bundling; see `scripts/bundle.mjs`.

It is not checked in. During `tauri dev` the app falls back to `genet-daemon`
on `PATH`, so `cargo build -p genet-daemon` and a `PATH` entry pointing at
`target/debug` is enough to run the desktop shell without packaging anything.
