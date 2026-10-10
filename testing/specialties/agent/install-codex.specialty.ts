// Installing the built-in Codex Agent the way a user does, end to end, with
// the real CLI: the built-in codex script finds (or does not find) Node.js,
// asks before it runs `npm install` from the real registry into its own
// prefix, stops at a durable account-login obligation, and accepts an API key through a
// secret question. The only replacement is the LLM endpoint: Codex's own user
// configuration in the lease home points its model provider at the mock LLM,
// which proves which bearer reached it by digest only. The npm registry is real; when they cannot be reached the
// case is blocked, not failed.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { AgentUserRequest } from "@genehub/proto";

import {
  BlockedError,
  CODEX_NPM_PACKAGE,
  codexNpmPrefix,
  defineSpecialty,
  HOST_AGENT_CLIS,
  hostNode,
  installNodeLikeNvm,
  leaseProcesses,
  pathWithout,
  pointCodexAtMockLlm,
  requireNpmPackage,
  seedScriptAgentRuntime,
  withoutNodeOrAgentClis,
  type CaseContext,
} from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type AgentInfo = Awaited<ReturnType<CaseContext["flows"]["branches"]["listAgents"]>>[number];
type Pushes = ReturnType<CaseContext["flows"]["branches"]["recordAgentPushes"]>;
type EventLog = Awaited<ReturnType<CaseContext["flows"]["main"]["attachEventLog"]>>;

const CODEX = "codex";
/** The SDK's guidance when no npm can be found (`install.NO_NODE`). */
const NO_NODE_HINT = "需要 Node.js 和 npm";
const INSTALL_TITLE = "安装 Codex CLI";
const LOGIN_TITLE = "登录 Codex";
const API_KEY_TITLE = "用 API Key 登录 Codex";
/** A real `npm install @openai/codex` downloads a platform binary. */
const NPM_TIMEOUT_MS = 10 * 60_000;

const STAGES = [
  "without-node",
  "node-appears-then-install",
  "api-key-login",
  "turn-reaches-mock",
  "native-question",
  "key-rotation",
  "update-check",
  "import-codex-history",
  "no-secret-leak",
  "logout",
  "stop-leaves-nothing",
];

