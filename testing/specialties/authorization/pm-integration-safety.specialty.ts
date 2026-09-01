import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

const MODEL = "deepseek/deepseek-v4-flash";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type Event = { type?: string; raw: unknown };

function terminalCount(events: Event[]): number {
  return events.filter((event) =>
    ["turnCompleted", "turnFailed", "turnCanceled"].includes(event.type ?? ""),
  ).length;
}

async function waitForPmIdle(opened: Opened, pmId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = await opened.client.call({
      type: "session.get",
      payload: { sessionId: pmId },
    });
    if (snapshot?.type === "snapshot" && snapshot.data.summary.status === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PM Session did not become idle before the next public command");
}

async function runPmCommand(
  t: CaseContext,
  opened: Opened,
  pmId: string,
  events: Event[],
  command: string,
  instruction: string,
): Promise<void> {
  await waitForPmIdle(opened, pmId);
  const terminalsBefore = terminalCount(events);
  opened.mock.script(
    { tool: { name: "bash", arguments: { command } } },
    { text: "The requested project-control operation completed." },
  );
  await t.flows.main.sendPrompt(opened.client, pmId, instruction);
  await t.tools.waitUntil(() => terminalCount(events) === terminalsBefore + 1, 45_000);
  const snapshot = await opened.client.call({
    type: "session.get",
    payload: { sessionId: pmId },
  });
  t.assertions.assert(
    snapshot?.type === "snapshot" && snapshot.data.summary.status === "idle",
    `PM command failed: ${JSON.stringify(events.slice(-16))}`,
  );
}

async function approveDelivery(
  t: CaseContext,
  opened: Opened,
  pmId: string,
): Promise<void> {
  let deliveryRevision: number | undefined;
  await t.tools.waitUntil(async () => {
    const status = await opened.client.call({
      type: "pm.project.status",
      payload: { workspaceId: opened.workspaceId },
    });
    const run = status?.type === "projectStatus"
      ? status.data.workflowRuns.find((item) => item.controllerSessionId === pmId)
      : undefined;
    const ready = Boolean(
      run?.activeNodes.includes("approve-delivery") &&
        run.availableEdges.some(
          (edge) => edge.id === "delivery-approved" && edge.satisfied,
        ),
    );
    if (ready) deliveryRevision = run?.revision;
    return ready;
  }, 45_000);
  if (deliveryRevision === undefined) {
    throw new Error("reviewed candidate did not reach the delivery decision");
  }
  const approved = await opened.client.call({
    type: "pm.workflow.transition",
    payload: {
      workspaceId: opened.workspaceId,
      sessionId: pmId,
      edgeId: "delivery-approved",
      expectedRevision: deliveryRevision,
      facts: [],
    },
  });
  if (approved?.type !== "projectStatus") {
    throw new Error(`user delivery approval failed: ${JSON.stringify(approved)}`);
  }
}

function writeSpace(workspace: string, name: string, worktreeSpace: string): void {
  mkdirSync(`${workspace}/spaces/${name}`, { recursive: true });
  writeFileSync(
    `${workspace}/spaces/${name}/pipespace.json`,
    `${JSON.stringify({
      schema: "pipespace.v1",
      name,
      agents: ["codex"],
      skills: ["project-contract"],
      tags: [],
      skillProviders: [{ type: "folder", path: "../../skills" }],
    })}\n`,
  );
  writeFileSync(
    `${workspace}/spaces/${name}/${name}.code-workspace`,
    `${JSON.stringify({
      folders: [
        { name, path: "." },
        { name: "game", path: `../../worktrees/${worktreeSpace}/game` },
      ],
    })}\n`,
  );
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createPm(opened: Opened, title: string): Promise<string> {
  const created = await opened.client.call({
    type: "pm.session.create",
    payload: {
      workspaceId: opened.workspaceId,
      modelId: MODEL,
      modeId: null,
      effortId: "medium",
      title,
    },
  });
  if (created?.type !== "session") {
    throw new Error(`pm.session.create returned ${created?.type}`);
  }
  return created.data.id;
}

defineSpecialty(
  {
    id: "specialty.authorization.pm-integration-fails-closed",
    title: "Coordinator integration aborts conflicts and rejects executable Git configuration",
    oracle:
      "through two real PM Sessions and the public CLI, independently reviewed exact candidates reach Coordinator integration; a merge conflict leaves main unchanged and clean, while an executable merge driver is rejected without running it",
    catches: [
      "a failed merge leaves MERGE_HEAD or dirty files in the shared baseline",
      "Coordinator executes a repository-configured merge driver while integrating an accepted candidate",
      "integration failure is retried silently instead of becoming durable workflow evidence",
      "PM performs the merge or manufactures the integration verdict",
    ],
    tags: [
      "core",
      "authorization",
      "pm-agent-mvp",
      "workflow",
      "git",
      "parity",
      "pm-integration-safety",
    ],
    llm: { default: "mock" },
    resources: {
      environments: 1,
      cpu: 2,
      memoryMb: 1024,
      io: 1,
      browser: 0,
      pool: "standard",
    },
    expectedDurationMs: 120_000,
    timeoutMs: 240_000,
    surfaces: ["daemon", "agent", "git", "workbench-client"],
    productInterfaces: ["genet-cli", "@genehub/workbench/client"],
  },
  async (t) => {
    const workAgentId = t.flows.main.installFixtureAcpAgent(t.env);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const conflictPm = await createPm(opened, "Conflict integration fixture");
      const unsafePm = await createPm(opened, "Unsafe Git integration fixture");
      const conflictEvents = await t.flows.main.attachEventLog(opened.client, conflictPm);
      const unsafeEvents = await t.flows.main.attachEventLog(opened.client, unsafePm);

      const workspace = t.env.workspace;
      const repository = `${workspace}/repositories/game`;
      const conflictWorktree = `${workspace}/worktrees/impl-conflict/game`;
      const unsafeWorktree = `${workspace}/worktrees/impl-unsafe/game`;
      mkdirSync(repository, { recursive: true });
      mkdirSync(`${workspace}/skills/project-contract`, { recursive: true });
      writeFileSync(
        `${workspace}/.gitignore`,
        [
          ".genethub/",
          "repositories/",
          "worktrees/",
          "spaces/*/.pipebuilder/",
          "spaces/*/.agents/",
          "spaces/*/.cursor/",
          "spaces/*/.codebuddy/",
          "spaces/*/.claude/",
          "spaces/*/AGENTS.md",
          "spaces/*/CLAUDE.md",
          "",
        ].join("\n"),
      );
      writeFileSync(
        `${workspace}/skills/project-contract/SKILL.md`,
        "---\nname: project-contract\ndescription: Preserve integration safety.\n---\n\n# Integration safety\n",
      );
      for (const [name, worktree] of [
        ["impl-conflict", "impl-conflict"],
        ["review-conflict", "impl-conflict"],
        ["impl-unsafe", "impl-unsafe"],
        ["review-unsafe", "impl-unsafe"],
      ] as const) {
        writeSpace(workspace, name, worktree);
      }

      git(workspace, ["init", "-q", "-b", "main"]);
      git(workspace, ["config", "user.name", "GeneHub PM Fixture"]);
      git(workspace, ["config", "user.email", "pm-fixture@genehub.invalid"]);
      git(repository, ["init", "-q", "-b", "main"]);
      git(repository, ["config", "user.name", "Fixture WorkAgent"]);
      git(repository, ["config", "user.email", "work-fixture@genehub.invalid"]);
      writeFileSync(`${repository}/shared.txt`, "base\n");
      git(repository, ["add", "shared.txt"]);
      git(repository, ["commit", "-qm", "Create integration baseline"]);
      git(repository, [
        "worktree",
        "add",
        "-q",
        "-b",
        "work/conflict",
        conflictWorktree,
        "main",
      ]);
      git(repository, [
        "worktree",
        "add",
        "-q",
        "-b",
        "work/unsafe",
        unsafeWorktree,
        "main",
      ]);
      git(workspace, [
        "add",
        ".gitignore",
        "spaces/pm",
        "spaces/impl-conflict",
        "spaces/review-conflict",
        "spaces/impl-unsafe",
        "spaces/review-unsafe",
        "skills/project-contract",
      ]);
      git(workspace, ["commit", "-qm", "Initialize integration safety topology"]);

      const spaceNames = [
        "impl-conflict",
        "review-conflict",
        "impl-unsafe",
        "review-unsafe",
      ];
      const buildSpaces = spaceNames
        .flatMap((name) => [
          `"$GENEHUB_CLI" agent-space check ${name}`,
          `"$GENEHUB_CLI" agent-space build ${name} --require-no-post-commands`,
          `"$GENEHUB_CLI" agent-space verify ${name}`,
        ])
        .join(" && ");
      await runPmCommand(
        t,
        opened,
        conflictPm,
        conflictEvents,
        [
          '"$GENEHUB_CLI" pm project init',
          '"$GENEHUB_CLI" pm project intent set --outcome "Prove conflict cleanup" --acceptance "Main remains clean after conflict"',
          '"$GENEHUB_CLI" pm project advance --to git-ready',
          buildSpaces,
          '"$GENEHUB_CLI" pm project advance --to topology-verified',
        ].join(" && "),
        "Initialize the integration-safety topology.",
      );
      await runPmCommand(
        t,
        opened,
        conflictPm,
        conflictEvents,
        spaceNames
          .map(
            (name) =>
              `"$GENEHUB_CLI" workspace register-agent-space spaces/${name}/${name}.code-workspace`,
          )
          .join(" && "),
        "Register the integration-safety Agent Spaces.",
      );
      const listed = await opened.client.call({ type: "workspace.list" });
      t.assertions.assert(listed?.type === "workspaces", `workspace.list returned ${listed?.type}`);
      if (listed?.type !== "workspaces") return;
      const workspaceIds = new Map(
        listed.data
          .filter((item) => spaceNames.includes(item.name))
          .map((item) => [item.name, item.id]),
      );
      const sourceCommit = git(workspace, ["rev-parse", "HEAD"]);
      await runPmCommand(
        t,
        opened,
        conflictPm,
        conflictEvents,
        [
          `"$GENEHUB_CLI" pm project space record --name impl-conflict --purpose "Implement conflict fixture" --path spaces/impl-conflict --workspace ${workspaceIds.get("impl-conflict")} --commit ${sourceCommit} --tag conflict-lineage`,
          `"$GENEHUB_CLI" pm project space record --name review-conflict --purpose "Review conflict fixture" --path spaces/review-conflict --workspace ${workspaceIds.get("review-conflict")} --commit ${sourceCommit} --role review --tag conflict-lineage`,
          `"$GENEHUB_CLI" pm project space record --name impl-unsafe --purpose "Implement unsafe-config fixture" --path spaces/impl-unsafe --workspace ${workspaceIds.get("impl-unsafe")} --commit ${sourceCommit} --tag unsafe-lineage`,
          `"$GENEHUB_CLI" pm project space record --name review-unsafe --purpose "Review unsafe-config fixture" --path spaces/review-unsafe --workspace ${workspaceIds.get("review-unsafe")} --commit ${sourceCommit} --role review --tag unsafe-lineage`,
          '"$GENEHUB_CLI" pm project advance --to workspaces-registered',
          '"$GENEHUB_CLI" pm project advance --to active',
          '"$GENEHUB_CLI" pm project workflow select --graph bugfix',
          '"$GENEHUB_CLI" pm project workflow transition --edge aligned --fact intent.aligned',
        ].join(" && "),
        "Record the exact integration-safety capabilities and select the first Workflow.",
      );
      await runPmCommand(
        t,
        opened,
        unsafePm,
        unsafeEvents,
        [
          '"$GENEHUB_CLI" pm project intent set --outcome "Reject executable Git configuration" --acceptance "No repository command is executed"',
          '"$GENEHUB_CLI" pm project workflow select --graph bugfix',
          '"$GENEHUB_CLI" pm project workflow transition --edge aligned --fact intent.aligned',
        ].join(" && "),
        "Select the independent unsafe-configuration Workflow.",
      );

      writeFileSync(`${conflictWorktree}/shared.txt`, "candidate\n");
      git(conflictWorktree, ["add", "shared.txt"]);
      git(conflictWorktree, ["commit", "-qm", "Create conflicting candidate"]);
      await runPmCommand(
        t,
        opened,
        conflictPm,
        conflictEvents,
        [
          '"$GENEHUB_CLI" pm project package put --id conflict-candidate --title "Conflicting candidate" --outcome "Prove merge abort cleanup" --space-tag conflict-lineage --repository game --branch work/conflict --node fix',
          '"$GENEHUB_CLI" pm project package transition --id conflict-candidate --to ready',
          `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${workspaceIds.get("impl-conflict")} --work-package conflict-candidate --no-wait "GENEHUB_FIXTURE_CANDIDATE_READY"`,
        ].join(" && "),
        "Dispatch the conflicting implementation candidate.",
      );
      await t.tools.waitUntil(async () => {
        const status = await opened.client.call({
          type: "pm.project.status",
          payload: { workspaceId: opened.workspaceId },
        });
        return status?.type === "projectStatus" &&
          status.data.workPackages.find((item) => item.id === "conflict-candidate")?.status ===
            "candidate";
      }, 45_000);
      writeFileSync(`${repository}/shared.txt`, "main\n");
      git(repository, ["add", "shared.txt"]);
      git(repository, ["commit", "-qm", "Diverge shared baseline"]);
      const conflictMain = git(repository, ["rev-parse", "HEAD"]);
      await runPmCommand(
        t,
        opened,
        conflictPm,
        conflictEvents,
        `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${workspaceIds.get("review-conflict")} --work-package conflict-candidate --no-wait "GENEHUB_FIXTURE_REVIEW_PASS"`,
        "Dispatch the independent Reviewer for the conflicting candidate.",
      );
      await approveDelivery(t, opened, conflictPm);
      let conflictStatus: Awaited<ReturnType<typeof opened.client.call>> | undefined;
      await t.tools.waitUntil(async () => {
        conflictStatus = await opened.client.call({
          type: "pm.project.status",
          payload: { workspaceId: opened.workspaceId },
        });
        return conflictStatus?.type === "projectStatus" && Boolean(
          conflictStatus.data.workPackages.find((item) => item.id === "conflict-candidate")
            ?.integrationError,
        );
      }, 60_000);
      const conflictPackage =
        conflictStatus?.type === "projectStatus"
          ? conflictStatus.data.workPackages.find((item) => item.id === "conflict-candidate")
          : undefined;
      t.assertions.assert(
        conflictPackage?.status === "accepted" &&
          conflictPackage.reviewVerdict === "pass" &&
          conflictPackage.integrationError?.includes("could not be merged cleanly") === true &&
          git(repository, ["rev-parse", "HEAD"]) === conflictMain &&
          readFileSync(`${repository}/shared.txt`, "utf8") === "main\n" &&
          git(repository, ["status", "--porcelain"]) === "" &&
          !existsSync(`${repository}/.git/MERGE_HEAD`),
        `conflicting integration did not abort cleanly: ${JSON.stringify(conflictStatus)}`,
      );

      writeFileSync(`${unsafeWorktree}/unsafe.txt`, "accepted candidate\n");
      git(unsafeWorktree, ["add", "unsafe.txt"]);
      git(unsafeWorktree, ["commit", "-qm", "Create unsafe-config candidate"]);
      await runPmCommand(
        t,
        opened,
        unsafePm,
        unsafeEvents,
        [
          '"$GENEHUB_CLI" pm project package put --id unsafe-candidate --title "Unsafe Git configuration candidate" --outcome "Reject executable merge configuration" --space-tag unsafe-lineage --repository game --branch work/unsafe --node fix',
          '"$GENEHUB_CLI" pm project package transition --id unsafe-candidate --to ready',
          `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${workspaceIds.get("impl-unsafe")} --work-package unsafe-candidate --no-wait "GENEHUB_FIXTURE_CANDIDATE_READY"`,
        ].join(" && "),
        "Dispatch the unsafe-configuration implementation candidate.",
      );
      await t.tools.waitUntil(async () => {
        const status = await opened.client.call({
          type: "pm.project.status",
          payload: { workspaceId: opened.workspaceId },
        });
        return status?.type === "projectStatus" &&
          status.data.workPackages.find((item) => item.id === "unsafe-candidate")?.status ===
            "candidate";
      }, 45_000);
      const sentinel = `${workspace}/merge-driver-must-not-run`;
      const unsafeMain = git(repository, ["rev-parse", "HEAD"]);
      git(repository, ["config", "merge.untrusted.driver", `touch ${sentinel}`]);
      try {
        await runPmCommand(
          t,
          opened,
          unsafePm,
          unsafeEvents,
          `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${workspaceIds.get("review-unsafe")} --work-package unsafe-candidate --no-wait "GENEHUB_FIXTURE_REVIEW_PASS"`,
          "Dispatch the independent Reviewer for the unsafe-configuration candidate.",
        );
        await approveDelivery(t, opened, unsafePm);
        let unsafeStatus: Awaited<ReturnType<typeof opened.client.call>> | undefined;
        await t.tools.waitUntil(async () => {
          unsafeStatus = await opened.client.call({
            type: "pm.project.status",
            payload: { workspaceId: opened.workspaceId },
          });
          return unsafeStatus?.type === "projectStatus" && Boolean(
            unsafeStatus.data.workPackages.find((item) => item.id === "unsafe-candidate")
              ?.integrationError,
          );
        }, 60_000);
        const unsafePackage =
          unsafeStatus?.type === "projectStatus"
            ? unsafeStatus.data.workPackages.find((item) => item.id === "unsafe-candidate")
            : undefined;
        t.assertions.assert(
          unsafePackage?.status === "accepted" &&
            unsafePackage.reviewVerdict === "pass" &&
            unsafePackage.integrationError?.includes("may execute an external command") === true &&
            !existsSync(sentinel) &&
            git(repository, ["rev-parse", "HEAD"]) === unsafeMain &&
            git(repository, ["status", "--porcelain"]) === "",
          `unsafe Git configuration was not rejected before integration: ${JSON.stringify(unsafeStatus)}`,
        );
      } finally {
        git(repository, ["config", "--unset", "merge.untrusted.driver"]);
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
