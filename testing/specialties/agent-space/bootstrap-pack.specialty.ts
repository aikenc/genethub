import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

interface CliResult {
  status: number;
  data: Record<string, unknown>;
  text: string;
}

defineSpecialty(
  {
    id: "specialty.agent-space.bootstrap-pack",
    title: "One Bootstrap Pack materializes the PM game-delivery team",
    oracle:
      "`genet space bootstrap plan` is read-only and `apply` installs the versioned PM assets, project DCGs, and exactly four Builder-verified AgentSpaces (WorkflowManager, Executor, Coder, Reviewer) with the declared component tree; applying the same pack again is an idempotent no-op rather than a duplicate team",
    catches: [
      "bootstrap exists only as daemon business constants rather than a versioned resource pack",
      "planning mutates the project",
      "the four AgentSpaces are written but never Builder-verified or registered",
      "ownership and scheduling parents are confused, so the project reaches every Worker directly",
      "a repeated PM request creates duplicate Spaces or increments component revisions",
      "the installed workflow is not visible to the public workflow CLI",
    ],
    tags: ["core", "agent-space", "bootstrap-pack", "genet-cli", "workflow"],
    llm: { default: "mock" },
    expectedDurationMs: 30_000,
    timeoutMs: 120_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "genet-cli", "workbench-client"],
    productInterfaces: ["genet space bootstrap", "genet space children", "genet workflow inspect"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const projectRoot = path.join(opened.workspaceRoot, "game-project");
      mkdirSync(projectRoot, { recursive: true });
      const projectReply = await opened.client.call({
        type: "workspace.open",
        payload: { root: projectRoot },
      });
      t.assertions.assert(projectReply?.type === "workspace", "workspace.open did not return the project");
      const projectId = projectReply?.type === "workspace" ? projectReply.data.id : "";

      const genet = (args: string[]): CliResult => {
        const result = spawnSync(opened.daemon.genet, args, {
          cwd: projectRoot,
          env: opened.daemon.env,
          encoding: "utf8",
        });
        let data: Record<string, unknown> = {};
        for (const line of result.stdout.split("\n")) {
          if (!line.trim().startsWith("{")) continue;
          try {
            const envelope = JSON.parse(line) as { data?: Record<string, unknown> };
            data = envelope.data ?? {};
          } catch {
            // Diagnostics are allowed around the one JSON answer.
          }
        }
        return { status: result.status ?? -1, data, text: `${result.stdout}\n${result.stderr}` };
      };
      const bootstrap = (action: "plan" | "apply") =>
        genet([
          "space",
          "bootstrap",
          action,
          "--workspace",
          projectId,
          "--pack",
          "game-delivery-v1",
          "--agent",
          "opencode",
          "--model",
          "mock",
        ]);

      const available = genet(["space", "bootstrap", "list"]);
      t.assertions.assert(available.status === 0, `bootstrap list failed: ${available.text}`);
      const packs = (available.data.packs ?? []) as Array<{ id: string; description: string }>;
      t.assertions.assert(
        packs.some(
          (pack) =>
            pack.id === "game-delivery-v1" &&
            pack.description.includes("WorkflowManager"),
        ),
        `the game delivery Pack is not discoverable by its declared purpose: ${available.text}`,
      );

      const planned = bootstrap("plan");
      t.assertions.assert(planned.status === 0, `bootstrap plan failed: ${planned.text}`);
      t.assertions.assert(planned.data.status === "planned", `plan did not report planned: ${planned.text}`);
      t.assertions.assert(
        planned.data.entrySkill === ".pipebuilder/skills/project-manager/SKILL.md",
        `bootstrap plan did not expose its method entry point: ${planned.text}`,
      );
      t.assertions.assert(
        !existsSync(path.join(projectRoot, "pipespace.json")),
        "bootstrap plan mutated the project",
      );

      const applied = bootstrap("apply");
      t.assertions.assert(applied.status === 0, `bootstrap apply failed: ${applied.text}`);
      const spaces = (applied.data.spaces ?? []) as Array<{
        id: string;
        name: string;
        agentSpace?: { revision: number; parentWorkspaceId?: string; components: Array<{ componentId: string; role?: string }> };
      }>;
      t.assertions.assert(spaces.length === 4, `bootstrap did not return four Spaces: ${applied.text}`);

      const byName = new Map(spaces.map((space) => [space.name, space]));
      for (const name of ["executor", "coder", "reviewer", "workflow-manager"]) {
        const space = byName.get(name);
        t.assertions.assert(Boolean(space), `Bootstrap Pack omitted ${name}`);
        t.assertions.assert(
          existsSync(path.join(projectRoot, "spaces", name, ".pipebuilder", "lock.json")),
          `${name} was not materialized by AgentSpaceBuilder`,
        );
      }
      const executor = byName.get("executor")!;
      const coder = byName.get("coder")!;
      const reviewer = byName.get("reviewer")!;
      const manager = byName.get("workflow-manager")!;
      t.assertions.assert(
        executor.agentSpace?.parentWorkspaceId === projectId &&
          executor.agentSpace.components.some((component) => component.componentId === "executor"),
        `Executor is not the project's scheduling boundary: ${JSON.stringify(executor)}`,
      );
      for (const worker of [coder, reviewer, manager]) {
        t.assertions.assert(
          worker.agentSpace?.parentWorkspaceId === executor.id,
          `${worker.name} was not attached directly to Executor`,
        );
      }
      t.assertions.assert(
        coder.agentSpace?.components.some(
          (component) => component.componentId === "worker" && component.role === "coder",
        ),
        "Coder lost its worker role",
      );
      t.assertions.assert(
        reviewer.agentSpace?.components.some((component) => component.componentId === "reviewer"),
        "Reviewer did not receive its specialized component",
      );
      t.assertions.assert(
        manager.agentSpace?.components.some((component) => component.componentId === "executor"),
        "WorkflowManager is not its own nested scheduling boundary",
      );

      const beforeRevisions = spaces.map((space) => `${space.id}:${space.agentSpace?.revision}`).sort();
      const repeated = bootstrap("apply");
      t.assertions.assert(repeated.status === 0, `repeated bootstrap failed: ${repeated.text}`);
      const repeatedSpaces = (repeated.data.spaces ?? []) as typeof spaces;
      t.assertions.assert(
        repeatedSpaces.map((space) => `${space.id}:${space.agentSpace?.revision}`).sort().join(",") ===
          beforeRevisions.join(","),
        `repeated bootstrap changed identity or revisions: ${repeated.text}`,
      );

      const inspected = genet(["workflow", "inspect", "--workspace", projectId]);
      t.assertions.assert(inspected.status === 0, `installed workflow is not inspectable: ${inspected.text}`);
      const projectYaml = readFileSync(path.join(projectRoot, ".genethub/workflow/project.yaml"), "utf8");
      t.assertions.assert(
        projectYaml.includes("defaultWorkflow: game-project"),
        "the installed project workflow does not select the game delivery DCG",
      );

      t.note(`project=${projectId} executor=${executor.id} team=${spaces.map((space) => space.name).join(",")}`);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
