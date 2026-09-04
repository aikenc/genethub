import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

function digest(file: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

/** A PipeBuilder-owned projection the daemon will accept as an AgentSpace. */
function writeAgentSpaceRoot(root: string, name: string): string {
  mkdirSync(path.join(root, ".pipebuilder"), { recursive: true });
  const manifest = path.join(root, "pipespace.json");
  const workspace = path.join(root, `${name}.code-workspace`);
  writeFileSync(manifest, JSON.stringify({ schema: "pipespace.v1", name }));
  writeFileSync(workspace, JSON.stringify({ folders: [{ path: "." }] }));
  writeFileSync(
    path.join(root, ".pipebuilder/lock.json"),
    JSON.stringify({
      schema: "pipebuilder-lock.v1",
      pipespace: {
        name,
        manifestDigest: digest(manifest),
        workspace: path.basename(workspace),
        workspaceDigest: digest(workspace),
      },
      artifacts: [],
    }),
  );
  return root;
}

interface Instance {
  componentId: string;
  role?: string;
  spaceDir: string;
  sessionDir: string;
}

defineSpecialty(
  {
    id: "specialty.agent-space.component-instances",
    title: "A Session is the running instance of its AgentSpace, composition included",
    oracle:
      "every responsibility enabled on an AgentSpace is live in each of its Sessions with two durable directories, the Space scope shared across Sessions and the Session scope inside that Session; the list follows the Space as it is recomposed while the Session stays open, and disabling a responsibility removes the instance without destroying what it wrote at Space scope",
    catches: [
      "a Session has to be told which components it carries, so its list drifts from its Space's",
      "a component mounted after the Session opened stays invisible until a new Session",
      "the two scopes collapse into one directory, so closing a conversation loses project state",
      "session-scope storage is written outside the session directory and survives it",
      "a disabled component still resolves as a live instance",
      "a component identifier reaches the filesystem as a caller-chosen path",
    ],
    tags: ["core", "agent-space", "genet-cli"],
    llm: { default: "mock" },
    expectedDurationMs: 20_000,
    timeoutMs: 90_000,
    resources: { environments: 1, cpu: 2, memoryMb: 640, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "genet-cli", "workbench-client"],
    productInterfaces: ["genet session components", "session.components", "genet space"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const genet = (args: string[]): { status: number; text: string; data: Record<string, unknown> } => {
        const result = spawnSync(opened.daemon.genet, args, {
          cwd: opened.workspaceRoot,
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
            // Diagnostic noise, not the answer.
          }
        }
        return { status: result.status ?? -1, text: `${result.stdout}\n${result.stderr}`, data };
      };

      const root = writeAgentSpaceRoot(path.join(opened.workspaceRoot, "team"), "team");
      const openedSpace = await opened.client.call({
        type: "workspace.open",
        payload: { root },
      });
      t.assertions.assert(openedSpace?.type === "workspace", "workspace.open did not return a workspace");
      const spaceId = openedSpace?.type === "workspace" ? openedSpace.data.id : "";

      const mount = (component: string, revision: number, extra: string[] = []) =>
        genet([
          "space",
          "component",
          "set",
          "--workspace",
          spaceId,
          "--component",
          component,
          "--revision",
          String(revision),
          ...extra,
        ]);
      const mountedWorker = mount("worker", 0, ["--role", "coder"]);
      t.assertions.assert(mountedWorker.status === 0, `mounting worker failed: ${mountedWorker.text}`);

      // The Session is created after the Space already carries `worker`, and
      // is never told about it.
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, spaceId);
      const read = (): Instance[] => {
        const result = genet(["session", "components", sessionId]);
        t.assertions.assert(result.status === 0, `session components failed: ${result.text}`);
        return (result.data.components ?? []) as Instance[];
      };

      const initial = read();
      t.assertions.assert(
        initial.length === 1 && initial[0]?.componentId === "worker",
        `the Session did not instantiate its Space's composition: ${JSON.stringify(initial)}`,
      );
      const worker = initial[0]!;
      t.assertions.assert(worker.role === "coder", `the instance lost its role: ${JSON.stringify(worker)}`);
      t.assertions.assert(
        existsSync(worker.spaceDir) && existsSync(worker.sessionDir),
        `an instance reported storage that does not exist: ${JSON.stringify(worker)}`,
      );
      t.assertions.assert(
        worker.spaceDir !== worker.sessionDir,
        "the two scopes are the same directory, so Space state dies with the conversation",
      );
      t.assertions.assert(
        worker.sessionDir.includes(sessionId),
        `session scope is not inside this Session: ${worker.sessionDir}`,
      );
      t.assertions.assert(
        !worker.spaceDir.includes(sessionId),
        `Space scope was placed inside one Session: ${worker.spaceDir}`,
      );

      // Recompose the Space while the Session stays open. An ordinary coding
      // agent picks up an improved skill without a new conversation, and a
      // mounted responsibility is no different.
      const mountedReviewer = mount("reviewer", 1);
      t.assertions.assert(mountedReviewer.status === 0, `mounting reviewer failed: ${mountedReviewer.text}`);
      const recomposed = read();
      t.assertions.assert(
        recomposed.map((instance) => instance.componentId).join(",") === "reviewer,worker",
        `a component mounted after the Session opened stayed invisible: ${JSON.stringify(recomposed)}`,
      );
      const reviewer = recomposed[0]!;

      // What the Space keeps must not be reclaimed when a responsibility is
      // taken off; only the live instance goes away. `component set` replaces
      // the whole contract, so this restates nothing it does not mean.
      const ledger = path.join(reviewer.spaceDir, "verdicts");
      writeFileSync(ledger, "kept");
      const disabled = mount("reviewer", 2, ["--disabled"]);
      t.assertions.assert(disabled.status === 0, `disabling reviewer failed: ${disabled.text}`);
      const afterDisable = read().map((instance) => instance.componentId);
      t.assertions.assert(
        afterDisable.join(",") === "worker",
        `a disabled component is still a live instance: ${afterDisable.join(",")}`,
      );
      t.assertions.assert(
        readFileSync(ledger, "utf8") === "kept",
        "disabling a responsibility destroyed what it had written at Space scope",
      );

      t.note(
        `${spaceId} session ${sessionId}: worker→reviewer,worker→reviewer with space scope at ${path.basename(worker.spaceDir)}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
