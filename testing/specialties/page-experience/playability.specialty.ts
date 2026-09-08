import { createHash } from "node:crypto";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.playability",
  title: "The shipped Reviewer probe distinguishes a playable start from ready-state and missing-observer failures",
  oracle: "Real Chromium clicks the fixed artifact and exercises movement and firing; the ready-state regression fails start, while unavailable observation is explicitly unverifiable",
  catches: ["declared features substitute for runtime evidence", "start leaves ready but review passes", "missing instrumentation is reported as passed"],
  tags: ["page-experience", "workflow-control"], runner: "playwright",
  expectedDurationMs: 15_000, timeoutMs: 90_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 1, pool: "browser" },
  surfaces: ["browser", "bootstrap-pack"], productInterfaces: ["game-reviewer/scripts/check-playability.mjs", "gameTestSnapshot"],
}, async t => {
  symlinkSync(path.join(t.openRoot, "testing/node_modules"), path.join(t.env.workspace, "node_modules"), "dir");
  const script = path.join(t.openRoot, "apps/daemon/bootstrap-packs/game-delivery-v1/spaces/reviewer/skills/game-reviewer/scripts/check-playability.mjs");
  for (const variant of ["healthy", "ready", "unobservable"] as const) {
    const entry = path.join(t.env.workspace, variant + ".html");
    const html = `<!doctype html><html><body><button id="start">开始战斗</button><script>
let state='ready', x=0, shots=0;
document.querySelector('#start').onclick=()=>{${variant === "ready" ? "" : "state='playing';"}};
addEventListener('keydown',e=>{if(state!=='playing')return;if(e.code==='ArrowRight')x++;if(e.code==='Space')shots++;});
${variant === "unobservable" ? "" : "window.gameTestSnapshot=()=>({state,player:{x},shotsFired:shots});"}
</script></body></html>`;
    writeFileSync(entry, html);
    const contract = path.join(t.env.workspace, variant + ".json");
    writeFileSync(contract, JSON.stringify({ entry, sha256: createHash("sha256").update(html).digest("hex"), startSelector: "#start" }));
    const result = spawnSync(process.execPath, [script, contract], { cwd: t.env.workspace, env: process.env, encoding: "utf8", timeout: 45_000 });
    let report: { status: string; checks: Array<{ name: string; passed: boolean }>; error?: string; coverage?: string };
    try { report = JSON.parse(result.stdout.trim()); } catch { throw new Error(`probe omitted JSON: ${result.stderr || result.stdout}`); }
    if (variant === "healthy") {
      t.assertions.assert(result.status === 0 && report.status === "passed" && report.checks.length === 3, `healthy fixture failed: ${JSON.stringify(report)}`);
      t.assertions.assert(report.coverage?.includes("only"), "probe overstated level/Boss/item coverage");
    } else if (variant === "ready") t.assertions.assert(result.status !== 0 && report.status === "failed" && report.checks[0]?.name === "start" && !report.checks[0]?.passed, "ready regression escaped the runtime start check");
    else t.assertions.assert(result.status !== 0 && report.status === "unverifiable" && report.error?.includes("gameTestSnapshot"), "missing observer was not explicitly unverifiable");
    t.note(`${variant}: ${report.status}`);
  }
  t.assertions.assert(readFileSync(script, "utf8").includes("game-playability.v1"), "probe no longer declares its result contract");
});
