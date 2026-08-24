import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  defineJourney,
  genetEnv,
  locateGenet,
  parseJson,
  runGenet,
} from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.connectivity.legacy-state-migrates-once",
    title: "Pre-Wasm connectivity and machines migrate exactly once",
    oracle: "Hub and Relay identities survive upgrade; later unpair, detach, and forget survive restart",
    catches: [
      "legacy enrollment is ignored and trial enrollment conflicts",
      "legacy rendezvous route changes during upgrade",
      "native machine secret crosses into guest storage",
      "forgotten machines are resurrected from the legacy source",
      "unpaired connectivity is resurrected after restart",
    ],
    tags: ["core", "connectivity", "migration", "persistence", "parity", "v1-wasm"],
    llm: { default: "none" },
    expectedDurationMs: 25_000,
    timeoutMs: 90_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "genet-cli", "workbench-client"],
    productInterfaces: ["genet-cli", "@genehub/workbench/client"],
  },
  async (t) => {
    const nativeSecret = "native-machine-secret";
    const legacyMachineId = "m_legacy";
    const expectedRoute = createHash("sha256")
      .update(`genehub-rendezvous:${legacyMachineId}:${nativeSecret}`)
      .digest("hex")
      .slice(0, 32);
    mkdirSync(t.env.data, { recursive: true });
    writeFileSync(
      path.join(t.env.data, "state.json"),
      JSON.stringify(
        {
          machineId: legacyMachineId,
          secret: nativeSecret,
          enrollment: {
            hubUrl: "http://127.0.0.1:1",
            machineId: "hm_legacy",
            daemonId: legacyMachineId,
            secret: "legacy-hub-secret",
            workspaceCatalogGeneration: "wcg_legacy",
          },
          rendezvous: {
            relayUrl: "http://127.0.0.1:1",
            joinToken: "legacy-join-token",
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      path.join(t.env.data, "machines.json"),
      JSON.stringify({
        machines: [
          {
            machineId: "m_peer",
            name: "Legacy peer",
            fingerprint: "AA11-BB22-CC33-DD44",
            endpoint: "ws://127.0.0.1:2/fabric/v2?ticket=legacy&route=m_peer",
            deviceId: "d_legacy",
            secret: "legacy-peer-secret",
            pairedAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );

    const genet = locateGenet(t.openRoot);
    const cliEnv = genetEnv(t.openRoot, t.env.env);
    const cli = (args: string[]) => {
      const result = runGenet(genet, args, cliEnv);
      if (result.code !== 0) {
        throw new Error(`genet ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
      }
      return parseJson(result.stdout);
    };

    const first = await t.flows.main.startLocalEnvironment({ openRoot: t.openRoot, lease: t.env });
    try {
      const hub = await first.client.call({ type: "hub.status" });
      t.assertions.assert(hub?.type === "hubStatus", `hub.status returned ${hub?.type}`);
      if (hub?.type !== "hubStatus") throw new Error("hub.status failed");
      t.assertions.assert(hub.data.state === "paired", `legacy Hub state is ${hub.data.state}`);
      if (hub.data.state !== "paired") throw new Error("legacy Hub enrollment was not migrated");
      t.assertions.assert(hub.data.hubUrl === "http://127.0.0.1:1", `Hub URL ${hub.data.hubUrl}`);
      t.assertions.assert(hub.data.machineId === "hm_legacy", `Hub machine ${hub.data.machineId}`);

      const devices = await first.client.call({ type: "device.list" });
      t.assertions.assert(devices?.type === "devices", `device.list returned ${devices?.type}`);
      if (devices?.type !== "devices") throw new Error("device.list failed");
      const remote = devices.data.remote;
      t.assertions.assert(remote.relayUrl === "ws://127.0.0.1:1", `Relay URL ${remote.relayUrl}`);
      t.assertions.assert(Boolean(remote.rendezvousUrl), "legacy rendezvous URL is missing");
      const rendezvous = new URL(remote.rendezvousUrl!);
      t.assertions.assert(
        rendezvous.searchParams.get("route") === expectedRoute,
        `legacy route changed to ${rendezvous.searchParams.get("route")}`,
      );

      const listed = cli(["machine", "list"]);
      const machines = (listed.data as { machines?: Array<{ machineId?: string }> } | undefined)?.machines ?? [];
      t.assertions.assert(machines.some((machine) => machine.machineId === "m_peer"), "legacy peer was not imported");

      const portable = path.join(t.env.data, "portable");
      const configBytes = readFileSync(path.join(portable, "config.json"), "utf8");
      t.assertions.assert(!configBytes.includes(nativeSecret), "native machine secret entered guest config");
      for (const name of ["legacy-connectivity.json", "legacy-machines.json"]) {
        const marker = JSON.parse(readFileSync(path.join(portable, name), "utf8")) as { migrated?: boolean };
        t.assertions.assert(marker.migrated === true, `${name} is not a durable tombstone`);
      }

      const forgotten = cli(["machine", "forget", "m_peer"]);
      t.assertions.assert(
        (forgotten.data as { forgotten?: boolean } | undefined)?.forgotten === true,
        "legacy peer was not forgotten",
      );
      const unpaired = await first.client.call({ type: "hub.unpair" });
      t.assertions.assert(
        unpaired?.type === "hubStatus" && unpaired.data.state === "unpaired",
        "Hub did not unpair",
      );
      const detached = await first.client.call({ type: "device.remoteDetach" });
      t.assertions.assert(
        detached?.type === "remoteAccess" && !detached.data.relayUrl,
        "remote access did not detach",
      );
    } finally {
      first.client.close();
      first.daemon.stop();
      await first.mock.stop();
    }

    const second = await t.flows.main.startLocalEnvironment({ openRoot: t.openRoot, lease: t.env });
    try {
      const hub = await second.client.call({ type: "hub.status" });
      t.assertions.assert(
        hub?.type === "hubStatus" && hub.data.state === "unpaired",
        "legacy Hub enrollment resurrected after unpair",
      );
      const devices = await second.client.call({ type: "device.list" });
      t.assertions.assert(
        devices?.type === "devices" && !devices.data.remote.relayUrl,
        "legacy remote access resurrected after detach",
      );
      const listed = cli(["machine", "list"]);
      const machines = (listed.data as { machines?: unknown[] } | undefined)?.machines ?? [];
      t.assertions.assert(machines.length === 0, "legacy peer resurrected after forget");
    } finally {
      second.client.close();
      second.daemon.stop();
      await second.mock.stop();
    }
  },
);
