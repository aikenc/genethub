# Manage this installation's updates from the CLI

The native CLI provides `update check`, `update live`, `update app`, and
`update status --request-id <id>`. Linux x64 and Apple Silicon macOS CLI
installations support App replacement. Desktop `.app` and Windows installation
are not yet supported by this updater. Update sources are stamped per channel;
`genet-beta` updates beta, and `genet` updates stable.

```sh
genet update check
genet update live --request-id component-001
genet update app --request-id app-001
genet update status --request-id app-001 --wait
```

An update interrupts that instance's connections and Agent processes when it
activates. Downloading and preparation run in an independent native worker;
Node, a source checkout and an open browser are not required. The worker saves a
receipt before stopping anything. `--wait` waits for the update, but its caller
may disappear during activation. Reconnect and query the original ID instead
of creating a second request. Query exit 0 means the receipt was read: inspect
`updateState`, `error`, `appApplied`, `liveApplied`, `running` and `continuation`.

The same ID with the same operation returns the original receipt, including a
failure. Reusing it for another operation or an explicitly different continuation
Session returns `requestIdConflict`. Concurrent installations in one data-dir
are refused with `updateBusy`. No automatic timer checks a remote update feed.

An Agent's authenticated local Session context binds its continuation. An
explicit `--resume-session <id>` can name a Session in the updated instance.
Do not pass another machine/channel's Session ID. After activation, the daemon
waits for the result before recovering the original inbox; its delivery carries
the update receipt. A Session without pending durable input receives a deduped
system notice. Paused/closed Sessions are not woken. `continuation.resumed`
means a new execution started, not that the entire original goal finished.

Existing remote shell is sufficient to manage another machine or channel:

```sh
genet shell --machine <stable-machine-id> --workspace <workspace-id> -- /actual/path/genet-beta update app --request-id beta-app-001
genet shell --machine <stable-machine-id> --workspace <workspace-id> -- /actual/path/genet-beta update status --request-id beta-app-001
```

The stable caller does not need this update feature: it only runs a command.
The target beta CLI/Host/guest must first be installed with this feature. A
beta restart must not stop stable. A beta-only installation uses its own
independent worker and needs no stable installation.

App updates check the pinned archive hash/length, platform, channel, binary and
bundled component versions and required Python runtime before stopping the old
daemon. The original service manager stays in charge. A manually started daemon
gets an explicit independent startup adapter. Only the actual adjacent channel
CLI/Host/component are replaced; other channels' binaries are not selected by
name or killed by image matching. A bad package leaves the old daemon running.

If replacement fails before the new Host starts and the data is not in use, the
worker restores its backup. Before opening a new guest, the Host records a durable
startup observation. Once that exists, even an exited new process is reported
for compatibility inspection;
it is not blindly downgraded over potentially migrated data. `partial` records
an App that installed successfully while its subsequent Live update failed.
The bundled component remains a floor for active Live selection.

Request data lives under the channel data-dir's `updates/requests/<id>/`.
Request identity, worker progress and per-request continuation are separate
records. `update status` works while the daemon is unavailable. An exited worker
without a final receipt is `interrupted`, never assumed successful. On native
daemon startup, an interrupted file replacement before new startup can restore
its backup; a transaction that reached new startup is verified without replaying
installation. If neither version or the OS can start, an external recovery path
is still needed. Never delete component high-water files to force a downgrade.

Development release checks use SHA256/length/channel/ABI and the existing
component envelope. They do not claim an independent production signing root.
First installation of this capability uses the existing installer; old native
CLIs that explicitly refuse `update` cannot acquire it through a Live alone.
