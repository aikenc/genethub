import { describe, expect, it, vi } from "vitest";

import {
  FabricConnectionError,
  FabricStateError,
  type FabricReconnectOptions,
  type FabricSocketCloseEvent,
  type FabricSocketLike,
} from "./endpoint";
import {
  decodeFabricFrame,
  decodeFabricOpenPayload,
  encodeFabricFrame,
  FabricKind,
  type FabricFrame,
} from "./frame";
import { HubFabricApiError, HubWorkspaceFabric } from "./hub-workspaces";

const id = (value: number) => value.toString(16).padStart(32, "0");
const bytes = (value = "") => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

class FakeSocket implements FabricSocketLike {
  binaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: FabricSocketCloseEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: Uint8Array[] = [];

  send(data: Uint8Array): void {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(data.slice());
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  peerClose(code = 1006, reason = "network lost"): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  receive(frame: FabricFrame): void {
    // Adapter tests only need stale-epoch delivery; endpoint tests cover the
    // full inbound state machine.
    this.onmessage?.({ data: encodeFabricFrame(frame) });
  }
}

class ManualReconnectTimer {
  readonly delays: number[] = [];
  private readonly pending: Array<{
    handle: object;
    callback: () => void;
    cancelled: boolean;
  }> = [];

  readonly timer: NonNullable<FabricReconnectOptions["timer"]> = {
    set: (callback, delayMs) => {
      const task = { handle: {}, callback, cancelled: false };
      this.delays.push(delayMs);
      this.pending.push(task);
      return task.handle;
    },
    clear: (handle) => {
      const task = this.pending.find((candidate) => candidate.handle === handle);
      if (task) task.cancelled = true;
    },
  };

  get activeCount(): number {
    return this.pending.filter((task) => !task.cancelled).length;
  }

