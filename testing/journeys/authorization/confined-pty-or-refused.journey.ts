import { writeFileSync } from "node:fs";
import path from "node:path";

import { ProtocolError_ } from "@genehub/web/client";

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.authorization.confined-pty-or-refused",
    title: "A terminal for someone else is confined or refused but never neither",
    oracle:
      "a read+pty device either answers from inside the workspace without reading next door, or pty.open is isolationUnavailable rather than forbidden; full-grant and owner terminals still open",
    catches: ["remote pty is an unconstrained login shell", "isolation failure reported as forbidden"],
    tags: ["core", "authorization", "parity"],
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 40_000,
    timeoutMs: 120_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const narrow = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read", "pty"]);
    const chunks: string[] = [];
    const stop = narrow.client.onPty((_ptyId, data) => {
      if (data) chunks.push(data);
    });
    try {
      let ptyId: string | null = null;
      try {
        const pty = await narrow.client.call({
          type: "pty.open",
          payload: { workspaceId: opened.workspaceId, cols: 80, rows: 24 },
        });
        t.assertions.assert(pty?.type === "pty", `pty.open returned ${pty?.type}`);
        ptyId = pty?.type === "pty" ? pty.data.ptyId : "";
      } catch (error) {
        if (!(error instanceof ProtocolError_)) throw error;
        const code = String(error.detail.code);
        t.assertions.assert(
          code.toLowerCase() === "isolationunavailable" || error.message.toLowerCase().includes("isolationunavailable"),
          `an unconfinable machine has to say so: ${code} ${error.message}`,
        );
        t.assertions.assert(
          code.toLowerCase() !== "forbidden" && !error.message.toLowerCase().includes("forbidden"),
          `isolation failure was reported as a permission problem: ${error.message}`,
        );
      }
      if (ptyId) {
        const outside = path.join(path.dirname(opened.workspaceRoot), "outside-the-workspace.txt");
        writeFileSync(outside, "OUT-OF-BOUNDS");
        await narrow.client.call({
          type: "pty.write",
          payload: { ptyId, data: `cat ${outside}; echo confined-$((6*7))\n` },
        });
        await t.tools.waitUntil(() => chunks.join("").includes("confined-42"), 20_000);
        t.assertions.assert(
          !chunks.join("").includes("OUT-OF-BOUNDS"),
          `a confined terminal read a file outside its workspace: ${chunks.join("")}`,
        );
      }

      const whole = await t.flows.main.pairDevice(opened.client, opened.daemon, []);
      try {
        const unconfined = await whole.client.call({
          type: "pty.open",
          payload: { workspaceId: opened.workspaceId, cols: 80, rows: 24 },
        });
        t.assertions.assert(unconfined?.type === "pty", "an unconfined terminal is still allowed to those who hold it");
      } finally {
        whole.client.close();
      }

      const local = await opened.client.call({
        type: "pty.open",
        payload: { workspaceId: opened.workspaceId, cols: 80, rows: 24 },
      });
      t.assertions.assert(local?.type === "pty", "the local user opens a terminal");
    } finally {
      stop();
      narrow.client.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