function installCase(
  input: {
    id: string;
    title: string;
    oracle: string;
    catches: string[];
    network: boolean;
    llm: "mock" | "none";
    expectedDurationMs: number;
    stages?: string[];
  },
  run: (t: CaseContext) => Promise<void>,
): void {
  defineSpecialty(
    {
      id: `specialty.agent.install.${input.id}`,
      title: input.title,
      oracle: input.oracle,
      catches: input.catches,
      tags: ["agent", "script-agent", "agent-install", "codex", ...(input.network ? ["network"] : ["core"])],
      llm: { default: input.llm },
      expectedDurationMs: input.expectedDurationMs,
      timeoutMs: input.network ? 20 * 60_000 : input.expectedDurationMs * 4,
      resources: input.network
        ? { environments: 1, cpu: 2, memoryMb: 2048, io: 2, browser: 0, pool: "heavy" }
        : { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
      surfaces: ["daemon", "script-agent", "codex-cli", "workbench-client", ...(input.network ? ["npm-registry"] : [])],
      productInterfaces: ["@genehub/workbench/client", "daemon-protocol", "agent-serve-protocol-1"],
      stages: input.stages,
    },
    run,
  );
}

const primary = (agent: AgentInfo) => agent.actions?.find((action) => action.primary)?.id;
const actionIds = (agent: AgentInfo) => (agent.actions ?? []).map((action) => action.id);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

interface StartedAction {
  actionId: string;
  /** The job on screen before; the action's own job has another id. */
  before: string | undefined;
}

/** Starts an Agent action. Its job shows in AgentInfo only from the
 * script's first job notification, which may come after a request. */
async function startAction(t: CaseContext, opened: Opened, actionId: string): Promise<StartedAction> {
  const before = (await t.flows.branches.listAgents(opened.client)).find((agent) => agent.id === CODEX)?.job?.id;
  const ran = await t.flows.branches.agentControl(opened.client, {
    type: "agent.action", payload: { agentId: CODEX, actionId },
  });
  t.assertions.assert(ran.ok, `agent.action ${actionId} failed: ${ran.ok ? "" : ran.error}`);
  return { actionId, before };
}

async function jobEnd(t: CaseContext, opened: Opened, started: StartedAction, timeoutMs = 60_000): Promise<NonNullable<AgentInfo["job"]>> {
  const ended = await t.flows.branches.waitForAgent(opened.client, CODEX,
    (agent) => agent.job?.action === started.actionId && agent.job.id !== started.before && agent.job.done,
    { timeoutMs, what: `done with ${started.actionId}` });
  return ended.job!;
}

/** While the confirmation is still open, the action's job is already on
 * screen: a person sees the install running, not just a question. */
async function jobVisibleWhilePending(t: CaseContext, opened: Opened, started: StartedAction, requestId: string): Promise<void> {
  await t.flows.branches.waitForAgent(opened.client, CODEX, (agent) =>
    agent.job?.action === started.actionId && agent.job.id !== started.before && !agent.job.done
    && (agent.pendingRequests ?? []).some((request) => request.id === requestId),
  { timeoutMs: 10_000, what: `showing the ${started.actionId} job while its request is pending` });
}

/** The phases one job went through, in the order the client was told. */
function phasesOf(pushes: Pushes, jobId: string): string[] {
  const phases: string[] = [];
  for (const list of pushes.lists) {
    const job = list.find((agent) => agent.id === CODEX)?.job;
    if (job?.id === jobId && job.phase && phases.at(-1) !== job.phase) phases.push(job.phase);
  }
  return phases;
}

async function nextRequest(
  t: CaseContext,
  pushes: Pushes,
  title: string,
  seen: Set<string>,
  timeoutMs = 30_000,
): Promise<AgentUserRequest> {
  let found: AgentUserRequest | undefined;
  await t.tools.waitUntil(() => {
    found = pushes.requests.find((request) => request.agentId === CODEX && request.title === title && !seen.has(request.id));
    return found !== undefined;
  }, timeoutMs).catch(() => {
    throw new Error(`no "${title}" request within ${timeoutMs}ms; saw ${JSON.stringify(pushes.requests.map((request) => request.title))}`);
  });
  seen.add(found!.id);
  return found!;
}

async function requestClosed(t: CaseContext, pushes: Pushes, requestId: string): Promise<void> {
  await t.tools.waitUntil(() => pushes.closed.some((item) => item.requestId === requestId), 15_000)
    .catch(() => { throw new Error(`request ${requestId} was never closed`); });
}

const choose = (optionId: string) => ({ type: "answered" as const, optionId, answers: [] });

async function loginWithApiKey(t: CaseContext, opened: Opened, pushes: Pushes, seen: Set<string>, key: string): Promise<AgentInfo> {
  const started = await startAction(t, opened, "login-api-key");
  const request = await nextRequest(t, pushes, API_KEY_TITLE, seen);
  const question = request.questions.find((item) => item.id === "key");
  t.assertions.assert(question?.input === "secret", `the API key question is not secret: ${JSON.stringify(request.questions)}`);
  t.assertions.assert(request.options.some((option) => option.id === "save"), `no save option: ${JSON.stringify(request.options)}`);
  await t.flows.branches.answerAgentRequest(opened.client, {
    agentId: CODEX,
    requestId: request.id,
    outcome: { type: "answered", optionId: "save", answers: [{ questionId: "key", selectedOptionIds: [], freeformText: key }] },
  });
  await requestClosed(t, pushes, request.id);
  const job = await jobEnd(t, opened, started);
  t.assertions.assert(!job.error, `login-api-key failed: ${job.error}`);
  return t.flows.branches.waitForAgent(opened.client, CODEX,
    (agent) => agent.probe.state === "ready" && agent.catalog.models.length > 0, { timeoutMs: 60_000, what: "ready with models" });
}

async function waitForTerminal(t: CaseContext, events: EventLog, after: number, timeoutMs = 120_000) {
  let found: { raw: unknown } | undefined;
  await t.tools.waitUntil(() => {
    found = events.slice(after).find((item) => item.type === "turnCompleted" || item.type === "turnFailed");
    return found !== undefined;
  }, timeoutMs).catch(() => {
    throw new Error(`no terminal turn event; saw ${events.slice(after).map((item) => item.type).join(",")}`);
  });
  return (found!.raw as { event?: Record<string, unknown> }).event ?? {};
}

async function assistantText(opened: Opened, sessionId: string): Promise<string[]> {
  const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
  if (reply?.type !== "snapshot") throw new Error(`session.get returned ${reply?.type}`);
  return reply.data.items
    .filter((item) => item.type === "assistantMessage")
    .map((item) => (item as { text: string }).text.trim());
}

/** One prompt in `sessionId`; the turn must complete with the mock's text,
 * carried by exactly one Responses call whose bearer is `key`. */
async function turnWithKey(
  t: CaseContext,
  opened: Opened,
  session: { id: string; events: EventLog },
  key: string,
  label: string,
): Promise<{ prompt: string; reply: string }> {
  const nonce = randomBytes(6).toString("hex");
  const prompt = `Reply for ${label} ${nonce}`;
  const reply = `codex-mock-${label}-${nonce}`;
  opened.mock.script({ text: reply });
  const calls = opened.mock.calls.length;
  const mark = session.events.length;
  await t.flows.main.sendPrompt(opened.client, session.id, prompt);
  const terminal = await waitForTerminal(t, session.events, mark);
  t.assertions.assert(terminal.type === "turnCompleted", `${label}: turn ended ${JSON.stringify(terminal).slice(0, 600)}`);
  const texts = await assistantText(opened, session.id);
  t.assertions.assert(texts.at(-1) === reply, `${label}: last agent message ${JSON.stringify(texts.at(-1))}, expected the mock's text`);
  const responses = opened.mock.calls.slice(calls).filter((call) => call.method === "POST" && call.path.endsWith("/responses"));
  t.assertions.assert(responses.length === 1, `${label}: the mock saw ${responses.length} Responses calls`);
  t.assertions.assert(responses[0]!.authorizationSha256 === sha256(`Bearer ${key}`),
    `${label}: the Responses call did not carry the current API key as its bearer`);
  return { prompt, reply };
}

/** A CLI run the way a person runs it in a terminal; returns the exit code. */
function runCli(program: string, args: string[], env: NodeJS.ProcessEnv, input: string, cwd?: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { env, cwd, stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code); });
    child.stdin.end(input);
  });
}

