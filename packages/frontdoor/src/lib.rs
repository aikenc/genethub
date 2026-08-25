//! What the native front door has to know, and nothing else.
//!
//! `genet` is a thin forwarder: it starts and stops the daemon, confines a
//! process, and hands argv to the running guest over loopback `POST /cli`
//! (`docs/cli-thin-forwarder.md`). None of that requires knowing what a session
//! is. Yet the CLI used to link the whole `genet-daemon` crate to get five
//! things out of it — the build identity, where the data directory is, whether
//! a lock file's pid is alive, how to mint a control-plane proof, and the shape
//! of an error envelope.
//!
//! The cost was not the binary size. It was that every edit to the session
//! kernel, the adapters or the data plane recompiled the front door and looked,
//! to anything watching the build, like a change to the installed App. This
//! crate is that shared vocabulary, extracted so the two can move apart:
//!
//! - [`channel`] — build identity, written wholesale by `scripts/channel.mjs`
//! - [`paths`] — the on-disk layout
//! - [`perms`] — who that layout is kept to, on three platforms
//! - [`fs_lock`] — advisory locks, native or asked of the shell
//! - [`lifecycle`] — is that daemon running, and how does it stop
//! - [`proof`] — loopback control-plane proofs, domain-separated per action
//! - [`envelope`] — the machine-readable shape of a CLI answer
//! - [`selectors`] — `--machine` and `--cwd`, parsed before anything dispatches
//!
//! What is deliberately *not* here: any product verb, any session type, any
//! transport beyond the loopback proofs. A thing that belongs to the business
//! belongs in the component, where it ships as a Live release.

pub mod channel;
pub mod envelope;
pub mod fs_lock;
pub mod lifecycle;
pub mod paths;
pub mod perms;
pub mod proof;
pub mod selectors;
pub mod version;

pub use paths::Paths;
