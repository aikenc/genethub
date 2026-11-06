# Workbench machine connections

The Workbench owns machine clients through `MachineConnections`. The active
conversation, session/project directory and message Fork/Forward borrow the same
client, including cross-machine previews inside the Workbench. Display-only shares
retain their own restricted client and cannot borrow full Workbench authority.
A consumer releases a lease; it never closes a borrowed client.

`Host.targets` supplies route locators and optional stable daemon identities.
`machineRefs` normalizes that boundary. A route locator is only used to mint a
fresh ticket. All returned clients are checked against the independently known
machine handle and fingerprint, including after reconnect. The initial default
connection is matched to the authoritative directory after its handshake.

The page retains up to four clients on desktop and three on mobile. Live leases
are pinned. Idle clients expire after 60 seconds or are evicted first when the
budget fills. A fully occupied pool rejects another acquisition with a retryable
visible error rather than closing an active conversation. One aborted summary
reader cannot close a client used by another consumer. Opening is bounded by a
10 second deadline; directory RPCs use the same per-request deadline without
closing another consumer's client. Other requests retain existing delivery semantics.

Only a foreground lease enables RTC and prewarms the large-data companion, subject to the user's existing preference.
The Client's separately admitted bulk carrier remains an internal transport
optimization; it is not a second machine owner. CLI remote dispatch remains owned
by the daemon and is unchanged.

The conversation and project lists share one machine filter, defaulting to all
machines. Filtering does not attach a new active client. Opening a conversation
borrows its machine's client and selects that client's source-owned store. Delayed replies always update their source store; inactive
body subscriptions are detached without stopping the Agent or
closing the original machine client. Returning restores that source's tabs and drafts. Each source is keyed by identity plus its
local workspace/session ID. Equal names are never merged.

Directory reads use `session.page`, initially at most 100 summaries per source,
and `workspace.list`, with two concurrent source reads. Older history is loaded
explicitly by cursor; expanding a project reads its own first ten sessions.
Search and status filters describe the loaded scope. Unsupported old daemons
show an upgrade error instead of falling back to unbounded `session.list`.
Directory snapshots refresh every 30 seconds while visible, on foreground resume,
and on explicit refresh. Active-source updates reuse the current store.
Offline snapshots are dated and unknown; an authorization rejection clears them.
This is not the separately proposed session-change push protocol or an exact
activity-count API.

The old machine switcher, overview dialog, Fork temporary-client helper, and
unused `HubWorkspaceFabric` browser facade are removed. Hub workspace directory
and ticket endpoints remain in this candidate. Their server implementation also
shares node routing and revocation mechanisms with the current cross-machine
protocol tests; this browser refactor does not retire that server surface. Removing that server compatibility surface requires a coordinated
server migration; it is not necessary to share machine connections in this build.

The official Console keeps its Host stable after bootstrap. Explicit selection
from the account machine page uses `Host.onTargetRequested`; changing the active
conversation URL does not mint another ticket or replace the pool.
PWA manifest updates also retain an already loaded Workbench document across
machines, so a source URL change cannot discard a pending navigation or its pool.
Browser history entries carry the machine identity, and self-hosted reloads resolve the
machine in the path before an older rendezvous fragment.

This candidate implements connection convergence, not the whole earlier UX and
daemon proposal. Exact activity totals independent of pagination, session-change
pushes, a server search API, persistent cross-device icon preferences and explicit
cross-machine Space membership are separate work. List filters expose their
loaded scope; the Forward target picker reads at most 500 recent summaries.
