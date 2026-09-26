# Windows Workflow / WR audit (2026-09-16)

Scope: the WR startup fix, Workflow carrier/material resolution, project setup,
restricted evidence tools, and the native process boundary. This is **not a
Windows release qualification**. The available test host is Linux; no Windows
machine is paired with the diagnosing installation.

## Fixed in the guest

| Finding | Change | Evidence |
| --- | --- | --- |
| Automatic trial diagnosis resolved the formal project instead of the Run's pinned material | Use `execution_root` for Worker reachability; retain the separate project evidence scope | `specialty.workflow.trial-materials.silence-wr` |
| An evidence-only role could select a backend without bounded evidence tools | Adapter capability check at draft validation and Session creation/start | `specialty.workflow.authoring-validation.contract`, `specialty.workflow.trial-materials.readonly-unsupported` |
| Windows-authored relative Workspace folders contained backslashes the POSIX guest could not resolve | Interpret both separators in `.code-workspace` folder definitions before host-path conversion and canonicalization; file API paths are unchanged | `specialty.filesystem.windows-workspace-separators` uses actual public Workspace/file operations, spaces and Unicode |
| Private evidence directory names were compared case-sensitively | Reserve `.git`, `.genethub/sessions` and `.genethub/components` case-insensitively; keep canonical root containment case-sensitive | `specialty.workflow.evidence-paths.private-case` proves denial and ordinary artifact reads through a real restricted Agent |
| PM bootstrap canonicalized native Git output directly inside WASI | Pass `--show-toplevel` through the existing guest path converter, as `repository_directories` already does | `specialty.agent-space.workflow-package-build` covers the ordinary path; the Windows drive spelling still needs a Windows run |
| A diagnosis that failed before creating its Session prevented Run cleanup | Treat typed `SessionMissing` for reserved/failed diagnoses as no process to retire; existing Sessions and other errors retain normal fencing and cleanup | `specialty.workflow.trial-materials.silence-wr-start-failed` uses real silence, an unsupported read-only backend, public Session lookup and cancellation |

The two new cases fail on the preceding product version: folder lookup fails,
and a mixed-case private canary reaches the model. They do not emulate NTFS and
do not establish behavior for junctions, short names, alternate streams or ACLs.

The dev refresh also exposed a pre-existing `stopping` Run whose failed WR
Session had never been created. Reconciliation repeatedly retried its cleanup;
live profiling showed repeated Session metadata scans while the browser smoke
timed out. The cleanup fix is generic, does not edit historical Run snapshots,
and does not suppress lookup errors for ordinary Workers or running diagnoses.
The slow smoke must still be rerun successfully; this observation alone does
not prove that cleanup was the only source of latency.

## Audited boundaries

- Run execution and evidence roots are separately pinned; the WR fix does not
  expand Workspace folders, disable `evidenceOnly`, rewrite installed project
  roles, or migrate historical snapshots.
- Native `genet ... agent-serve` and the WASM Agent retain their existing launch
  path. The bound CLI is absolute and restricted tools pass an argument array,
  not a shell command. Path quoting is not delegated to the model in this tool.
- The PM preparation helper emits `/`-separated Workspace/execution definitions
  and converts guest drive paths for native Node; trial Git metadata and object
  storage are still checked independently of the formal repository.
- Persistence and lease locking remain in their existing owners. This change
  introduces no new state format, replay mechanism or Windows-specific engine
  branch. Linux restart/cancel cases are not power-loss or NTFS evidence.

## Open Windows-native risks — not fixed by a dev guest refresh

1. `apps/host/src/process.rs` has Unix process-group ownership/signalling, but
   its non-Unix `own_session` / `signal_group` are no-ops and `group_alive`
   returns false. The immediate child has `kill_on_drop` / `start_kill`, which
   does **not** prove its descendants are gone. Windows cancellation, timeout,
   and parent exit require a native process-tree fix and real OS tests.
   A correct implementation must own the tree before it can fork, track it
   after the leader exits, and fail explicitly if ownership cannot be acquired.
   This belongs in the native process resource, not Workflow business logic.
2. Host preopens cover mounted drive letters, not arbitrary UNC shares. Do not
   promise that an unmapped network share is usable. Extended-length paths,
   junctions, NTFS short-name aliases, drive-letter casing and semicolons in
   installation paths need explicit Windows fixtures.
3. The built-in Agent's ordinary file tools consume guest-form paths. Native
   drive/backslash paths pasted into tool arguments are not automatically
   normalized there. Test both supplied guest paths and native user input
   before claiming complete Windows file-tool parity.

Native process changes require the App/full delivery path described in
`architecture.md` B5, not only replacing `genehub_guest.wasm`. Keep the Linux
dev refresh and the still-open Windows native qualification separate.

Minimum Windows acceptance: spaced Unicode roots on two drives; bootstrap an
existing Git repository; prepare an isolated Executor and start restricted WR;
reject private-storage case/alias/junction escapes; read an ordinary artifact;
submit through the exact CLI; kill/timeout/restart with a child and grandchild;
confirm no descendants, false completion, or duplicate node dispatch remain.
