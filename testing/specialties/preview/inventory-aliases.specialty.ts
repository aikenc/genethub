import { spawn } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ServicePreviewClient } from "@genehub/workbench/client";
import { BlockedError, defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.preview.inventory-project-aliases",
  title: "One real preview stays visible through many projects without multiplying its failed health probe",
  oracle: "A shipped Python application is exposed by 33 actual workspace roots. Suspending only that application makes all aliases unreachable in under three seconds; resuming it restores every alias, scoped isolation and authenticated shutdown without reusing the failed observation.",
  catches: ["one timeout per alias turns a process inventory into seconds of waves", "deduplication drops legitimate project entries", "a completed failed probe is cached after app recovery", "aliases borrow another project's service metadata"],
  tags: ["core", "service-preview", "session-catalog", "preview-inventory-aliases"],
  llm: { default: "none" }, expectedDurationMs: 20000, timeoutMs: 90000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" },
  requirements: [
    { kind: "python", env: "GENEHUB_PREVIEW_MEDIA_PYTHON", minVersion: [3, 11], modules: ["aiohttp"] },
    { kind: "command", env: "GENEHUB_PREVIEW_MEDIA_PYTHON", args: ["-c", "import signal; assert hasattr(signal, 'SIGSTOP'); print('process-suspension-supported')"], contains: "process-suspension-supported" },
  ],
  requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "service-preview", "filesystem", "workbench-client"],
  productInterfaces: ["@genehub/workbench/client", "workspace.open", "process.list", "process.workspaceList", "process.serviceStop"],
}, async t => {
  const python = process.env.GENEHUB_PREVIEW_MEDIA_PYTHON;
  if (!python) throw new BlockedError("Python preview runtime required");
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const adapter = join(t.env.workspace, "adapter");
  await cp(join(t.env.data, "builtin-skills/genehub-preview/assets/python-adapter"), adapter, { recursive: true });
  const entry = join(t.env.workspace, "index.html");
  await writeFile(entry, "<!doctype html><title>Actual aliased preview</title>");
  const app = spawn(python, [join(adapter, "app.py"), "--entry", entry, "--daemon-root", t.env.data], { cwd: adapter, stdio: "ignore" });
  const aliases = [{ id: o.workspaceId, entryPath: `${o.rootHandle}/index.html` }];
  try {
    for (let i = 0; i < 32; i++) {
      const definitionRoot = join(t.env.root, "alias-definition-" + i);
      await mkdir(definitionRoot);
      const definition = join(definitionRoot, "project.code-workspace");
      await writeFile(definition, JSON.stringify({ folders: [{ path: t.env.workspace }, { path: definitionRoot }] }));
      const opened = await o.client.call({ type: "workspace.open", payload: { root: definition } });
      if (opened?.type !== "workspace") throw new Error("real alias workspace did not open");
      aliases.push({ id: opened.data.id, entryPath: `${opened.data.folders[0]!.rootHandle}/index.html` });
    }
    t.assertions.assert(new Set(aliases.map(a => a.id)).size === 33, "fixture aliases collapsed into one project");
    const otherRoot = join(t.env.root, "unrelated-project"); await mkdir(otherRoot);
    const other = await o.client.call({ type: "workspace.open", payload: { root: otherRoot } });
    if (other?.type !== "workspace") throw new Error("unrelated project did not open");
    let discovered: ServicePreviewClient | null = null;
    await t.tools.waitUntil(async () => {
      if (app.exitCode !== null) throw new Error("actual preview application exited");
      discovered = await ServicePreviewClient.discover(o.client, o.workspaceId, aliases[0]!.entryPath);
      return discovered !== null;
    }, 15000);
    const service = discovered as unknown as ServicePreviewClient;
    const runId = service.descriptor.runId; service.close();
    const list = () => o.client.call({ type: "process.list" });
    const checkAliases = async (reachable: boolean) => {
      const reply = await list();
      t.assertions.assert(reply?.type === "processes", "no real process inventory");
      if (reply?.type !== "processes") throw new Error("wrong process response");
      const rows = reply.data.filter(p => p.service?.runId === runId);
      t.assertions.assert(rows.length === aliases.length && aliases.every(alias => rows.some(p => p.workspaceId === alias.id && p.pid === app.pid && p.service?.entryPath === alias.entryPath && p.service.reachable === reachable && p.service.canStop === reachable)), "native Run lost aliases, changed scope or retained a stale health result");
      t.assertions.assert(!JSON.stringify(reply).includes('"secret"') && !JSON.stringify(reply).includes('"port"'), "process inventory exposed registration credentials");
    };
    await checkAliases(true);
    // Real fault in our own external SDK application. The daemon, registry,
    // protocol responses and timeouts are untouched.
    t.assertions.assert(app.kill("SIGSTOP"), "could not suspend actual SDK app");
    const began = performance.now();
    await checkAliases(false);
    const unavailableMs = Math.round(performance.now() - began);
    t.assertions.assert(unavailableMs < 3000, "same Run timeout multiplied across aliases: " + unavailableMs);
    t.assertions.assert(app.kill("SIGCONT"), "could not resume actual SDK app");
    await checkAliases(true);
    const isolated = await o.client.call({ type: "process.workspaceList", payload: { workspaceId: other.data.id } });
    t.assertions.assert(isolated?.type === "processes" && !isolated.data.some(p => p.service?.runId === runId), "preview crossed an unrelated project scope");
    const alias = aliases.at(-1)!;
    const scoped = await o.client.call({ type: "process.workspaceList", payload: { workspaceId: alias.id } });
    t.assertions.assert(scoped?.type === "processes" && scoped.data.some(p => p.service?.runId === runId) && scoped.data.every(p => p.workspaceId === alias.id), "scoped alias inventory returned other project entries");
    await o.client.call({ type: "process.serviceStop", payload: { workspaceId: alias.id, entryPath: alias.entryPath, runId } });
    await t.tools.waitUntil(() => app.exitCode !== null, 10000);
    const stopped = await list();
    t.assertions.assert(stopped?.type === "processes" && !stopped.data.some(p => p.service?.runId === runId), "authenticated alias stop left a retained Run");
    t.note(JSON.stringify({ realRuns: 1, legitimateProjectAliases: aliases.length, unavailableMs, resumedFresh: true, isolated: true, stopped: true }));
  } finally { app.kill("SIGCONT"); app.kill("SIGTERM"); o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
