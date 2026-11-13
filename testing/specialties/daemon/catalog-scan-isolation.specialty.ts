import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, parseJson, runGenetAsync } from "../../framework/public.ts";

// Production supports text/JSON tracing formatters. Match categorical fields
// without depending on timestamps, ANSI presentation or private log paths.
function field(line: string, name: string, value: string): boolean {
  return new RegExp(`"?${name}"?\\s*[:=]\\s*"?${value}"?(?:[, }]|$)`).test(line);
}

const common = {
  tags: ["core", "session-pages", "session-read", "catalog-pressure"],
  llm: { default: "none" as const },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "filesystem", "genet-cli"],
  productInterfaces: ["session.page", "session.rename", "session list --active", "meta.json", "daemon.log"],
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 2, browser: 0 },
};

defineSpecialty({ ...common,
  id: "specialty.daemon.catalog.unrelated-scan-isolation",
  title: "A small project refresh finishes during an unrelated scan and survives its deferred publication",
  oracle: "Real directory observations witness an in-flight global sweep across 30000 unrelated files; the small scope returns a newer external title before that sweep publishes, and an unscoped read keeps that title after publication",
  catches: ["scoped reads take the global sweep lock", "deferred background observations overwrite newer scoped data"],
  expectedDurationMs: 60_000, timeoutMs: 180_000,
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env, launchEnv: { GENEHUB_LOCAL_LOG: "debug" } });
  try {
    const small = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
    const smallFile = join(o.workspaceRoot, ".genethub/sessions", small, "meta.json");
    const bigRoot = join(o.workspaceRoot, "z-unrelated"); mkdirSync(bigRoot);
    const opened = await o.client.call({ type: "workspace.open", payload: { root: bigRoot } });
    if (opened?.type !== "workspace") throw Error("unrelated workspace did not open");
    const seed = await t.flows.main.createBuiltinSession(o.client, opened.data.id);
    const home = join(bigRoot, ".genethub/sessions");
    const model = JSON.parse(readFileSync(join(home, seed, "meta.json"), "utf8"));
    for (let i = 0; i < 30_000; i++) {
      const id = `s_isolation_${i}`, dir = join(home, id); mkdirSync(dir);
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...model, id, titleLocked: true, title: "unrelated", updatedAtMs: Date.now() - 60_000 }));
    }
    const page = async (workspaceId: string | null) => {
      const r = await o.client.call({ type: "session.page", payload: { requests: [{ workspaceId, limit: 100, cursor: null }], includeArchived: true } });
      if (r?.type !== "sessionPages" || r.data[0]?.error) throw Error("scope could not be read");
      return r.data[0]!;
    };
    await page(opened.data.id);
    // Local public mutations keep a sizeable part of the other home hot. This
    // makes the overlapping scan repeatable even after the cold-watch spread.
    for (let first = 0; first < 3_000; first += 8) {
      await Promise.all(Array.from({ length: 8 }, (_, n) => o.client.call({ type: "session.rename", payload: {
        sessionId: `s_isolation_${first + n}`, title: "hot unrelated record",
      } })));
    }
    // Expire scope reuse; external updates require the next real observation.
    await new Promise(resolve => setTimeout(resolve, 2_100));
    const logPath = join(t.env.data, "logs/daemon.log");
    const log = () => existsSync(logPath) ? readFileSync(logPath, "utf8").replace(/\x1b\[[0-9;]*m/g, "") : "";
    const before = log().length;
    // Directory/file watches are hot after creation. The small home is first
    // in this fixture's physical directory order, the large child follows it.
    await t.tools.waitUntil(() => log().slice(before).split("\n").some(line => line.includes("session_catalog_home_observed") && field(line, "scoped", "false") && field(line, "observations", "1")), 35_000, { intervalMs: 5 });
    const seen = log().length;
    const changed = { ...JSON.parse(readFileSync(smallFile, "utf8")), title: "newer scoped observation", titleLocked: true, updatedAtMs: Date.now() + 60_000 };
    writeFileSync(smallFile, JSON.stringify(changed));
    const scoped = await page(o.workspaceId);
    t.assertions.assert(scoped.sessions.some(row => row.id === small && row.title === changed.title), "small scope did not observe its external write");
    t.assertions.assert(!log().slice(seen).split("\n").some(line => line.includes("session_catalog_swept") && field(line, "scoped", "false")), "small scope waited until the unrelated sweep finished");
    await t.tools.waitUntil(() => log().slice(seen).split("\n").some(line => line.includes("session_catalog_swept") && field(line, "scoped", "false")), 45_000);
    const global = await page(null);
    t.assertions.assert(global.sessions.some(row => row.id === small && row.title === changed.title), "old global observation rolled back the scoped result");
    t.note("30000 real unrelated records; scope completed before global commit and newer title survived in unscoped cache");
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});

