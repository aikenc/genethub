import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

/**
 * Writes a PipeBuilder v1 source contract. The test then asks the product
 * AgentSpaceBuilder to materialize and own the projection.
 */
function writeAgentSpaceSource(root: string, name: string): string {
  mkdirSync(root, { recursive: true });
  const manifest = path.join(root, "pipespace.json");
  const workspace = path.join(root, `${name}.code-workspace`);
  writeFileSync(
    manifest,
    JSON.stringify({
      schema: "pipespace.v1",
      name,
      agents: ["codex"],
      skills: [],
      tags: [],
      skillProviders: [],
    }),
  );
  writeFileSync(workspace, JSON.stringify({ folders: [{ path: "." }] }));
  return root;
}

interface CliResult {
  status: number;
  envelope: Record<string, unknown> | undefined;
  text: string;
}

defineSpecialty(
  {
    id: "specialty.agent-space.composition-boundary",
    title: "AgentSpace composition answers ownership and scheduling separately",
    oracle:
      "one open AgentSpace carries any combination of pm/executor/worker/reviewer through `genet space`; only a Space mounting an enabled executor can enumerate its direct Workers, and that enumeration never reaches past a child that is itself an Executor; every change requires the revision the caller read, and a refused change leaves the registration byte-identical",
    catches: [
      "a parent relationship is treated as permission to dispatch",
      "an Executor enumerates grandchildren and crosses a subteam's boundary",
      "a Space is forced into one exclusive role so PM cannot also drive the flow",
      "concurrent configuration silently overwrites another caller's change",
      "a refused configuration leaves a half-written registration",
      "a cycle in the ownership tree is accepted",
      "the replaced exclusive-role shape stops being readable for older clients",
    ],
    tags: ["core", "agent-space", "authorization", "genet-cli"],
    llm: { default: "mock" },
    expectedDurationMs: 20_000,
    timeoutMs: 90_000,
    resources: { environments: 1, cpu: 2, memoryMb: 640, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "genet-cli", "workbench-client"],
    productInterfaces: ["genet space", "@genehub/workbench/client", "agentSpace.configure"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const space = (args: string[], cwd = opened.workspaceRoot): CliResult => {
        const result = spawnSync(opened.daemon.genet, ["space", ...args], {
          cwd,
          env: opened.daemon.env,
          encoding: "utf8",
        });
        const text = `${result.stdout}\n${result.stderr}`;
        let envelope: Record<string, unknown> | undefined;
        for (const line of result.stdout.split("\n")) {
          if (!line.trim().startsWith("{")) continue;
          try {
            envelope = JSON.parse(line) as Record<string, unknown>;
          } catch {
            // A non-envelope line is diagnostic noise, not the answer.
          }
        }
        return { status: result.status ?? -1, envelope, text };
      };
      const data = (result: CliResult): Record<string, unknown> =>
        (result.envelope?.data ?? {}) as Record<string, unknown>;
      const registration = (result: CliResult): Record<string, unknown> =>
        (data(result).agentSpace ?? {}) as Record<string, unknown>;

      type SpaceKey = "project" | "coder" | "subteam" | "helper";
      const ids: Record<SpaceKey, string> = { project: "", coder: "", subteam: "", helper: "" };
      const projectRoot = writeAgentSpaceSource(
        path.join(opened.workspaceRoot, "spaces", "project"),
        "project",
      );
      const projectBuild = space([
        "builder",
        "build",
        "--workspace",
        opened.workspaceId,
        "--name",
        "project",
      ]);
      t.assertions.assert(
        projectBuild.status === 0,
        `AgentSpaceBuilder build failed for project: ${projectBuild.text}`,
      );
      const projectReply = await opened.client.call({
        type: "workspace.open",
        payload: { root: projectRoot },
      });
      t.assertions.assert(projectReply?.type === "workspace", "workspace.open failed for project");
      ids.project = projectReply?.type === "workspace" ? projectReply.data.id : "";

      // One Space, two responsibilities. The exclusive model this replaced
      // could not express it at all.
      const mountedPm = space([
        "component",
        "set",
        "--workspace",
        ids.project,
        "--component",
        "pm",
        "--revision",
        "0",
      ]);
      t.assertions.assert(mountedPm.status === 0, `mounting pm failed: ${mountedPm.text}`);
      t.assertions.assert(
        registration(mountedPm).revision === 1,
        `first registration did not land on revision 1: ${mountedPm.text}`,
      );
      const mountedExecutor = space([
        "component",
        "set",
        "--workspace",
        ids.project,
        "--component",
        "executor",
        "--revision",
        "1",
      ]);
      t.assertions.assert(
        mountedExecutor.status === 0,
        `a project Space could not also drive the flow: ${mountedExecutor.text}`,
      );

      const stale = space([
        "component",
        "set",
        "--workspace",
        ids.project,
        "--component",
        "worker",
        "--role",
        "coder",
        "--revision",
        "1",
      ]);
      t.assertions.assert(stale.status !== 0, "a stale revision was accepted");
      t.assertions.assert(
        stale.text.includes("revision 1") || stale.text.includes("not 1"),
        `the conflict did not name the revision the caller read: ${stale.text}`,
      );

      const afterStale = space(["inspect", "--workspace", ids.project]);
      t.assertions.assert(afterStale.status === 0, `inspect failed: ${afterStale.text}`);
      const projectComponents = (
        (registration(afterStale).components ?? []) as Array<{ componentId: string }>
      ).map((component) => component.componentId);
      t.assertions.assert(
        registration(afterStale).revision === 2 &&
          projectComponents.join(",") === "executor,pm",
        `the refused change was not a no-op: ${afterStale.text}`,
      );

      const childRoots: Record<Exclude<SpaceKey, "project">, string> = {
        coder: writeAgentSpaceSource(path.join(projectRoot, "spaces", "coder"), "coder"),
        subteam: writeAgentSpaceSource(path.join(projectRoot, "spaces", "subteam"), "subteam"),
        helper: writeAgentSpaceSource(path.join(projectRoot, "spaces", "helper"), "helper"),
      };
      for (const [key, root] of Object.entries(childRoots) as Array<
        [Exclude<SpaceKey, "project">, string]
      >) {
        const built = space([
          "builder",
          "build",
          "--workspace",
          ids.project,
          "--name",
          key,
        ]);
        t.assertions.assert(built.status === 0, `AgentSpaceBuilder build failed for ${key}: ${built.text}`);
        const reply = await opened.client.call({ type: "workspace.open", payload: { root } });
        t.assertions.assert(reply?.type === "workspace", `workspace.open failed for ${key}`);
        ids[key] = reply?.type === "workspace" ? reply.data.id : "";
      }

      const attach = (child: string, parent: string) =>
        space(["parent", "set", "--workspace", child, "--parent", parent]);
      const mountWorker = (child: string, role: string) =>
        space([
          "component",
          "set",
          "--workspace",
          child,
          "--component",
          "worker",
          "--role",
          role,
        ]);

      for (const [child, role] of [
        [ids.coder, "coder"],
        [ids.subteam, "tester"],
      ] as Array<[string, string]>) {
        const attached = attach(child, ids.project);
        t.assertions.assert(attached.status === 0, `attaching ${child} failed: ${attached.text}`);
        const mounted = mountWorker(child, role);
        t.assertions.assert(mounted.status === 0, `mounting worker failed: ${mounted.text}`);
      }
      const subteamExecutor = space([
        "component",
        "set",
        "--workspace",
        ids.subteam,
        "--component",
        "executor",
      ]);
      t.assertions.assert(
        subteamExecutor.status === 0,
        `a Worker could not become a subteam Executor: ${subteamExecutor.text}`,
      );
      const helperAttached = attach(ids.helper, ids.subteam);
      t.assertions.assert(
        helperAttached.status === 0,
        `attaching under a subteam failed: ${helperAttached.text}`,
      );
      const helperMounted = mountWorker(ids.helper, "coder");
      t.assertions.assert(helperMounted.status === 0, `mounting helper failed: ${helperMounted.text}`);

      const childrenOf = (workspaceId: string): { result: CliResult; ids: string[] } => {
        const result = space(["children", "--workspace", workspaceId]);
        const listed = (
          (data(result).children ?? []) as Array<{ workspaceId: string }>
        ).map((child) => child.workspaceId);
        return { result, ids: listed.sort() };
      };

      const projectChildren = childrenOf(ids.project);
      t.assertions.assert(
        projectChildren.result.status === 0,
        `an Executor could not list its Workers: ${projectChildren.result.text}`,
      );
      t.assertions.assert(
        projectChildren.ids.join(",") === [ids.coder, ids.subteam].sort().join(","),
        `the Executor did not see exactly its direct Workers: ${projectChildren.result.text}`,
      );
      t.assertions.assert(
        !projectChildren.ids.includes(ids.helper),
        "the project reached past a subteam into its Workers",
      );
      const subteamChildren = childrenOf(ids.subteam);
      t.assertions.assert(
        subteamChildren.ids.join(",") === ids.helper,
        `the subteam is not its own scheduling boundary: ${subteamChildren.result.text}`,
      );

      // Being somebody's parent is ownership. Only the executor component is
      // permission to command, so a plain Worker gets nothing to enumerate.
      const workerAttempt = space(["children", "--workspace", ids.coder]);
      t.assertions.assert(
        workerAttempt.status !== 0 && workerAttempt.text.includes("executor"),
        `a Worker was allowed to enumerate: ${workerAttempt.text}`,
      );

      const cycle = space(["parent", "set", "--workspace", ids.project, "--parent", ids.coder]);
      t.assertions.assert(
        cycle.status !== 0 &&
          (cycle.text.includes("cycle") || cycle.text.includes("childSpaceConflict")),
        `a cycle in the ownership tree was accepted: ${cycle.text}`,
      );
      const afterCycle = space(["inspect", "--workspace", ids.project]);
      t.assertions.assert(afterCycle.status === 0, `inspect after refused cycle failed: ${afterCycle.text}`);
      t.assertions.assert(
        registration(afterCycle).revision === 2 &&
          registration(afterCycle).parentWorkspaceId == null,
        `the cycle-forming reparent changed the project despite rejection: ${afterCycle.text}`,
      );

      const listed = await opened.client.call({ type: "workspace.list" });
      t.assertions.assert(listed?.type === "workspaces", "workspace.list failed");
      const projectInfo =
        listed?.type === "workspaces"
          ? listed.data.find((workspace) => workspace.id === ids.project)
          : undefined;
      t.assertions.assert(
        projectInfo?.agentSpace?.components?.length === 2,
        `the component set is not the wire truth: ${JSON.stringify(projectInfo?.agentSpace)}`,
      );
      t.assertions.assert(
        projectInfo?.pipeSpace?.pm === true &&
          projectInfo?.pipeSpace?.workerRole === "workflow-executor",
        `the older exclusive-role shape stopped being readable: ${JSON.stringify(projectInfo?.pipeSpace)}`,
      );

      t.note(
        `project=${ids.project}#${registration(afterStale).revision} coder=${ids.coder} subteam=${ids.subteam} helper=${ids.helper}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
