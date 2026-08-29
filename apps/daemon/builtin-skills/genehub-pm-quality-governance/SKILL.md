---
name: genehub-pm-quality-governance
description: Assure PM project delivery quality without requiring the manager to master implementation details by defining evidence gates, commissioning independent Review WorkAgents, binding verdicts to exact Git candidates, testing demos, collecting execution feedback, and iterating Agent Space Skills. Use before accepting, integrating, merging, releasing, or retrying a rejected package, and whenever repeated WorkAgent friction suggests a Skill change.
---

# Govern delivery quality and Skills

Manage quality through contracts, separation, and evidence. Confidence, polished explanations, and implementation volume are not evidence.

Read [references/evidence-gates.md](references/evidence-gates.md) when defining or evaluating a candidate.

## Gate a candidate

1. Restate the user-visible acceptance criteria and the package contract.
2. Identify the exact repository, commit, tree, dependency lock, Builder lock, and test/build evidence.
3. Reject dirty or moving candidates. A changed commit/tree invalidates all earlier verdicts.
4. Require one compact evidence bundle from the implementation WorkSession:
   exact commands and exit codes, candidate commit/tree, artifact digests,
   known limitations, and changed contracts. Do not ask the PM to reproduce
   every implementation checkpoint or rerun a green package gate after each
   internal commit.
5. Keep the recorded Agent Space Builder identity current. Dispatch, candidate, review, and acceptance gates re-verify the lock; changing and re-recording an implementation Space blocks its candidate/review, and changing a review Space blocks reviews in progress. Reconcile the affected package instead of bypassing the refusal.
6. Select checks by risk: behavior, regression, integration, security, performance, compatibility, license, and operability.
7. Create an independent Review Agent Space when code or another material artifact is accepted. The reviewer receives read-only candidate facts and no completion pressure.
8. Require a structured verdict with findings, evidence references, unresolved risks, and explicit pass/fail. A reviewer that edits the candidate cannot approve it.
9. Send failures back to the implementation WorkSession or a replacement with lineage. Re-run affected tests and commission a fresh review.
10. After merging accepted slices, run the full merged baseline before branching or dispatching any downstream content, migration, or integration package. Per-slice passes do not prove the accepted baseline composes. If accepted slices conflict semantically, create a prerequisite seam-fix package and independently gate it instead of hiding the repair inside unrelated downstream scope.

Use Demo/preview acceptance for experience claims. The user should be able to verify the delivered behavior without reading implementation details.

Record each gate through the PM control plane. Evidence flags are repeatable:

```text
"$GENEHUB_CLI" pm project package transition --id <id> --to candidate \
  --repository <repo-id> --commit <full-commit> --tree <full-tree> --evidence <test-or-artifact>
"$GENEHUB_CLI" agent run --agent <third-party-id> --model <model> \
  --workspace <different-review-space-id> --work-package <same-id> --no-wait \
  "Review only the bound candidate; do not edit it. Return findings and a pass/fail verdict with evidence."
"$GENEHUB_CLI" pm project package transition --id <id> --to review \
  --review-session <independent-work-session> --candidate-commit <full-commit> \
  --candidate-tree <full-tree> --review-evidence <check-performed>
"$GENEHUB_CLI" pm project package transition --id <id> --to accepted \
  --review-session <same-review-session> --candidate-commit <same-commit> \
  --candidate-tree <same-tree> --verdict pass --review-evidence <verdict-evidence>
```

The daemon rejects missing evidence, moving candidate identities, self-review, and acceptance without an explicit passing verdict.

## Learn from execution

After a failure, delay, review rejection, or user correction, classify the cause:

- work contract or intent gap;
- Agent Space context/topology gap;
- Agent Space Skill instruction or tool gap;
- Coding Agent/runtime limitation;
- product/Builder defect;
- external dependency or user decision.

Do not turn every incident into a Skill rule. Change a Skill only when the lesson is reusable for that Space responsibility.

If a package's responsibility, owned paths, input commit, checks, or completion
contract changes, update its Git-managed Provider Skill, rebuild and verify the
Space, and re-record its identity before the next dispatch. A one-off
continuation prompt may recover the current checkpoint, but it must be followed
by that durable Skill update and explicit accounting for candidates/reviews
invalidated by the new Builder lock. Prompt-only scope drift is not an accepted
management state.

A runtime turn cap is not package failure when the WorkSession and Git lineage are intact. Resume from verified state. If the same check or defect consumes two consecutive capped turns, do not resend the same generic completion request: record the recurring cause, request a focused diagnosis and checkpoint, shrink the work contract, or introduce a genuinely independent specialist package. Repeated recovery without a changed management strategy is itself PM drift.

## Iterate a Space Skill

1. Resolve the Git-managed Provider source; do not edit generated `.agents`, `.claude`, `.cursor`, `.codebuddy`, `AGENTS.md`, or lock outputs.
2. Reproduce the problem in a bounded Demo or historical failure case.
3. Try the smallest instruction/resource change in the local override when useful.
4. Exercise at least three trigger prompts, three adjacent non-trigger prompts, one success path, and one failure/recovery path.
5. Promote the stable change to the root `skills/` Provider source, rebuild and verify the Agent Space, then commit it.
6. Record which Demo evidence justified the new Skill version and which active candidates/reviews it invalidates.

Keep PM Skills generic. Project-type and user-specific management rules are injectable project Skills; implementation knowledge belongs to the affected Agent Space Skill, not the PM catalog.
