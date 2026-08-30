# PM project lifecycle

Use the project Folder Workspace root as the PM cwd for the entire project.

## New project stages

1. `folderSelected`: call `pm project init`. It must reject unknown files, an existing `.git`, or conflicting `spaces/`, `repositories/`, and `worktrees/`. A daemon-owned `.genethub/` directory is allowed.
2. `preflightPassed`: verify Git and at least one intended third-party Coding Agent/model. Guide the user through missing installation or login; never install or submit credentials silently.
3. `gitReady`: initialize the outer Space-management repository on `main`, add the standard ignores, create the independent business repository and its empty baseline, then record the stage. Do not change global Git config.
4. `topologyVerified`: create only the Agent Spaces needed by the current graph. Run Agent Space Builder check, explain, dry-run, build, and verify; commit source Skills and Space definitions in the outer repository.
5. `workspacesRegistered`: register each verified Agent Space through the bound CLI and record its workspace id, Space commit, and Builder lock digest.
6. `active`: mark the shared project topology ready for independent PM Session Workflow Runs with `pm project advance --to active`. This is the final project **phase** transition. Do not substitute `pm project lifecycle --to active`; lifecycle is a separate field and may already be active while the phase remains `workspacesRegistered`. The project does not need a requirement-specific Intent or WorkPackage yet; each Session records those after selecting its own graph. Dispatch still requires that Session's durable package, branch, worktree, budget, and gates.

Every stage is idempotent. On resume, validate the already-recorded fact and continue at the first incomplete stage; do not create a second repository or baseline.
Only the project-initialization Session advances these shared stages. Sibling
requirement Sessions reuse the active project and must not race each other by
replaying global phase transitions.

## PM turn boundary

The PM is durable across turns, not continuously busy inside one turn. Dispatch and bind all ready independent packages, record immediate facts, report briefly, then return idle. Never implement supervision with shell sleep, timers, background jobs, polling loops, or repeated session reads. The daemon supervisor owns scheduled checks and material-change wakes so the user can ask a question or redirect the project between PM turns.

## Terminal states

- `waitingUser`: no timed model turn; wake on user guidance.
- `completed`: close the current accepted delivery and retain Agent Spaces, repositories, WorkSessions, candidates, and reviews. A later explicit user request for this Folder reopens the same project with `lifecycle --to active`, records a new Intent revision, and adds new work packages; never create a second outer repository or discard accepted lineage.
- `cancelled`: stop active work safely and retain the same evidence. MVP has no physical Agent Space deletion or automatic cleanup.
