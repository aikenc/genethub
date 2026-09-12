# GeneHub testing

Open catalog, `testctl`, and the public TypeScript test engineering tree.

Normative design lives in Cloud:

- [测试工程总体提案](../../genethub-cloud/docs/testing/README.md) is not a path from this checkout; use the paired Cloud worktree `docs/testing/README.md`
- Engineering principles: Cloud `docs/testing/engineering-principles.md` (`P01`–`P13`)
- Engineering laws: Cloud `docs/testing/engineering-laws.md` (`L01`–`L16`)

This package does not copy those checklists. `testctl governance check` only implements mechanical mappings and cites IDs.

`testing/deprecated/rust/` is frozen legacy. The crate stays on disk and can be invoked by hand with
`cargo test -p genehub-testing`; complete `testctl` gates retain required legacy cases according to policy and parity metadata.
New business cases belong in `journeys/`, `specialties/`, or `e2e/`.

For a bounded dev feedback, use `plan` then `run --gate dev-feedback --case <id> --reason <scope>`
(repeat `--case`, or select with `--tags`). Use absolute `--open`, `--cloud` and `--space` paths:
`npm --prefix` changes the command working directory. Feedback evidence is distinct from full dev/Beta/Stable qualification.
Selection output includes affected surfaces, declared dependencies and cumulative expected case duration, not a wall-clock guarantee.

Selected cases can declare `requirements: [{kind: "python", env: "VARIABLE", minVersion: [3, 11], modules: ["aiohttp"]}]`.
All consumers of that environment dependency must declare it. The coordinator probes only selected requirements before starting
workers or hashing artifacts; a missing dependency blocks the run, including cases not started. It never installs dependencies.
Runtime service availability and undeclared dependencies still require case-level checks; preflight is not a promise that every
possible environment error is eliminated.

The run path and phase are printed on stderr immediately, with 15-second progress and immediate failure notices.
`inspect --run <dir>` works before completion, returning `progress`, partial `results`, and null qualification. An old heartbeat
is an observation to investigate, not proof of process death. Only a finalized manifest can qualify a run.

`run --resume <finalized-dir>` creates a new record. Gate, selection/reason, exact source/dirty digest, artifact bytes, runtime,
governance, runner/policy and common environment must match. Only passed results with complete zero-leak evidence are reused;
declared dependency changes invalidate the corresponding cases. Failed/unstable runs and already-started timed-out cases are refused, never silently retried. Only budget-interrupted cases that never started may resume.
Preflight-only and old v1 runs have no reusable execution evidence. A crash before finalization also requires a fresh run.
The original run remains unchanged; the new manifest lists reused units and their origin. Hashing saves only within one snapshot,
and reads the bytes again at completion. Environment values are fingerprinted, not written into evidence.

Full gates with a filtered selection stay unqualified and return nonzero; `dev-feedback` cannot stand in for a complete gate.
For user-facing feedback, record the distinction between function-level checks and an actual user interaction through recovery.
