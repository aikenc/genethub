import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

import type { DeviceCredential, Reply } from "@genehub/proto";

import type { MockLlmHandle } from "../../../infrastructure/public.ts";
import { BlockedError } from "../../../infrastructure/public.ts";
import { assertions } from "../../assertions/index.ts";
import { connectProductClient } from "../../drivers/client.ts";
import { daemonEndpoint, startDaemon, type DaemonHandle } from "../../drivers/daemon.ts";
import { locateGenet, tryLocateDaemonComponent } from "../../drivers/cli.ts";
import type { EnvironmentLease } from "../../../infrastructure/public.ts";
import { startMockLlm } from "../../../infrastructure/public.ts";
import { waitUntil } from "../../tools/wait.ts";

function hostHome(): string {
  return userInfo().homedir;
}

/** Copies this account's Cursor CLI login into the isolated lease home. */
export function seedHostCursorLogin(lease: EnvironmentLease): void {
  const home = hostHome();
  const auth = path.join(home, ".config", "cursor", "auth.json");
  if (!existsSync(auth)) {
    throw new BlockedError("this machine has no Cursor login at ~/.config/cursor/auth.json");
  }
  const destDir = path.join(lease.home, ".config", "cursor");
  mkdirSync(destDir, { recursive: true });
  copyFileSync(auth, path.join(destDir, "auth.json"));
  mkdirSync(path.join(lease.home, ".cursor"), { recursive: true });
  for (const name of ["cli-config.json", "agent-cli-state.json"]) {
    const src = path.join(home, ".cursor", name);
    if (existsSync(src)) copyFileSync(src, path.join(lease.home, ".cursor", name));
  }
}

/** Copies GeneHub-beta provider config into the lease data dir before first start. */
export function seedHostBetaProviders(lease: EnvironmentLease): void {
  const betaConfig = path.join(hostHome(), ".local", "share", "GeneHub-beta", "config.json");
  if (!existsSync(betaConfig)) {
    throw new BlockedError("GeneHub-beta config.json is not on this machine");
  }
  const raw = JSON.parse(readFileSync(betaConfig, "utf8")) as {
    agents?: { providers?: Record<string, unknown> };
  };
  const providers = raw.agents?.providers;
  if (!providers || Object.keys(providers).length === 0) {
    throw new BlockedError("GeneHub-beta config has no agents.providers");
  }
  const dest = path.join(lease.data, "config.json");
  const current = existsSync(dest)
    ? (JSON.parse(readFileSync(dest, "utf8")) as Record<string, unknown>)
    : {};
  const agents =
    current.agents && typeof current.agents === "object"
      ? (current.agents as Record<string, unknown>)
      : {};
  current.agents = { ...agents, providers };
  writeFileSync(dest, `${JSON.stringify(current, null, 2)}\n`);
}

/** Copies this account's Codex CLI login into the isolated lease home. */
export function seedHostCodexLogin(lease: EnvironmentLease): void {
  const home = hostHome();
  const auth = path.join(home, ".codex", "auth.json");
  if (!existsSync(auth)) {
    throw new BlockedError("this machine has no Codex login at ~/.codex/auth.json");
  }
  const dest = path.join(lease.home, ".codex");
  mkdirSync(dest, { recursive: true });
  copyFileSync(auth, path.join(dest, "auth.json"));
  const config = path.join(home, ".codex", "config.toml");
  if (existsSync(config)) copyFileSync(config, path.join(dest, "config.toml"));
}

const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEEPSEEK_OPENAI_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_BARE_MODEL = "deepseek-v4-flash";

export type HostBuiltinLlm = {
  apiKey: string;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  bareId: string;
};

/** Reads the machine's GeneHub-beta DeepSeek key at runtime. Never logs the value. */
export function hostBuiltinLlm(): HostBuiltinLlm {
  const betaConfig = path.join(hostHome(), ".local", "share", "GeneHub-beta", "config.json");
  if (!existsSync(betaConfig)) {
    throw new BlockedError("GeneHub-beta config.json is not on this machine");
  }
  const raw = JSON.parse(readFileSync(betaConfig, "utf8")) as {
    agents?: { providers?: Record<string, { apiKey?: string; baseUrl?: string | null }> };
  };
  const deepseek = raw.agents?.providers?.deepseek;
  const apiKey = deepseek?.apiKey?.trim();
  if (!deepseek || !apiKey) {
    throw new BlockedError("GeneHub-beta has no deepseek apiKey");
  }
  return {
    apiKey,
    openaiBaseUrl: deepseek.baseUrl?.trim() || DEEPSEEK_OPENAI_BASE_URL,
    anthropicBaseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
    bareId: DEFAULT_BARE_MODEL,
  };
}

