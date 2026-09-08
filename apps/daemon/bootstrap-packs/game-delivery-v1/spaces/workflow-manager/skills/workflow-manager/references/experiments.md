# Experimental execution

PM coordinates the decision and remains the user's conversation. Prepare the source and experiment plan; a managed WorkflowManager cannot dispatch another Workflow. Return the plan and candidate digest to PM for dispatch.

1. Fix the requirement/acceptance revisions, baseline commit and cases, expected benefit, cost ceiling and stopping conditions. Select a separate project-owned directory, such as `experiments/v2`, with its own Git repository. Copy the approved baseline without private Session state, secrets or live output destinations. An external write that cannot be redirected safely is a concrete blocker; do not silently reuse it.
2. Prepare a separate Executor and squad under `spaces/`, e.g. `executor-v2`, `coder-v2`, `reviewer-v2`, and the specialist roles required by this project's catalog. Give their code-workspaces the experimental project directory as their task folder. Copy and adjust the approved Skill/prompt/model source. Builder writes require the user interface or a user terminal; managed Agents must return the concrete source and operation plan to PM to guide the user, not invoke them under a session caller. The user builds and verifies with `genet space builder build --name <space-name> --require-no-post-commands` and `space builder verify`.
3. Use the existing AgentSpace plans and Human-approved changes to attach the new Executor to the PM project, then its Workers to that Executor. Set Parent before mounting components so the new Space is verified within the owning project. Mount `worker` before its `reviewer` extension. Preserve the formal team; do not reparent or rename it as an experiment. If a guard reports an active-resource conflict, surface it rather than bypassing it.
4. In the candidate's `.genethub/workflow/project.yaml`, set the complete execution binding:

```yaml
execution:
  executorPath: spaces/executor-v2
  root: experiments/v2
```

The formal v1 candidate retains `executorPath: spaces/executor` and `root: .`. Candidate digests bind this configuration along with the workflows, role/model configuration and prompts. Every required role must have its own enabled, Builder-verified Worker attached to the selected Executor. The approved Skills stay Builder-verified; changing registered sources requires rebuilding and updating their binding, and may block an in-flight Run instead of reinterpreting it.

5. Compile with `genet workflow inspect` and return its candidate digest. PM runs `genet workflow dispatch --workflow <workflow-id> --candidate <digest> --task <unique-experiment-key> --no-wait --message <goal-baseline-cases-budget>`. An explicit inactive candidate is captured durably, requires a distinct Executor and independent Git directory, and does not activate itself. A changed or unavailable digest is rejected. Retrying the same PM task and payload returns the original Run; a changed payload requires a new key.
6. WR compares actual artifacts and requirements, regression, rework, time, human effort and cost. Record missing evidence and confounders. PM decides whether to continue, reject or adopt within the user's authorization and agreed budget. Source compilation and engineering Reviewer approval alone are not this comparison.
7. After adoption is justified, PM uses `genet workflow activate --candidate <reviewed-digest> --revision <current-activation-revision>`. This CAS switches the complete candidate/execution binding for future Runs. Existing Runs keep their original binding. Roll back with the previous digest and the current revision; do not rewrite historical results or pretend to undo external side effects.

Trial bindings provide separate repositories and squads, not an OS sandbox for arbitrary external tools. Declare and redirect external destinations explicitly. Archive unsuccessful experiment directories only after their Runs have ended; retain Run/report/digest references, and use the existing approved Space lifecycle/removal actions for registered resources.
