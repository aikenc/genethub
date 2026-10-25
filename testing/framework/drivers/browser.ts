import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { BrowserContextOptions } from "playwright";
import type { Target } from "@genehub/workbench/client";
import type { DaemonEndpoint } from "./daemon.ts";
import { BlockedError } from "../../infrastructure/public.ts";

export async function openBrowser(options: BrowserContextOptions = {}, evidence: { trace?: boolean } = {}) {
  if (process.env.TESTCTL_BROWSER_SELECTED !== "1") throw new BlockedError("Select a Playwright case to use the browser fixture");
  const { chromium } = await import("playwright");
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) { throw new BlockedError(`Playwright Chromium is unavailable: ${String(error)}`); }
  const context = await browser.newContext(options);
  const artifacts = process.env.TESTCTL_BROWSER_ARTIFACTS;
  if (artifacts) mkdirSync(artifacts, { recursive: true });
  if (evidence.trace !== false) await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  return { page, context, async close() {
    try { if (evidence.trace !== false) await context.tracing.stop(artifacts ? { path: path.join(artifacts, "trace.zip") } : undefined); }
    finally { await browser.close(); }
  } };
}

/** Mount the public embedding entry against the real authenticated endpoint.
 * Vite is the product build pipeline; no private store or UI implementation
 * is imported or replaced by a test double. */
export async function openWorkbenchPage(openRoot: string, getEndpoint: () => DaemonEndpoint, workspaceId: string, sessionId: string, options: BrowserContextOptions = {}, evidence: { trace?: boolean } = {}, catalog?: { targets(): Target[]; endpoint(id:string): DaemonEndpoint }) {
  const endpoint = getEndpoint();
  const require = createRequire(path.join(openRoot, "packages/workbench/package.json"));
  const vite = await import(pathToFileURL(require.resolve("vite")).href);
  const root = path.join(openRoot, "packages/workbench");
  const originalCwd = process.cwd();
  // The product's Tailwind/PostCSS configuration resolves content from its
  // package cwd, exactly as npm run dev does. Each case has its own process.
  process.chdir(root);
  const entry = require.resolve("@genehub/workbench");
  const script = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {App, parseAssetPreviewPath, parsePreviewPopout, PreviewPopoutPage, watchPreviewConnectionFragment} from ${JSON.stringify(entry)}; import '@genehub/workbench/theme.css';
const host = {kind:'browser', endpoint:async()=>{const e=await (await fetch('/__test_endpoint')).json();return {...e,via:'loopback',label:e.label??'Browser test machine'};}, notify:()=>{}, openExternal:()=>{}};
${catalog ? `host.targets=async()=>await (await fetch('/__test_targets')).json();host.openTarget=async(id)=>{const r=await fetch('/__test_source?id='+encodeURIComponent(id));if(!r.ok)throw Object.assign(new Error('source unavailable'),{status:r.status});return {...await r.json(),via:'loopback'};};` : ""}
const source = parseAssetPreviewPath(window.location.pathname);
if (source) watchPreviewConnectionFragment();
// The popout must inherit the opener's authenticated client through the real
// public bridge. Giving it the fixture host would hide a broken bridge.
const page = source ? React.createElement(PreviewPopoutPage,{source,context:parsePreviewPopout(window.location.search,window.location.hash)}) : React.createElement(App,{host});
createRoot(document.getElementById('root')).render(${catalog ? 'React.createElement(React.StrictMode,null,page)' : 'page'});`;
  const server = await vite.createServer({
    root, configFile: path.join(root, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, open: false },
    plugins: [{
      name: "test-public-workbench-embed",
      configureServer(server: { middlewares: { use(handler: (request: { url?: string }, response: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void }, next: () => void) => void): void } }) {
        server.middlewares.use((request, response, next) => {
          if (catalog && request.url === "/__test_targets") {
            response.setHeader("Content-Type", "application/json"); response.setHeader("Cache-Control", "no-store");
            response.end(JSON.stringify(catalog.targets())); return;
          }
          if (catalog && request.url?.startsWith("/__test_source?")) {
            response.setHeader("Content-Type", "application/json"); response.setHeader("Cache-Control", "no-store");
            try {
              const id=new URL(request.url,"http://localhost").searchParams.get("id")??"";
              const target=catalog.targets().find(t=>t.id===id); if(!target)throw new Error("unknown source");
              response.end(JSON.stringify({...catalog.endpoint(id),label:target.label}));
            } catch { response.statusCode=503;response.end(JSON.stringify({error:"source_unavailable"})); }
            return;
          }
          if (request.url !== "/__test_endpoint") return next();
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Cache-Control", "no-store");
          const current=getEndpoint();
          response.end(JSON.stringify({...current,...(catalog ? {label:catalog.targets().find(t=>t.deviceHandle===current.localServerProof.machineId||t.id===current.localServerProof.machineId)?.label} : {})}));
        });
      },
      transformIndexHtml(html: string) { return html.replace('src="/src/main.tsx"', 'src="/__test_workbench.ts"'); },
      resolveId(id: string) { if (id === "/__test_workbench.ts") return "\0test-workbench"; },
      load(id: string) { if (id === "\0test-workbench") return script; },
    }],
  });
  try {
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error("Vite did not expose the public Workbench");
    const browser = await openBrowser(options, evidence);
    try {
      const route = `d/${encodeURIComponent(endpoint.localServerProof.machineId)}/w/${encodeURIComponent(workspaceId)}/s/${encodeURIComponent(sessionId)}`;
      await browser.page.goto(url + route, {waitUntil: "domcontentloaded", timeout: 45_000});
      return { ...browser, async close() { try { await browser.close(); } finally { await server.close(); process.chdir(originalCwd); } } };
    } catch (error) { await browser.close(); throw error; }
  } catch (error) { await server.close(); process.chdir(originalCwd); throw error; }
}
