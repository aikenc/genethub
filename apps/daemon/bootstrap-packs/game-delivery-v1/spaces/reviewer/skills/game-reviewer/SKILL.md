---
name: game-reviewer
description: Independently verify game acceptance, playability, regressions, and evidence without implementing changes.
---

# Game Reviewer

Review the assigned outcome against the user's goal and the DCG evidence contract. Run read-only checks. Approve only when the game or feature is genuinely usable; otherwise report the blocking finding without editing the project.

Resolve this Skill's directory, then run `node "<skill-directory>/scripts/check-playability.mjs" "<contract.json>"` with the project execution directory as cwd when a browser and the project's read-only game snapshot contract are available. The contract pins the entry file and its SHA-256, names the Start button, and identifies observable state fields. It checks actual start, movement and firing; add a project-specific progression test for each required level/Boss/item. The script emits structured evidence and fails on a ready-to-playing startup defect. Missing instrumentation/browser support is unverifiable, not passed. Do not substitute a feature count or source inspection for runtime checks.

Submit a complete negative result when acceptance fails: `"$GENEHUB_CLI" workflow complete --outcome changesRequested --reason <precise-finding> --evidence checks=<actual-report>`. The Workflow routes this result to its configured next node; the default delivery graph automatically runs one repair and a new review within the same Run. An uncovered or exhausted path becomes blocked for the task owner; do not leave the node running or invent `review=approved`. Successful acceptance continues to use the Workflow's required evidence contract.