defineSpecialty({ ...common,
  id: "specialty.daemon.catalog.activity-cli-restarts-complete-pass",
  title: "The real activity CLI restarts a drifted complete read and never returns partial success",
  oracle: "A real CLI reads 1000 active sessions; a public rename after its first page invalidates its cursor, the complete query restarts and returns every unique session; the server records both revision fingerprints even when rejection is fast",
  catches: ["CLI exposes recoverable cursor drift without restarting", "CLI combines old and new passes", "subsecond page failures leave no attributable diagnostics"],
  expectedDurationMs: 20_000, timeoutMs: 120_000,
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env, launchEnv: { GENEHUB_LOCAL_LOG: "debug" } });
  try {
    const seed = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
    const home = join(o.workspaceRoot, ".genethub"), sessions = join(home, "sessions");
    const model = JSON.parse(readFileSync(join(sessions, seed, "meta.json"), "utf8"));
    const ids = [seed];
    for (let i = 1; i < 1000; i++) {
      const id = `s_cli_activity_${i}`, dir = join(sessions, id); ids.push(id); mkdirSync(dir);
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...model, id, titleLocked: true, title: "activity", updatedAtMs: Date.now() - i }));
    }
    const source = "fixture.activity-cli";
    writeFileSync(join(home, "coordination-source.json"), JSON.stringify({ version: 1, source }));
    writeFileSync(join(home, "session-coordination.json"), JSON.stringify({ version: 1, source, revision: 1, updatedAtMs: Date.now(), receivedAtMs: Date.now(),
      sessions: Object.fromEntries(ids.map(id => [id, { source, active: true, pending: 1, ready: 0, unknown: 0, updatedAtMs: Date.now(), stale: false }])) }));
    await new Promise(resolve => setTimeout(resolve, 2_100));
    const logPath = join(t.env.data, "logs/daemon.log"), log = () => readFileSync(logPath, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
    // External files enter the unscoped presentation index on its background
    // cadence. Establish the fixture through the public scoped refresh first;
    // this test concerns cursor drift, not racing initial reconciliation.
    await o.client.call({ type: "session.page", payload: { requests: [{ workspaceId: o.workspaceId, limit: 100, cursor: null, activeOnly: true }], includeArchived: true } });
    const ready = await o.client.call({ type: "session.page", payload: { requests: [{ workspaceId: null, limit: 100, cursor: null, activeOnly: true }], includeArchived: true } });
    t.assertions.assert(ready?.type === "sessionPages" && ready.data[0]?.sessions.length === 100 && !!ready.data[0]?.nextCursor,
      "fixture did not expose multiple activity pages: " + JSON.stringify(ready?.type === "sessionPages" ? { count: ready.data[0]?.sessions.length, error: ready.data[0]?.error } : { type: ready?.type }));
    const before = log().length;
    const reading = runGenetAsync(o.daemon.genet, ["session", "list", "--active", "--include-archived"], o.daemon.env);
    let completed: Awaited<typeof reading> | undefined;
    void reading.then(result => { completed = result; });
    await t.tools.waitUntil(() => {
      const observed = log().slice(before).split("\n").some(line => line.includes("session_activity_page_served") && field(line, "continuation", "false") && field(line, "more", "true"));
      if (!observed && completed) {
        const value = parseJson(completed.stdout) as { error?: { code?: string; message?: string }; data?: { sessions?: unknown[] } };
        throw Error("CLI ended before a witnessed first page: " + JSON.stringify({ exit: completed.code, error: value.error?.code, message: value.error?.message, rows: value.data?.sessions?.length }));
      }
      return observed;
    }, 30_000, { intervalMs: 2 });
    const renamed = await o.client.call({ type: "session.rename", payload: { sessionId: seed, title: "changed between CLI pages" } });
    t.assertions.assert(renamed?.type === "session", "public rename failed");
    const result = await reading;
    const value = parseJson(result.stdout) as { data?: { sessions?: Array<{ id: string }>; complete?: boolean } };
    const rows = value.data?.sessions ?? [];
    t.assertions.assert(result.code === 0 && value.data?.complete === true && rows.length === ids.length && new Set(rows.map(row => row.id)).size === ids.length && ids.every(id => rows.some(row => row.id === id)), "complete activity CLI did not recover every unique row: exit=" + result.code);
    const evidence = log().slice(before);
    t.assertions.assert(evidence.includes("session_activity_page_changed") && evidence.includes("expected_revision") && evidence.includes("actual_revision"), "the controlled drift was not independently witnessed with revision fingerprints");
    t.assertions.assert(evidence.split("\n").some(line => line.includes("session_read_wait") && field(line, "outcome", "error")), "fast page error was not observable");
    t.note("1000 unique active rows, witnessed mid-pagination rename/cursor rejection, complete native CLI recovery and classified failure diagnostics");
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
