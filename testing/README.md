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
