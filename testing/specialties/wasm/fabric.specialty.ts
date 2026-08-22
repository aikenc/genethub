import { createServer, type Server, type Socket } from "node:net";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";

import { WebSocketServer } from "ws";

import {
  BlockedError,
  defineSpecialty,
  tryLocateDaemonComponent,
  tryLocateHost,
  type CaseContext,
} from "../../framework/public.ts";

/**
 * The daemon reaches other machines by hanging a Fabric v2 uplink on a relay.
 * The relay is a separate service on the far side of the network, so a test
 * that wants to see the daemon dial has to be that far side. Both cases below
 * stand where the relay stands and assert only what arrives on the wire.
 */

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

function requireWasmArtifacts(openRoot: string): void {
  const host = tryLocateHost(openRoot);
  const component = tryLocateDaemonComponent(openRoot);
  if (!host || !component) {
    throw new BlockedError(
      `wasm artifacts missing: host=${host ?? "no"} component=${component ?? "no"}`,
    );
  }
}

function fabricMeta(id: string, title: string, oracle: string, catches: string[]) {
  return {
    id,
    title,
    oracle,
    catches,
    tags: ["core", "wasm-guest", "v2-shell", "connectivity"],
    llm: { default: "none" as const },
    expectedDurationMs: 25_000,
    timeoutMs: 150_000,
    resources: {
      environments: 1,
      cpu: 2,
      memoryMb: 768,
      io: 1,
      browser: 0,
      pool: "standard" as const,
    },
    surfaces: ["genehub-host", "daemon"],
    productInterfaces: ["@genehub/web/client"],
    requiredArtifacts: ["genehub-host-dev", "genehub_guest.wasm"],
  };
}

async function withOpened(t: CaseContext, run: (opened: Opened) => Promise<void>): Promise<void> {
  requireWasmArtifacts(t.openRoot);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await run(opened);
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
}

function portOf(server: Server | ReturnType<typeof createHttpServer>): number {
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("the stand-in relay never bound a port");
  return address.port;
}

