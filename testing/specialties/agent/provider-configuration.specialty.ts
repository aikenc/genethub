import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { connectProductClient, daemonEndpoint, defineSpecialty, openProviderSession, openWorkbenchPage, parseJson,
  runGenet, runGenetAsync, startMockLlm, type CaseContext } from "../../framework/public.ts";
import type { ProviderOperationCommand } from "@genehub/proto";

type Opened = Awaited<ReturnType<typeof openProviderSession>>;
async function snapshot(s: Opened, client = s.client) {
  const reply = await client.call({ type: "session.get", payload: { sessionId: s.sessionId } });
  if (reply?.type !== "snapshot") throw new Error("session snapshot missing");
  return reply.data;
}
async function operation(s: Opened, command: ProviderOperationCommand, client = s.client) {
  const reply = await client.call({ type: "provider.operation", payload: { sessionId: s.sessionId, operation: command } });
  if (reply?.type !== "providerOperation") throw new Error("provider receipt missing");
  return reply.data;
}
async function prepare(t: CaseContext, s: Opened) {
  await t.flows.main.sendPrompt(s.client, s.sessionId, "给 GeneHub 配置模型服务，密钥我来输入。", null, "u_" + randomBytes(16).toString("hex"));
  await t.tools.waitUntil(async () => (await snapshot(s)).pendingPermissions.some(p => p.kind === "providerConfiguration"), 20_000);
  return (await snapshot(s)).pendingPermissions[0]!;
}
function sessionText(dir: string): string {
  return readdirSync(dir, { withFileTypes: true }).map(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sessionText(file) : readFileSync(file).toString("utf8");
  }).join("\n");
}
const shape = {
  tags: ["core", "session", "authorization", "provider-self-bootstrap"], llm: { default: "mock" as const },
  expectedDurationMs: 20_000, timeoutMs: 120_000,
  surfaces: ["daemon", "real-cli", "script-agent", "workbench-client", "filesystem"],
  productInterfaces: ["genet context", "genet provider", "provider.operation", "session.get"],
};

