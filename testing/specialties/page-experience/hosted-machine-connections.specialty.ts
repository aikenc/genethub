import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { allocatePort, createLease, releaseLease, defineSpecialty, openBrowser, startHub, startRelay } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.hosted-machine-connections",
  title: "The actual signed-in Console keeps the shared machine pool across navigation",
  oracle: "Two native daemons enroll through real Hub pairing; the built Console opens both sources without additional connect requests on a conversation jump, then reloads the selected remote conversation correctly",
  catches: ["Console reconstructs Host on every address change", "a remote jump remints connection tickets", "reload returns to the initial machine"],
  tags: ["machine-connections", "page-experience", "cloud-console"], runner: "playwright", requiredRepos: ["cloud"], llm: { default: "none" },
  expectedDurationMs: 75_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 3, memoryMb: 3072, browser: 1, io: 1, pool: "browser" },
  surfaces: ["cloud-console", "cloud-server", "relay", "daemon", "workbench-ui"],
  productInterfaces: ["@genehub/workbench", "hub.pair", "hub-http", "session.page"],
}, async t => {
  const other = createLease("hosted-machine-");
  const cloud = process.env.TESTCTL_CLOUD_ROOT!;
  const consoleDir = join(t.env.root, "console"), consoleRoot = join(cloud, "console");
  await promisify(execFile)(process.execPath, [join(consoleRoot, "node_modules/vite/bin/vite.js"), "build", "--base", "/", "--outDir", consoleDir],
    { cwd: consoleRoot, env: { ...process.env, VITE_GENEHUB_SUBPATH: "" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const port = await allocatePort(), token = randomBytes(24).toString("hex");
  const hub = await startHub({ databasePath: join(t.env.root, "hosted.sqlite"), relayOrigin: `http://127.0.0.1:${port}`, relayToken: token, consoleDir });
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  let a: Awaited<ReturnType<typeof t.flows.main.openWorkspace>> | undefined, b: typeof a;
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  let phase="bootstrap";
  try {
    relay = await startRelay({ openRoot: t.openRoot, port, control: { origin: hub.origin, token } });
    t.env.env.GENEHUB_LOCAL_HUB_URL = hub.origin; other.env.GENEHUB_LOCAL_HUB_URL = hub.origin;
    a = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    b = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: other });
    const account = hub.browser(); await hub.signInOwner(account);
    for (const [opened, title] of [[a,"Hosted A"],[b,"Hosted B"]] as const) {
      const pairing = await opened.client.call({ type: "hub.pair", payload: { hubUrl: hub.origin, displayName: title } });
      if (pairing?.type !== "hubStatus" || pairing.data.state !== "pairing") throw new Error("pairing did not start");
      await hub.approvePairing(account, pairing.data.userCode);
    }
    await t.tools.waitUntil(async () => {
      const me = await account.json<{ machines: { online: boolean }[] }>("/app/me");
      return me.machines.filter(machine => machine.online).length === 2;
    }, 45_000);
    const first = await t.flows.main.createBuiltinSession(a.client, a.workspaceId), second = await t.flows.main.createBuiltinSession(b.client, b.workspaceId);
    for (const [opened, id, title] of [[a, first, "Hosted A"], [b, second, "Hosted B"]] as const) {
      await opened.client.call({ type: "session.rename", payload: { sessionId: id, title: `${title} session` } });
      await opened.client.call({ type: "workspace.rename", payload: { workspaceId: opened.workspaceId, name: `${title} project` } });
    }
    browser = await openBrowser({ viewport: { width: 1280, height: 900 } }, { trace: false });
    const cookies = (account.cookie() ?? "").split(";").map(part => {
      const at = part.indexOf("="); return { name: part.slice(0,at).trim(), value: part.slice(at+1), url: hub.origin, httpOnly: true, sameSite: "Lax" as const };
    }).filter(cookie => cookie.name);
    await browser.context.addCookies(cookies);
    const page = browser.page; let connects = 0;
    page.on("pageerror", error => t.note(`Browser error: ${error.message}`));
    page.on("request", request => { if (request.method() === "POST" && /\/app\/machines\/[^/]+\/connect$/.test(new URL(request.url()).pathname)) connects++; });
    await page.goto(`${hub.origin}/d/${a.client.identity!.machineId}/w/${a.workspaceId}/s/${first}`);
    await page.getByRole("heading", { name: "Hosted A session", exact: true }).waitFor();
    const list = page.getByRole("complementary", { name: "会话列表", exact: true });
    await list.getByRole("combobox", { name: "机器筛选" }).getByRole("option", { name: /全部机器 · 2\/2 在线/ }).waitFor({ state: "attached" });
    const beforeJump = connects;
    phase="jump";
    await list.getByRole("button", { name: /Hosted B session/ }).click();
    await page.getByRole("heading", { name: "Hosted B session", exact: true }).waitFor();
    t.assertions.assert(connects === beforeJump, `Console rebuilt or reminted on a pooled jump: ${beforeJump} -> ${connects}`);
    await page.waitForURL(url=>url.pathname.includes(b!.client.identity!.machineId.slice(2,10)) && url.pathname.includes(second.slice(2,10)));
    phase="reload";
    await page.reload();
    await page.getByRole("heading", { name: "Hosted B session", exact: true }).waitFor();
    t.assertions.assert(page.url().includes(b.client.identity!.machineId.slice(2,10)), "reload did not preserve the selected source URL");
    t.note(JSON.stringify({ signedInSources: 2, connectRequestsBeforeJump: beforeJump, connectRequestsAfterJump: beforeJump, remoteReload: true }));
  } catch (error) {
    if (browser) t.note(`Hosted ${phase} failure: ${await browser.page.locator("body").innerText().then(text=>text.slice(-5000)).catch(()=>"unavailable")}`);
    throw error;
  } finally {
    await browser?.close();
    for (const opened of [a,b]) if (opened) { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
    relay?.stop(); await hub.stop(); releaseLease(other);
  }
});
