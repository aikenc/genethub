import {mkdir, writeFile, readFile} from "node:fs/promises";
import path from "node:path";
import {defineSpecialty, daemonEndpoint, openBrowser, openPreviewBrowser} from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.machine-preview-navigation",
  title: "Secondary links and runtime reads work inside a real opaque Preview iframe",
  oracle: "A real browser loads relative data and secondary documents, preserves query/history, runs local form submit handlers through button and Enter, and blocks external form submission",
  catches: ["parent base-uri rejects virtual origin", "runtime URL normalization loses ..", "XHR bypasses the file bridge", "standalone Markdown opens an unmounted float", "query becomes a filename", "HTML-only navigation filter discards other file types", "opaque iframe blocks local form submit handlers before JavaScript can cancel navigation", "form action escapes the Preview CSP"],
  tags: ["page-experience", "machine-preview", "filesystem"], runner: "playwright", llm: {default: "none"},
  expectedDurationMs: 40_000, timeoutMs: 150_000,
  resources: {environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 1, pool: "browser"},
  requiredRepos: ["cloud"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["workbench-ui", "asset-preview", "daemon", "cloud-csp"],
  productInterfaces: ["@genehub/workbench", "asset.preview"],
}, async t => {
  const site = path.join(t.env.workspace, "site");
  const pages = path.join(site, "pages");
  await mkdir(pages, {recursive: true});
  await mkdir(path.join(site, "scripts"));
  await mkdir(path.join(site, "scripts#part"));
  await mkdir(path.join(pages, "deep"));
  await writeFile(path.join(pages, "root.json"), '{"label":"initial site root"}');
  await writeFile(path.join(site, "data.json"), '{"label":"parent directory bytes"}');
  await writeFile(path.join(site, "data#?%.json"), '{"label":"literal encoded bytes"}');
  await writeFile(path.join(site, "scripts#part", "module?.js"), 'fetch(new URL("../data%23%3F%25.json", import.meta.url)).then(r=>r.json()).then(x=>document.getElementById("encoded-module").textContent=x.label);');
  await writeFile(path.join(site, "scripts", "module.js"), 'fetch(new URL("../data.json", import.meta.url)).then(r=>r.json()).then(x=>document.getElementById("module").textContent=x.label);');
  await writeFile(path.join(pages, "start.html"), `<!doctype html><html><head><title>Nested entry</title></head><body>
    <h1>Start</h1><p id="fetch"></p><p id="xhr"></p><p id="module"></p><p id="encoded-module"></p><p id="missing"></p><p id="head"></p><p id="abort"></p>
    <form id="tasks"><input aria-label="Task title" required><button>Add task</button></form><ul id="task-list"></ul>
    <form action="https://must-not-submit.invalid/preview-form" method="post"><button>Submit externally</button></form>
    <a href="deep/next.html?view=wide#anchor">Second page</a><a href="missing.md">Missing document</a>
    <script type="module" src="../scripts/module.js"></script><script type="module" src="../scripts%23part/module%3F.js"></script><script>
    document.getElementById("tasks").addEventListener("submit",function(event){event.preventDefault();const input=this.querySelector("input");const item=document.createElement("li");item.textContent=input.value;document.getElementById("task-list").appendChild(item);input.value="";});
    fetch("../data.json").then(r=>r.json()).then(x=>document.getElementById("fetch").textContent=x.label);
    const xhr=new XMLHttpRequest();xhr.open("GET","../data.json");xhr.responseType="json";xhr.onload=()=>document.getElementById("xhr").textContent=xhr.response.label;xhr.send();
    const missing=new XMLHttpRequest();missing.open("GET","absent.json");missing.onload=()=>document.getElementById("missing").textContent=String(missing.status);missing.send();
    fetch("../data.json",{method:"HEAD"}).then(async r=>document.getElementById("head").textContent=r.status+":"+(await r.text()).length);
    const aborted=new XMLHttpRequest();aborted.open("GET","../data.json");aborted.onabort=()=>document.getElementById("abort").textContent="aborted";aborted.send();aborted.abort();
    </script></body></html>`);
  await writeFile(path.join(pages, "deep", "next.html"), '<!doctype html><html><head><title>Second</title></head><body><div style="height:1200px"></div><h1 id="anchor">Second page target</h1><p id="query"></p><p id="root-data"></p><a href="../guide.md?mode=read#install">Read guide</a><script>fetch("/root.json").then(r=>r.json()).then(x=>document.getElementById("root-data").textContent=x.label);document.getElementById("query").textContent=window.genehubPreviewLocation.search;</script></body></html>');
  await writeFile(path.join(pages, "guide.md"), '# Guide\n\n[Jump to install](#install)\n\n[Open source](source%20file.txt?view=raw#target)\n\n' + Array.from({length: 40}, (_, i) => `Paragraph ${i}.\n\n`).join("") + '## Install\n\nInstallation target.\n');
  await writeFile(path.join(pages, "source file.txt"), 'source file target');
  const opened = await t.flows.main.openWorkspace({openRoot: t.openRoot, lease: t.env});
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  let consumer: Awaited<ReturnType<typeof openPreviewBrowser>> | undefined;
  try {
    const caddy = await readFile(path.join(process.env.TESTCTL_CLOUD_ROOT!, "deploy/Caddyfile"), "utf8");
    const workbenchPolicy = caddy.split("\n").find(line => line.trim().startsWith("header @workbench Content-Security-Policy"))?.match(/"([^"]+)"/)?.[1];
    t.assertions.assert(Boolean(workbenchPolicy), "deployed workbench policy unavailable");
    browser = await openBrowser({}, {trace: false});
    const page = browser.page;
    const escaped: string[] = [];
    const formRequests: string[] = [];
    page.on("request", request => {if(request.url().includes("must-not-submit.invalid"))formRequests.push(request.url());});
    page.on("request", request => { if (/\/(?:data\.json|absent\.json|missing\.md)(?:[?#]|$)/.test(request.url()) && !request.url().includes("preview.invalid")) escaped.push(request.url()); });
    const endpoint = daemonEndpoint(opened.daemon);
    const testPolicy = workbenchPolicy!.replace("connect-src 'self'", `connect-src 'self' ${new URL(endpoint.url).origin}`);
    consumer = await openPreviewBrowser({openRoot: t.openRoot, lease: t.env, page, endpoint, workspaceId: "", entryPath: path.join(pages, "start.html"), contentSecurityPolicy: testPolicy});
    const frame = () => page.frameLocator('iframe[title="HTML 文件预览"]');
    for (const id of ["fetch", "xhr", "module"]) {
      await t.tools.waitUntil(async () => await frame().locator(`#${id}`).textContent() === "parent directory bytes", 20_000).catch(() => { throw new Error(`Runtime ${id} failed: ${consumer!.errors.join("; ")}`); });
    }
    await t.tools.waitUntil(async () => await frame().locator("#encoded-module").textContent() === "literal encoded bytes", 20_000).catch(async () => { throw new Error(`Encoded module failed: value=${await frame().locator("#encoded-module").textContent()} errors=${consumer!.errors.join("; ")} scripts=${(await frame().locator('script[type="module"]').allTextContents()).join("; ").slice(0, 1800)}`); });
    await t.tools.waitUntil(async () => await frame().locator("#missing").textContent() === "404", 15_000);
    await t.tools.waitUntil(async () => await frame().locator("#head").textContent() === "200:0", 15_000);
    await t.tools.waitUntil(async () => await frame().locator("#abort").textContent() === "aborted", 15_000);
    await frame().getByRole("textbox", {name: "Task title"}).fill("Button-created task");
    await frame().getByRole("button", {name: "Add task", exact: true}).click();
    await t.tools.waitUntil(async () => await frame().locator("#task-list li").count() === 1, 5_000);
    await frame().getByRole("textbox", {name: "Task title"}).fill("Enter-created task");
    await frame().getByRole("textbox", {name: "Task title"}).press("Enter");
    await t.tools.waitUntil(async () => await frame().locator("#task-list li").count() === 2, 5_000);
    t.assertions.assert((await frame().locator("#task-list li").allTextContents()).join("|") === "Button-created task|Enter-created task", "form handlers did not add the entered tasks");
    await frame().getByRole("button", {name: "Add task", exact: true}).click();
    t.assertions.assert(await frame().locator("#task-list li").count() === 2, "empty required title submitted");
    await frame().getByRole("link", {name: "Missing document"}).click();
    await page.getByRole("alert").first().waitFor();
    t.assertions.assert(Boolean((await page.getByRole("alert").first().textContent())?.trim()), "missing document error was not visible");
    await frame().getByRole("link", {name: "Second page", exact: true}).click();
    await frame().getByRole("heading", {name: "Second page target"}).waitFor();
    await frame().locator("#root-data").getByText("initial site root").waitFor();
    t.assertions.assert(await frame().locator("#query").textContent() === "?view=wide", "document query was lost or entered the filename");
    await frame().getByRole("link", {name: "Read guide"}).click();
    await page.getByRole("heading", {name: "Install", exact: true}).waitFor();
    const windows = browser.context.pages().length;
    await page.getByRole("link", {name: "Jump to install", exact: true}).click();
    await t.tools.waitUntil(async () => await page.getByRole("heading", {name: "Install", exact: true}).evaluate(node => {const r=node.getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight;}), 5000);
    t.assertions.assert(browser.context.pages().length === windows, "Markdown anchor opened a new window");
    await page.getByRole("status").filter({hasText: "页面参数：?mode=read"}).waitFor();
    await page.getByRole("link", {name: "Open source"}).click();
    await page.getByText("source file target", {exact: true}).waitFor();
    await page.getByRole("button", {name: "后退", exact: true}).click();
    await page.getByRole("heading", {name: "Guide", exact: true}).waitFor();
    await page.getByRole("button", {name: "后退", exact: true}).click();
    await page.getByRole("heading", {name: "Guide", exact: true}).waitFor();
    await page.getByRole("button", {name: "后退", exact: true}).click();
    await frame().getByRole("heading", {name: "Second page target"}).waitFor();
    t.assertions.assert(escaped.length === 0, "local file requests escaped to the Cloud origin");
    t.assertions.assert(!consumer.errors.some(error => /base-uri|SyntaxError|Unexpected token/.test(error)), `runtime failed under parent policy: ${consumer.errors.join("; ")}`);
    await page.getByRole("button", {name: "后退", exact: true}).click();
    await frame().getByRole("heading", {name: "Start", exact: true}).waitFor();
    await frame().getByRole("button", {name: "Submit externally", exact: true}).click();
    // A blocked navigation may replace Chromium's iframe with an error document.
    // Assert the browser's policy violation and the absence of outgoing requests.
    await t.tools.waitUntil(() => consumer!.errors.some(error => error.includes("form-action 'none'") && error.includes("request has been blocked")), 5_000);
    t.assertions.assert(formRequests.length === 0, "a form request escaped the Preview policy");
    t.note("Actual local WASI plus Chromium, deployed workbench CSP, opaque iframe, local form button/Enter/required validation with blocked external submission, fetch/XHR/module/HEAD/abort, visible missing file, query/anchor, HTML→Markdown→text and history.");
  } finally { await consumer?.close(); await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
