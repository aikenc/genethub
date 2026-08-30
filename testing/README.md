# GeneHub testing

Open catalog, `testctl`, and the public TypeScript test engineering tree.

Normative design lives in Cloud:

- [测试工程总体提案](../../genethub-cloud/docs/testing/README.md) is not a path from this checkout; use the paired Cloud worktree `docs/testing/README.md`
- Engineering principles: Cloud `docs/testing/engineering-principles.md` (`P01`–`P13`)
- Engineering laws: Cloud `docs/testing/engineering-laws.md` (`L01`–`L16`)

This package does not copy those checklists. `testctl governance check` only implements mechanical mappings and cites IDs.

`testing/deprecated/rust/` is frozen legacy. The crate stays on disk and can be invoked by hand with
`cargo test -p genehub-testing`; required `testctl` gates and `cargo test --workspace` do not run it.
New business cases belong in `journeys/`, `specialties/`, or `e2e/`.

## Failure evidence

Before an isolated Node lease is removed, every non-passing case writes a sanitized evidence bundle below
`runs/<run>/failures/<case>/evidence/<unit>/`. Its index records the original logical location and retained copy for
daemon/CLI/worker logs, PM and WorkAgent session stores, PM project/DCG state, workspace control files, process state,
Git state, and relevant environment-key presence. Text is redacted before it enters the run; oversized or binary files
remain visible in the index with an explicit truncation or omission reason.

Use `testctl inspect --run <run> --failed` for the compact storage/session index, and add `--artifacts` for the complete
per-file manifest. Human decision requests and responses remain available through both `inspect` and `interactions`.
