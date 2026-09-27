import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { defineSpecialty, startHub, startRelay, allocatePort } from "../../framework/public.ts";

for (const variant of ["ignored-generation", "historical-reasons"] as const) {
  defineSpecialty({
    id: `specialty.connectivity.review-feedback-${variant}`,
    title: `Feedback keeps the correct offline cause: ${variant}`,
    oracle: "Real feedback HTTP submission stores the reason belonging to each observed outage and ignores rejected presence generations",
    catches: ["rejected presence poisons diagnostics", "latest outage rewrites older feedback events"],
    tags: ["network-review-experiment", "feedback", "cloud-server"], llm: { default: "none" },
    requiredRepos: ["cloud"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
    productInterfaces: ["hub-http", "fabric-presence-http", "feedback-http"],
    surfaces: ["cloud-server", "daemon", "relay"],
    expectedDurationMs: 20000, timeoutMs: 90000,
    resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  }, async t => {
    const token = randomBytes(32).toString("hex");
    const port = await allocatePort();
    const databasePath = join(t.env.root, "review-hub.sqlite");
    const hub = await startHub({databasePath, relayOrigin: `http://127.0.0.1:${port}`, relayToken: token});
    const relay = await startRelay({openRoot: t.openRoot, port, control: {origin: hub.origin, token}});
    t.env.env.GENEHUB_LOCAL_HUB_URL = hub.origin;
    const opened = await t.flows.main.openWorkspace({openRoot: t.openRoot, lease: t.env});
    // Read the actual persisted evidence with SQLite, never mutate product
    // tables or call private product state/diagnostics methods.
    const require = createRequire(join(process.env.TESTCTL_CLOUD_ROOT!, "server/package.json"));
    const Database = require("better-sqlite3");
    const db = new Database(databasePath, {readonly: true, fileMustExist: true});
    try {
      const owner = hub.browser(); await hub.signInOwner(owner);
      const pairing = await opened.client.call({type: "hub.pair", payload: {hubUrl: hub.origin, displayName: "review-machine"}});
      if (pairing?.type !== "hubStatus" || pairing.data.state !== "pairing") throw new Error("pairing did not start");
      await hub.approvePairing(owner, pairing.data.userCode);
      let node: {handle: string; machine_id: string; connection_generation: number} | undefined;
      await t.tools.waitUntil(() => {
        node = db.prepare("SELECT handle,machine_id,connection_generation FROM fabric_endpoints WHERE kind='node' AND connected_at IS NOT NULL AND presence_generation=connection_generation").get();
        return !!node;
      }, 30000);
      // Stop our isolated relay so heartbeats cannot overwrite injected wire
      // facts. No production relay or user's connection is touched.
      relay.stop();
      await new Promise(r => setTimeout(r, 300));
      const presence = async (generation: number, state: "online" | "offline", reasonCode?: string) => {
        const response = await fetch(`${hub.origin}/internal/fabric/v2/presence`, {
          method: "POST", headers: {"content-type": "application/json", authorization: `Bearer ${token}`},
          body: JSON.stringify({endpointHandle: node!.handle, connectionGeneration: generation, state,
            ...(reasonCode ? {reasonCode, strikes: 8} : {})}),
        });
        await response.body?.cancel(); return response.status;
      };
      const diagnosticSessionId = `diag_review_${randomBytes(8).toString("hex")}`;
      const headers = {"x-genehub-diagnostic-session": diagnosticSessionId};
      const connect = async () => {
        const response = await owner.fetch(`/app/machines/${node!.machine_id}/connect`, {method: "POST", headers});
        await response.body?.cancel();
        t.assertions.assert(response.status === 409, `offline connect status=${response.status}`);
      };
      const initial = await presence(node!.connection_generation, "offline", "lateFrameOverflow");
      t.assertions.assert(initial === 204, `valid presence rejected: ${initial}`);
      await connect();
      let rejected: number | null = null;
      if (variant === "ignored-generation") {
        rejected = await presence(node!.connection_generation + 100, "offline", "data");
        t.assertions.assert(rejected === 409, `invalid generation was not fenced: ${rejected}`);
        await connect();
      } else {
        t.assertions.assert(await presence(node!.connection_generation, "online") === 204, "recovery failed");
        t.assertions.assert(await presence(node!.connection_generation, "offline", "data") === 204, "second outage failed");
        await connect();
      }
      const snapshot = await opened.client.diagnostics();
      // Submit the public feedback wire projection, as the browser does. Extra
      // daemon patrol counters are not part of the machine feedback contract.
      const machine = {
        version: snapshot.version, capturedAt: snapshot.capturedAt, daemonVersion: snapshot.daemonVersion,
        os: snapshot.os || "unknown", arch: snapshot.arch || "unknown", uptimeSeconds: snapshot.uptimeSeconds,
        hubState: snapshot.hubState, remoteState: snapshot.remoteState,
        events: snapshot.events, droppedEvents: snapshot.droppedEvents,
      };
      const now = new Date().toISOString();
      const response = await owner.fetch("/app/feedback", {method: "POST", headers, body: JSON.stringify({
        description: "isolated network attribution experiment", screenshots: [],
        diagnostics: {version: 4, machine, diagnosticSessionId, startedAt: now, capturedAt: now,
          page: "/machines", pageKind: "workbench", tabId: "tab_review", build: "review", brand: "GeneHub",
          userAgent: "testctl", viewport: {width: 1280, height: 720}, online: true, visibility: "visible", previewPath: null, events: []},
      })});
      t.assertions.assert(response.status === 201, `feedback status=${response.status}${response.status === 201 ? "" : ": " + await response.text()}`);
      const report = await response.json() as {id: string};
      const stored = JSON.parse(db.prepare("SELECT diagnostics_json FROM feedback_reports WHERE id=?").get(report.id).diagnostics_json);
      t.assertions.assert(stored.machine?.events.some((e: any) => e.operation === "data.endpoint" && e.code === "websocket"), "actual daemon path fact did not survive feedback submission");
      const events = stored.control.events.filter((e: any) => e.kind === "fabric.connect" && e.status === 409);
      const reasons = events.map((e: any) => e.reasonCode);
      const expected = variant === "ignored-generation" ? ["lateFrameOverflow", "lateFrameOverflow"] : ["lateFrameOverflow", "data"];
      const summary = JSON.stringify({variant, rejectedPresenceStatus: rejected, expected, actual: reasons, feedbackStored: true});
      t.note(summary);
      t.assertions.assert(JSON.stringify(reasons) === JSON.stringify(expected), summary);
    } finally { db.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); relay.stop(); await hub.stop(); }
  });
}
