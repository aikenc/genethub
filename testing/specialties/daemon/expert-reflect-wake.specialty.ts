import { existsSync, readFileSync, readdirSync } from "node:fs";
import { defineSpecialty, openTeam, type CaseContext } from "../../framework/public.ts";
type Team = Awaited<ReturnType<typeof openTeam>>;
function reflectCase(id: string, oracle: string, run: (t: CaseContext, r: Team) => Promise<void>) {
  defineSpecialty({ id: `specialty.daemon.${id}`, title: id, oracle, catches: [oracle],
    tags: ["core", "expert", "merge-remediation"], llm: { default: "none" }, expectedDurationMs: 25000,
    timeoutMs: 180000, surfaces: ["daemon", "tools/team.py", "genet-cli"],
  }, async t => { const r = await openTeam(t); try { await run(t, r); } finally { await r.dispose(); } });
}
const pending = (r: Team) => existsSync(r.state("pending")) ? readdirSync(r.state("pending")).filter(f => f.endsWith(".json")).map(f => JSON.parse(readFileSync(r.state("pending", f), "utf8"))) : [];
reflectCase("expert-reflect-wake", "real completed Human rounds trigger one reflection at its configured threshold and its persisted gap prevents repeated starts", async (t, r) => {
  for (const prompt of ["first round", "second round"]) {
    await r.send(r.front, prompt); await t.tools.waitUntil(async () => (await r.snapshot(r.front)).summary.status === "idle", 20000);
  }
  r.ok(["hook"], { TEAM_WAKE_ROUNDS: "2", TEAM_WAKE_CHECK: "0", TEAM_WAKE_GAP: "600" });
  const state = JSON.parse(readFileSync(r.state("reflect.json"), "utf8"));
  t.assertions.assert(state.sessionId, "completed real rounds did not wake reflection");
  r.ok(["hook"], { TEAM_WAKE_ROUNDS: "2", TEAM_WAKE_CHECK: "0", TEAM_WAKE_GAP: "600" });
  t.assertions.assert(JSON.parse(readFileSync(r.state("reflect.json"), "utf8")).sessionId === state.sessionId, "one threshold woke twice");
});
reflectCase("expert-reflect-now", "reflect now starts through real CLI and routes a subsequent request to the existing running reflection; tell-user is explicitly system-attributed", async (t, r) => {
  const out = r.ok(["reflect", "now", "--model", "fixture", "立即检查入口"], { TEAM_AGENT: "ctl-accept-then-silent", GENEHUB_SESSION_ID: r.front });
  const id = /s_[0-9a-f]+/.exec(out)?.[0]; t.assertions.assert(id, "no reflection Session");
  await t.tools.waitUntil(async () => (await r.snapshot(id!)).summary.status === "running", 20000);
  r.ok(["reflect", "now", "--model", "fixture", "再保留设置"], { TEAM_AGENT: "ctl-accept-then-silent", GENEHUB_SESSION_ID: r.front });
  t.assertions.assert(pending(r).filter(row => row.kind === "reflect" || row.kind === "team-reflect").length === 1, "busy reflection duplicated");
  r.ok(["tell-user", "需要用户判断的进展"]);
  await t.tools.waitUntil(async () => (await r.snapshot(r.front)).items.some(item => item.type === "userMessage" && item.text.includes("需要用户判断的进展") && item.origin?.sessionId === "system"), 20000);
});
reflectCase("expert-three-law-team-relay", "real parallel children share a Human round batch, stay pending while parent is running, then report once without undoing an explicit pause", async (t, r) => {
  await r.send(r.front, "Please delegate this round");
  await t.tools.waitUntil(async () => (await r.snapshot(r.front)).summary.status === "idle", 20000);
  const children: string[] = [];
  for (const name of ["first", "second"]) {
    const out = r.ok(["spawn", "--kind", "research", "--desc", name, "--model", "fixture", "research"], { GENEHUB_SESSION_ID: r.front });
    children.push(/s_[0-9a-f]+/.exec(out)![0]);
  }
  for (const id of children) await t.tools.waitUntil(async () => (await r.snapshot(id)).summary.status === "idle", 20000);
  const rows = pending(r); t.assertions.assert(rows.length === 2 && rows[0].batch === rows[1].batch, "children did not inherit a real round batch");
  await r.client.call({ type: "session.interrupt", payload: { sessionId: r.front } });
  r.ok(["hook"]);
  t.assertions.assert((await r.snapshot(r.front)).summary.inputSummary?.paused, "child results undid Human pause");
  await r.send(r.front, "Please continue");
  await t.tools.waitUntil(async () => (await r.snapshot(r.front)).summary.status === "idle", 20000);
  r.ok(["hook"]);
  t.assertions.assert(children.every(id => !existsSync(r.state("pending", `${id}.json`))), "completed batch did not drain");
});
