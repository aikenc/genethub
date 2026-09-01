import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

const MODEL = "deepseek/deepseek-v4-flash";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type Event = { type?: string; raw: unknown };

function terminalCount(events: Event[]): number {
  return events.filter((event) =>
    ["turnCompleted", "turnFailed", "turnCanceled"].includes(event.type ?? ""),
  ).length;
}

function completedCount(events: Event[]): number {
  return events.filter((event) => event.type === "turnCompleted").length;
}

async function waitForPmIdle(opened: Opened, pmId: string): Promise<void> {
  await new Promise<void>(async (resolve, reject) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const snapshot = await opened.client.call({
        type: "session.get",
        payload: { sessionId: pmId },
      });
      if (snapshot?.type === "snapshot" && snapshot.data.summary.status === "idle") {
        resolve();
        return;
      }
      await new Promise((next) => setTimeout(next, 100));
    }
    reject(new Error("PM Session did not become idle before the next public command"));
  });
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
  const completionsBefore = completedCount(events);
  opened.mock.script(
    { tool: { name: "bash", arguments: { command } } },
    { text: "The requested project-control operation completed." },
  );
  await t.flows.main.sendPrompt(opened.client, pmId, instruction);
  await t.tools.waitUntil(() => terminalCount(events) === terminalsBefore + 1, 45_000);
  t.assertions.assert(
    completedCount(events) === completionsBefore + 1,
    `PM command failed: ${JSON.stringify(events.slice(-16))}`,
  );
}