defineSpecialty(
  fabricMeta(
    "specialty.wasm.fabric.guest-opens-its-own-uplink",
    "The guest opens the Fabric uplink itself and reports online only once the relay accepted it",
    "the relay side receives GET /fabric/v2?ticket=<slot> as a WebSocket upgrade from the daemon, and device.list then reports remote.online true",
    [
      "fabric is a stub in the guest and is_online is hard-coded false",
      "the guest cannot open an outbound socket at all",
      "the uplink claims online before any relay accepted it",
      "the admission ticket is dropped on the way to the relay",
    ],
  ),
  async (t) => {
    const upgrades: { url: string; headers: IncomingMessage["headers"] }[] = [];
    const http = createHttpServer((_request, response) => {
      response.writeHead(404).end();
    });
    const sockets = new WebSocketServer({ noServer: true });
    http.on("upgrade", (request, socket, head) => {
      if (!request.url?.startsWith("/fabric/v2")) {
        socket.destroy();
        return;
      }
      upgrades.push({ url: request.url, headers: request.headers });
      // Accepting and then staying silent is enough: the uplink is online from
      // the moment the WebSocket exists, and everything after that is the peer
      // protocol, which this case deliberately does not speak.
      sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, request));
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const relayUrl = `http://127.0.0.1:${portOf(http)}`;

    try {
      await withOpened(t, async (opened) => {
        const attached = await opened.client.call({
          type: "device.remoteAttach",
          payload: { relayUrl, joinToken: null },
        });
        t.assertions.assert(
          attached?.type === "remoteAccess",
          `device.remoteAttach returned ${attached?.type}`,
        );
        await t.tools.waitUntil(() => upgrades.length > 0, 20_000);
        const upgrade = upgrades[0];
        if (!upgrade) throw new Error("the daemon never reached the relay");
        t.assertions.assert(
          /^\/fabric\/v2\?ticket=[^&]+$/.test(upgrade.url),
          `the daemon asked for ${upgrade.url}, which is not one bounded Fabric admission`,
        );
        t.assertions.assert(
          String(upgrade.headers.upgrade ?? "").toLowerCase() === "websocket",
          `the daemon did not ask for a WebSocket: ${JSON.stringify(upgrade.headers)}`,
        );
        t.assertions.assert(
          typeof upgrade.headers["sec-websocket-key"] === "string",
          `no client handshake key, so this was not a real upgrade: ${JSON.stringify(upgrade.headers)}`,
        );

        await t.tools.waitUntil(async () => {
          const devices = await opened.client.call({ type: "device.list" });
          return devices?.type === "devices" && devices.data.remote.online === true;
        }, 20_000);
        const devices = await opened.client.call({ type: "device.list" });
        if (devices?.type !== "devices") throw new Error("device.list failed");
        t.assertions.assert(
          devices.data.remote.online === true,
          `the uplink never came online: ${JSON.stringify(devices.data.remote)}`,
        );
        t.assertions.assert(
          devices.data.remote.relayUrl === relayUrl,
          `remote.relayUrl is ${devices.data.remote.relayUrl}, expected ${relayUrl}`,
        );
      });
    } finally {
      sockets.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  },
);

defineSpecialty(
  fabricMeta(
    "specialty.wasm.fabric.rtc-is-offered-by-the-component-too",
    "The component daemon offers the direct RTC upgrade the native one does",
    "connection.identity from the wasm daemon reports rtcSupported true, so a viewer that can reach this machine directly is not held on the relay by which build answered it",
    [
      "the guest silently loses the RTC upgrade and every viewer stays on the slower relay path",
      "rtc_supported is answered per build rather than by what the shell can carry",
      "the wasm daemon advertises RTC without a shell import behind it",
    ],
  ),
  async (t) => {
    await withOpened(t, async (opened) => {
      const identity = await opened.client.call({ type: "connection.identity" });
      if (identity?.type !== "hello") throw new Error("connection.identity failed");
      t.assertions.assert(
        identity.data.rtcSupported === true,
        `the component daemon disclaimed RTC: ${JSON.stringify(identity.data)}`,
      );
    });
  },
);

defineSpecialty(
  fabricMeta(
    "specialty.wasm.fabric.wss-is-encrypted-before-it-is-http",
    "A wss:// relay gets a TLS handshake from inside the component, never plaintext HTTP",
    "the first bytes the daemon writes to a wss:// endpoint are a TLS record (0x16 0x03 …), and the plaintext upgrade line never appears",
    [
      "wss is silently downgraded to a plaintext WebSocket",
      "the guest sends the HTTP upgrade before any TLS handshake",
      "TLS is skipped because the guest has no crypto provider",
      "the failure is reported as unsupported instead of being attempted",
    ],
  ),
  async (t) => {
    // A raw socket, not a TLS server: what is being asserted is what the
    // daemon writes first. Finishing the handshake would need a certificate
    // chained to a root the shell trusts, and would prove nothing more about
    // which side of the boundary the encryption happens on.
    const firstBytes: Buffer[] = [];
    const server = createServer((socket: Socket) => {
      socket.once("data", (chunk: Buffer) => {
        firstBytes.push(chunk);
        socket.destroy();
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const relayUrl = `https://127.0.0.1:${portOf(server)}`;

    try {
      await withOpened(t, async (opened) => {
        const attached = await opened.client.call({
          type: "device.remoteAttach",
          payload: { relayUrl, joinToken: null },
        });
        t.assertions.assert(
          attached?.type === "remoteAccess",
          `device.remoteAttach returned ${attached?.type}`,
        );
        await t.tools.waitUntil(() => firstBytes.length > 0, 20_000);
        const opening = firstBytes[0];
        if (!opening) throw new Error("the daemon never wrote anything to the wss endpoint");
        t.assertions.assert(
          opening[0] === 0x16 && opening[1] === 0x03,
          `the daemon opened with ${opening.subarray(0, 16).toString("hex")}, which is not a TLS record`,
        );
        t.assertions.assert(
          !opening.subarray(0, 64).toString("latin1").includes("GET "),
          `the daemon sent a plaintext HTTP request to a wss endpoint: ${opening.subarray(0, 64).toString("latin1")}`,
        );

        // A handshake that cannot be verified must leave the machine offline
        // rather than half-attached: "the relay refused me" and "I am reachable"
        // are the two answers a user acts on differently.
        const devices = await opened.client.call({ type: "device.list" });
        if (devices?.type !== "devices") throw new Error("device.list failed");
        t.assertions.assert(
          devices.data.remote.online !== true,
          `an unverifiable TLS peer was reported as online: ${JSON.stringify(devices.data.remote)}`,
        );
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
