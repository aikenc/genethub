import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { allocatePort, daemonEndpoint, defineSpecialty, openBrowser, startHub, startRelay } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.feedback-log-recovery",
  title: "Feedback submits during a real daemon stall and recovers original-machine logs after reload",
  oracle: "The actual signed-in Console submits one feedback receipt while its real Host is stopped; after page reload and Host resumption it attaches bounded daemon log evidence to that same report and machine, without persisting log text or creating a second report",
  catches: ["feedback waits indefinitely for unavailable daemon logs", "reload loses recovery metadata", "recovery uses a different machine", "retry creates duplicate feedback", "log text persists in the recovery queue"],
  tags: ["page-experience", "cloud-console", "feedback", "recovery"], runner: "playwright", requiredRepos: ["cloud"], llm: { default: "none" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: ["sqlite3", "signal"] }],
  resources: { environments: 1, cpu: 2, memoryMb: 3072, browser: 1, io: 1, pool: "browser" },
  expectedDurationMs: 45_000, timeoutMs: 180_000,
  surfaces: ["cloud-console", "cloud-server", "daemon", "relay", "filesystem"],
  productInterfaces: ["feedback UI", "hub-http", "log.tail", "@genehub/workbench"],
}, async t => {
  const cloud = process.env.TESTCTL_CLOUD_ROOT!, consoleRoot = join(cloud, "console"), consoleDir = join(t.env.root, "console");
  await promisify(execFile)(process.execPath, [join(consoleRoot, "node_modules/vite/bin/vite.js"), "build", "--base", "/", "--outDir", consoleDir],
    { cwd: consoleRoot, env: { ...process.env, VITE_GENEHUB_SUBPATH: "" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const port = await allocatePort(), token = randomBytes(24).toString("hex"), database = join(t.env.root, "feedback.sqlite");
  const hub = await startHub({ databasePath: database, relayOrigin: `http://127.0.0.1:${port}`, relayToken: token, consoleDir });
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  let opened: Awaited<ReturnType<typeof t.flows.main.openWorkspace>> | undefined;
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  let paused = false, pid = 0;
  try {
    relay = await startRelay({ openRoot: t.openRoot, port, control: { origin: hub.origin, token } });
    t.env.env.GENEHUB_LOCAL_HUB_URL = hub.origin;
    opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const account = hub.browser(); await hub.signInOwner(account);
    const pairing = await opened.client.call({ type: "hub.pair", payload: { hubUrl: hub.origin, displayName: "Feedback recovery machine" } });
    if (pairing?.type !== "hubStatus" || pairing.data.state !== "pairing") throw Error("pairing did not start");
    await hub.approvePairing(account, pairing.data.userCode);
    await t.tools.waitUntil(async () => (await account.json<{ machines: Array<{ online: boolean }> }>("/app/me")).machines.some(row => row.online), 45_000);
    const session = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await opened.client.call({ type: "session.rename", payload: { sessionId: session, title: "Feedback recovery conversation" } });
    const machine = opened.client.identity!.machineId;
    browser = await openBrowser({ viewport: { width: 1280, height: 900 } }, { trace: false });
    await browser.context.addCookies((account.cookie() ?? "").split(";").flatMap(part => {
      const at = part.indexOf("="); return at < 1 ? [] : [{ name: part.slice(0, at).trim(), value: part.slice(at + 1), url: hub.origin, httpOnly: true, sameSite: "Lax" as const }];
    }));
    const page = browser.page;
    const conversationUrl = `${hub.origin}/d/${machine}/w/${opened.workspaceId}/s/${session}`;
    await page.goto(conversationUrl);
    await page.getByRole("heading", { name: "Feedback recovery conversation", exact: true }).waitFor();
    // Real previous-log bytes exercise the public log.tail transport and the
    // UTF-8 recovery bound. This encoding fixture does not fake a fault event
    // or claim that a natural rotation happened during this short scenario.
    writeFileSync(join(t.env.data, "logs/daemon.log.1"), "界".repeat(30_000));
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "反馈问题", exact: true }).click();
    await page.getByLabel("问题描述", { exact: true }).fill("A real stalled connection should retain its diagnostic evidence");
    pid = daemonEndpoint(opened.daemon).localServerProof.pid;
    process.kill(pid, "SIGSTOP"); paused = true;
    const receipt = page.waitForResponse(response => new URL(response.url()).pathname === "/app/feedback" && response.request().method() === "POST");
    const start = performance.now();
    await page.getByRole("button", { name: "提交反馈", exact: true }).click();
    const response = await receipt;
    t.assertions.assert(response.status() === 201 && performance.now() - start < 8_000, "feedback submission was blocked by stalled log collection");
    const { id } = await response.json() as { id: string };
    const submitted = response.request().postDataJSON() as { diagnostics: { machineId?: string; machineLogs?: unknown[] } };
    t.assertions.assert(submitted.diagnostics.machineId === machine && !submitted.diagnostics.machineLogs?.length, "initial report did not identify the unavailable original machine");
    await t.tools.waitUntil(async () => page.evaluate(() => !!localStorage.getItem("genehub.feedback.log-recovery.v1")), 5_000);
    const queue = await page.evaluate(() => localStorage.getItem("genehub.feedback.log-recovery.v1"));
    t.assertions.assert(!!queue && queue.includes(id) && !queue.includes("text") && !queue.includes("cookie"), "recovery queue was missing or persisted log/credential content");
    await page.goto(conversationUrl, { waitUntil: "domcontentloaded" });
    process.kill(pid, "SIGCONT"); paused = false;
    await page.getByRole("heading", { name: "Feedback recovery conversation", exact: true }).waitFor({ timeout: 45_000 });
    const read = () => JSON.parse(execFileSync(process.env.GENEHUB_PYTHON!, ["-c",
      "import sqlite3,json,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nr=c.execute('SELECT diagnostics_json FROM feedback_reports WHERE id=?',(sys.argv[2],)).fetchone()\nd=json.loads(r[0]) if r else {}\nv=d.get('machineLogRecovery',{})\nprint(json.dumps({'reports':c.execute('SELECT COUNT(*) FROM feedback_reports').fetchone()[0],'machineId':v.get('machineId'),'logs':[{'name':x['name'],'bytes':len(x['text'].encode()),'truncated':x['truncated'],'replacement':chr(65533) in x['text']} for x in v.get('logs',[])]}))",
      database, id], { encoding: "utf8" })) as { reports: number; machineId?: string; logs: Array<{ name: string; bytes: number; truncated: boolean; replacement: boolean }> };
    await t.tools.waitUntil(() => read().logs.length > 0, 45_000);
    const recovered = read();
    t.assertions.assert(recovered.reports === 1 && recovered.machineId === machine && recovered.logs.every(log => log.bytes > 0 && log.bytes <= 65_536), "recovery duplicated the report, changed machine or exceeded evidence bounds");
    t.assertions.assert(recovered.logs.some(log => log.name === "daemon.log.1" && log.truncated && !log.replacement), "previous Unicode log tail split a code point or lost truncation evidence");
    await t.tools.waitUntil(async () => page.evaluate(() => !localStorage.getItem("genehub.feedback.log-recovery.v1")), 5_000);
    t.note("Real Console + Hub + Relay + signed Wasm Host: feedback submitted during SIGSTOP; reload retained metadata; SIGCONT restored conversation and attached bounded original-machine logs to one receipt");
  } finally {
    if (paused) { try { process.kill(pid, "SIGCONT"); } catch { /* owned process already gone */ } }
    await browser?.close();
    if (opened) { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
    relay?.stop(); await hub.stop();
  }
});