defineSpecialty({ ...shape, id: "specialty.agent.provider-configuration.browser",
  title: "Provider configuration remains in the original conversation across restart, with direct Human secret input",
  oracle: "a real Agent CLI reports sessionController without Settings, stops before the browser shows the configuration; restart retains the card; one password submission saves and probes Anthropic, starts a fresh execution in the original Session, and leaves no key in receipts/chat/model requests; duplicate submission does not call the model or overwrite config",
  catches: ["wrong caller identity", "Agent configures unrelated software", "secret enters model context", "restart loses card", "duplicate provider mutation"],
  runner: "playwright", resources: { environments: 1, cpu: 1, memoryMb: 1536, io: 1, browser: 1, pool: "browser" },
}, async t => {
  const s = await openProviderSession(t, "anthropic");
  let client = s.client;
  const browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(s.daemon), s.workspaceId, s.sessionId, {}, { trace: false });
  try {
    const request = await prepare(t, s);
    const discovered = s.journal().filter(e => e.event === "provider-discovery");
    const context = discovered.map(e => { try { return parseJson(String(e.result)) as { type?: string; data?: { principal?: {type?: string}; authority?: { grants?: string[] } } }; } catch { return null; } }).find(e => e?.type === "context");
    t.assertions.assert(context?.data?.principal?.type === "sessionController" && !context?.data?.authority?.grants?.includes("settings"), "Agent received invented localUser or Settings authority");
    const cli = s.journal().find(e => e.event === "provider-cli");
    t.assertions.assert(!!cli, "configuration did not use the public CLI");
    const isRunning = (pid: number) => { try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z"; } catch { return false; } };
    t.assertions.assert(!isRunning(Number(cli!.cliPid)), "Human card appeared while its CLI was alive");
    await browser.page.getByLabel("Provider API Key").waitFor();
    const before = await snapshot(s);
    client.close(); s.daemon.stop();
    t.assertions.assert(runGenet(s.daemon.genet, ["daemon", "start"], s.daemon.env).code === 0, "daemon restart failed");
    client = await connectProductClient(daemonEndpoint(s.daemon));
    await browser.page.reload();
    await browser.page.getByLabel("Provider API Key").waitFor();
    t.assertions.assert((await snapshot(s, client)).pendingPermissions[0]?.id === request.id, "restart changed the operation");
    const key = "test-provider-" + randomBytes(24).toString("hex");
    await browser.page.getByLabel("Provider API Key").fill(key);
    await browser.page.getByRole("button", { name: "保存并验证", exact: true }).click();
    await t.tools.waitUntil(async () => (await snapshot(s, client)).summary.status === "idle" && s.journal().some(e => e.event === "continuation-received" && e.matched), 25_000);
    const receipt = await operation(s, { type: "get", actionId: s.actionId }, client);
    t.assertions.assert(receipt.state === "saved" && receipt.validation.status === "ready", "saved configuration did not verify a model");
    const after = await snapshot(s, client);
    t.assertions.assert(after.summary.modeId === before.summary.modeId && after.pendingPermissions.length === 0, "configuration changed permission mode or left the card");
    t.assertions.assert(s.journal().filter(e => e.event === "session-start").length === 2, "answer did not start exactly one fresh execution");
    t.assertions.assert(!JSON.stringify([after, receipt, s.mock.requests]).includes(key), "credential entered a public receipt, chat or model request");
    t.assertions.assert(!sessionText(path.join(s.workspaceRoot, ".genethub", "sessions", s.sessionId)).includes(key), "credential persisted in Session records");
    const config = readFileSync(path.join(t.env.data, "config.json"), "utf8");
    t.assertions.assert(JSON.parse(config).agents.providers["fixture-provider"].apiKey === key, "credential never reached its machine config");
    const calls = s.mock.calls.length;
    await operation(s, { type: "submit", actionId: s.actionId, approved: true }, client);
    t.assertions.assert(s.mock.calls.length === calls && readFileSync(path.join(t.env.data, "config.json"), "utf8") === config, "duplicate decision re-executed the mutation or probe");
    await t.assertions.expectProtocolCode(() => operation(s, { type: "submit", actionId: s.actionId, approved: true, apiKey: "different-input" }, client), "badRequest");
    t.assertions.assert(readFileSync(path.join(t.env.data, "config.json"), "utf8") === config, "altered duplicate changed credential");
    t.note("sameSession=true; nativeExecutions=2; dialect=anthropic; secretOutsideConversation=true");
  } finally { await browser.close(); client.close(); await s.dispose(); }
});

defineSpecialty({ ...shape, id: "specialty.agent.provider-configuration.authorization",
  title: "Provider operations reject unauthorized approval and stale plans, while retaining existing credentials",
  oracle: "read+session device cannot submit; ordinary answers cannot approve a provider operation; concurrent Human settings update makes the plan stale without overwriting its key; rejection resumes the same task; changed action payload and credential command arguments are rejected",
  catches: ["general Session permission elevates to Settings", "generic answer substitutes for configuration authorization", "stale plan overwrites new settings", "action identity changes"],
}, async t => {
  const s = await openProviderSession(t, "openai");
  let reader: Awaited<ReturnType<CaseContext["flows"]["main"]["pairDevice"]>> | undefined;
  try {
    const request = await prepare(t, s);
    reader = await t.flows.main.pairDevice(s.client, s.daemon, ["read", "session"], "provider-reader");
    await t.assertions.expectProtocolCode(() => operation(s, { type: "submit", actionId: s.actionId, approved: true, apiKey: "not-a-real-key" }, reader!.client), "forbidden");
    await t.assertions.expectProtocolCode(() => s.client.call({ type: "session.respondPermission", payload: { sessionId: s.sessionId, requestId: request.id, outcome: { outcome: "selected", optionId: "approve" } } }), "forbidden");
    const pending = await operation(s, { type: "get", actionId: s.actionId });
    await t.assertions.expectProtocolCode(() => operation(s, { type: "prepare", actionId: s.actionId, draft: { ...pending.draft, label: "changed" } }), "badRequest");
    const bad = runGenet(s.daemon.genet, ["provider", "configure", "new", "--api-key", "masked"], s.daemon.env);
    t.assertions.assert(bad.code === 2, "credential argument accepted by CLI");
    const existingKey = "existing-" + randomBytes(16).toString("hex");
    await s.client.call({ type: "settings.setProvider", payload: { providerId: "fixture-provider", apiKey: existingKey, baseUrl: s.mock.origin, label: "Manual change", dialect: "openai", models: ["mock-llm"] } });
    await t.assertions.expectProtocolCode(() => operation(s, { type: "submit", actionId: s.actionId, approved: true, apiKey: "replacement" }), "badRequest");
    t.assertions.assert((await operation(s, { type: "get", actionId: s.actionId })).state === "stale", "changed settings did not fence the plan");
    await operation(s, { type: "submit", actionId: s.actionId, approved: false });
    await t.tools.waitUntil(async () => (await snapshot(s)).summary.status === "idle", 15_000);
    t.assertions.assert(JSON.parse(readFileSync(path.join(t.env.data, "config.json"), "utf8")).agents.providers["fixture-provider"].apiKey === existingKey, "stale or rejected operation overwrote existing key");
  } finally { reader?.client.close(); await s.dispose(); }
});

