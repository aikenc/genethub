import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {defineSpecialty, daemonEndpoint, openWorkbenchPage} from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.cross-entry-storage",
  title: "Opening the same app from chat and from a sibling board retains its saved records",
  oracle: "A record saved through the chat link remains visible through a sibling board; child pages share the app store, another sibling app remains independent, and Preview history restores each app's own store",
  catches: ["navigation carries the board storage namespace into another app", "every child page gets a new namespace", "history restores a file with another app's storage", "a project-wide store mixes sibling apps"],
  tags: ["page-experience", "machine-preview", "storage"], runner: "playwright", llm: {default: "mock"},
  expectedDurationMs: 45000, timeoutMs: 180000,
  resources: {environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 1, pool: "browser"},
  surfaces: ["workbench-ui", "asset-preview", "daemon", "agent"],
  productInterfaces: ["@genehub/workbench", "session.send", "asset.preview"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({openRoot: t.openRoot, lease: t.env});
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    for (const dir of ["board", "app/pages", "other"])
      await mkdir(path.join(opened.workspaceRoot, dir), {recursive: true});
    const store = `<p id="records"></p><button id="save">Save record</button><script>
      const read=()=>localStorage.getItem('records')||'0';
      const show=()=>document.getElementById('records').textContent=read();show();
      document.getElementById('save').onclick=()=>{localStorage.setItem('records',String(Number(read())+1));show();};</script>`;
    await writeFile(path.join(opened.workspaceRoot, "app/index.html"), `<!doctype html><h1>Signup app</h1>${store}<a href="pages/details.html">Details</a><a href="../other/index.html">Other app</a>`);
    await writeFile(path.join(opened.workspaceRoot, "app/pages/details.html"), `<!doctype html><h1>Signup details</h1>${store}<a href="/index.html">App home</a>`);
    await writeFile(path.join(opened.workspaceRoot, "other/index.html"), `<!doctype html><h1>Independent app</h1>${store}<a href="../app/index.html">Return to signup</a>`);
    await writeFile(path.join(opened.workspaceRoot, "board/index.html"), '<!doctype html><h1>Team board</h1><a href="../app/index.html">Enter signup</a>');
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    opened.mock.script({text: "[Signup entry](app/index.html)\n\n[Team board](board/index.html)"});
    const session = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, session, "Deliver the signup app and board");
    await t.tools.waitUntil(async () => {
      const r = await opened.client.call({type:"session.get",payload:{sessionId:session}});
      return r?.type === "snapshot" && !!r.data.summary.latestReply && r.data.summary.status === "idle";
    }, 30000);
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, session);
    const page = browser.page;
    const frame = () => page.frameLocator('iframe[title="HTML 文件预览"]');
    const count = async (expected: string) => t.tools.waitUntil(async () => await frame().locator('#records').textContent() === expected, 10000).catch(async () => {
      throw new Error(`Saved records: expected ${expected}, saw ${await frame().locator('#records').textContent()} at ${await frame().getByRole('heading').innerText()}`);
    });
    await page.getByRole('link', {name:'Signup entry',exact:true}).last().click();
    await count('0');
    await frame().getByRole('button',{name:'Save record',exact:true}).click();
    await count('1');
    await frame().getByRole('link',{name:'Details',exact:true}).click();
    await count('1');
    await frame().getByRole('link',{name:'App home',exact:true}).click();
    await frame().getByRole('heading',{name:'Signup app',exact:true}).waitFor();
    await count('1');
    await page.getByRole('button',{name:'关闭预览',exact:true}).click();
    await page.getByRole('link',{name:'Team board',exact:true}).last().click();
    await frame().getByRole('link',{name:'Enter signup',exact:true}).click();
    await count('1');
    await frame().getByRole('link',{name:'Other app',exact:true}).click();
    await count('0');
    await frame().getByRole('button',{name:'Save record',exact:true}).click();
    await count('1');
    await frame().getByRole('button',{name:'Save record',exact:true}).click();
    await count('2');
    await frame().getByRole('link',{name:'Return to signup',exact:true}).click();
    await count('1');
    await page.getByRole('button',{name:'后退',exact:true}).click();
    await frame().getByRole('heading',{name:'Independent app',exact:true}).waitFor();
    await count('2');
    await page.getByRole('button',{name:'前进',exact:true}).click();
    await frame().getByRole('heading',{name:'Signup app',exact:true}).waitFor();
    await count('1');
    t.note('Real WASI and built workbench public consumer; all saved data created via actual page buttons, no storage injection.');
  } finally {
    await browser?.close();opened.client.close();opened.daemon.stop();await opened.mock.stop();
  }
});
