# Workflow authoring validation

The authored business method belongs to project/Pack YAML. The platform supplies one parser/compiler,
bounded JSON data and deterministic execution; it does not implement a game pipeline or ask an LLM to validate YAML.

## Two existing CLI surfaces

```sh
"$GENEHUB_CLI" schema workflow.definition
"$GENEHUB_CLI" workflow check --draft
```

`schema` returns `data.definition`, a Draft 2020-12 JSON Schema generated from the Rust deserialization
types, plus `x-genehub` capabilities and boundaries. It describes our v1/v2 syntax, **not** OWS/ASL
compatibility. No jq, JSONata, remote `$ref`, script runtime or standard-DSL migration is added.
The schema helps authoring; the production compiler remains authoritative for control flow and bounds.

`check --draft` uses the same bounded source loader and compiler as activation/dispatch. It does not
create/persist a Candidate, Run, lease, session, Worker, or change Active. Normal `check [--run]` retains
its runtime-check behavior. `--run` and `--draft` are mutually exclusive. Authorization and project
boundaries are unchanged. An older daemon omitting the draft report is an explicit capability error.

On success, `data.draft` contains `valid: true`, the exact source Candidate digest, default Workflow,
execution binding and **catalog-referenced** workflows/roles. These come from the final compiled snapshot,
not regexes or a scan of every YAML file in a directory. They do not prove carrier readiness.

On invalid source, the CLI exits nonzero with `error.code: workflowValidationFailed` and
`error.details.draft`: `valid: false`, no runnable metadata, and at most 64 diagnostics. Parsing a broken
project/catalog stops dependency traversal. Otherwise the first causal failure per catalog entry is
collected and duplicate diagnostics are suppressed. This is not an exhaustive error list inside each
malformed file; repair then rerun. `truncated` reports the output cap.

Each diagnostic has `phase`, `code`, `severity`, source-relative `file`, RFC 6901 `path`, `message` and
`hint`. `line`/`column` are 1-based only when supplied by the parser; compiler locations use pointers,
not invented YAML offsets. `expected`/`actual` describe known type mismatches, not raw user values.
Legacy semantic/dependency errors may locate the file root; their constraint remains in `message`.

For example, an `if` with `condition: {op: literal, value: "true"}` is rejected at its condition with
`WF_EXPRESSION_TYPE`, `expected: boolean`, `actual: string`. Use the boolean `true` without quotes.
Likewise, arithmetic/array/boolean operands with statically incompatible kinds are rejected. References
are not subject to speculative data-flow inference: missing fields and dynamic types fail at runtime.
Runtime expression failures retain the block path and a `condition.error` history event with the same
diagnostic fields. Cancel, timeout and permission failures retain their existing hard stop semantics.

## Closed result contracts

Prefer explicit JSON Schema-compatible object syntax:

```yaml
completion:
  output:
    type: object
    required: [decision]
    additionalProperties: false
    properties:
      decision: {type: string, enum: [go, noGo]}
      explanation: {type: string, minLength: 1}
```

Only `decision` is required here. Extra keys are rejected and present optional keys are validated.
The bounded subset also supports array/items/minItems/maxItems, string/enum/minLength, integer, boolean
and null. It is not a full JSON Schema evaluator. No open object, executable validator or remote schema.
For backward compatibility, omitting **both** object keywords preserves the original all-required,
closed-object shorthand. Supplying only one keyword is rejected. Existing snapshots/digests retain the
same serialization when both are omitted; old Runs are not rewritten.

## Agent repair and evidence boundaries

WM uses schema → edit → draft check → bounded correction → evaluation. The built-in Skill stops after
three unsuccessful repair passes and returns remaining evidence to PM; the platform runs no LLM or
repair loop. `evaluate.mjs` consumes compiled roles/execution and checks the digest again before evaluation.
Quoted values, inline mappings and uncataloged scratch files cannot falsify its role inventory.

PM uses the same minimal facts to correct its interpretation/delegation and routes method edits to WM.
The Executor still closes the complete configured workflow. No PM milestone scheduler or reflection
state machine is added. A successful shape check does not prove tests ran; compilation/evaluation does
not prove improvement. Real trials and independent WR evidence remain necessary when warranted.

Pack upgrades remain explicit and protect customizations. New installations get the updated instructions;
restarting a service does not overwrite an existing project's Pack assets.