defineSpecialty({ ...shape, id: "specialty.agent.provider-configuration.endpoint-and-failure",
  title: "Changing provider endpoint cannot carry the old key; a saved provider with failed authentication is not ready",
  oracle: "an existing provider at another endpoint requires a fresh key; omission causes no config write or request to the new host; a directly submitted new key reaches only the new endpoint, and an injected HTTP 401 is a durable authenticationFailed receipt, distinct from saved",
  catches: ["old credential forwarded to a new endpoint", "saved reported as verified", "authentication failure lost on restart"],
}, async t => {
  const s = await openProviderSession(t, "openai");
  const old = await startMockLlm();
  try {
    const oldKey = "old-" + randomBytes(16).toString("hex");
    await s.client.call({ type: "settings.setProvider", payload: { providerId: "fixture-provider", apiKey: oldKey, baseUrl: old.origin, label: "Old", dialect: "openai", models: ["mock-llm"] } });
    await prepare(t, s);
    const prepared = await operation(s, { type: "get", actionId: s.actionId });
    t.assertions.assert(prepared.replacesEndpoint && prepared.keyRequired, "endpoint change offered the old credential");
    await t.assertions.expectProtocolCode(() => operation(s, { type: "submit", actionId: s.actionId, approved: true }), "badRequest");
    t.assertions.assert(s.mock.calls.length === 0, "old key was sent before Human input");
    const newKey = "new-" + randomBytes(16).toString("hex");
    s.mock.script({ status: 401 });
    const saved = await operation(s, { type: "submit", actionId: s.actionId, approved: true, apiKey: newKey });
    t.assertions.assert(saved.state === "saved" && saved.validation.status === "authenticationFailed", "failed credential was reported ready");
    t.assertions.assert(s.mock.calls.every(call => call.authorizationSha256 === createHash("sha256").update("Bearer " + newKey).digest("hex")), "new endpoint received another credential");
    t.assertions.assert(!JSON.stringify(saved).includes(newKey), "failure receipt includes credential");
    s.mock.script({ text: "ok" });
    const retried = await operation(s, { type: "verify", actionId: s.actionId });
    t.assertions.assert(retried.validation.status === "ready", "explicit verification retry did not update receipt");
  } finally { await old.stop(); await s.dispose(); }
});