async function openCodexSession(t: CaseContext, opened: Opened, ready: AgentInfo): Promise<{ id: string; events: EventLog }> {
  const modelId = ready.catalog.defaultModel ?? ready.catalog.models[0]!.id;
  const id = await t.flows.main.createAgentSession(opened.client, { workspaceId: opened.workspaceId, agentId: CODEX, modelId });
  return { id, events: await t.flows.main.attachEventLog(opened.client, id) };
}

async function noteCodexLogs(t: CaseContext, opened: Opened, secrets: string[]): Promise<void> {
  const logs = await t.flows.branches.agentLogs(opened.client, CODEX, 25).catch((error: unknown) => [`agent.logs failed: ${String(error)}`]);
  const agents = await t.flows.branches.listAgents(opened.client).catch(() => []);
  const codex = agents.find((agent) => agent.id === CODEX);
  let text = `codex: ${JSON.stringify(codex ? t.flows.branches.summarizeAgent(codex) : null)}\ncodex logs: ${logs.join(" | ")}`;
  for (const secret of secrets) text = text.replaceAll(secret, "[api-key]");
  t.note(text);
}

installCase(
  {
    id: "codex-node-found-after-start-then-install-and-api-key-login",
    title: "Codex installs once Node.js appears, logs in with an API key and talks to the model with the current key",
    oracle: "with no Node.js reachable the codex Agent offers install with the Node guidance and an install job fails leaving no npm prefix; after nvm-style Node appears under the lease home (daemon not restarted) install asks first with its job already shown (not done), shows the npm prefix under state/codex, runs the real npm install, offers a durable account-login capability limitation without an expiring link or running login process whose cancel still ends the job done with codex under the prefix and login/login-api-key offered; with Codex's own config pointed at the mock, an API key answer makes it ready with models, a session turn completes with the mock's text over exactly one Responses call bearing sha256(Bearer key); after switching to a second key with login-api-key (no logout) both the same and a new session reach the mock with the second key, and after a third key is saved by `codex login --with-api-key` outside GeneHub the same session's next turn carries the third; update reports the registry's version and stays ready; the first session's thread (once closed) and a `codex exec` thread the user ran in a terminal in the workspace are each listed by session.importList, session.import gives a native codex session whose timeline holds that prompt then the mock's reply, the thread is not offered again, and the imported session completes a turn with the current key; no key appears in agent.logs, agent.list, Agent pushes or the daemon log; logout leaves it not logged in; a /proc census that saw the app-server and the script finds no lease process after the daemon stops",
    catches: [
      "Node.js installed after daemon start is not found without a restart",
      "install runs without asking, or outside the Agent's own prefix",
      "a cancelled login after a successful install fails the install job",
      "API key not delivered to codex login, or Codex not ready after it",
      "Codex history not offered for import, imported without its messages, offered twice, or not continuable",
      "app-server sessions keep a revoked key after re-login or a key change outside GeneHub",
      "update check breaks a working install",
      "API key echoed into logs, state or pushes",
      "codex app-server or the script outlives the daemon",
    ],
    network: true,
    llm: "mock",
    expectedDurationMs: 180_000,
    stages: STAGES,
  },
  async (t) => {
    const node = hostNode();
    const latest = await requireNpmPackage(t.env, CODEX_NPM_PACKAGE, node);
    withoutNodeOrAgentClis(t.env);
    seedScriptAgentRuntime(t.env);
    const prefix = codexNpmPrefix(t.env);
    const codexBin = path.join(prefix, "bin", "codex");
    const keys = [1, 2, 3].map(() => `sk-genehub-test-${randomBytes(20).toString("hex")}`);
    const [key1, key2, key3] = keys as [string, string, string];
    let nvmBin = "";
    const seen = new Set<string>();

    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const pushes = t.flows.branches.recordAgentPushes(opened.client);
    let daemonStopped = false;
    try {
      await t.stage("without-node", async () => {
        const absent = await t.flows.branches.waitForAgent(opened.client, CODEX,
          (agent) => primary(agent) === "install" && (agent.message ?? "").includes(NO_NODE_HINT), { timeoutMs: 60_000, what: "offering install without Node.js" });
        t.assertions.assert(absent.source === "builtin" && absent.probe.state === "unavailable",
          `codex without Node.js: ${JSON.stringify(t.flows.branches.summarizeAgent(absent))}`);
        const job = await jobEnd(t, opened, await startAction(t, opened, "install"));
        t.assertions.assert((job.error ?? "").includes(NO_NODE_HINT), `install without Node.js ended ${JSON.stringify(job)}`);
        t.assertions.assert(!existsSync(prefix), "an install without Node.js left an npm prefix");
        t.assertions.assert(!pushes.requests.some((request) => request.agentId === CODEX), "install without Node.js asked the user anyway");
      });

      await t.stage("node-appears-then-install", async () => {
        nvmBin = installNodeLikeNvm(t.env, node);
        const started = await startAction(t, opened, "install");
        const confirm = await nextRequest(t, pushes, INSTALL_TITLE, seen);
        await jobVisibleWhilePending(t, opened, started, confirm.id);
        t.assertions.assert((confirm.detail ?? "").includes(prefix) && (confirm.detail ?? "").includes(CODEX_NPM_PACKAGE),
          `install request does not show the npm prefix and package: ${confirm.detail}`);
        t.assertions.assert(["run", "cancel"].every((id) => confirm.options.some((option) => option.id === id)),
          `install options ${JSON.stringify(confirm.options)}`);
        t.assertions.assert(!existsSync(codexBin), "npm ran before the user confirmed");
        await t.flows.branches.answerAgentRequest(opened.client, { agentId: CODEX, requestId: confirm.id, outcome: choose("run") });

        const login = await nextRequest(t, pushes, LOGIN_TITLE, seen, NPM_TIMEOUT_MS);
        t.assertions.assert(login.display.length === 0 && (login.detail ?? "").includes("此版本不能在工作台完成账号登录"), "no durable account-login instruction");
        t.assertions.assert(login.options.some(o => o.id === "check") && login.options.some(o => o.id === "cancel"), "no login check/cancel actions");
        t.assertions.assert(!leaseProcesses(t.env).some(p => /codex.*\blogin\b/.test(p.cmd)), "login CLI retained during Human pause");
        t.assertions.assert(existsSync(codexBin), "the login request came before codex was under the npm prefix");
        await t.flows.branches.answerAgentRequest(opened.client, { agentId: CODEX, requestId: login.id, outcome: choose("cancel") });
        await requestClosed(t, pushes, login.id);

        const job = await jobEnd(t, opened, started);
        const phases = phasesOf(pushes, job.id);
        t.note(`install job phases: ${phases.join(" > ")}; ended: ${job.message ?? ""}`);
        t.assertions.assert(!job.error, `install with a cancelled login failed: ${job.error}`);
        t.assertions.assert(phases.indexOf("install") >= 0 && phases.indexOf("install") < phases.lastIndexOf("login"),
          `install job phases ${phases.join(",")}`);
        const installed = await t.flows.branches.waitForAgent(opened.client, CODEX,
          (agent) => agent.probe.state !== "ready" && ["login", "login-api-key"].every((id) => actionIds(agent).includes(id)),
          { what: "installed but not logged in" });
        t.assertions.assert(primary(installed) === "login", `primary action after install ${primary(installed)}`);
      });

      let ready: AgentInfo | undefined;
      await t.stage("api-key-login", async () => {
        pointCodexAtMockLlm(t.env, opened.mock.origin);
        ready = await loginWithApiKey(t, opened, pushes, seen, key1);
        t.note(`ready: version ${ready.version}, ${ready.catalog.models.length} models, default ${ready.catalog.defaultModel}`);
      });

      let first: { id: string; events: EventLog } | undefined;
      let firstTurn: { prompt: string; reply: string } | undefined;
      await t.stage("turn-reaches-mock", async () => {
        first = await openCodexSession(t, opened, ready!);
        firstTurn = await turnWithKey(t, opened, first, key1, "first-key");
        const running = leaseProcesses(t.env);
        t.assertions.assert(running.some((item) => item.cmd.includes("app-server")),
          `the process census does not see the session's codex app-server: ${JSON.stringify(running.map((item) => item.cmd.slice(0, 80)))}`);
      });

      await t.stage("native-question", async () => {
        const requestIds = new Set<string>();
        for (const attempt of [1, 2]) {
        const questionId = "conversation-choice-" + attempt;
        const names = (tools: Array<{ name?: string; tools?: unknown[] }>, prefix = ""): string[] => tools.flatMap(tool =>
          tool.tools ? names(tool.tools as Array<{ name?: string; tools?: unknown[] }>, prefix + (tool.name ?? "") + ".")
            : tool.name ? [prefix + tool.name] : []);
        opened.mock.script({ respond: body => {
          t.note("request fields: " + Object.entries(body as object).map(([key, value]) => key + ":" + (Array.isArray(value) ? "array" : typeof value)).join(","));
          t.note("request encoding: " + opened.mock.inboundHeaders.map(h => h["content-encoding"] ?? "identity").join(","));
          t.note("tools shape: " + JSON.stringify(((body as { tools?: Array<Record<string, unknown>> }).tools ?? []).slice(0, 4).map(tool => ({ keys: Object.keys(tool), type: tool.type, name: tool.name, functionName: (tool.function as { name?: string } | undefined)?.name }))).slice(0, 600));
          const tools = names((body as { tools?: Array<{ name?: string }> }).tools ?? []);
          // Some native model transports encode tool definitions in their
          // input context, not in the optional top-level tools array. Let the
          // real CLI validate the call; the card/stop/resume is the oracle.
          const tool = tools.find(name => name === "request_user_input" || name.endsWith(".request_user_input")) ?? "request_user_input";
          t.note("advertised tools: " + tools.slice(0, 30).join(","));
          return { tool: { name: tool, arguments: { questions: [{ id: questionId, header: "测试输入与选择",
            question: "请选择并输入补充信息", options: [{ label: "选项 A", description: "第一项" }, { label: "选项 B", description: "第二项" }] }] } } };
        } });
        const began = first!.events.length;
        await t.flows.main.sendPrompt(opened.client, first!.id, "我们正在调试Agent对话，你能给我一个输入框+一个选择给我试试吗？");
        let requestId = "";
        await t.tools.waitUntil(async () => {
          const reply = await opened.client.call({ type: "session.get", payload: { sessionId: first!.id } });
          const pending = reply?.type === "snapshot" ? reply.data.pendingPermissions.find(p => p.kind === "question") : undefined;
          requestId = pending?.id ?? "";
          const found = pending?.questions?.some(q => q.id === questionId && q.allowFreeform && q.options.length === 2) ?? false;
          if (!found && first!.events.slice(began).some(e => e.type === "turnCompleted" || e.type === "turnFailed")) throw new Error("native turn ended without a question");
          return found;
        }, 60_000).catch(error => {
          const recent = opened.mock.requests.slice(-3) as Array<{ input?: Array<{ type?: string; output?: unknown }>; tools?: Array<{ name?: string }> }>;
          t.note("native-question events: " + first!.events.slice(-12).map(e => e.type).join(","));
          t.note("native tool registered: " + recent.map(body => (body.tools ?? []).some(tool => tool.name === "request_user_input")).join(","));
          t.note("native tool results: " + recent.flatMap(body => (body.input ?? []).filter(item => item.type === "function_call_output").map(item => JSON.stringify(item.output).slice(0, 500))).slice(-3).join(" | "));
          throw error;
        });
        t.assertions.assert(!requestIds.has(requestId), "native JSON-RPC id was reused in the new execution");
        requestIds.add(requestId);
        await t.tools.waitUntil(() => !leaseProcesses(t.env).some(p => p.cmd.includes("app-server")), 10_000);
        const answer = "durable-question-answer-" + randomBytes(8).toString("hex");
        let delivered = false;
        opened.mock.script({ respond: body => {
          delivered = JSON.stringify(body).includes(answer);
          return { text: "question-resumed" };
        } });
        const after = first!.events.length;
        const result = await opened.client.call({ type: "session.respondPermission", payload: { sessionId: first!.id, requestId,
          outcome: { outcome: "answered", answers: [{ questionId, selectedOptionIds: [], freeformText: answer }] } } });
        t.assertions.assert(result?.type === "ack", "question answer rejected");
        const terminal = await waitForTerminal(t, first!.events, after);
        t.assertions.assert(terminal.type === "turnCompleted" && delivered, "answer did not reach fresh resumed execution");
        }
      });

      await t.stage("key-rotation", async () => {
        // A logged-in Codex offers switching keys directly, no logout first.
        t.assertions.assert(actionIds(ready!).includes("login-api-key"), `a logged-in Codex offers ${actionIds(ready!).join(",")}`);
        ready = await loginWithApiKey(t, opened, pushes, seen, key2);
        await turnWithKey(t, opened, first!, key2, "same-session");
        await turnWithKey(t, opened, await openCodexSession(t, opened, ready), key2, "new-session");

        // The key changed outside GeneHub, as `codex login` in a terminal does.
        // The script polls its auth file every 10 s; one period after key2's
        // write it has seen that, so the next notice can only be the terminal's.
        await new Promise((resolve) => setTimeout(resolve, 11_000));
        const notices = async () => (await t.flows.branches.agentLogs(opened.client, CODEX, 2_000))
          .filter((line) => line.includes("auth file changed")).length;
        const before = await notices();
        const login = await runCli(codexBin, ["login", "--with-api-key"], {
          ...process.env, HOME: t.env.home, PATH: nvmBin + path.delimiter + (t.env.env.PATH ?? ""),
        }, `${key3}\n`);
        t.assertions.assert(login === 0, `codex login --with-api-key in a terminal exited ${login}`);
        await t.tools.waitUntil(async () => (await notices()) > before, 30_000)
          .catch(() => { throw new Error("the codex script never noticed the changed auth file"); });
        await turnWithKey(t, opened, first!, key3, "after-terminal-login");
      });

      await t.stage("update-check", async () => {
        const job = await jobEnd(t, opened, await startAction(t, opened, "update"), NPM_TIMEOUT_MS);
        t.note(`update with registry at ${latest}: ${job.message ?? ""}`);
        t.assertions.assert(!job.error, `update failed: ${job.error}`);
        const after = await t.flows.branches.waitForAgent(opened.client, CODEX,
          (agent) => agent.probe.state === "ready" && agent.version === latest, { timeoutMs: 60_000, what: `ready on ${latest}` });
        t.assertions.assert(after.catalog.models.length > 0, "no models after the update check");
      });

      await t.stage("import-codex-history", async () => {
        // Two kinds of Codex history in the lease home's ~/.codex: the first
        // GeneHub session's thread (closed now), and a `codex exec` the user
        // ran in a terminal in this folder. A terminal run before the daemon
        // started would also have to log Codex in, taking away the login path
        // this case drives, so it runs here with the installed CLI.
        const closed = await opened.client.call({ type: "session.close", payload: { sessionId: first!.id } });
        t.assertions.assert(closed?.type === "ack", `session.close returned ${closed?.type}`);
        const nonce = randomBytes(6).toString("hex");
        const terminal = { prompt: `terminal history ${nonce}`, reply: `codex-mock-terminal-${nonce}` };
        opened.mock.script({ text: terminal.reply });
        const calls = opened.mock.calls.length;
        const exec = await runCli(codexBin, ["exec", "--skip-git-repo-check", terminal.prompt], {
          ...process.env, HOME: t.env.home, PATH: nvmBin + path.delimiter + (t.env.env.PATH ?? ""),
        }, "", opened.workspaceRoot);
        t.assertions.assert(exec === 0, `codex exec in a terminal exited ${exec}`);
        t.assertions.assert(opened.mock.calls.slice(calls).some((call) => call.path.endsWith("/responses")
          && call.authorizationSha256 === sha256(`Bearer ${key3}`)), "the terminal's codex exec never reached the mock with the saved key");

        for (const [label, turn] of [["GeneHub thread", firstTurn!], ["codex exec thread", terminal]] as const) {
          const listed = await opened.client.call({ type: "session.importList", payload: { workspaceId: opened.workspaceId, limit: 30 } });
          if (listed?.type !== "sessionImports") throw new Error(`session.importList returned ${listed?.type}`);
          const source = listed.data.sources.find((item) => item.agentId === CODEX);
          t.assertions.assert(source?.supported === true && !source.error,
            `codex import source ${JSON.stringify(source ? { ...source, candidates: source.candidates.length } : null)}`);
          const matches = (item: { title: string; preview: string }) => item.title.includes(turn.prompt) || item.preview.includes(turn.prompt);
          const candidate = source!.candidates.find(matches);
          t.assertions.assert(candidate !== undefined,
            `${label} is not an import candidate; saw ${JSON.stringify(source!.candidates.map((item) => item.title.slice(0, 60)))}`);
          const imported = await opened.client.call({ type: "session.import", payload: { workspaceId: opened.workspaceId, candidateId: candidate!.candidateId } });
          if (imported?.type !== "session") throw new Error(`session.import of the ${label} returned ${imported?.type}`);
          t.assertions.assert(imported.data.agentId === CODEX && imported.data.imported?.continuation === "native",
            `imported ${label} ${JSON.stringify({ agentId: imported.data.agentId, imported: imported.data.imported })}`);
          const snapshot = await opened.client.call({ type: "session.get", payload: { sessionId: imported.data.id } });
          if (snapshot?.type !== "snapshot") throw new Error(`session.get returned ${snapshot?.type}`);
          const items = snapshot.data.items as Array<{ type: string; text?: string }>;
          const user = items.findIndex((item) => item.type === "userMessage" && (item.text ?? "").includes(turn.prompt));
          const answer = items.findIndex((item) => item.type === "assistantMessage" && (item.text ?? "").trim() === turn.reply);
          t.assertions.assert(user >= 0 && answer > user, `imported ${label} timeline ${JSON.stringify(items.map((item) => item.type))}`);
          const again = await opened.client.call({ type: "session.importList", payload: { workspaceId: opened.workspaceId, limit: 30 } });
          t.assertions.assert(again?.type === "sessionImports" && !again.data.sources.some((item) => item.candidates.some(matches)),
            `the imported ${label} is offered for import again`);
          const events = await t.flows.main.attachEventLog(opened.client, imported.data.id);
          await turnWithKey(t, opened, { id: imported.data.id, events }, key3, `imported-${label.split(" ")[1]}`);
        }
      });

      await t.stage("no-secret-leak", async () => {
        const logs = (await t.flows.branches.agentLogs(opened.client, CODEX)).join("\n");
        const listed = JSON.stringify(await t.flows.branches.listAgents(opened.client));
        const pushed = JSON.stringify({ lists: pushes.lists, requests: pushes.requests });
        const daemonLog = t.env.env.GENEHUB_LOG && existsSync(t.env.env.GENEHUB_LOG) ? readFileSync(t.env.env.GENEHUB_LOG, "utf8") : "";
        const leaks = Object.entries({ "agent.logs": logs, "agent.list": listed, "Agent pushes": pushed, "daemon log": daemonLog })
          .filter(([, text]) => keys.some((key) => text.includes(key)))
          .map(([where]) => where);
        t.assertions.assert(leaks.length === 0, `an API key leaked into ${leaks.join(", ")}`);
      });

      await t.stage("logout", async () => {
        const job = await jobEnd(t, opened, await startAction(t, opened, "logout"));
        t.assertions.assert(!job.error, `logout failed: ${job.error}`);
        await t.flows.branches.waitForAgent(opened.client, CODEX,
          (agent) => agent.probe.state !== "ready" && primary(agent) === "login", { what: "logged out" });
      });

      await t.stage("stop-leaves-nothing", async () => {
        // The census must see this lease's processes before it can vouch for none.
        const running = leaseProcesses(t.env);
        t.assertions.assert(running.some((item) => item.cmd.includes("boot.py")),
          `the process census does not see the codex script: ${JSON.stringify(running.map((item) => item.cmd.slice(0, 80)))}`);
        daemonStopped = true;
        opened.daemon.stop();
        let left = leaseProcesses(t.env);
        await t.tools.waitUntil(() => (left = leaseProcesses(t.env)).length === 0, 15_000).catch(() => {
          throw new Error(`processes outlived the daemon: ${JSON.stringify(left)}`);
        });
      });
    } catch (error) {
      if (!daemonStopped) await noteCodexLogs(t, opened, keys);
      throw error;
    } finally {
      pushes.stop();
      opened.client.close();
      if (!daemonStopped) opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

installCase(
  {
    id: "codex-install-canceled",
    title: "Cancelling the Codex install confirmation installs nothing",
    oracle: "with npm on PATH and no codex, the install action asks before running npm while its job (action install, not done) is already shown; answering cancel closes the request and ends the job done (no error) with the script's cancelled message, the npm prefix under state/codex is absent or empty, no npm process of this lease runs, and install is still the primary action",
    catches: [
      "npm runs before or despite the user's cancel",
      "a cancelled install reported as a failure",
      "a cancelled install leaves a half-made prefix or a running npm",
    ],
    network: false,
    llm: "none",
    expectedDurationMs: 25_000,
  },
  async (t) => {
    const node = hostNode();
    if (existsSync(path.join(node.bin, "codex"))) {
      throw new BlockedError(`${node.bin} holds codex beside npm; this machine cannot present Node.js without Codex`);
    }
    t.env.env.PATH = node.bin + path.delimiter + pathWithout(HOST_AGENT_CLIS, t.env.env.PATH ?? process.env.PATH ?? "");
    seedScriptAgentRuntime(t.env);
    const prefix = codexNpmPrefix(t.env);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const pushes = t.flows.branches.recordAgentPushes(opened.client);
    try {
      const absent = await t.flows.branches.waitForAgent(opened.client, CODEX,
        (agent) => primary(agent) === "install" && agent.probe.state !== "ready", { timeoutMs: 60_000, what: "offering install" });
      t.assertions.assert(!(absent.message ?? "").includes(NO_NODE_HINT), `npm is on PATH but the Agent asks for Node.js: ${absent.message}`);
      const started = await startAction(t, opened, "install");
      const confirm = await nextRequest(t, pushes, INSTALL_TITLE, new Set());
      await jobVisibleWhilePending(t, opened, started, confirm.id);
      await t.flows.branches.answerAgentRequest(opened.client, { agentId: CODEX, requestId: confirm.id, outcome: choose("cancel") });
      await requestClosed(t, pushes, confirm.id);
      const job = await jobEnd(t, opened, started);
      t.assertions.assert(!job.error && job.message === "已取消", `cancelled install ended ${JSON.stringify(job)}`);
      const made = existsSync(prefix) ? readdirSync(prefix) : [];
      t.assertions.assert(made.length === 0, `the npm prefix has ${made.join(",")}`);
      const npm = leaseProcesses(t.env).filter((item) => /\bnpm\b/.test(item.cmd));
      t.assertions.assert(npm.length === 0, `npm processes of this lease: ${JSON.stringify(npm)}`);
      const after = await t.flows.branches.listAgents(opened.client);
      const codex = after.find((agent) => agent.id === CODEX);
      t.assertions.assert(codex !== undefined && primary(codex) === "install" && codex.probe.state !== "ready",
        `after cancel: ${JSON.stringify(codex ? t.flows.branches.summarizeAgent(codex) : null)}`);
    } catch (error) {
      await noteCodexLogs(t, opened, []);
      throw error;
    } finally {
      pushes.stop();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
