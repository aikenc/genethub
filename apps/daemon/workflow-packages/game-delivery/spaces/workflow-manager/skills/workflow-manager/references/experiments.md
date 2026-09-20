# Workflow trials

PM understands the human's goal and delegates Workflow creation to WM. The
Executor and its squad carry the new Workflow; test directories, repositories
and data validate that carrier. One Executor may run several catalog Workflows.
PM owns preparation and dispatch. Managed WM returns its plan and Candidate;
it cannot recursively dispatch or borrow PM's identity.

1. Fix intent, requirement/checklist revisions, baseline, comparison cases,
   expected benefit, cost ceiling and stopping conditions. Describe Workflow
   changes and the necessary Executor/Worker Skills, prompts, models and roles.
   Separate known facts from hypotheses.
2. PM prepares the carrier using the project-manager Skill's
   `references/workflow-trials.md` and `scripts/prepare-executor.mjs`. It uses
   existing project authorization, exact Builder plans and component receipts.
   Do not hand ordinary authorized commands back to the user. Preserve source
   customizations; resolve conflicting sources or active Runs before rebuilding.
3. Default material is under
   `spaces/<new-executor>/.genethub/temp/exp/<testname>/`. This is an ordinary
   directory: create zero, one or several independent repositories as needed.
   Preserve required branch/tag/history semantics. Worktrees may come from the
   experiment's own repository, with Git common data inside the execution
   material boundary. Never share formal Git metadata or object alternates.
   Workers see the specific material subtree, not the Executor's private
   Session storage. Declare external destinations and redirect trial writes.
4. Prepare the trial's carrier and material. A package's Executor is the
   product Space its own source implies, so a variant gets its own carrier by
   being its own package — there is no project-level binding to rewrite. The
   task directory is a per-Run fact supplied at dispatch, for example
   `--root spaces/executor-v2/.genethub/temp/exp/review-first/project`.

   Editable definitions stay in the package directory under `.genethub/workflows/<package>/`. Copying that directory (or branching its git checkout) gives a fully independent definition plus carriers, which is how two variants run side by side.
   Candidate identity includes the package's derived carrier; a Run pins its
   definition, that carrier and its task directory. Test project branches are independent of formal Git.
   A role YAML does not register a Worker: exactly one enabled direct Worker
   per referenced role must exist before dispatch.
5. Compile with `workflow inspect`, evaluate structure, and return the digest.
   PM dispatches `workflow dispatch --workflow <id> --candidate <digest>
   --root <trial-material> --task <stable-key> --no-wait
   --message <goal-baseline-budget>`. This captures the inactive Candidate
   without activation. It needs a distinct Executor and task directory. Git write leases validate the node's actual repository when
   acquired; plain material directories need no fabricated Git repository.
6. WR compares actual coverage, artifact/check versions, rework, failures, time,
   measured cost and human effort on comparable inputs. Disclose missing evidence
   and environment differences. Compilation and WM self-evaluation do not prove
   improvement.
7. PM may retain the tested new carrier, bind it to the intended formal task
   directory, verify that binding and activate with the current activation
   revision. This creates a new full Candidate digest; keep tested file and
   Builder identities for comparison. Returning to the old Executor is optional
   and requires configuration equivalence. Existing Runs retain their snapshots;
   rollback restores the previous full binding for future Runs. Test materials
   are not automatically merged.

Clean material only after no active Run or adopted binding refers to it.
Material cleanup does not delete the Workflow or its Executor. Keep Run and
report references. This structure is not an OS sandbox or a guarantee about
arbitrary external tool side effects.
