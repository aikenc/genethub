# Single-Run development review

`game-dev` is project-owned business configuration shipped in the Pack. Read the
full original request and current assignment; do not infer the job from a role
name. Both phases complete through `"$GENEHUB_CLI" workflow complete --output
'<JSON>'`, with the shape supplied by the host. Successful node completion means
the assessment/check was performed, not that its verdict was positive.

## Requirements

Return decision (`go`, `noGo`, `needsAuthorization`), scope, feasibility, risks,
budgetAdvice and milestones. Each milestone has a stable id, goal, and 1–32 criteria
with stable id, requirement and method. There may be up to 32 milestones; do not
invent 1/2/3 complexity slots. `go` needs a nonempty executable plan.

Check the original goal and non-goals, the existing artifact and reusable parts,
feasibility/unknowns, actual evidence methods, risk, and available request budget.
Preserve all unresolved original acceptance; a staged plan is not permission to
remove requirements. Include engineering correctness, regressions and actual
experience/playability in the same delivery contract. Select checks appropriate
to the project (mobile input/layout when mobile, offline only when required).
No fixed number of human playtesters is a universal default. Make criteria few,
specific and non-overlapping: each consumes an independent review activity.

On replan, read `accepted`, `delivered` and `previousFailure`. Keep still-valid
accepted contracts byte-for-byte equivalent as JSON values and plan remaining
work around their artifacts. Changed criteria require revalidation; an ID alone
does not prove the old acceptance applies. Do not claim past acceptance proves
the current combined artifact has no regressions; include relevant regression
criteria in later milestones. Keep the plan within authorization and total budget.
If proceeding needs a scope/resource decision outside that authority, return
`needsAuthorization`; if infeasible, `noGo`. These end assessment without Coder
or publication. A recommendation cannot enlarge the platform's budget allowance.

## Acceptance item

The input binds one `criterion`, its complete milestone `contract`, and Coder
`artifact` evidence (including commit). Check that artifact/version before making
observations. Execute the specified read-only verification, using the project's
runtime/playability tools when appropriate. Return exactly:

```json
{"passed": false, "finding": "Specific unmet requirement or uncertainty", "evidence": "Actual check and result, artifact/commit and useful source reference"}
```

Do not edit or commit the project, skip the assigned criterion, silently change
acceptance, or claim runtime quality from source inspection. Missing verification
means `passed: false`, not guessed success. Inability to execute the review at all
must use `--outcome blocked|failed --reason <fact>`; never leave the node running.

The graph invokes every frozen criterion and accumulates its result. One negative
item rejects the milestone. It allows initial implementation plus one repair,
then stops later milestones and returns the failure to requirement review, within
at most three planning rounds. Host failures and cancellation are not swallowed
as replanning. These limits live in YAML and remain subject to the shared budget.

Contracts and reports are retained in node outputs and Executor history. The
shape checker validates structure, not that a cited check actually executed.
Useful checks may be proposed to WM for project-library reuse even when they
failed this time. Do not edit a public/default checklist during a delivery Run;
promotion needs evidence of reuse value and the ordinary method-change process.