export function requireHostCli(name: string): string {
  const which = spawnSync("which", [name], { encoding: "utf8" });
  if (which.status !== 0) {
    throw new BlockedError(`${name} is not on PATH`);
  }
  return which.stdout.trim();
}

export function prependHostCliPath(lease: EnvironmentLease, binary: string): void {
  const resolved = requireHostCli(binary);
  const binDir = path.dirname(resolved);
  const current = lease.env.PATH ?? process.env.PATH ?? "";
  if (!current.split(path.delimiter).includes(binDir)) {
    lease.env.PATH = `${binDir}${path.delimiter}${current}`;
  }
}

/**
 * Points the already-installed `claude` CLI at the configured host backend:
 * Claude Code's own documented environment variables, set on the daemon process
 * so the child it spawns inherits them.
 */
export function pointClaudeAtBuiltinLlm(lease: EnvironmentLease): void {
  prependHostCliPath(lease, "claude");
  lease.env.IS_SANDBOX = "1";
  const settings = path.join(hostHome(), ".claude", "settings.json");
  if (existsSync(settings)) {
    const env = (JSON.parse(readFileSync(settings, "utf8")) as { env?: Record<string, unknown> }).env;
    if (typeof env?.ANTHROPIC_BASE_URL === "string" && env.ANTHROPIC_BASE_URL.trim()) {
      for (const [key, value] of Object.entries(env)) {
        if ((key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_")) && typeof value === "string") lease.env[key] = value;
      }
      return;
    }
  }
  const llm = hostBuiltinLlm();
  lease.env.ANTHROPIC_BASE_URL = llm.anthropicBaseUrl;
  lease.env.ANTHROPIC_AUTH_TOKEN = llm.apiKey;
  lease.env.ANTHROPIC_API_KEY = llm.apiKey;
  // Claude Code refuses --dangerously-skip-permissions as uid 0 unless it
  // believes it is already in a sandbox. This is the CLI's own documented
  // container/CI switch, inherited by the child the daemon spawns.
  lease.env.IS_SANDBOX = "1";
  for (const key of [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
  ]) {
    lease.env[key] = llm.bareId;
  }
}

/** Configures the real OpenCode CLI against the same controlled LLM endpoint as the built-in agent. */
export function writeOpencodeBuiltinConfig(lease: EnvironmentLease, mock: MockLlmHandle): string {
  prependHostCliPath(lease, "opencode");
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      journey: {
        npm: "@ai-sdk/openai-compatible",
        name: "Journey",
        options: {
          baseURL: mock.origin + "/v1",
          apiKey: "sk-test",
        },
        models: { [DEFAULT_BARE_MODEL]: { name: "Journey" } },
      },
    },
  };
  writeFileSync(path.join(lease.workspace, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`);
  return `journey/${DEFAULT_BARE_MODEL}`;
}

export function sessionEventOf(entry: { raw: unknown }): { type?: string; [key: string]: unknown } | undefined {
  const raw = entry.raw as { event?: { type?: string } };
  return raw.event as { type?: string; [key: string]: unknown } | undefined;
}

export type ShellAsk = {
  workspaceId: string;
  argv: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  timeoutMs?: number | null;
};

export type ShellFrame = {
  type?: string;
  data?: string;
  code?: number;
  signal?: number;
  timedOut?: boolean;
  timed_out?: boolean;
};

export type ShellResult = {
  status: number;
  metadata: unknown;
  frames: ShellFrame[];
};

async function collectLengthPrefixedJson(body: AsyncIterable<Uint8Array>): Promise<ShellFrame[]> {
  const frames: ShellFrame[] = [];
  let buffered = new Uint8Array(0);
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    const next = new Uint8Array(buffered.byteLength + chunk.byteLength);
    next.set(buffered);
    next.set(chunk, buffered.byteLength);
    buffered = next;
    while (buffered.byteLength >= 4) {
      const length = new DataView(buffered.buffer, buffered.byteOffset, 4).getUint32(0);
      if (buffered.byteLength < 4 + length) break;
      frames.push(JSON.parse(decoder.decode(buffered.slice(4, 4 + length))) as ShellFrame);
      buffered = buffered.slice(4 + length);
      if (frames.at(-1)?.type === "exit") return frames;
    }
  }
  return frames;
}

/** Opens `shell.run` and returns the live stream plus the collected result. */
export function startShell(
  client: ProductSession["client"],
  request: ShellAsk,
  stdin: Uint8Array = new Uint8Array(),
): { stream: ReturnType<ProductSession["client"]["openShellStream"]>; result: Promise<ShellResult> } {
  const stream = client.openShellStream(request);
  const result = (async () => {
    if (stdin.byteLength > 0) await stream.write(stdin);
    await stream.finish();
    const head = await stream.responseHead;
    const frames = head.status === 200 ? await collectLengthPrefixedJson(stream.body()) : [];
    return { status: head.status, metadata: head.metadata, frames };
  })();
  void result.catch(() => undefined);
  return { stream, result };
}

/** Runs argv through the production `shell.run` stream and collects frames. */
export async function runShell(
  client: ProductSession["client"],
  request: ShellAsk,
  stdin: Uint8Array = new Uint8Array(),
): Promise<ShellResult> {
  return startShell(client, request, stdin).result;
}

export function shellText(frames: ShellFrame[], stream: "stdout" | "stderr"): string {
  return frames
    .filter((frame) => frame.type === stream)
    .map((frame) => frame.data ?? "")
    .join("");
}

export function shellExit(frames: ShellFrame[]): { code?: number; signal?: number } | undefined {
  const found = frames.find((frame) => frame.type === "exit");
  if (!found) return undefined;
  return { code: found.code, signal: found.signal };
}

export function shellTimedOut(frames: ShellFrame[]): boolean {
  return frames.some((frame) => frame.type === "exit" && (frame.timedOut === true || frame.timed_out === true));
}

export interface ProductSession {
  client: Awaited<ReturnType<typeof connectProductClient>>;
  daemon: DaemonHandle;
  mock: MockLlmHandle;
  workspaceId: string;
  workspaceRoot: string;
  rootHandle: string;
  events: Array<{ type?: string }>;
  sessionId: string;
}

export interface OpenedWorkspace {
  client: ProductSession["client"];
  daemon: DaemonHandle;
  mock: MockLlmHandle;
  workspaceId: string;
  workspaceRoot: string;
  rootHandle: string;
}

export async function startLocalEnvironment(input: {
  openRoot: string;
  lease: EnvironmentLease;
  onDiagnostic?: Parameters<typeof connectProductClient>[0]["onDiagnostic"];
}): Promise<{ daemon: DaemonHandle; mock: MockLlmHandle; client: ProductSession["client"] }> {
  const mock = await startMockLlm();
  const daemon = startDaemon({
    genet: locateGenet(input.openRoot),
    wasm: tryLocateDaemonComponent(input.openRoot),
    lease: input.lease,
  });
  const endpoint = daemonEndpoint(daemon);
  const client = await connectProductClient({
    ...endpoint,
    onDiagnostic: input.onDiagnostic,
    redial: async () => daemonEndpoint(daemon),
  });
  return { daemon, mock, client };
}

export async function openWorkspace(input: {
  openRoot: string;
  lease: EnvironmentLease;
  onDiagnostic?: Parameters<typeof connectProductClient>[0]["onDiagnostic"];
}): Promise<OpenedWorkspace> {
  const started = await startLocalEnvironment(input);
  try {
    const opened = await started.client.call({
      type: "workspace.open",
      payload: { root: input.lease.workspace },
    });
    if (opened?.type !== "workspace") throw new Error("workspace.open failed");
    const rootHandle = opened.data.folders[0]?.rootHandle;
    if (!rootHandle) throw new Error("workspace has no rootHandle");
    return {
      ...started,
      workspaceId: opened.data.id,
      workspaceRoot: input.lease.workspace,
      rootHandle,
    };
  } catch (error) {
    started.client.close();
    started.daemon.stop();
    await started.mock.stop();
    throw error;
  }
}

/// Relative location of the Workflow package this product build ships.
export const BUILTIN_PACKAGE_ID = "game-delivery";
const BUILTIN_PACKAGE_SOURCE = "apps/daemon/workflow-packages/game-delivery";

/**
 * Clones the shipped Workflow package into a project exactly the way a user
 * would, so tests exercise the same discover/build path a community clone
 * takes. Copying rather than `git clone` keeps the test hermetic; the daemon
 * never reads the package's `.git` for anything but provenance display.
 */
export function clonePackage(input: {
  openRoot: string;
  projectRoot: string;
  packageId?: string;
  sourceRoot?: string;
}): string {
  const target = path.join(
    input.projectRoot,
    ".genethub/workflows",
    input.packageId ?? BUILTIN_PACKAGE_ID,
  );
  const source = input.sourceRoot ?? path.join(input.openRoot, BUILTIN_PACKAGE_SOURCE);
  if (!existsSync(source)) throw new Error(`no Workflow package at ${source}`);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  return target;
}

/**
 * Writes a minimal Workflow package a test can then add flows and roles to.
 *
 * It replaces the old `workflow init` scaffold: a project is Workflow-enabled
 * because a package directory exists, so a fixture creates one the same way a
 * user's `git clone` would rather than calling a command that no longer exists.
 * Returns the package directory.
 */
export function seedWorkflowPackage(input: {
  projectRoot: string;
  packageId?: string;
  description?: string;
  /** Space sources this package declares, materialized by `workflow build`. */
  spaces?: Array<{ name: string; components: Array<{ componentId: string; role?: string }>; lifecycle?: string }>;
}): string {
  const root = path.join(input.projectRoot, ".genethub/workflows", input.packageId ?? "local");
  for (const sub of ["flows", "roles", "prompts"]) {
    mkdirSync(path.join(root, sub), { recursive: true });
  }
  writeFileSync(
    path.join(root, "workflow.md"),
    `---\ndescription: ${input.description ?? "test package"}\n---\n\n测试用包。\n`,
  );
  for (const space of input.spaces ?? []) {
    const dir = path.join(root, "spaces", space.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "space.json.src"),
      `${JSON.stringify({ lifecycle: space.lifecycle ?? "pooled", components: space.components }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(dir, "pipespace.json.src"),
      `${JSON.stringify({ schema: "pipespace.v1", name: space.name, agents: ["codex"], skills: [], skillProviders: [], tags: [] }, null, 2)}\n`,
    );
  }
  return root;
}

/**
 * Seeds a package with one runnable flow and its worker role, the shape most
 * Workflow specs previously got from `workflow init`.
 */
export function seedDirectChangePackage(input: {
  projectRoot: string;
  packageId?: string;
  agentId?: string;
  modelId?: string;
  spaces?: Parameters<typeof seedWorkflowPackage>[0]["spaces"];
}): string {
  const root = seedWorkflowPackage({
    projectRoot: input.projectRoot,
    packageId: input.packageId,
    description: "direct change fixture",
    spaces: input.spaces,
  });
  writeFileSync(
    path.join(root, "flows/direct-change.yaml"),
    `${JSON.stringify({
      schema: "genehub.workflow.definition.v1",
      id: "direct-change",
      version: 1,
      entry: "implement",
      nodes: [
        {
          id: "implement",
          uses: "agent.session",
          with: {
            role: "worker",
            workspace: ".",
            writeLease: { targetRef: "current", ttlSeconds: 3600 },
          },
          completion: {
            all: [
              { key: "commit", verify: "git.commitOnTarget" },
              { key: "checks", verify: "value.nonEmpty" },
            ],
          },
          on: { completed: ["publish"] },
        },
        { id: "publish", uses: "result.publish" },
      ],
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, "roles/worker.yaml"),
    `${JSON.stringify({
      schema: "genehub.workflow.role.v1",
      id: "worker",
      agentId: input.agentId ?? "genet",
      ...(input.modelId === null ? {} : { modelId: input.modelId ?? "deepseek/deepseek-v4-flash" }),
      userInteraction: "readOnly",
      prompt: "prompts/direct-worker.md",
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, "prompts/direct-worker.md"),
    "你是当前项目直达流程中的实现 Worker。只处理根会话交付的精确目标，不扩大范围，不替用户改变流程。\n先核对仓库与目标 ref，再完成实现和项目要求的检查。只有真实提交已经位于租约目标 ref、检查已经实际执行后，才可按系统合同上报证据；不得编造 commit、测试或检查结果。\n",
  );
  return root;
}

export async function configureMockProvider(
  client: ProductSession["client"],
  mock: MockLlmHandle,
): Promise<void> {
  await client.call({
    type: "settings.setProvider",
    payload: {
      providerId: "deepseek",
      apiKey: "sk-test",
      baseUrl: mock.origin,
      label: null,
      dialect: null,
      models: null,
    },
  });
}

export async function createBuiltinSession(
  client: ProductSession["client"],
  workspaceId: string,
  cwd: string | null = null,
): Promise<string> {
  const session = await client.call({
    type: "session.create",
    payload: {
      workspaceId,
      agentId: "genet",
      modelId: "deepseek/deepseek-v4-flash",
      modeId: null,
      title: null,
      cwd,
    },
  });
  if (session?.type !== "session") throw new Error("session.create failed");
  return session.data.id;
}

export async function requireAgentReady(
  client: ProductSession["client"],
  agentId: string,
): Promise<Extract<Reply, { type: "agents" }>["data"][number]> {
  const agents = await client.call({ type: "agent.refresh" });
  if (agents?.type !== "agents") throw new Error(`agent.refresh returned ${agents?.type}`);
  const agent = agents.data.find((item) => item.id === agentId);
  if (!agent || agent.probe.state !== "ready") {
    throw new BlockedError(`${agentId} agent is not ready: ${JSON.stringify(agent?.probe)}`);
  }
  return agent;
}

export async function createAgentSession(
  client: ProductSession["client"],
  input: { workspaceId: string; agentId: string; modelId: string | null },
): Promise<string> {
  const created = await client.call({
    type: "session.create",
    payload: {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      modelId: input.modelId,
      modeId: null,
      title: null,
      cwd: null,
    },
  });
  if (created?.type !== "session") throw new Error(`session.create returned ${created?.type}`);
  return created.data.id;
}

export async function attachEventLog(
  client: ProductSession["client"],
  sessionId: string,
): Promise<Array<{ type?: string; raw: unknown }>> {
  const events: Array<{ type?: string; raw: unknown }> = [];
  await client.subscribe(sessionId, {
    onEvent: (event) => {
      const inner = (event as { event?: { type?: string } }).event;
      events.push({ type: inner?.type ?? (event as { type?: string }).type, raw: event });
    },
    onResync: () => {},
  });
  return events;
}

export async function sendPrompt(
  client: ProductSession["client"],
  sessionId: string,
  text: string,
  continuesRound: string | null = null,
): Promise<void> {
  await client.call({
    type: "session.send",
    payload: {
      sessionId,
      text,
      attachments: [],
      artifactPreviewBaseUrl: null,
      continuesRound,
    },
  });
}

export async function completeVerifiableTask(input: {
  openRoot: string;
  lease: EnvironmentLease;
  task: { prompt: string; relative: string; contents: string };
}): Promise<ProductSession> {
  const opened = await openWorkspace(input);
  const { client, mock } = opened;
  await configureMockProvider(client, mock);
  mock.script(
    {
      tool: {
        name: "write",
        arguments: { path: input.task.relative, content: input.task.contents },
      },
    },
    { text: "Created." },
  );
  const sessionId = await createBuiltinSession(client, opened.workspaceId);
  const events: Array<{ type?: string }> = [];
  await client.subscribe(sessionId, {
    onEvent: (event) => {
      events.push({ type: (event as { type?: string }).type });
    },
    onResync: () => {},
  });
  await sendPrompt(client, sessionId, input.task.prompt);
  await waitUntil(() => {
    try {
      assertions.fileEquals(input.lease.workspace, input.task.relative, input.task.contents);
      return true;
    } catch {
      return false;
    }
  }, 45_000);
  assertions.fileEquals(input.lease.workspace, input.task.relative, input.task.contents);
  return { ...opened, events, sessionId };
}

export async function openSecondClient(
  opened: OpenedWorkspace,
  name = "testctl-2",
  options: Pick<Parameters<typeof connectProductClient>[0], "socketFactory" | "onDiagnostic"> = {},
): Promise<ProductSession["client"]> {
  const endpoint = daemonEndpoint(opened.daemon);
  return connectProductClient({
    ...endpoint,
    name,
    ...options,
    redial: async () => daemonEndpoint(opened.daemon),
  });
}

export async function pairDevice(
  owner: ProductSession["client"],
  daemon: DaemonHandle,
  grants: string[] = [],
  name = "ported-laptop",
): Promise<{ client: ProductSession["client"]; deviceId: string; credential: DeviceCredential }> {
  const invite = await owner.call({
    type: "device.invite",
    payload: grants.length > 0 ? { grants } : null,
  });
  if (invite?.type !== "invite") throw new Error("device.invite failed");
  const code = invite.data.code;
  const split = code.indexOf(".");
  if (split < 0) throw new Error("invite code is not inviteId.secret");
  const inviteId = code.slice(0, split);
  const secret = code.slice(split + 1);
  const endpoint = daemonEndpoint(daemon);
  const pairing = await connectProductClient({
    url: endpoint.url,
    inviteCredential: { inviteId, secret },
    name: "genehub-pairing",
  });
  try {
    const claimed = await pairing.call({
      type: "device.claim",
      payload: { code: inviteId, deviceName: name },
    });
    if (claimed?.type !== "claimed") throw new Error("device.claim failed");
    const client = await connectProductClient({
      url: endpoint.url,
      credential: { deviceId: claimed.data.deviceId, secret: claimed.data.secret },
      name,
      redial: async () => ({
        url: daemonEndpoint(daemon).url,
        credential: { deviceId: claimed.data.deviceId, secret: claimed.data.secret },
      }),
    });
    return { client, deviceId: claimed.data.deviceId, credential: claimed.data };
  } finally {
    pairing.close();
  }
}

export async function connectDevice(
  daemon: DaemonHandle,
  credential: Pick<DeviceCredential, "deviceId" | "secret">,
  name = "returning-device",
): Promise<ProductSession["client"]> {
  return connectProductClient({
    url: daemonEndpoint(daemon).url,
    credential,
    name,
    redial: async () => ({ url: daemonEndpoint(daemon).url, credential }),
  });
}

export async function claimDeviceInvite(
  daemon: DaemonHandle,
  code: string,
  deviceName = "claimed-device",
): Promise<DeviceCredential> {
  const split = code.indexOf(".");
  if (split < 0) throw new Error("invite code is not inviteId.secret");
  const inviteId = code.slice(0, split);
  const secret = code.slice(split + 1);
  const endpoint = daemonEndpoint(daemon);
  const pairing = await connectProductClient({
    url: endpoint.url,
    inviteCredential: { inviteId, secret },
    name: "genehub-pairing",
  });
  try {
    const claimed = await pairing.call({
      type: "device.claim",
      payload: { code: inviteId, deviceName },
    });
    if (claimed?.type !== "claimed") throw new Error("device.claim failed");
    return claimed.data;
  } finally {
    pairing.close();
  }
}

export function daemonWsUrl(daemon: DaemonHandle): string {
  return daemonEndpoint(daemon).url;
}

export async function connectWithoutAdmission(daemon: DaemonHandle): Promise<"closed" | "ready"> {
  try {
    const client = await connectProductClient({
      url: daemonEndpoint(daemon).url,
      name: "no-token",
    });
    client.close();
    return "ready";
  } catch {
    return "closed";
  }
}

export async function handshakeAndList(input: {
  openRoot: string;
  lease: EnvironmentLease;
}): Promise<Reply | undefined> {
  const started = await startLocalEnvironment(input);
  try {
    return await started.client.call({ type: "workspace.list" });
  } finally {
    started.client.close();
    started.daemon.stop();
    await started.mock.stop();
  }
}
