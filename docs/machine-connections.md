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
machines. Single-endpoint hosts use the same directory through a default local
target; they no longer render a different sidebar. Filtering does not attach a new active client. Opening a conversation
borrows its machine's client and selects that client's source-owned store. Delayed replies always update their source store; inactive
body subscriptions are detached without stopping the Agent or
closing the original machine client. Returning restores that source's tabs and drafts. Each source is keyed by identity plus its
local workspace/session ID. Equal names are never merged.

Directory reads use `session.page` and `workspace.list`, with two concurrent
source reads. The initial global page contains at most 100 summaries. Up to 32
roots with child Spaces also get five root-session previews each, in batches of
at most ten workspace scopes; child activity cannot displace the front previews.
Ordinary conversations are flat and sorted across sources. Projects with children
show their root conversations by default, with internal conversations collapsed.
Opening internals reads ten records per Space with at most two concurrent reads,
and a Space filter narrows that single time-sorted list. Older history uses cursors.
Search and status filters describe the loaded scope. Unsupported old daemons
show an upgrade error instead of falling back to unbounded `session.list`.
Directory snapshots refresh every 30 seconds while visible, on foreground resume,
and on explicit refresh. Active-source updates reuse the current store.
Refresh progress is separate from the last confirmed source state: a healthy
source stays usable during a normal refresh. A failed read remains uncertain
until a subsequent successful read; starting a retry cannot revive old healthy
status. Genuine offline/timeout/denial outcomes still change the source state.
Offline snapshots are dated and unknown; an authorization rejection clears them.
This is not the separately proposed session-change push protocol or an exact
activity-count API.

The machine filter uses a compact trigger with an ellipsized machine name. Its
bounded menu lists source status, daemon version and loaded counts on separate
lines; all machines is the default. Keyboard selection, Escape, outside clicks
and focus changes close the menu without changing the execution target.
Historical pagination is not an unknown runtime state: incomplete activity
counts use a visible `≥` lower bound, while the dashed unknown icon is reserved
for unavailable source/collaboration state. An exhausted per-Space cursor alone
does not establish complete retained coverage after a machine-wide refresh.
Absence of an activity icon does not assert that an incompletely read project is idle.

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


The header owns single-session actions; message Fork/Forward stay on messages.
Bulk actions operate on the current visible source-qualified selection and require
confirmed replies. Archives update the source store before refreshing, and newer
directory facts cannot be overwritten by an older active-session cache. A missing
delete acknowledgement leaves local navigation intact. Bulk deletion is not enabled
without a daemon atomic-idle contract.

New conversations are local drafts with source-labeled project cards. Retargeting
keeps unsent text and browser-owned File objects in memory. Inline attachments
carry their bytes without source paths; nonportable source paths remain in the
original draft and are reported as missing in the new target. Binary content is
never serialized to localStorage; reloads retain only text and attachment counts.
Pinned projects are a browser preference keyed by machine and workspace. Product
bootstrap projects default to pinned via the daemon's optional `builtin` fact,
identified from its actual administrator storage location, never a display name.

The visible list has two toolbar rows: machine/search/new above and filters/bulk/
more below. In-progress includes actual Human requests and failures, while icons
keep those states distinct. Bounded directory reads include archived summaries;
current/archived views filter that shared snapshot locally, so archived work
remains reachable and changing views cannot race a new transport range.

Navigation has its own cancellable intent and never disables every row. A newer
selection cancels an older connection lease without closing another consumer.
Page transitions happen before awaiting the body; a late body cannot reopen a
page the user has already left. The 700px split breakpoint includes iPad Mini;
compact split navigation is 56px and its list 256–280px, with 44px touch targets.

A compact bookmark outside loaded pages resolves within its addressed Space via
bounded metadata pages, including archived history. It does not load other
Spaces or accept an ambiguous locator; a later navigation cancels its result.
