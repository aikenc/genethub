import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { daemonEndpoint, defineSpecialty, openBrowser, openPreviewBrowser } from "../../framework/public.ts";

function generateBoard(root: string, openRoot: string, env: NodeJS.ProcessEnv) {
  mkdirSync(join(root, "datas/releases/review"), { recursive: true });
  writeFileSync(join(root, "agent-space.genet.json"), JSON.stringify({ schema: "agent-space.v1", name: "board-snapshot-fixture", folders: [{ path: "." }] }));
  writeFileSync(join(root, "datas/releases/review/index.html"), "<!doctype html><title>Review candidate</title><h1>Review candidate</h1>");
  const result = spawnSync(process.env.GENEHUB_PYTHON!, [join(openRoot, "apps/daemon/builtin-skills/genehub/references/team-template/tools/pm_board_server.py"), "--once", "--team-root", root], { env, encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error(`Board CLI failed: ${result.stderr}`);
  const file = join(root, "datas/board/live.json");
  return { file, snapshot: JSON.parse(readFileSync(file, "utf8")) };
}

const metadata = {
  tags: ["page-experience", "team-board"], runner: "playwright" as const, llm: { default: "none" as const },
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 1, pool: "browser" as const },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python" as const, env: "GENEHUB_PYTHON", minVersion: [3, 7] as [number, number], modules: [] }],
  surfaces: ["team-template", "workbench-ui", "asset-preview", "daemon"],
  productInterfaces: ["pm_board_server.py --once", "@genehub/workbench", "asset.preview"],
  expectedDurationMs: 30_000, timeoutMs: 180_000,
};

defineSpecialty({
  ...metadata,
  id: "specialty.page-experience.team-board-snapshot",
  title: "Team board identifies stale snapshots and recovers real Preview file failures",
  oracle: "The emitted board inside the real Preview identifies an old stopped-service snapshot, displays a fresh disk update, retains the last data with a visible error when the file disappears, and recovers without claiming a live service",
  catches: ["old disk data presented as live", "refresh error hidden forever", "failed refresh erases useful data", "recovery needs a new page"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  let consumer: Awaited<ReturnType<typeof openPreviewBrowser>> | undefined;
  try {
    const board = generateBoard(t.env.workspace, t.openRoot, { ...opened.daemon.env, GENEHUB_CLI: opened.daemon.genet });
    board.snapshot.updatedAtMs = Date.now() - 3 * 60 * 60_000;
    board.snapshot.updatedAt = "three hours ago";
    board.snapshot.service = { running: false };
    writeFileSync(board.file, JSON.stringify(board.snapshot));
    browser = await openBrowser({}, { trace: false });
    consumer = await openPreviewBrowser({ openRoot: t.openRoot, lease: t.env, page: browser.page, endpoint: daemonEndpoint(opened.daemon), workspaceId: "", entryPath: join(t.env.workspace, "datas/board/index.html") });
    const frame = browser.page.frameLocator('iframe[title="HTML 文件预览"]');
    await frame.locator("#team-title").getByText(/board-snapshot-fixture/).waitFor();
    const old = await frame.locator("#service-text").innerText();
    t.assertions.assert(/快照/.test(old) && /过期/.test(old) && !/自动同步|在线/.test(old), `Stopped stale snapshot claimed live freshness: ${old}`);
    board.snapshot.updatedAtMs = Date.now();
    board.snapshot.updatedAt = "fresh file update";
    board.snapshot.description = "Fresh artifact from the same Team";
    writeFileSync(board.file, JSON.stringify(board.snapshot));
    await frame.getByRole("button", { name: "🔄 立即刷新", exact: true }).click();
    await t.tools.waitUntil(async () => await frame.locator("#team-desc").innerText() === board.snapshot.description, 15_000);
    const fresh = await frame.locator("#service-text").innerText();
    t.assertions.assert(/快照/.test(fresh) && !/过期|在线/.test(fresh), `Fresh static file misrepresented: ${fresh}`);
    unlinkSync(board.file);
    await frame.getByRole("button", { name: "🔄 立即刷新", exact: true }).click();
    await t.tools.waitUntil(async () => /刷新失败/.test(await frame.locator("#service-text").innerText()), 30_000);
    t.assertions.assert(await frame.locator("#team-desc").innerText() === board.snapshot.description, "Failed refresh discarded last known data");
    board.snapshot.updatedAtMs = Date.now();
    board.snapshot.description = "Recovered artifact without reopening";
    writeFileSync(board.file, JSON.stringify(board.snapshot));
    await frame.getByRole("button", { name: "🔄 立即刷新", exact: true }).click();
    await t.tools.waitUntil(async () => await frame.locator("#team-desc").innerText() === board.snapshot.description, 15_000);
    t.assertions.assert(!/刷新失败/.test(await frame.locator("#service-text").innerText()), "Recovered file retained failure status");
    t.note("Actual emitted template in native opaque Preview: stale/fresh file provenance, missing-file failure and same-page recovery; no model calls.");
  } finally { await consumer?.close(); await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

defineSpecialty({
  ...metadata,
  id: "specialty.page-experience.team-board-refresh-pressure",
  title: "Slow board artifact refresh stays single flight and aborts its real HTTP request",
  oracle: "An ordinary browser consumes the emitted artifact over an owned file server; actual delayed responses do not overlap under repeated manual and periodic refresh, a stalled request closes on timeout, and the same page recovers",
  catches: ["every timer tick adds another slow request", "manual refresh bypasses the active read", "timeout leaves transport open", "read failure cannot recover"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  let hold = true, active = 0, maximum = 0, requests = 0, cancelled = 0;
  const pending: ServerResponse[] = [];
  const board = generateBoard(t.env.workspace, t.openRoot, { ...opened.daemon.env, GENEHUB_CLI: opened.daemon.genet });
  const sendFile = (response: ServerResponse) => {
    if (response.destroyed) return;
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(readFileSync(board.file));
  };
  // A real ordinary file transport, not a replacement GeneHub API. Holding its
  // socket is the network fault; all successful bytes come from the CLI artifact.
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    if (path === "/board/index.html") { response.writeHead(200, { "content-type": "text/html" }); response.end(readFileSync(join(t.env.workspace, "datas/board/index.html"))); return; }
    if (path !== "/board/live.json") { response.writeHead(404); response.end(); return; }
    requests++; active++; maximum = Math.max(maximum, active);
    response.once("close", () => { active--; if (!response.writableFinished) cancelled++; });
    if (hold) pending.push(response); else sendFile(response);
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No owned HTTP endpoint");
    browser = await openBrowser({}, { trace: false });
    await browser.page.goto(`http://127.0.0.1:${address.port}/board/index.html`);
    await t.tools.waitUntil(() => active > 0, 5_000);
    for (let n = 0; n < 5; n++) await browser.page.getByRole("button", { name: "🔄 立即刷新", exact: true }).click();
    await new Promise(resolve => setTimeout(resolve, 6500));
    t.assertions.assert(maximum === 1 && requests === 1, `Slow refresh amplified requests: activePeak=${maximum}, requests=${requests}`);
    hold = false; for (const response of pending.splice(0)) sendFile(response);
    await browser.page.locator("#team-title").getByText(/board-snapshot-fixture/).waitFor();
    hold = true;
    await browser.page.getByRole("button", { name: "🔄 立即刷新", exact: true }).click();
    await t.tools.waitUntil(() => active > 0, 5_000);
    await t.tools.waitUntil(() => cancelled > 0, 15_000);
    await t.tools.waitUntil(async () => /刷新失败/.test(await browser!.page.locator("#service-text").innerText()), 5_000);
    hold = false; for (const response of pending.splice(0)) sendFile(response);
    board.snapshot.description = "Recovered after real transport timeout";
    board.snapshot.updatedAtMs = Date.now(); writeFileSync(board.file, JSON.stringify(board.snapshot));
    await browser.page.getByRole("button", { name: "🔄 立即刷新", exact: true }).click();
    await t.tools.waitUntil(async () => await browser!.page.locator("#team-desc").innerText() === board.snapshot.description, 15_000);
    t.assertions.assert(maximum === 1 && cancelled > 0, "Refresh leaked or overlapped real HTTP requests");
    t.note(JSON.stringify({ maximumInFlight: maximum, requests, cancelled, samePageRecovered: true }));
  } finally { await browser?.close(); for (const response of pending) response.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