  runNext(): void {
    const task = this.pending.find((candidate) => !candidate.cancelled);
    if (!task) throw new Error("no reconnect timer is pending");
    task.cancelled = true;
    task.callback();
  }
}

interface RequestCall {
  path: string;
  init: RequestInit;
  body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function admission(endpointId: string, ticket: string) {
  return {
    endpointId,
    url: `wss://relay.test/fabric/v2?ticket=${ticket}`,
    admissionExpiresAt: "2099-01-01T00:00:00.000Z",
    endpointExpiresAt: "2099-01-02T00:00:00.000Z",
  };
}

function route(workspaceId: string) {
  return {
    routeTicket: `route:${workspaceId}`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    operationExpiresAt: "2099-01-01T00:05:00.000Z",
    placementRevision: 4,
    targetFingerprint: `fp:${workspaceId}`,
  };
}

function api(
  handler: (call: RequestCall) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: RequestCall[] } {
  const calls: RequestCall[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const raw = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const call = { path: String(input), init, body: raw };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function client(
  fetch: typeof globalThis.fetch,
  ids: string[],
  baseUrl?: string,
  reconnect?: FabricReconnectOptions | false,
): { fabric: HubWorkspaceFabric; sockets: FakeSocket[]; urls: string[] } {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const fabric = new HubWorkspaceFabric({
    fetch,
    ...(baseUrl ? { baseUrl } : {}),
    ...(reconnect === undefined ? {} : { reconnect }),
    streamId: () => {
      const next = ids.shift();
      if (!next) throw new Error("test ran out of ids");
      return next;
    },
    socketFactory: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { fabric, sockets, urls };
}

async function establish(
  fabric: HubWorkspaceFabric,
  sockets: FakeSocket[],
  index = 0,
): Promise<FakeSocket> {
  const connecting = fabric.connect();
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(index));
  const socket = sockets[index]!;
  socket.open();
  await connecting;
  return socket;
}

function frames(socket: FakeSocket) {
  return socket.sent.map((wire) => {
    const frame = decodeFabricFrame(wire);
    if (!frame) throw new Error("SDK emitted an invalid frame");
    return frame;
  });
}

describe("the resource-first Hub workspace Fabric adapter", () => {
  it("aborts a hung endpoint issue at the total HTTP deadline", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetch = vi.fn((_input: RequestInfo | URL, init: RequestInit = {}) => {
        signals.push(init.signal as AbortSignal);
        return new Promise<Response>(() => {});
      }) as unknown as typeof globalThis.fetch;
      const fabric = new HubWorkspaceFabric({ fetch, requestTimeoutMs: 25 });
      const connecting = fabric.connect();
      const rejected = expect(connecting).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(signals[0]?.aborted).toBe(true);
      fabric.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists logical workspaces and opens two of them over one endpoint socket", async () => {
    const hub = api(({ path, body }) => {
      if (path === "/app/workspaces") {
        return json({
          workspaces: [
            {
              id: "ws_alpha",
              name: "Alpha",
              availability: "online",
              lastSeenAt: "2026-08-04T00:00:00.000Z",
              revision: 2,
            },
            {
              id: "ws_beta",
              name: "Beta",
              availability: "offline",
              lastSeenAt: null,
              revision: 1,
            },
          ],
        });
      }
      if (path === "/app/fabric/endpoints") return json(admission("fep_one", "admit-1"));
      if (path === "/app/fabric/routes") {
        const target = (body as { target: { workspaceId: string } }).target.workspaceId;
        return json(route(target));
      }
      return json({ error: "not_found" }, 404);
    });
    const stack = client(hub.fetch, [id(1), id(2)]);
    const socket = await establish(stack.fabric, stack.sockets);

    expect(await stack.fabric.directory()).toEqual([
      {
        id: "ws_alpha",
        name: "Alpha",
        availability: "online",
        lastSeenAt: "2026-08-04T00:00:00.000Z",
        revision: 2,
      },
      {
        id: "ws_beta",
        name: "Beta",
        availability: "offline",
        lastSeenAt: null,
        revision: 1,
      },
    ]);

    const [alpha, beta] = await Promise.all([
      stack.fabric.openWorkspace("ws_alpha", bytes("hello-alpha")),
      stack.fabric.openWorkspace("ws_beta", bytes("hello-beta")),
    ]);
    expect(stack.sockets).toHaveLength(1);
    expect(alpha.stream.id).toBe(id(1));
    expect(beta.stream.id).toBe(id(2));
    expect(alpha.route.targetFingerprint).toBe("fp:ws_alpha");

    const opened = frames(socket);
    expect(opened.map((frame) => frame.kind)).toEqual([FabricKind.Open, FabricKind.Open]);
    expect(
      opened.map((frame) => {
        const payload = decodeFabricOpenPayload(frame.payload);
        return payload && {
          routeTicket: payload.routeTicket,
          opaqueHello: text(payload.opaqueHello),
        };
      }),
    ).toEqual([
      { routeTicket: "route:ws_alpha", opaqueHello: "hello-alpha" },
      { routeTicket: "route:ws_beta", opaqueHello: "hello-beta" },
    ]);

    const endpointCalls = hub.calls.filter((call) => call.path === "/app/fabric/endpoints");
    expect(endpointCalls).toHaveLength(1);
    expect(endpointCalls[0]?.body).toEqual({});
    const routes = hub.calls.filter((call) => call.path === "/app/fabric/routes");
    expect(routes.map((call) => call.body)).toEqual([
      { sourceEndpointId: "fep_one", target: { workspaceId: "ws_alpha" } },
      { sourceEndpointId: "fep_one", target: { workspaceId: "ws_beta" } },
    ]);
    // Resource changes affected only OPENs; no target was ever put in a socket URL.
    expect(stack.urls).toEqual(["wss://relay.test/fabric/v2?ticket=admit-1"]);
    stack.fabric.close();
  });

  it("keeps every Hub API below a reverse-proxy deployment subpath", async () => {
    const prefix = "https://hub.test/relay-dev-0";
    const hub = api(({ path, body }) => {
      if (path === `${prefix}/app/fabric/endpoints`) {
        return json(admission("fep_subpath", "admit"));
      }
      if (path === `${prefix}/app/workspaces`) return json({ workspaces: [] });
      if (path === `${prefix}/app/fabric/routes`) {
        const workspaceId = (body as { target: { workspaceId: string } }).target.workspaceId;
        return json(route(workspaceId));
      }
      return json({ error: "escaped_deployment_prefix" }, 404);
    });
    const stack = client(hub.fetch, [id(1)], `${prefix}/`);
    await establish(stack.fabric, stack.sockets);

    expect(await stack.fabric.directory()).toEqual([]);
    await stack.fabric.openWorkspace("ws_under_prefix");
    expect(hub.calls.map((call) => call.path)).toEqual([
      `${prefix}/app/fabric/endpoints`,
      `${prefix}/app/workspaces`,
      `${prefix}/app/fabric/routes`,
    ]);
    stack.fabric.close();
  });

  it("fails old streams and automatically renews one admission without replay", async () => {
    const timers = new ManualReconnectTimer();
    let endpointIssue = 0;
    const hub = api(({ path, body }) => {
      if (path === "/app/fabric/endpoints") {
        endpointIssue += 1;
        return json(admission("fep_stable", `admit-${endpointIssue}`));
      }
      if (path === "/app/fabric/routes") {
        const workspaceId = (body as { target: { workspaceId: string } }).target.workspaceId;
        return json(route(workspaceId));
      }
      return json({ workspaces: [] });
    });
    const stack = client(hub.fetch, [id(11), id(12)], undefined, {
      initialDelayMs: 25,
      maxDelayMs: 25,
      jitterRatio: 0,
      timer: timers.timer,
    });
    const oldSocket = await establish(stack.fabric, stack.sockets);
    const old = await stack.fabric.openWorkspace("ws_old");
    const oldDone = old.stream.done;

    oldSocket.peerClose(1006, "wifi changed");
    const outcome = await oldDone;
    expect(outcome.type).toBe("connectionClosed");
    if (outcome.type !== "connectionClosed") throw new Error("expected disconnect");
    expect(outcome.error).toBeInstanceOf(FabricConnectionError);
    expect(stack.fabric.connectionState).toBe("closed");
    expect(timers.delays).toEqual([25]);

    const before = hub.calls.length;
    await expect(stack.fabric.openWorkspace("ws_no_implicit_retry")).rejects.toBeInstanceOf(
      FabricStateError,
    );
    expect(hub.calls).toHaveLength(before);
    expect(stack.sockets).toHaveLength(1);

    timers.runNext();
    await vi.waitFor(() => expect(stack.sockets).toHaveLength(2));
    const freshSocket = stack.sockets[1]!;
    freshSocket.open();
    await vi.waitFor(() => expect(stack.fabric.connectionState).toBe("open"));
    expect(hub.calls.filter((call) => call.path === "/app/fabric/endpoints").map((call) => call.body)).toEqual([
      {},
      { endpointId: "fep_stable" },
    ]);
    expect(stack.urls.at(-1)).toBe("wss://relay.test/fabric/v2?ticket=admit-2");
    expect(freshSocket.sent).toHaveLength(0);

    // Even a deliberately delivered old-epoch frame cannot attach itself to
    // the new socket or cause a reply there.
    oldSocket.receive({
      kind: FabricKind.Data,
      streamId: old.stream.id,
      value: 1n,
      payload: bytes("late"),
    });
    await Promise.resolve();
    expect(freshSocket.sent).toHaveLength(0);

    const fresh = await stack.fabric.openWorkspace("ws_fresh");
    expect(fresh.stream.id).toBe(id(12));
    expect(freshSocket.sent).toHaveLength(1);
    stack.fabric.close();
  });

  it.each([4403, 4408] as const)(
    "does not ask the Hub for another admission after terminal close %i",
    async (code) => {
      const timers = new ManualReconnectTimer();
      let endpointIssue = 0;
      const hub = api(({ path }) => {
        if (path === "/app/fabric/endpoints") {
          endpointIssue += 1;
          return json(admission("fep_terminal", `admit-${endpointIssue}`));
        }
        return json({ workspaces: [] });
      });
      const stack = client(hub.fetch, [], undefined, { timer: timers.timer });
      const socket = await establish(stack.fabric, stack.sockets);

      socket.peerClose(code, code === 4403 ? "revoked" : "expired");
      expect(stack.fabric.connectionState).toBe("closed");
      expect(timers.activeCount).toBe(0);
      await expect(stack.fabric.connect()).rejects.toMatchObject({ code });
      expect(endpointIssue).toBe(1);
      expect(stack.sockets).toHaveLength(1);
      stack.fabric.close();
    },
  );

  it("abandons an expired one-shot route without sending OPEN", async () => {
    const hub = api(({ path }) => {
      if (path === "/app/fabric/endpoints") return json(admission("fep_one", "admit"));
      if (path === "/app/fabric/routes") {
        return json({ ...route("ws_old"), expiresAt: "2000-01-01T00:00:00.000Z" });
      }
      return json({ workspaces: [] });
    });
    const stack = client(hub.fetch, [id(1)]);
    const socket = await establish(stack.fabric, stack.sockets);

    await expect(stack.fabric.openWorkspace("ws_old")).rejects.toMatchObject({
      code: "fabric_route_expired",
    });
    expect(socket.sent).toHaveLength(0);
    expect(stack.fabric.connectionState).toBe("open");
    stack.fabric.close();
  });

  it("does not start an operation whose execution deadline already passed", async () => {
    const hub = api(({ path }) => {
      if (path === "/app/fabric/endpoints") return json(admission("fep_one", "admit"));
      if (path === "/app/fabric/routes") {
        return json({
          ...route("ws_old"),
          operationExpiresAt: "2000-01-01T00:00:00.000Z",
        });
      }
      return json({ workspaces: [] });
    });
    const stack = client(hub.fetch, [id(1)]);
    const socket = await establish(stack.fabric, stack.sockets);

    await expect(stack.fabric.openWorkspace("ws_old")).rejects.toMatchObject({
      code: "fabric_operation_expired",
    });
    expect(socket.sent).toHaveLength(0);
    stack.fabric.close();
  });

  it("refuses a resumed admission that silently changes endpoint identity", async () => {
    const timers = new ManualReconnectTimer();
    let attempt = 0;
    const hub = api(({ path }) => {
      if (path !== "/app/fabric/endpoints") return json({ workspaces: [] });
      attempt += 1;
      return json(
        attempt === 1
          ? admission("fep_original", "first")
          : admission("fep_different", "second"),
      );
    });
    const stack = client(hub.fetch, [], undefined, {
      initialDelayMs: 1,
      maxDelayMs: 1,
      jitterRatio: 0,
      timer: timers.timer,
    });
    const socket = await establish(stack.fabric, stack.sockets);
    socket.peerClose();

    const resumed = stack.fabric.connect();
    timers.runNext();
    await expect(resumed).rejects.toBeInstanceOf(HubFabricApiError);
    await expect(resumed).rejects.toMatchObject({
      code: "fabric_endpoint_identity_changed",
      status: 502,
    });
    expect(stack.sockets).toHaveLength(1);
    stack.fabric.close();
  });

  it("preserves structured Hub route failures without opening a stream", async () => {
    const hub = api(({ path }) => {
      if (path === "/app/fabric/endpoints") return json(admission("fep_one", "admit"));
      if (path === "/app/fabric/routes") return json({ error: "target_offline" }, 409);
      return json({ workspaces: [] });
    });
    const stack = client(hub.fetch, [id(1)]);
    const socket = await establish(stack.fabric, stack.sockets);

    await expect(stack.fabric.openWorkspace("ws_offline")).rejects.toMatchObject({
      status: 409,
      code: "target_offline",
    });
    expect(socket.sent).toHaveLength(0);
    stack.fabric.close();
  });
});
