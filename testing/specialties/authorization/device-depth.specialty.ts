import { defineSpecialty, genetEnv, locateGenet, runGenet, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

function authCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext, opened: Opened) => Promise<void>,
): void {
  defineSpecialty(
    {
      id,
      title,
      oracle,
      catches,
      tags: ["core", "daemon", "authorization-depth"],
      llm: { default: "none" },
      expectedDurationMs: 20_000,
      timeoutMs: 90_000,
      resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0, pool: "standard" },
      surfaces: ["daemon", "workbench-client"],
      productInterfaces: ["@genehub/workbench/client"],
    },
    async (t) => {
      const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      try {
        await run(t, opened);
      } finally {
        opened.client.close();
        opened.daemon.stop();
        await opened.mock.stop();
      }
    },
  );
}

function devicesOf(reply: unknown): Array<{ id: string; name: string; grants?: string[]; connected: boolean }> {
  const typed = reply as { type?: string; data?: { devices?: Array<{ id: string; name: string; grants?: string[]; connected: boolean }> } };
  if (typed.type !== "devices" || !Array.isArray(typed.data?.devices)) {
    throw new Error(`device.list failed: ${JSON.stringify(reply)}`);
  }
  return typed.data.devices;
}

async function inviteCode(opened: Opened, grants: string[] = []): Promise<string> {
  const reply = await opened.client.call({ type: "device.invite", payload: grants.length ? { grants } : null });
  if (reply?.type !== "invite") throw new Error(`device.invite failed: ${JSON.stringify(reply)}`);
  return reply.data.code;
}

async function mustReject(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(message);
}

function restartDaemon(t: CaseContext): void {
  const genet = locateGenet(t.openRoot);
  const env = genetEnv(t.openRoot, t.env.env);
  const result = runGenet(genet, ["daemon", "restart"], env);
  if (result.code !== 0) throw new Error(`daemon restart failed: ${result.stderr || result.stdout}`);
}

authCase(
  "specialty.authorization.multiple-devices-unique",
  "Multiple authorized devices retain distinct identities and grants",
  "device.list contains both exact names under different ids with their independent grant sets",
  ["device name used as identity", "later claim overwrites earlier device", "grants copied between devices"],
  async (t, opened) => {
    const first = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "shared-name");
    const second = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read", "files"], "shared-name");
    try {
      t.assertions.assert(first.deviceId !== second.deviceId, "duplicate display names reused a device id");
      const listed = devicesOf(await opened.client.call({ type: "device.list" }));
      const a = listed.find((entry) => entry.id === first.deviceId);
      const b = listed.find((entry) => entry.id === second.deviceId);
      t.assertions.assert(a?.name === "shared-name" && b?.name === "shared-name", `missing devices: ${JSON.stringify(listed)}`);
      t.assertions.assert(JSON.stringify(a?.grants) === JSON.stringify(["handshake", "read"]), `wrong first grants: ${JSON.stringify(a)}`);
      t.assertions.assert(JSON.stringify(b?.grants) === JSON.stringify(["handshake", "read", "files"]), `wrong second grants: ${JSON.stringify(b)}`);
    } finally {
      first.client.close(); second.client.close();
    }
  },
);

authCase(
  "specialty.authorization.invite-single-use",
  "An invitation can be claimed exactly once",
  "the first claim returns a credential and replaying the same code is rejected",
  ["invite retained after claim", "claim replay issues a second credential"],
  async (t, opened) => {
    const code = await inviteCode(opened, ["read"]);
    const credential = await t.flows.main.claimDeviceInvite(opened.daemon, code, "first-claim");
    t.assertions.assert(Boolean(credential.deviceId && credential.secret), "first claim did not return a credential");
    await mustReject(
      () => t.flows.main.claimDeviceInvite(opened.daemon, code, "replay"),
      "a consumed invitation was accepted twice",
    );
  },
);

authCase(
  "specialty.authorization.wrong-secret-preserves-invite",
  "A wrong invite secret neither claims nor destroys the invitation",
  "the forged code is rejected and the original code remains claimable afterward",
  ["secret ignored", "failed authentication consumes legitimate invite", "invite id alone authorizes claim"],
  async (t, opened) => {
    const code = await inviteCode(opened);
    const split = code.indexOf(".");
    const forged = `${code.slice(0, split)}.${code.slice(split + 1)}-wrong`;
    await mustReject(() => t.flows.main.claimDeviceInvite(opened.daemon, forged, "forged"), "wrong secret was accepted");
    const credential = await t.flows.main.claimDeviceInvite(opened.daemon, code, "legitimate");
    t.assertions.assert(Boolean(credential.deviceId), "failed attempt destroyed the valid invite");
  },
);

