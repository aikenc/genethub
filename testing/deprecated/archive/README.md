# Archived frozen sources

These sources and evidence are audit records, not an active crate or runner.

- `concurrency-reconstruction-20261030/`: original Git source, the one-field current-protocol adaptation,
  temporary adapter and shared-Agent launch alias; exact manifest/results for the qualified comparison
  `261030-1019-parity-reconstruction-execute-4898`. Both frozen cases actually ran with `--ignored`.
  Rust used the native daemon from the same source; TS used the WASM daemon; both used the common current
  CLI/guest Agent. This does not assert bit-identical native and WASM daemon executables.
- `cli-reconstruction-20261030/`: the seven existing CLI Rust cases, the four forwarded contract facts,
  temporary adapter, explicit old-case → TS mapping, and qualified run `261030-1030-cli-parity-c417`.
  Native front-door argument/redaction and intrinsic OS confinement checks stay in `apps/cli/tests`.
- `claude.rs`: six real-provider source cases remain auditable. All now have TS counterparts, including
  `journey.session.claude-subagent-isolation`. The fresh probe `261030-1019-claude-current-probe-eb4e`
  returned `403 Insufficient account balance`; it is blocked, not passed.
- `opencode.rs`: two suspended cases for the removed native OpenCode capability. Their original
  approval and reactivation conditions remain in `migration/rust-parity.json`.

The old drifted concurrency run is still invalid. New comparisons replace its missing evidence; historical
records are not edited into a pass. Restore/reclassify obligations according to Cloud L12–L14 if a capability
or source is reintroduced; do not re-enable an untracked Rust business helper.
