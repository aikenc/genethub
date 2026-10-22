import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionSnapshot, WorkspaceInfo } from "@genehub/proto";
import type { CaseContext } from "../../context.ts";
import { registerControlledAgent, type ControlledAgentOptions } from "../../builders/script-agent.ts";

/** Shipped template + Builder + CLI, against real isolated daemon Sessions. */
export async function openTeam(t: CaseContext, name = "review-team", extraAgents: ControlledAgentOptions[] = []) {
  for (const profile of ["normal", "native-question", "accept-then-silent", "exit-without-terminal"] as const) {
    registerControlledAgent(t.env, { profile, id: `ctl-${profile}`, chunks: 2 });
  }
  for (const agent of extraAgents) registerControlledAgent(t.env, agent);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const template = path.join(t.env.data, "builtin-skills/genehub/references/team-template");
  const builder = path.join(t.env.data, "builtin-skills/genehub/references/spacebuilder/spacebuilder.py");
  const root = path.join(t.env.data, "spaces", name);
  cpSync(template, root, { recursive: true });
  const descriptor = path.join(root, "agent-space.genet.json");
  writeFileSync(descriptor, JSON.stringify({ ...JSON.parse(readFileSync(descriptor, "utf8")), name }));
  // Drive timer actions explicitly; this is an ordinary user-owned hook setting.
  const hook = path.join(root, "skills/team-front/hooks/timer.genet.json");
  writeFileSync(hook, JSON.stringify({ ...JSON.parse(readFileSync(hook, "utf8")), enabled: false }));
  mkdirSync(path.join(root, ".genethub"), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...opened.daemon.env, GENEHUB_CLI: opened.daemon.genet, TEAM_AGENT: "ctl-normal" };
  delete env.GENEHUB_CONTROLLER_TOKEN; delete env.GENEHUB_EXECUTION_LEASE; delete env.GENEHUB_SESSION_ID;
  const configPath = path.join(root, ".genethub/open.env");
  writeFileSync(configPath, "TEAM_AGENT=ctl-normal\n");
  const command = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const original = readFileSync(configPath, "utf8");
    const overrides = Object.entries(extra).filter(([key]) => key.startsWith("TEAM_"));
    if (overrides.length) writeFileSync(configPath, original + "\n" + overrides.map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
    const result = spawnSync("python3", [path.join(root, "tools/team.py"), ...args], {
      cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (overrides.length) writeFileSync(configPath, original);
    return { code: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? String(result.error ?? "") };
  };
  const built = spawnSync("python3", [builder, "build", root, "--format", "json"], { env, encoding: "utf8" });
  t.assertions.assert(built.status === 0, `team build: ${built.stdout} ${built.stderr}`);
  await opened.client.call({ type: "workspace.open", payload: { root } });
  let spaces: WorkspaceInfo[] = [];
  await t.tools.waitUntil(async () => {
    const reply = await opened.client.call({ type: "workspace.list" });
    if (reply?.type !== "workspaces") throw new Error("workspace.list did not return workspaces");
    spaces = reply.data;
    const parent = spaces.find(row => row.root === root);
    return Boolean(parent && spaces.some(row => row.name === "leader" && row.agentSpace?.parentWorkspaceId === parent.id));
  }, 30_000);
  const project = spaces.find(row => row.root === root)!;
  const create = async (agentId = "ctl-normal", workspaceId = project.id) => {
    const reply = await opened.client.call({ type: "session.create", payload: {
      workspaceId, agentId, modelId: null, modeId: null, title: "Review conversation", cwd: null,
    } });
    if (reply?.type !== "session") throw new Error("session.create did not return session");
    return reply.data.id;
  };
  const front = await create();
  const snapshot = async (id: string): Promise<SessionSnapshot> => {
    const reply = await opened.client.call({ type: "session.get", payload: { sessionId: id } });
    if (reply?.type !== "snapshot") throw new Error("session.get did not return snapshot");
    return reply.data;
  };
  const send = async (id: string, text: string) => {
    const messageId = `human.${randomUUID()}`;
    await opened.client.call({ type: "session.send", payload: { sessionId: id, text, messageId, attachments: [], artifactPreviewBaseUrl: null, continuesRound: null } });
    await t.tools.waitUntil(async () => {
      const summary = (await snapshot(id)).summary;
      return summary.status !== "idle" || !summary.inputSummary?.pendingMessageIds.includes(messageId);
    }, 15000);
  };
  const state = (...parts: string[]) => path.join(root, ".genethub/team", ...parts);
  const ok = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const done = command(args, extra);
    t.assertions.assert(done.code === 0, `team ${args[0]}: ${done.out.slice(-600)} ${done.err.slice(-600)}`);
    return done.out;
  };
  return { ...opened, root, template, builder, env, command, ok, spaces, project, front, create, snapshot, send, state,
    async dispose() { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); } };
}