authCase(
  "specialty.authorization.credential-survives-restart",
  "A paired credential remains valid across daemon restart",
  "the same device id reconnects and lists workspaces after restart",
  ["authorized devices only in memory", "restart rotates device secret", "reconnect silently becomes owner"],
  async (t, opened) => {
    const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "persistent");
    paired.client.close();
    restartDaemon(t);
    const returning = await t.flows.main.connectDevice(opened.daemon, paired.credential, "persistent");
    try {
      const reply = await returning.call({ type: "workspace.list" });
      t.assertions.assert(reply?.type === "workspaces", "stored credential did not survive restart");
      const listed = devicesOf(await opened.client.call({ type: "device.list" }));
      t.assertions.assert(listed.some((entry) => entry.id === paired.deviceId), "restart replaced device identity");
    } finally { returning.close(); }
  },
);

authCase(
  "specialty.authorization.revoke-persists-restart",
  "Revocation remains effective after daemon restart",
  "a revoked stored credential cannot reconnect after the daemon restarts",
  ["revocation only disconnects current socket", "restart resurrects authorization", "stale credential cache accepted"],
  async (t, opened) => {
    const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "revoked");
    paired.client.close();
    await opened.client.call({ type: "device.revoke", payload: { deviceId: paired.deviceId } });
    restartDaemon(t);
    await mustReject(
      () => t.flows.main.connectDevice(opened.daemon, paired.credential, "revoked-return"),
      "revoked credential reconnected after restart",
    );
  },
);

authCase(
  "specialty.authorization.revoke-isolated",
  "Revoking one device does not disturb another",
  "the target loses access while a separately paired device remains ready and authorized",
  ["global authorization epoch invalidates peers", "wrong device removed", "revoke restarts transport"],
  async (t, opened) => {
    const target = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "target");
    const survivor = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "survivor");
    try {
      await opened.client.call({ type: "device.revoke", payload: { deviceId: target.deviceId } });
      await mustReject(() => target.client.call({ type: "workspace.list" }), "revoked target still acted");
      const reply = await survivor.client.call({ type: "workspace.list" });
      t.assertions.assert(reply?.type === "workspaces", "unrelated device was disrupted by revoke");
    } finally { target.client.close(); survivor.client.close(); }
  },
);

authCase(
  "specialty.authorization.list-does-not-leak-secrets",
  "Authorized-device listings do not expose credentials",
  "serialized device.list output contains identity and grants but neither credential secret nor invite code",
  ["credential serialized in DeviceInfo", "invite code retained in listing", "secret hidden only by TypeScript type"],
  async (t, opened) => {
    const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "private");
    try {
      const reply = await opened.client.call({ type: "device.list" });
      const serialized = JSON.stringify(reply);
      t.assertions.assert(serialized.includes(paired.deviceId), "listing omitted paired identity");
      t.assertions.assert(!serialized.includes(paired.credential.secret), "device.list leaked credential secret");
      t.assertions.assert(!/\"secret\"|\"code\"/.test(serialized), `listing exposed credential-shaped field: ${serialized}`);
    } finally { paired.client.close(); }
  },
);

authCase(
  "specialty.authorization.narrow-device-cannot-administer",
  "A read-only device cannot administer device authorization",
  "device.list, device.invite, and device.revoke are all rejected for the narrow credential",
  ["read grant implies device administration", "list leaks peer identities", "revoke lacks owner check"],
  async (t, opened) => {
    const narrow = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "narrow");
    try {
      await t.assertions.expectProtocolCode(() => narrow.client.call({ type: "device.list" }), "forbidden");
      await t.assertions.expectProtocolCode(
        () => narrow.client.call({ type: "device.invite", payload: null }),
        "forbidden",
      );
      await t.assertions.expectProtocolCode(
        () => narrow.client.call({ type: "device.revoke", payload: { deviceId: narrow.deviceId } }),
        "forbidden",
      );
    } finally { narrow.client.close(); }
  },
);

authCase(
  "specialty.authorization.concurrent-claim-single-winner",
  "Concurrent claims on one invitation produce one winner",
  "exactly one claimant receives a credential and device.list records exactly that one authorization",
  ["claim check and consume race", "two credentials minted for one invite", "losing claim leaves phantom device"],
  async (t, opened) => {
    const code = await inviteCode(opened, ["read"]);
    const settled = await Promise.allSettled([
      t.flows.main.claimDeviceInvite(opened.daemon, code, "racer-a"),
      t.flows.main.claimDeviceInvite(opened.daemon, code, "racer-b"),
    ]);
    const winners = settled.filter((entry) => entry.status === "fulfilled");
    t.assertions.assert(winners.length === 1, `expected one claim winner: ${JSON.stringify(settled)}`);
    const listed = devicesOf(await opened.client.call({ type: "device.list" }));
    const racers = listed.filter((entry) => entry.name === "racer-a" || entry.name === "racer-b");
    t.assertions.assert(racers.length === 1, `claim race created ${racers.length} devices`);
  },
);