function writeSpace(
  workspace: string,
  name: string,
  worktreeSpace: string,
): void {
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

function commitFile(worktree: string, relative: string, contents: string, message: string): void {
  writeFileSync(`${worktree}/${relative}`, contents);
  execFileSync("git", ["add", relative], { cwd: worktree });
  execFileSync("git", ["commit", "-qm", message], { cwd: worktree });
}

defineSpecialty(
  {
    id: "specialty.authorization.pm-rework-integrates-accepted-siblings",
    title: "A reviewed rework integrates accepted siblings from the earlier cohort",
    oracle:
      "through the public PM CLI, two independent implementation and review WorkSessions produce one accepted sibling and one failed candidate; after exact-lineage rework passes, the Coordinator records integration evidence for both accepted packages and the repository main contains both changes",
    catches: [
      "the integration source walk stops at the newest WorkAgent node instance and loses accepted siblings from the earlier iteration",
      "a failed review cancels already accepted siblings instead of preserving their immutable evidence",
      "the Run reaches delivered after integrating only the replacement package",
      "PM, Worker and Reviewer roles are collapsed into one execution context",
      "a contradictory review-pass carrying findings is accepted or integrated",
    ],
    tags: [
      "core",
      "authorization",
      "pm-agent-mvp",
      "workflow",
      "parity",
      "pm-rework-integration",
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
    expectedDurationMs: 90_000,
    timeoutMs: 180_000,
    surfaces: ["daemon", "agent", "git", "workbench-client"],
    productInterfaces: ["genet-cli", "@genehub/workbench/client"],
  },
  async (t) => {
    const workAgentId = t.flows.main.installFixtureAcpAgent(t.env);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const created = await opened.client.call({
        type: "pm.session.create",
        payload: {
          workspaceId: opened.workspaceId,
          modelId: MODEL,
          modeId: null,
          effortId: "medium",
          title: "Rework integration fixture",
        },
      });
      t.assertions.assert(created?.type === "session", `pm.session.create returned ${created?.type}`);
      if (created?.type !== "session") return;
      const pmId = created.data.id;
      const events = await t.flows.main.attachEventLog(opened.client, pmId);

      mkdirSync(`${t.env.workspace}/repositories/game`, { recursive: true });
      mkdirSync(`${t.env.workspace}/worktrees/impl-a`, { recursive: true });
      mkdirSync(`${t.env.workspace}/worktrees/impl-b`, { recursive: true });
      mkdirSync(`${t.env.workspace}/skills/project-contract`, { recursive: true });
      writeFileSync(
        `${t.env.workspace}/.gitignore`,
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
        `${t.env.workspace}/skills/project-contract/SKILL.md`,
        "---\nname: project-contract\ndescription: Preserve the deterministic bugfix fixture contract.\n---\n\n# Project contract\n\nKeep every candidate independently reviewable.\n",
      );
      writeSpace(t.env.workspace, "impl-a", "impl-a");
      writeSpace(t.env.workspace, "impl-b", "impl-b");
      writeSpace(t.env.workspace, "review-a", "impl-a");
      writeSpace(t.env.workspace, "review-b", "impl-b");

      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: t.env.workspace });
      execFileSync("git", ["config", "user.name", "GeneHub PM Fixture"], {
        cwd: t.env.workspace,
      });
      execFileSync("git", ["config", "user.email", "pm-fixture@genehub.invalid"], {
        cwd: t.env.workspace,
      });
      execFileSync("git", ["init", "-q", "-b", "main"], {
        cwd: `${t.env.workspace}/repositories/game`,
      });
      execFileSync("git", ["config", "user.name", "Fixture WorkAgent"], {
        cwd: `${t.env.workspace}/repositories/game`,
      });
      execFileSync("git", ["config", "user.email", "work-fixture@genehub.invalid"], {
        cwd: `${t.env.workspace}/repositories/game`,
      });
      writeFileSync(`${t.env.workspace}/repositories/game/README.md`, "# Game baseline\n");
      execFileSync("git", ["add", "README.md"], {
        cwd: `${t.env.workspace}/repositories/game`,
      });
      execFileSync("git", ["commit", "-qm", "Create business baseline"], {
        cwd: `${t.env.workspace}/repositories/game`,
      });
      execFileSync(
        "git",
        [
          "worktree",
          "add",
          "-q",
          "-b",
          "work/a",
          `${t.env.workspace}/worktrees/impl-a/game`,
          "main",
        ],
        { cwd: `${t.env.workspace}/repositories/game` },
      );
      execFileSync(
        "git",
        [
          "worktree",
          "add",
          "-q",
          "-b",
          "work/b",
          `${t.env.workspace}/worktrees/impl-b/game`,
          "main",
        ],
        { cwd: `${t.env.workspace}/repositories/game` },
      );
      execFileSync("git", ["add", ".gitignore", "spaces/pm", "spaces/impl-a", "spaces/impl-b", "spaces/review-a", "spaces/review-b", "skills/project-contract"], {
        cwd: t.env.workspace,
      });
      execFileSync("git", ["commit", "-qm", "Initialize rework integration topology"], {
        cwd: t.env.workspace,
      });

      const spaceNames = ["impl-a", "impl-b", "review-a", "review-b"];
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
        pmId,
        events,
        [
          '"$GENEHUB_CLI" pm project init',
          '"$GENEHUB_CLI" pm project intent set --outcome "Integrate an accepted sibling and its reviewed rework" --acceptance "Both accepted candidates reach repository main"',
          '"$GENEHUB_CLI" pm project advance --to git-ready',
          buildSpaces,
          '"$GENEHUB_CLI" pm project advance --to topology-verified',
        ].join(" && "),
        "Initialize and verify the deterministic rework topology.",
      );

      await runPmCommand(
        t,
        opened,
        pmId,
        events,
        spaceNames
          .map(
            (name) =>
              `"$GENEHUB_CLI" workspace register-agent-space spaces/${name}/${name}.code-workspace`,
          )
          .join(" && "),
        "Register the four verified Agent Spaces.",
      );
      const listed = await opened.client.call({ type: "workspace.list" });
      t.assertions.assert(listed?.type === "workspaces", `workspace.list returned ${listed?.type}`);
      if (listed?.type !== "workspaces") return;
      const workspaceIds = new Map(
        listed.data
          .filter((workspace) => spaceNames.includes(workspace.name))
          .map((workspace) => [workspace.name, workspace.id]),
      );
      for (const name of spaceNames) {
        t.assertions.assert(workspaceIds.has(name), `registered Agent Space ${name} is missing`);
      }
      const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: t.env.workspace,
        encoding: "utf8",
      }).trim();
      await runPmCommand(
        t,
        opened,
        pmId,
        events,
        [
          `"$GENEHUB_CLI" pm project space record --name impl-a --purpose "Implement accepted sibling" --path spaces/impl-a --workspace ${workspaceIds.get("impl-a")} --commit ${sourceCommit} --tag a-lineage`,
          `"$GENEHUB_CLI" pm project space record --name impl-b --purpose "Implement failed and replacement candidate" --path spaces/impl-b --workspace ${workspaceIds.get("impl-b")} --commit ${sourceCommit} --tag b-lineage`,
          `"$GENEHUB_CLI" pm project space record --name review-a --purpose "Review accepted sibling" --path spaces/review-a --workspace ${workspaceIds.get("review-a")} --commit ${sourceCommit} --role review --tag a-lineage`,
          `"$GENEHUB_CLI" pm project space record --name review-b --purpose "Review failed and replacement candidate" --path spaces/review-b --workspace ${workspaceIds.get("review-b")} --commit ${sourceCommit} --role review --tag b-lineage`,
          '"$GENEHUB_CLI" pm project advance --to workspaces-registered',
          '"$GENEHUB_CLI" pm project advance --to active',
          '"$GENEHUB_CLI" pm project workflow select --graph bugfix',
        ].join(" && "),
        "Record the implementation and review capabilities and select the bugfix Workflow.",
      );

      const worktreeA = `${t.env.workspace}/worktrees/impl-a/game`;
      const worktreeB = `${t.env.workspace}/worktrees/impl-b/game`;
      commitFile(worktreeA, "accepted-sibling.txt", "accepted sibling\n", "Create accepted sibling");
      commitFile(worktreeB, "reworked-candidate.txt", "first candidate\n", "Create first candidate");
      await runPmCommand(
        t,
        opened,
        pmId,
        events,
        [
          '"$GENEHUB_CLI" pm project package put --id accepted-sibling --title "Accepted sibling" --outcome "Preserve the passing candidate" --space-tag a-lineage --repository game --branch work/a --node fix',
          '"$GENEHUB_CLI" pm project package put --id failed-original --title "Failed original" --outcome "Preserve failed review evidence" --space-tag b-lineage --repository game --branch work/b --node fix',
          '"$GENEHUB_CLI" pm project package transition --id accepted-sibling --to ready',
          '"$GENEHUB_CLI" pm project package transition --id failed-original --to ready',
          `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${workspaceIds.get("impl-a")} --work-package accepted-sibling --no-wait "GENEHUB_FIXTURE_CANDIDATE_READY"`,
          `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${workspaceIds.get("impl-b")} --work-package failed-original --no-wait "GENEHUB_FIXTURE_CANDIDATE_READY"`,
        ].join(" && "),
        "Bind and dispatch the two first-cohort implementation packages.",
      );

      await t.tools.waitUntil(async () => {
        const status = await opened.client.call({
          type: "pm.project.status",
          payload: { workspaceId: opened.workspaceId },
        });
        return (
          status?.type === "projectStatus" &&
          ["accepted-sibling", "failed-original"].every(
            (id) => status.data.workPackages.find((item) => item.id === id)?.status === "candidate",
          )
        );
      }, 45_000);
      await runPmCommand(
        t,
        opened,
        pmId,
        events,
        [
          `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${workspaceIds.get("review-a")} --work-package accepted-sibling --no-wait "GENEHUB_FIXTURE_REVIEW_PASS"`,
          `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${workspaceIds.get("review-b")} --work-package failed-original --no-wait "GENEHUB_FIXTURE_REVIEW_FAIL"`,
        ].join(" && "),
        "Dispatch independent passing and failing reviews.",
      );

      await t.tools.waitUntil(async () => {
        const status = await opened.client.call({
          type: "pm.project.status",
          payload: { workspaceId: opened.workspaceId },
        });
        const accepted =
          status?.type === "projectStatus"
            ? status.data.workPackages.find((item) => item.id === "accepted-sibling")
            : undefined;
        const failed =
          status?.type === "projectStatus"
            ? status.data.workPackages.find((item) => item.id === "failed-original")
            : undefined;
        const run =
          status?.type === "projectStatus"
            ? status.data.workflowRuns.find((item) => item.controllerSessionId === pmId)
            : undefined;
        return (
          accepted?.status === "accepted" &&
          accepted.reviewVerdict === "pass" &&
          failed?.status === "review" &&
          failed.reviewVerdict === "fail" &&
          run?.activeNodes.includes("review-triage") === true
        );
      }, 45_000);
      await runPmCommand(
        t,
        opened,
        pmId,
        events,
        '"$GENEHUB_CLI" pm project workflow transition --edge review-rework --fact review.rework.ready',
        "Choose the bounded rework edge for the failed candidate.",
      );

      commitFile(
        worktreeB,
        "reworked-candidate.txt",
        "first candidate\nreview correction\n",
        "Apply reviewer correction",
      );
      await runPmCommand(
        t,
        opened,
        pmId,
        events,
        [
          '"$GENEHUB_CLI" pm project package put --id failed-rework --title "Failed candidate rework" --outcome "Apply the bounded reviewer correction" --space-tag b-lineage --repository game --branch work/b --node fix',
          '"$GENEHUB_CLI" pm project package transition --id failed-rework --to ready',
          `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${workspaceIds.get("impl-b")} --work-package failed-rework --no-wait "GENEHUB_FIXTURE_CANDIDATE_READY"`,
        ].join(" && "),
        "Bind and dispatch the exact-lineage replacement package.",
      );
      await t.tools.waitUntil(async () => {
        const status = await opened.client.call({
          type: "pm.project.status",
          payload: { workspaceId: opened.workspaceId },
        });
        return (
          status?.type === "projectStatus" &&
          status.data.workPackages.find((item) => item.id === "failed-rework")?.status ===
            "candidate"
        );
      }, 45_000);
      await runPmCommand(
        t,
        opened,
        pmId,
        events,
        `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${workspaceIds.get("review-b")} --work-package failed-rework --no-wait "GENEHUB_FIXTURE_REVIEW_PASS"`,
        "Dispatch the independent Reviewer for the replacement candidate.",
      );

      let finalStatus: Awaited<ReturnType<typeof opened.client.call>> | undefined;
      await t.tools.waitUntil(async () => {
        finalStatus = await opened.client.call({
          type: "pm.project.status",
          payload: { workspaceId: opened.workspaceId },
        });
        const run =
          finalStatus?.type === "projectStatus"
            ? finalStatus.data.workflowRuns.find((item) => item.controllerSessionId === pmId)
            : undefined;
        return run?.status === "completed" && run.outcome === "delivered";
      }, 60_000);
      const packages =
        finalStatus?.type === "projectStatus" ? finalStatus.data.workPackages : [];
      const accepted = packages.find((item) => item.id === "accepted-sibling");
      const original = packages.find((item) => item.id === "failed-original");
      const replacement = packages.find((item) => item.id === "failed-rework");
      const mainAccepted = readFileSync(
        `${t.env.workspace}/repositories/game/accepted-sibling.txt`,
        "utf8",
      );
      const mainReworked = readFileSync(
        `${t.env.workspace}/repositories/game/reworked-candidate.txt`,
        "utf8",
      );
      t.assertions.assert(
        accepted?.status === "accepted" &&
          accepted.reviewVerdict === "pass" &&
          Boolean(accepted.integratedCommit) &&
          Boolean(accepted.integratedTree) &&
          original?.status === "cancelled" &&
          original.reviewVerdict === "fail" &&
          !original.integratedCommit &&
          replacement?.status === "accepted" &&
          replacement.reviewVerdict === "pass" &&
          Boolean(replacement.integratedCommit) &&
          Boolean(replacement.integratedTree) &&
          mainAccepted === "accepted sibling\n" &&
          mainReworked === "first candidate\nreview correction\n",
        `Coordinator delivered without integrating the full accepted cohort: ${JSON.stringify(finalStatus)}`,
      );

      // A Reviewer cannot smuggle an unresolved acceptance defect through a
      // passing verdict. Exercise the strict result protocol through a new PM
      // Session after the first Run has released the shared Spaces. The
      // Coordinator must request its one bounded repair, retain the exact
      // diagnostic in the Reviewer Session, and block rather than accept or
      // integrate the contradictory result.
      const contradictoryPm = await opened.client.call({
        type: "pm.session.create",
        payload: {
          workspaceId: opened.workspaceId,
          modelId: MODEL,
          modeId: null,
          effortId: "medium",
          title: "Contradictory Reviewer protocol fixture",
        },
      });
      t.assertions.assert(
        contradictoryPm?.type === "session",
        `second pm.session.create returned ${contradictoryPm?.type}`,
      );
      if (contradictoryPm?.type !== "session") return;
      const contradictoryPmId = contradictoryPm.data.id;
      const contradictoryEvents = await t.flows.main.attachEventLog(
        opened.client,
        contradictoryPmId,
      );
      commitFile(
        worktreeB,
        "contradictory-review.txt",
        "candidate whose Reviewer returns an internally inconsistent verdict\n",
        "Create contradictory review protocol fixture",
      );
      await runPmCommand(
        t,
        opened,
        contradictoryPmId,
        contradictoryEvents,
        [
          '"$GENEHUB_CLI" pm project workflow select --graph bugfix',
          '"$GENEHUB_CLI" pm project package put --id contradictory-review --title "Contradictory review" --outcome "Reject pass verdicts that still report findings" --space-tag b-lineage --repository game --branch work/b --node fix',
          '"$GENEHUB_CLI" pm project package transition --id contradictory-review --to ready',
          `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${workspaceIds.get("impl-b")} --work-package contradictory-review --no-wait "GENEHUB_FIXTURE_CANDIDATE_READY"`,
        ].join(" && "),
        "Create the candidate for contradictory Reviewer protocol coverage.",
      );
      await t.tools.waitUntil(async () => {
        const status = await opened.client.call({
          type: "pm.project.status",
          payload: { workspaceId: opened.workspaceId },
        });
        return (
          status?.type === "projectStatus" &&
          status.data.workPackages.find((item) => item.id === "contradictory-review")
            ?.status === "candidate"
        );
      }, 45_000);
      await runPmCommand(
        t,
        opened,
        contradictoryPmId,
        contradictoryEvents,
        `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${workspaceIds.get("review-b")} --work-package contradictory-review --no-wait "GENEHUB_FIXTURE_REVIEW_PASS_WITH_FINDINGS"`,
        "Dispatch a Reviewer that emits a contradictory passing verdict.",
      );

      let contradictoryStatus: Awaited<ReturnType<typeof opened.client.call>> | undefined;
      await t.tools.waitUntil(async () => {
        contradictoryStatus = await opened.client.call({
          type: "pm.project.status",
          payload: { workspaceId: opened.workspaceId },
        });
        return (
          contradictoryStatus?.type === "projectStatus" &&
          contradictoryStatus.data.workPackages.find(
            (item) => item.id === "contradictory-review",
          )?.status === "blocked"
        );
      }, 45_000);
      const contradictoryPackage =
        contradictoryStatus?.type === "projectStatus"
          ? contradictoryStatus.data.workPackages.find(
              (item) => item.id === "contradictory-review",
            )
          : undefined;
      const contradictoryReviewSession = contradictoryPackage?.reviewSessionId
        ? await opened.client.call({
            type: "session.get",
            payload: { sessionId: contradictoryPackage.reviewSessionId },
          })
        : undefined;
      const repairDiagnostic =
        contradictoryReviewSession?.type === "snapshot"
          ? contradictoryReviewSession.data.items.find(
              (item) =>
                item.type === "userMessage" &&
                item.text.includes("[GENEHUB_MANAGED_RESULT_REPAIR]") &&
                item.text.includes("review-pass must not contain findings"),
            )
          : undefined;
      t.assertions.assert(
        contradictoryPackage?.status === "blocked" &&
          !contradictoryPackage.reviewVerdict &&
          !contradictoryPackage.integratedCommit &&
          repairDiagnostic !== undefined,
        `Coordinator accepted a contradictory Reviewer result: package=${JSON.stringify(contradictoryPackage)} review=${JSON.stringify(contradictoryReviewSession)}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
