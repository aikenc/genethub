import { existsSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

function authStateCase(id: string, title: string, oracle: string, catches: string[], run: (t: CaseContext, opened: Opened) => Promise<void>): void {
  defineSpecialty({ id: `specialty.authorization.state.${id}`, title, oracle, catches, tags: ["core", "daemon", "authorization-state-depth"], llm: { default: "none" }, expectedDurationMs: 20_000, timeoutMs: 120_000, resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0, pool: "standard" }, surfaces: ["daemon", "workbench-client"], productInterfaces: ["@genehub/workbench/client"] }, async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try { await run(t, opened); } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
  });
}

function devices(reply: unknown): Array<{ id: string; name: string; grants?: string[]; connected: boolean }> {
  const value = reply as { type?: string; data?: { devices?: Array<{ id: string; name: string; grants?: string[]; connected: boolean }> } };
  if (value.type !== "devices" || !Array.isArray(value.data?.devices)) throw new Error(`device.list failed: ${JSON.stringify(reply)}`);
  return value.data.devices;
}

async function list(opened: Opened) { return devices(await opened.client.call({ type: "device.list" })); }
async function reject(action: () => Promise<unknown>, message: string) { try { await action(); } catch { return; } throw new Error(message); }
async function invite(opened: Opened, grants: string[] = []) { const reply = await opened.client.call({ type: "device.invite", payload: grants.length ? { grants } : null }); if (reply?.type !== "invite") throw new Error("invite failed"); return reply.data.code; }

authStateCase("unicode-name", "Device names preserve full Unicode", "device.list returns the exact CJK, Greek, emoji, and combining sequence", ["name encoding loss", "normalization drift"], async (t, opened) => {
  const name = "设备 Ελληνικά 🧬 e\u0301"; const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], name);
  try { t.assertions.assert((await list(opened)).find((item) => item.id === paired.deviceId)?.name === name, "Unicode device name changed"); } finally { paired.client.close(); }
});

authStateCase("long-name", "Long device names are not silently truncated", "a 512-character name is either retained exactly or the claim is explicitly refused", ["silent truncation creates ambiguous identity", "partial UTF-8 name"], async (t, opened) => {
  const name = "device-" + "界".repeat(505); let paired: Awaited<ReturnType<typeof t.flows.main.pairDevice>> | undefined;
  try { paired = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], name); } catch (error) { t.assertions.assert(String(error).length > 0, "long-name refusal lacked error"); return; }
  try { const found = (await list(opened)).find((item) => item.id === paired.deviceId); t.assertions.assert(found?.name === name, `long name changed: ${found?.name.length}`); } finally { paired.client.close(); }
});

authStateCase("disconnect-preserves-authorization", "Disconnecting a device preserves its authorization record", "after a successful read and socket close, the same id, name, and grants remain listed exactly once", ["socket close revokes credential", "disconnect duplicates record", "grants lost on cleanup"], async (t, opened) => {
  const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "connection-state");
  const read = await paired.client.call({ type: "workspace.list" });
  t.assertions.assert(read?.type === "workspaces", "paired device was not usable");
  paired.client.close();
  const matches = (await list(opened)).filter((item) => item.id === paired.deviceId);
  t.assertions.assert(matches.length === 1 && matches[0]?.name === "connection-state" && JSON.stringify(matches[0].grants) === JSON.stringify(["handshake", "read"]), `authorization changed: ${JSON.stringify(matches)}`);
});

authStateCase("reconnect-same-entry", "Reconnect preserves one device-list entry", "the same credential reconnects without duplicating identity", ["reconnect mints new device", "duplicate listing"], async (t, opened) => {
  const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "reconnect-one"); paired.client.close();
  const returning = await t.flows.main.connectDevice(opened.daemon, paired.credential, "reconnect-one");
  try { t.assertions.assert((await list(opened)).filter((item) => item.id === paired.deviceId).length === 1, "reconnect duplicated entry"); } finally { returning.close(); }
});

authStateCase("two-live-connections-one-entry", "Two live sockets for one credential share one identity", "device.list contains one authorization record and both sockets can read", ["socket mistaken for device identity", "second login invalidates first"], async (t, opened) => {
  const first = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "multi-socket"); const second = await t.flows.main.connectDevice(opened.daemon, first.credential, "multi-socket-2");
  try { const replies = await Promise.all([first.client.call({ type: "workspace.list" }), second.call({ type: "workspace.list" })]); t.assertions.assert(replies.every((reply) => reply?.type === "workspaces"), "one socket could not read"); t.assertions.assert((await list(opened)).filter((item) => item.id === first.deviceId).length === 1, "two sockets made two devices"); } finally { first.client.close(); second.close(); }
});

authStateCase("independent-invites", "Two invitations can be claimed independently", "both codes mint different device ids and neither consumes the other", ["single global invite slot", "claim clears all invites"], async (t, opened) => {
  const [a, b] = await Promise.all([invite(opened, ["read"]), invite(opened, ["read"])]); const ca = await t.flows.main.claimDeviceInvite(opened.daemon, a, "invite-a"); const cb = await t.flows.main.claimDeviceInvite(opened.daemon, b, "invite-b"); t.assertions.assert(ca.deviceId !== cb.deviceId, "independent invites shared identity");
});

