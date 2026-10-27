# Network acceptance v2 (2026-10-27)

The Human approved the proposed acceptance split and on-demand summaries on
2026-10-27 after clarifying the business requirement: 200 stored sessions,
50–80 active sessions, and preview traffic. This revision changes the contract
of the affected specialties explicitly. Historical v1 failures remain failures.
No case is removed and no gate or frozen-legacy selection changes.

## Business and degraded capacity

The 50/80-active mixed-load cases and normal both-hop separated profiles retain
their existing stimuli, exact-output assertions, 1500ms catalog p95 and preview
budgets. `team-b2-n1` instead measures 200 simultaneous complete subscriptions
with only one Native carrier: it must still recover every exact reply, execute
each source once, and provide error-free management calls below 10 seconds.
Its original 1500ms p95 observation is retained as `original1500msMet`, alongside
`productionLatencyQualified: false`. It does not certify the normal topology.

## Directional stalls

The four existing 1200/3000ms forward-hold profiles retain their actual physical
fault, aggregate bandwidth, 24MiB producers, original ~1MiB upload and original
10-second client timeout. An upload succeeds only with its ACK and exact file.
A typed timeout is an explicit uncertain outcome, never success and never an
automatic retry. Only an exact file or no file is accepted; partial data fails.
After the load observation and fast-network restoration, a distinct small write
on the same logical owner must receive an ACK within 1500ms and be exact.

One additional independent-two-hop 8000ms hold starting 3000ms into the request extends beyond
that unchanged deadline and must actually produce the typed timeout, proving that branch.

The raw upload result, `originalUploadAcknowledged`, `explicitTimeout`, and
`originalWriteRetried: false` remain visible. The small write certifies restored
usability after the test's restoration phase; it does not measure recovery time
starting at physical hold release or certify original-upload latency. All
no-fault uploads still require their original ACK within 10 seconds. Management
availability, source uniqueness, owner identity, actual physical fault checks,
aggregate capacity and queue bounds remain required.

## On-demand summary UI

The real mobile and desktop Workbench initially lists authorized devices without
querying their details. Only the expanded source reads projects and sessions;
collapse aborts reads and releases the summary client. No body subscription or
source task cancellation is introduced. Explicit refresh while all sources are
collapsed must issue no detail calls. Public bulk-summary consumers retain their
existing default behavior when no source selection is supplied.

This is device-source aggregation, not a Team membership/ACL implementation.
The specialties prove real Native processes and browser behavior, not 200 real
machines or a long-running deployment. Targeted results are not complete merge
or release qualification.