defineSpecialty({ ...shape, id: "specialty.agent.provider-configuration.crash",
  title: "A crash after provider save preserves the receipt and resumes without replaying secret input",
  oracle: "kill the actual host during a delayed model probe after config save; restart reconciles saved config, reports interrupted verification and resumes the original Session; explicit re-verification succeeds, and no duplicate mutation or secret appears in Session files",
  catches: ["config saved but conversation stays stranded", "crash repeats credential submission", "unfinished verification reported ready"],
}, async t => {
  const s = await openProviderSession(t, "openai");
  let client = s.client;
  try {
    await prepare(t, s);
    s.mock.script({ delayMs: 1500, text: "ok" });
    const key = "crash-" + randomBytes(16).toString("hex");
    const pending = operation(s, { type: "submit", actionId: s.actionId, approved: true, apiKey: key }).catch(() => null);
    await t.tools.waitUntil(() => s.mock.calls.length > 0, 15_000);
    const pid = daemonEndpoint(s.daemon).localServerProof.pid;
    process.kill(pid, "SIGKILL"); client.close();
    await pending;
    await t.tools.waitUntil(() => { try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z"; } catch { return true; } }, 10_000);
    const started = await runGenetAsync(s.daemon.genet, ["daemon", "start"], s.daemon.env);
    t.assertions.assert(started.code === 0, "restart after host kill failed");
    client = await connectProductClient(daemonEndpoint(s.daemon));
    await t.tools.waitUntil(async () => (await snapshot(s, client)).summary.status === "idle" && s.journal().some(e => e.event === "continuation-received"), 25_000);
    const receipt = await operation(s, { type: "get", actionId: s.actionId }, client);
    t.assertions.assert(receipt.state === "saved" && receipt.validation.status === "interrupted", "crash hid verification uncertainty");
    t.assertions.assert(!sessionText(path.join(s.workspaceRoot, ".genethub", "sessions", s.sessionId)).includes(key), "crash persisted secret in Session");
    s.mock.script({ text: "ok" });
    t.assertions.assert((await operation(s, { type: "verify", actionId: s.actionId }, client)).validation.status === "ready", "verification did not recover");
  } finally { client.close(); await s.dispose(); }
});


defineSpecialty({ ...shape, id: "specialty.agent.provider-configuration.stop",
  title: "Stopping a configuration task prevents later Human input from executing its old plan",
  oracle: "interrupt clears the real pending configuration; later submit cannot create a provider, repeated prepare retires the original action, and metadata-only legacy endpoint changes clear old keys instead of sending them to a new host",
  catches: ["canceled Session still mutates config", "retry resurrects stopped operation", "legacy settings path moves existing credential"],
}, async t => {
  const s = await openProviderSession(t, "openai");
  try {
    await prepare(t, s);
    const pending = await operation(s, { type: "get", actionId: s.actionId });
    await s.client.call({ type: "session.interrupt", payload: { sessionId: s.sessionId } });
    await t.assertions.expectProtocolCode(() => operation(s, { type: "submit", actionId: s.actionId, approved: true, apiKey: "late-input" }), "badRequest");
    const retired = await operation(s, { type: "prepare", actionId: s.actionId, draft: pending.draft });
    t.assertions.assert(retired.state === "rejected" && s.mock.calls.length === 0, "stopped operation resurrected or sent a request");
    const humanCancel = "human-cancel-action";
    await operation(s, { type: "prepare", actionId: humanCancel, draft: pending.draft });
    await s.client.call({ type: "session.respondPermission", payload: { sessionId: s.sessionId, requestId: "provider-" + humanCancel, outcome: { outcome: "canceled" } } });
    await t.assertions.expectProtocolCode(() => operation(s, { type: "submit", actionId: humanCancel, approved: true, apiKey: "late-canceled-input" }), "badRequest");
    const providers = await s.client.call({ type: "provider.list" });
    t.assertions.assert(providers?.type === "providers" && !providers.data.some(p => p.id === "fixture-provider"), "stopped plan created a provider");
    await s.client.call({ type: "settings.setProvider", payload: { providerId: "legacy", apiKey: "old-legacy", baseUrl: s.mock.origin, label: "Legacy", dialect: "openai", models: ["mock-llm"] } });
    const nextUrl = s.mock.origin + "/another-endpoint";
    const changed = await s.client.call({ type: "settings.setProvider", payload: { providerId: "legacy", apiKey: null, baseUrl: nextUrl, label: null, dialect: null, models: null } });
    t.assertions.assert(changed?.type === "settings" && changed.data.providers.find(p => p.id === "legacy")?.hasApiKey === false && s.mock.calls.length === 0, "legacy endpoint update retained or sent the old key");
  } finally { await s.dispose(); }
});