authStateCase("five-way-claim-one-winner", "Five concurrent claims have exactly one winner", "one credential is minted and one racer appears in device.list", ["claim consume race", "multiple credentials per invite"], async (t, opened) => {
  const code = await invite(opened, ["read"]); const settled = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => t.flows.main.claimDeviceInvite(opened.daemon, code, `five-racer-${index}`))); t.assertions.assert(settled.filter((item) => item.status === "fulfilled").length === 1, `winner count ${JSON.stringify(settled)}`); t.assertions.assert((await list(opened)).filter((item) => item.name.startsWith("five-racer-")).length === 1, "phantom racers listed");
});

authStateCase("wrong-invite-id-preserves-code", "A wrong invite id does not consume the valid code", "the forged id is rejected and the original code remains claimable", ["secret used without invite id", "failed lookup consumes invite"], async (t, opened) => {
  const code = await invite(opened); const dot = code.indexOf("."); const forged = `wrong-${code.slice(0, dot)}${code.slice(dot)}`; await reject(() => t.flows.main.claimDeviceInvite(opened.daemon, forged, "wrong-id"), "wrong invite id accepted"); const claimed = await t.flows.main.claimDeviceInvite(opened.daemon, code, "right-id"); t.assertions.assert(Boolean(claimed.deviceId), "forgery consumed valid invite");
});

authStateCase("repeated-forgeries-preserve-code", "Repeated forged secrets do not exhaust a valid invite", "five bad secrets fail and the original succeeds", ["failure counter destroys invite", "bad secret accepted after retries"], async (t, opened) => {
  const code = await invite(opened); const dot = code.indexOf("."); for (let index = 0; index < 5; index += 1) await reject(() => t.flows.main.claimDeviceInvite(opened.daemon, `${code.slice(0, dot)}.${code.slice(dot + 1)}-bad-${index}`, `bad-${index}`), "forged secret accepted"); const claimed = await t.flows.main.claimDeviceInvite(opened.daemon, code, "after-forgeries"); t.assertions.assert(Boolean(claimed.deviceId), "forgeries consumed invite");
});

authStateCase("revoke-live-immediate", "Revoking a live credential takes effect immediately", "the connected client loses read access without reconnecting", ["revoke only applies on next dial", "authorization cached per socket"], async (t, opened) => {
  const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "live-revoke"); try { await opened.client.call({ type: "device.revoke", payload: { deviceId: paired.deviceId } }); await reject(() => paired.client.call({ type: "workspace.list" }), "revoked live socket still read"); } finally { paired.client.close(); }
});

authStateCase("revoke-removes-list-entry", "Revocation removes the authorization record", "the revoked id disappears from device.list", ["revoke leaves reusable tombstone", "list reports stale authorization"], async (t, opened) => {
  const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "remove-list"); paired.client.close(); await opened.client.call({ type: "device.revoke", payload: { deviceId: paired.deviceId } }); t.assertions.assert(!(await list(opened)).some((item) => item.id === paired.deviceId), "revoked id remained listed");
});

authStateCase("default-invite-can-read", "A default invitation includes usable read access", "the claimed device lists workspaces and its stored grants include handshake and read", ["default invite mints unusable credential", "effective read omitted from listing"], async (t, opened) => {
  const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, [], "default-invite"); try { const reply = await paired.client.call({ type: "workspace.list" }); t.assertions.assert(reply?.type === "workspaces", "default invite could not read"); const found = (await list(opened)).find((item) => item.id === paired.deviceId); t.assertions.assert(found?.grants?.includes("handshake") === true && found.grants.includes("read"), `default grants ${JSON.stringify(found?.grants)}`); } finally { paired.client.close(); }
});

authStateCase("read-cannot-rename", "Read credentials cannot rename workspaces", "workspace.rename is forbidden and the owner still sees the old name", ["read grant escalates to write metadata", "forbidden mutation applied before check"], async (t, opened) => {
  const before = (await opened.client.call({ type: "workspace.list" })); const original = before?.type === "workspaces" ? before.data.find((item) => item.id === opened.workspaceId)?.name : undefined; const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "read-only-rename"); try { await t.assertions.expectProtocolCode(() => paired.client.call({ type: "workspace.rename", payload: { workspaceId: opened.workspaceId, name: "forbidden-name" } }), "forbidden"); const after = await opened.client.call({ type: "workspace.list" }); t.assertions.assert(after?.type === "workspaces" && after.data.find((item) => item.id === opened.workspaceId)?.name === original, "forbidden rename mutated state"); } finally { paired.client.close(); }
});

authStateCase("read-cannot-write-file", "Read credentials cannot write files", "file.write is forbidden and no disk file appears", ["read grant implies files", "permission checked after write"], async (t, opened) => {
  const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "read-no-files"); try { await t.assertions.expectProtocolCode(() => paired.client.call({ type: "file.write", payload: { workspaceId: opened.workspaceId, path: `${opened.rootHandle}/forbidden.txt`, content: "bad" } }), "forbidden"); t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, "forbidden.txt")), "forbidden write reached disk"); } finally { paired.client.close(); }
});

authStateCase("device-list-stable", "Repeated device listings are structurally stable", "twenty reads retain one exact id, name, and grant set", ["list duplicates entries", "grants mutate on read"], async (t, opened) => {
  const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read", "files"], "stable-list"); try { for (let index = 0; index < 20; index += 1) { const matches = (await list(opened)).filter((item) => item.id === paired.deviceId); t.assertions.assert(matches.length === 1 && matches[0]?.name === "stable-list" && JSON.stringify(matches[0].grants) === JSON.stringify(["handshake", "read", "files"]), `listing drift ${index}: ${JSON.stringify(matches)}`); } } finally { paired.client.close(); }
});
