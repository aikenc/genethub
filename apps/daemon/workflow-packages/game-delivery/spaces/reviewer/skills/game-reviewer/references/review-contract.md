# Review before repair

For `game-review-and-improve`, begin by reviewing the existing artifact. Do not
request an initial Coder commit merely to enter the workflow. Freeze the user's
requirements and a finite project-specific checklist with stable item IDs before
the first assessment. Preserve the IDs, criteria and requirement revision across
repair and re-review; only the artifact revision changes. Generic examples are
entry/start, required behavior, regression and delivery evidence. They are not a
mandatory universal checklist; never import another project's 29 items blindly.

Keep the contract and report as regular files in your assigned result area.
For many criteria, group them into bounded batches, cover every ID exactly once,
and merge the results before completing the review. The WM may represent those
batches with the existing structured `forEach`; no kernel checklist registry is
needed. Report partial, unmet or unverifiable criteria honestly.

Contract shape:

```json
{
  "schema": "genehub.review-contract.v1",
  "requirementRevision": "user-goal-v1",
  "checklistVersion": "acceptance-v1",
  "artifactRevision": "actual-commit-or-content-digest",
  "items": [{"id": "entry", "criterion": "The assigned entry starts the requested experience"}]
}
```

The report uses `schema: genehub.review-report.v1`, copies the three revisions,
sets `contractDigest` to `sha256:<digest of the exact contract file bytes>`, and
has one item per contract ID. Each item declares `status` as `met`, `partial`,
`unmet`, `unverifiable` or `notApplicable`. A met item needs an `evidence` array
containing `{ref, observation}`. Every other status needs a concrete `reason`;
notApplicable is a reasoned scope judgment, not a shortcut for an unperformed check.

Run `node <skill-dir>/scripts/check-review.mjs <contract.json> <report.json>`.
For re-review, pass the previous contract as the third argument. Archive the
checker output alongside the actual checks. Malformed coverage exits nonzero;
a valid negative report exits zero with `verdict: changesRequested`. Inspect the
verdict before submitting `workflow complete`. Approved reports supply
`review=approved`, `checks=<actual checks>` and `report=<report reference>`;
negative reports submit `changesRequested` with the reason and report.

The checker validates declared coverage and versions. It does not prove the
referenced tools ran, nor is invoking it currently a host-enforced completion
gate. Verify original evidence and disclose inaccessible checks. A repair that
changes acceptance needs a new PM decision rather than a quietly weakened re-review.
