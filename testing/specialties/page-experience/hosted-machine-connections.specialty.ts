import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
    // A project explicitly composes an identically named local/remote Space.
    // The actual owning daemon remains the independent oracle for navigation.
    const childRoot=join(a.workspaceRoot,"spaces","shared"); mkdirSync(childRoot,{recursive:true});
    writeFileSync(join(childRoot,"agent-space.genet.json"),JSON.stringify({name:"共享验证",folders:[{path:"."}]}));
    const child=await a.client.call({type:"workspace.open",payload:{root:childRoot}});
    if(child?.type!=="workspace")throw new Error("local Space missing");
    await a.client.call({type:"agentSpace.configure",payload:{workspaceId:a.workspaceId,expectedRevision:0,operation:{kind:"setLifecycle",lifecycle:"persistent"}}});
    await a.client.call({type:"agentSpace.configure",payload:{workspaceId:child.data.id,expectedRevision:0,operation:{kind:"setParent",parentWorkspaceId:a.workspaceId}}});
    const local=await t.flows.main.createBuiltinSession(a.client,child.data.id);
    await a.client.call({type:"session.rename",payload:{sessionId:local,title:"Local same-name Space"}});
    await b.client.call({type:"workspace.rename",payload:{workspaceId:b.workspaceId,name:"共享验证"}});
    writeFileSync(join(a.workspaceRoot,"agent-space.genet.json"),JSON.stringify({name:"Hosted A project",folders:[{path:"."}],members:[
      {machineId:b.client.identity!.machineId,workspaceId:b.workspaceId,name:"共享验证"},
      {machineId:"m_unavailable",workspaceId:"w_unknown",name:"离线岗位"},
    ]}));
    // An in-place edit from outside the daemon reaches the unscoped catalog
    // within its 30s cold look, not on the next call.
    await t.tools.waitUntil(async()=>{
      const catalog=await a!.client.call({type:"workspace.list"});
      return catalog?.type==="workspaces"&&catalog.data.find(w=>w.id===a!.workspaceId)?.agentSpace?.members?.[0]?.workspaceId===b!.workspaceId;
    },35_000).catch(()=>{throw new Error("descriptor references were not projected through workspace.list within 35s");});
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
    const group=list.getByRole("region",{name:"项目 Hosted A project",exact:true});
    await group.getByRole("button",{name:/Hosted A session/}).waitFor();
    t.assertions.assert(await group.getByRole("button",{name:/Hosted B session/}).count()===0,"remote internal session expanded by default");
    await group.getByRole("button",{name:/团队内部.*3 个 Space/}).click();
    const spaceFilter=group.getByRole("button",{name:"Hosted A project Space 筛选",exact:true});
    await spaceFilter.click();
    const chooser=page.getByRole("listbox",{name:"Hosted A project Space 筛选",exact:true});
    await chooser.getByRole("option",{name:/共享验证.*Hosted A/}).waitFor();
    await chooser.getByRole("option",{name:/共享验证.*Hosted B/}).waitFor();
    await chooser.getByRole("option",{name:/离线岗位.*状态未知/}).waitFor();
    t.assertions.assert(await page.getByRole("combobox",{name:"搜索Space或机器",exact:true}).count()===0,"Space chooser unexpectedly opened search");
    t.assertions.assert(await chooser.getByRole("option").count()===4,"source-labelled options are not directly available");
    await chooser.getByRole("option",{name:/共享验证.*Hosted B/}).click();
    await group.getByRole("button",{name:/Hosted B session/}).waitFor();
    t.assertions.assert(await group.getByRole("button",{name:/Local same-name Space/}).count()===0,"selected remote Space leaked a local sibling");
    t.assertions.assert(await group.getByRole("button",{name:/Hosted A session/}).isEnabled(),"Space loading disabled the front conversation");
    await list.getByRole("button", { name: "机器筛选", exact: true }).click();
    await list.getByRole("menuitemradio", { name: /全部机器.*2\/2 在线/ }).waitFor();
    await page.keyboard.press("Escape");
    await list.getByRole("button",{name:"机器筛选",exact:true}).click();
    await list.getByRole("menuitemradio",{name:/Hosted B.*在线/}).click();
    await group.getByRole("button",{name:/Hosted B session/}).waitFor();
    t.assertions.assert(await group.getByRole("button",{name:/Hosted A session/}).count()===0,"machine filter retained a front on the other machine");
    await list.getByRole("button",{name:"机器筛选",exact:true}).click();
    await list.getByRole("menuitemradio",{name:/全部机器/}).click();
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
