import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { Page } from "playwright";
import type { EnvironmentLease } from "../../infrastructure/public.ts";
import type { DaemonEndpoint } from "./daemon.ts";

/** Real package consumer, compiled by the product's Vite installation. No UI
 * replacements: AssetPreviewPage owns its normal iframe, bridge and media UI. */
export async function openPreviewBrowser(input: {
  openRoot: string;
  lease: EnvironmentLease;
  page: Page;
  endpoint: DaemonEndpoint;
  refreshEndpoint?: () => DaemonEndpoint;
  workspaceId: string;
  entryPath: string;
  surface?: "preview" | "processes" | "client-debug";
}) {
  const errors: string[] = [];
  input.page.on("pageerror", (error) => {
    if (errors.length < 8) errors.push(error.message);
  });
  input.page.on("console", (message) => {
    if (message.type() === "error" && errors.length < 8)
      errors.push(message.text().slice(0, 500));
  });
  const require = createRequire(
    join(input.openRoot, "packages/workbench/package.json"),
  );
  const testingRequire = createRequire(
    join(input.openRoot, "testing/package.json"),
  );
  const vite = await import(pathToFileURL(require.resolve("vite")).href);
  const root = join(input.lease.root, `browser-consumer-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><div id="root">Loading browser consumer</div><script type="module" src="/consumer.tsx"></script>',
  );
  await writeFile(
    join(root, "consumer.tsx"),
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {App,AssetPreviewPage,Client,browserHost,useWorkbench,configureClientDebugHost} from '@genehub/workbench';
const input=await window.previewInput();
if(input.surface==='client-debug'){
 configureClientDebugHost({...browserHost(),targets:async()=>[{id:'coordinator',label:'Test coordinator',kind:'local'}],openTarget:async()=>({...((await window.previewInput()).endpoint),via:'loopback',label:'Test coordinator'})});
 document.getElementById('root').innerHTML='<h1>Client debug consumer</h1><input aria-label="Debug input"><p id="marker">original</p>';
}else if(input.surface==='processes'){
 const host={...browserHost(),endpoint:async()=>({...input.endpoint,via:'lan'})};
 createRoot(document.getElementById('root')).render(<App host={host}/>);
 while(useWorkbench.getState().connection!=='ready'||!useWorkbench.getState().workspaces.length)await new Promise(r=>setTimeout(r,50));
 await useWorkbench.getState().selectWorkspace(input.workspaceId);
 useWorkbench.getState().openTab('processes');
}else{
 const client=new Client({...input.endpoint,rtcEnabled:false});client.connect();
 while(client.connectionState!=='ready'){document.getElementById('root').textContent='Client: '+client.connectionState+' '+(client.failure?.message??'');if(client.connectionState==='closed')throw new Error('Client closed');await new Promise(r=>setTimeout(r,50));}
 createRoot(document.getElementById('root')).render(<AssetPreviewPage client={client} source={{deviceHandle:client.identity.machineId,workspaceHandle:input.workspaceId,path:input.entryPath}}/>);
}
`,
  );
  const server = await vite.createServer({
    configFile: false,
    root,
    logLevel: "error",
    esbuild: { jsx: "automatic" },
    resolve: {
      alias: [
        {
          find: "@genehub/workbench",
          replacement: testingRequire.resolve("@genehub/workbench"),
        },
        {
          find: "react-dom/client",
          replacement: require.resolve("react-dom/client"),
        },
        {
          find: "react/jsx-runtime",
          replacement: require.resolve("react/jsx-runtime"),
        },
        {
          find: "react/jsx-dev-runtime",
          replacement: require.resolve("react/jsx-dev-runtime"),
        },
        { find: /^react$/, replacement: require.resolve("react") },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 0,
      fs: { allow: [root, input.openRoot] },
    },
  });
  await server.listen();
  input.page.on("response", (response) => {
    if (response.status() >= 400)
      void response
        .text()
        .then((text) => {
          if (errors.length < 8) errors.push(text.slice(0, 1500));
        })
        .catch(() => {});
  });
  await input.page.exposeFunction("previewInput", () => ({
    endpoint: input.refreshEndpoint?.() ?? input.endpoint,
    workspaceId: input.workspaceId,
    entryPath: input.entryPath,
    surface: input.surface,
  }));
  await input.page.goto(server.resolvedUrls.local[0]);
  return { errors, close: () => server.close() };
}
