# Prepare a runnable Workflow

PM owns project management and dispatch. WM owns Workflow design and returns
source changes, hypothesis and preparation requirements. WR compares actual
execution evidence with the fixed goal. The kernel supplies existing Space
composition, Candidate snapshots, Run execution, authorization and receipts;
it does not own an experiment registry or a universal improvement pipeline.

Editable definitions live in each package's directory under `<project>/.genethub/workflows/`.
A package's Executor is the product Space its own source implies — no project-level
binding selects one — and the task directory travels with the Run as
`workflow dispatch --root <project-relative>`. That directory is a weak task
reference; PM → Executor → direct Workers is an ownership tree.
`session_cwd` is the AgentSpace, while a node's `task_cwd` is its assigned material.
Expose that material subtree in a Worker workspace, not the Executor's entire
private `.genethub` area. The running Executor Session owns its component Run
snapshot; project source edits affect future snapshots.

## Preparation

Use the Node.js helper `scripts/prepare-executor.mjs` from the PM Skill source or
its Builder-generated projection. It needs Git only when the plan declares
repositories. Run it in the ordinary PM Session, retaining `GENEHUB_SESSION_ID`
and the exact absolute `GENEHUB_CLI`. A managed WM cannot do PM's management work.
Do not clear caller identity or use another daemon to avoid an authorization error.

Example input, after WM and PM have fixed the baseline and test intent:

```json
{
  "schema": "genehub.workflow-trial-plan.v1",
  "package": "game-delivery",
  "name": "v2",
  "testName": "review-first",
  "sourceExecutor": "executor",
  "taskRoot": "project",
  "repositories": [{"path": "project", "source": ".", "ref": "HEAD"}]
}
```

Replace HEAD with the approved commit when planning a comparison. `source` is an
explicit local repository path (relative paths resolve against the PM project).
The clone retains source local branches and tags with independent Git objects;
its origin remote is removed after cloning. Use `repositories: []` and
`taskRoot: "."` for plain data, or multiple disjoint repository paths and node
workspace references for a multi-repository Workflow. A Workflow that needs
worktrees can create them from its own experimental repository; place their Git
common directory inside the selected execution material root. Never point their
Git metadata or object alternates at the formal repository.

The helper copies only PipeBuilder source assets of the source Executor and its
direct Workers into new sibling Spaces, such as `executor-v2` and `reviewer-v2`.
It replaces their task folders with the precise material directory, builds and
verifies with the daemon, opens each Workspace, sets Parent before components,
and preserves lifecycle and role composition. Worker is mounted before Reviewer.
This is a starting carrier; WM's proposed new roles or source edits are applied
by PM with the same normal source → Builder plan → apply → verify → component
plan flow. Rebuild and refresh the registered component binding after source edits.

No new Human challenge is needed for a plan already covered by PM's project
management binding. A stale plan, lost binding or active-resource conflict is a
concrete recovery condition: inspect it and obtain a fresh plan after resolving
the facts. Do not ask the user to run a command that PM can already run.

The preparation receipt is under
`spaces/<executor>/.genethub/temp/exp/.<testname>.prepare.json`. Repeating the
same input checks existing sources, Builder state and registrations and reuses
completed steps. Different inputs, changed source baselines or conflicting files
stop without overwriting them. An interrupted partial Git clone needs inspection
of that recorded destination before retry; never remove an unrelated directory.
The receipt records preparation, not Run progress. Do not put secrets in plans.

The final source binding is compiled as an inactive Candidate. Read the receipt,
then dispatch the requested Workflow explicitly with its digest and a stable task
key. Candidate dispatch does not activate it. Verify actual Run ownership and
the material baseline; a directory named v2 alone proves nothing about isolation.

## Comparison and adoption

Compare fixed requirement/checklist versions, artifact revisions, actual checks,
rework, elapsed time, model/tool usage and human effort. Give WR source Run and
report references and disclose environment/model differences and missing data.
Negative or inconclusive evidence is a valid result; do not manufacture success
by changing acceptance or resetting budgets with new task names.

Retain a successful new Executor/squad and bind it to the intended formal task
directory. This changes the full Candidate digest; record the tested Workflow
file digests and Builder identities, then validate the new binding before using
`workflow activate --candidate <digest> --revision <current-activation-revision>`.
If using another carrier, verify equivalence first. Activation switches future
Runs and leaves existing Run snapshots intact. Rollback uses the previous full
binding and current activation revision. It does not undo external side effects.

Cleaning test materials does not delete the Workflow or its Executor. Only
archive/remove recorded material after no active Run or adopted binding uses it.
Preserve trial and WR report references. Repositories are optional test material,
and are not automatically merged into the formal project during adoption.
