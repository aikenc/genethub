#!/usr/bin/env node
import { watchInputs } from "../infrastructure/engine/input-watch.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { catalogDigest, loadCatalog } from "../infrastructure/engine/catalog.ts";
import { artifactBundleIdentity, artifactIdentity, repoIdentity, runsIgnored, snapshotHasher } from "../infrastructure/engine/git.ts";
import { planCases } from "../infrastructure/engine/planner.ts";
import { addResult, emptyCounts, rollupStatus } from "../infrastructure/engine/result.ts";
import {
  claimNext,
  completeUnit,
  createScheduler,
  defaultBudget,
  hasClaimable,
} from "../infrastructure/engine/scheduler.ts";
import { runNodeUnit } from "../infrastructure/adapters/node.ts";
import { runRustLegacyUnit } from "../infrastructure/adapters/rust-legacy.ts";
import { preflight, digest } from "../infrastructure/engine/preflight.ts";
import { reusableResults } from "../infrastructure/engine/resume.ts";
import { createRunStore, readRunResults } from "../infrastructure/evidence/run-store.ts";
import { parseSummaryLanguage, renderRunSummary } from "../infrastructure/evidence/summary.ts";
import { checkGovernance } from "../infrastructure/lint/governance.ts";
import { lintLayers } from "../infrastructure/lint/layers.ts";
import { parseGate, qualificationReasons } from "../policies/gates.ts";
import {
  POLICY_VERSION,
  RUNNER_VERSION,
  type RunProgress,
  type RunManifest,
  type UnitResult,
  type WorkUnit,
} from "../infrastructure/types.ts";

const TESTING_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPEN_DEFAULT = path.resolve(TESTING_ROOT, "..");

function flag(args: string[], name: string, fallback = ""): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  return args[index + 1] ?? fallback;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function valuesOf(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1]) out.push(args[i + 1]!);
  }
  return out;
}

function usage(): string {
  return `testctl <capabilities|lint|governance|plan|run|inspect|compare|list|prune> [options]
  capabilities
  lint [--open <path>] [--cloud <path>]
  governance check [--open <path>] [--cloud <path>]
  plan --gate <gate> [--open <path>] [--cloud <path>] [--tags <tag>] [--case <id>] [--reason <scope explanation>]
  run --space <abs> --gate <gate> --topic <slug> [--environments 16] [--summary-language <en|zh-CN>] [--open] [--cloud] [--max-run-ms] [--case <id>|--tags <tag>] [--reason <text>] [--resume <finalized-run>]
  dev-feedback requires explicit --case/--tags and --reason; it is scoped evidence, never full release qualification.
  Selected dependencies are checked before execution. Progress is on stderr and inspect works while running.
  --resume creates new evidence; only matching passed results are reused, failed/unstable retries are refused.
  inspect --run <abs> [--failed|--case <id>]
  compare --base <run> --candidate <run>
  list --space <abs>
  prune --space <abs> --before <yyyy-mm-dd> --apply
`;
}

async function runUnit(unit: WorkUnit, extraEnv: Record<string, string>, openRoot: string): Promise<UnitResult> {
  if (unit.meta.runner === "playwright") {
    const { runPlaywrightUnit } = await import("../infrastructure/adapters/playwright.ts");
    return runPlaywrightUnit(unit, extraEnv);
  }
  if (unit.meta.runner === "rust-legacy") return runRustLegacyUnit(unit, openRoot);
  return runNodeUnit(unit, extraEnv);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "";
  let args = argv.slice(1);
  let sub = "";
  if (command === "governance") {
    sub = args[0] ?? "";
    args = args.slice(1);
  }
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(usage());
    return 0;
  }
  const openRoot = flag(args, "--open", OPEN_DEFAULT);
  const cloudRoot = flag(args, "--cloud") || undefined;

  if (command === "capabilities") {
    process.stdout.write(`${JSON.stringify({ schema: "genehub.test-capabilities.v1", runnerVersion: RUNNER_VERSION,
      policyVersion: POLICY_VERSION, feedbackGate: "dev-feedback", explicitSelection: true, preflight: true,
      liveInspect: true, resume: "matching-passed-only" }, null, 2)}\n`);
    return 0;
  }

  if (command === "lint") {
    const findings = lintLayers(openRoot, cloudRoot);
    process.stdout.write(`${JSON.stringify({ ok: findings.length === 0, findings }, null, 2)}\n`);
    return findings.length === 0 ? 0 : 2;
  }

  if (command === "governance") {
    if (sub !== "check") {
      process.stderr.write("usage: testctl governance check\n");
      return 2;
    }
    const report = checkGovernance(openRoot, cloudRoot);
    if (report.digest === "missing-governance-docs") report.findings.push({ rule: "governance-documents", file: cloudRoot ?? "", message: "both engineering-principles.md and engineering-laws.md are required; use absolute repository paths" });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.digest === "missing-governance-docs") {
      process.stderr.write("governance documents unavailable; pass absolute --open and --cloud repository paths (npm --prefix changes cwd)\n");
      return 2;
    }
    return report.findings.length === 0 ? 0 : 2;
  }

  if (command === "plan") {
    const gate = parseGate(flag(args, "--gate", "change"));
    const cases = await loadCatalog({ openRoot, cloudRoot });
    const plan = planCases(cases, gate, valuesOf(args, "--tags"), valuesOf(args, "--case"), flag(args, "--reason"));
    process.stdout.write(
      `${JSON.stringify({ gate, scope: gate === "dev-feedback" ? "feedback" : "gate", reason: flag(args, "--reason"), units: plan.units.map((unit) => ({ id: unit.id, ms: unit.meta.expectedDurationMs, runner: unit.meta.runner, surfaces: unit.meta.surfaces, requirements: unit.meta.requirements ?? [] })), skipped: plan.skipped, estimatedMs: plan.estimatedMs }, null, 2)}\n`,
    );
    return 0;
  }

  if (command === "run") {
    const space = flag(args, "--space");
    const topic = flag(args, "--topic", "change");
    const gate = parseGate(flag(args, "--gate", "change"));
    const summaryLanguage = parseSummaryLanguage(flag(args, "--summary-language", "en"));
    const environments = Number(flag(args, "--environments", "16")) || 16;
    const maxRunMs = Number(flag(args, "--max-run-ms", "0")) || 0;
    if (!space) {
      process.stderr.write("--space is required\n");
      return 2;
    }
    if (!runsIgnored(space)) {
      process.stderr.write("space runs/ is not gitignored\n");
      return 2;
    }
    const captureInputs = () => {
      const hashFile = snapshotHasher();
      return ({
      open: repoIdentity(openRoot),
      cloud: cloudRoot ? repoIdentity(cloudRoot) : { path: "", sha: "n/a", branch: "n/a", dirty: false, dirtyDigest: "n/a" },
      artifact: artifactIdentity(openRoot, hashFile),
      bundle: artifactBundleIdentity(openRoot, cloudRoot, hashFile),
    }); };
    const cases = await loadCatalog({ openRoot, cloudRoot });
    const selection = { tags: valuesOf(args, "--tags"), cases: valuesOf(args, "--case"), reason: flag(args, "--reason").trim() };
    const plan = planCases(cases, gate, selection.tags, selection.cases, selection.reason);
    const store = createRunStore(space, topic);
    const startedAt = new Date();
    const results: UnitResult[] = [];
    const active = new Map<string, number>();
    let phase: RunProgress["phase"] = "preflight";
    const progress = (message?: string) => {
      const counts = emptyCounts();
      for (const result of results) addResult(counts, result);
      store.writeProgress({ schema: "genehub.test-progress.v1", runId: path.basename(store.dir), gate, phase,
        startedAt: startedAt.toISOString(), updatedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt.getTime(),
        total: plan.units.length, completed: results.length, counts,
        active: [...active].map(([id, at]) => ({ id, elapsedMs: Date.now() - at })), ...(message ? { message } : {}) });
    };
    const announce = () => process.stderr.write(`[testctl] ${phase} ${results.length}/${plan.units.length}; active=${[...active.keys()].join(",") || "none"}; elapsed=${Math.round((Date.now() - startedAt.getTime()) / 1000)}s; run=${store.dir}\n`);
    progress(); announce();
    const heartbeat = setInterval(() => { progress(); announce(); }, 15_000);
    heartbeat.unref();
    let inputWatch: ReturnType<typeof watchInputs> | undefined;
    try {
      const prerequisites = await preflight(plan.units.map(unit => unit.meta));
      const preflightBlocked = prerequisites.issues.length > 0;
      phase = "fingerprinting"; progress(); announce();
      // Failed preconditions do not require hashing large binaries or starting any test environments.
      const inputsAtStart = preflightBlocked ? {
        open: repoIdentity(openRoot),
        cloud: cloudRoot ? repoIdentity(cloudRoot) : { path: "", sha: "n/a", branch: "n/a", dirty: false, dirtyDigest: "n/a" },
        artifact: { path: null, hash: null, kind: "preflight-not-executed" },
        bundle: undefined,
      } : captureInputs();
      if (!preflightBlocked) inputWatch = watchInputs([openRoot, ...(cloudRoot ? [cloudRoot] : [])], inputsAtStart.bundle!.files.map(f => f.path));
      const governanceDigest = checkGovernance(openRoot, cloudRoot).digest;
      const resumeBinding = preflightBlocked ? undefined : {
        common: digest({ inputsAtStart, catalog: catalogDigest(cases), gate, selection,
          governanceDigest, runner: RUNNER_VERSION, policy: POLICY_VERSION, environment: prerequisites.environment.common, environments }),
        cases: prerequisites.environment.cases,
      };
      const resumeDir = flag(args, "--resume");
      const resumed = resumeDir && resumeBinding ? reusableResults(resumeDir, resumeBinding, plan.units) : undefined;
      if (resumed) for (const result of resumed.results) { results.push(result); store.writeResult(result); }
      if (preflightBlocked) for (const unit of plan.units) {
        const issue = prerequisites.issues.find(item => item.caseId === unit.caseId);
        const result: UnitResult = { id: unit.id, caseId: unit.caseId, variant: unit.variant, status: "blocked", phase: "preflight",
          startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 0,
          blockedReason: issue?.reason ?? "not started: selected dependency preflight failed" };
        results.push(result); store.writeResult(result); store.writeFailure(result, result.blockedReason!);
      }
      for (const issue of prerequisites.issues) process.stderr.write(`[testctl] blocked before execution: ${issue.caseId}: ${issue.reason}\n`);
      const completedIds = new Set(results.map(result => result.id));
      const scheduler = createScheduler(plan.units.filter(unit => !completedIds.has(unit.id)), defaultBudget(environments));
      phase = "running"; progress(); announce();
      // Every environment compiles the same component on each daemon start;
      // a shared, machine-local cache (target/ is gitignored) turns that into
      // one compile per artifact hash. The host only honours this on the local
      // channel — released builds always recompile.
      const componentCache = path.join(openRoot, "target", "test-component-cache");
      if (!preflightBlocked) mkdirSync(componentCache, { recursive: true });
      const extraEnv: Record<string, string> = {
        TESTCTL_OPEN_ROOT: openRoot,
        TESTCTL_CLOUD_ROOT: cloudRoot ?? "",
        GENEHUB_TEST_COMPONENT_CACHE_DIR: componentCache,
      };
      const runDeadline = maxRunMs > 0 ? Date.now() + maxRunMs : Number.POSITIVE_INFINITY;
      const inflight = new Set<Promise<void>>();

      const startOne = (unit: WorkUnit) => {
        const env = { ...extraEnv };
        if (unit.meta.runner === "playwright") {
          env.TESTCTL_BROWSER_ARTIFACTS = path.join(
            store.dir,
            "failures",
            unit.caseId.replace(/[^\w.-]+/g, "_"),
          );
        }
        active.set(unit.id, Date.now()); progress();
        const task = runUnit(unit, env, openRoot).then((result) => {
          active.delete(unit.id);
          completeUnit(scheduler, unit, result.durationMs);
          results.push(result);
          store.writeResult(result);
          progress();
          if (result.status !== "passed") process.stderr.write(`[testctl] ${result.status}: ${result.caseId}; inspect --run ${store.dir} --case ${result.caseId}\n`);
          if (result.status === "passed" && env.TESTCTL_BROWSER_ARTIFACTS) {
            rmSync(env.TESTCTL_BROWSER_ARTIFACTS, { recursive: true, force: true });
          }
          if (result.status === "failed" || result.status === "blocked" || result.status === "unstable") {
            store.writeFailure(
              result,
              [result.message ?? result.blockedReason ?? result.status, result.diagnostic].filter(Boolean).join("\n\n"),
            );
          }
          if (result.status === "passed" && result.message && unit.meta.retention) {
            store.writeReport(result);
          }
        }).finally(() => {
          inflight.delete(task);
        });
        inflight.add(task);
      };

      while (scheduler.pending.length > 0 || inflight.size > 0) {
        if (scheduler.pending.length > 0 && inflight.size === 0 && !hasClaimable(scheduler)) {
          const leftover = scheduler.pending.shift();
          if (leftover) {
            const blocked: UnitResult = {
              id: leftover.id,
              caseId: leftover.caseId,
              variant: leftover.variant,
              status: "blocked",
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              durationMs: 0,
              message: "insufficient resource tokens",
              blockedReason: "resource deadlock",
            };
            results.push(blocked);
            store.writeResult(blocked);
            store.writeFailure(blocked, blocked.message ?? "");
          }
          continue;
        }
        if (Date.now() > runDeadline) {
          while (scheduler.pending.length > 0) {
            const leftover = scheduler.pending.shift();
            if (!leftover) break;
            const interrupted: UnitResult = {
              id: leftover.id,
              caseId: leftover.caseId,
              variant: leftover.variant,
              status: "interrupted",
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              durationMs: 0,
              message: "run reached --max-run-ms",
            };
            results.push(interrupted);
            store.writeResult(interrupted);
          }
          break;
        }
        let claimed = claimNext(scheduler);
        while (claimed) {
          startOne(claimed);
          claimed = claimNext(scheduler);
        }
        if (inflight.size > 0) await Promise.race(inflight);
      }
      if (inflight.size > 0) await Promise.all(inflight);

      phase = "finalizing"; progress(); announce();
      const counts = emptyCounts();
      for (const result of results) addResult(counts, result);
      const status = results.length === 0 ? "blocked" : rollupStatus(results);
      const inputsAtEnd = preflightBlocked ? inputsAtStart : captureInputs();
      const { open, cloud, artifact } = inputsAtEnd;
      const requiredCases = (process.env.TESTCTL_REQUIRE_CASES ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const executed = new Set(results.map((item) => item.caseId));
      const reasons = qualificationReasons({
        gate,
        dirty: open.dirty || cloud.dirty,
        artifactHash: artifact.hash,
        blocked: counts.blocked,
        failed: counts.failed,
        unstable: counts.unstable,
        interrupted: counts.interrupted,
        openSha: open.sha,
        cloudSha: cloud.sha,
        requiredOpenSha: process.env.TESTCTL_REQUIRE_OPEN_SHA,
        requiredCloudSha: process.env.TESTCTL_REQUIRE_CLOUD_SHA,
        requiredArtifactHash: process.env.TESTCTL_REQUIRE_ARTIFACT_HASH,
        requiredNotExecuted: requiredCases.filter((id) => !executed.has(id)),
      });
      const inputObservation = inputWatch?.stop() ?? { changed: false, complete: false };
      inputWatch = undefined;
      const inputDrift = !preflightBlocked && (inputObservation.changed || JSON.stringify(inputsAtStart) !== JSON.stringify(inputsAtEnd));
      if ((selection.tags.length > 0 || selection.cases.length > 0) && ["merge", "dev", "beta", "stable"].includes(gate)) reasons.push("filtered selection is not the complete release gate");
      if (preflightBlocked) reasons.push("selected dependencies failed preflight; no test cases executed");
      if (!inputObservation.complete) reasons.push("input change observation incomplete");
      if (inputDrift) reasons.push("source or CLI artifact changed during run");
      if (results.length === 0) reasons.push("no test cases executed");
      const leakCount = (key: "processes" | "ports") => results.length > 0 && results.every(r => r.cleanup?.before[key] != null)
        ? results.reduce((sum, r) => sum + r.cleanup!.before[key]!, 0) : null;
      const leak = { processes: leakCount("processes"), ports: leakCount("ports") };
      if (leak.processes === null || leak.ports === null) reasons.push("resource census incomplete");
      else if (leak.processes > 0 || leak.ports > 0) reasons.push("resource leaks observed");
      const manifest: RunManifest = {
        schema: "genehub.test-run.v1",
        runId: path.basename(store.dir),
        topic,
        gate,
        status,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        localTime: startedAt.toString(),
        rfc3339: startedAt.toISOString(),
        utc: startedAt.toISOString(),
        trigger: "testctl",
        runnerVersion: RUNNER_VERSION,
        open,
        cloud,
        artifact,
        catalogDigest: catalogDigest(cases),
        selected: plan.units.map(unit => unit.caseId),
        selection,
        preflight: { issues: prerequisites.issues, checked: prerequisites.checked },
        resumeBinding,
        ...(resumed ? { resumedFrom: { runId: resumed.runId, reused: resumed.results.map(r => r.id) } } : {}),
        notExecuted: plan.skipped,
        counts,
        qualification: {
          gate,
          scope: gate === "dev-feedback" ? "feedback" : "gate",
          policyVersion: POLICY_VERSION,
          qualified: reasons.length === 0 && status === "passed",
          reasons,
        },
        governanceDigest,
        environments,
        resultsPath: path.join(store.dir, "results.ndjson"),
        leak,
        inputsAtStart,
        artifactBundle: inputsAtStart.bundle,
        inputObservation,
        inputDrift,
      };
      const failed = results.filter((item) => item.status !== "passed" && item.status !== "not-applicable");
      const slowest = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
      const summary = renderRunSummary({ manifest, failed, slowest, runDir: store.dir, language: summaryLanguage });
      store.finalize(manifest, summary);
      phase = "complete"; progress();
      process.stdout.write(`${store.dir}\n${status}\n`);
      return status === "passed" && (!["merge", "dev", "dev-feedback", "beta", "stable"].includes(gate) || manifest.qualification.qualified) ? 0 : 1;
    } catch (error) {
      phase = "error"; progress("coordinator stopped without finalized evidence; qualification unavailable");
      throw error;
    } finally {
      clearInterval(heartbeat);
      inputWatch?.stop();
    }
  }

  if (command === "inspect") {
    const runDir = flag(args, "--run");
    if (!runDir) {
      process.stderr.write("--run is required\n");
      return 2;
    }
    const manifestFile = path.join(runDir, "manifest.json");
    const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : null;
    const progressFile = path.join(runDir, "progress.json");
    const progress = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, "utf8")) as RunProgress : null;
    const results = readRunResults(runDir);
    const caseId = flag(args, "--case");
    const filtered = caseId
      ? results.filter((item) => item.caseId === caseId)
      : has(args, "--failed")
        ? results.filter((item) => item.status !== "passed")
        : results;
    // Detailed inspection reads the already-redacted retained failure evidence.
    // Keep the default summary small and never open a path supplied as a case id.
    if (caseId) for (const result of filtered) {
      const diagnostic = path.join(runDir, "failures", result.caseId.replace(/[^\w.-]+/g, "_"), "diagnostic.md");
      if (existsSync(diagnostic)) result.diagnostic = readFileSync(diagnostic, "utf8").slice(-64 * 1024);
    }
    process.stdout.write(`${JSON.stringify({ manifest, progress, finalized: Boolean(manifest), qualification: manifest?.qualification ?? null, heartbeatAgeMs: progress ? Date.now() - Date.parse(progress.updatedAt) : null, results: filtered }, null, 2)}\n`);
    return 0;
  }

  if (command === "compare") {
    const base = flag(args, "--base");
    const candidate = flag(args, "--candidate");
    const read = (dir: string) => JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as RunManifest;
    const a = read(base);
    const b = read(candidate);
    const duration = (manifest: RunManifest) =>
      Date.parse(manifest.endedAt) - Date.parse(manifest.startedAt);
    process.stdout.write(
      `${JSON.stringify({
        sameSha: a.open.sha === b.open.sha && a.cloud.sha === b.cloud.sha,
        sameArtifact: a.artifact.hash === b.artifact.hash,
        shaDrift: a.open.sha !== b.open.sha || a.cloud.sha !== b.cloud.sha,
        artifactRebuild: Boolean(a.artifact.hash && b.artifact.hash && a.artifact.hash !== b.artifact.hash),
        base: { status: a.status, qualified: a.qualification.qualified, durationMs: duration(a) },
        candidate: { status: b.status, qualified: b.qualification.qualified, durationMs: duration(b) },
      }, null, 2)}\n`,
    );
    return 0;
  }

  if (command === "list") {
    const space = flag(args, "--space");
    const root = path.join(space, "runs");
    const names = existsSync(root) ? readdirSync(root).filter((name) => statSync(path.join(root, name)).isDirectory()) : [];
    process.stdout.write(`${names.join("\n")}${names.length ? "\n" : ""}`);
    return 0;
  }

  if (command === "prune") {
    const space = flag(args, "--space");
    const before = Date.parse(flag(args, "--before"));
    const apply = has(args, "--apply");
    const root = path.join(space, "runs");
    if (!existsSync(root)) return 0;
    for (const name of readdirSync(root)) {
      const dir = path.join(root, name);
      if (statSync(dir).mtimeMs < before) {
        process.stdout.write(`${apply ? "delete" : "would-delete"} ${dir}\n`);
        if (apply) rmSync(dir, { recursive: true, force: true });
      }
    }
    return 0;
  }

  process.stderr.write(usage());
  return 2;
}

// Let stdout drain: forced process.exit truncated large plan/inspect JSON in pipes.
void main().then((code) => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`testctl: ${error instanceof Error ? error.message : "command failed"}\n`);
  process.exitCode = 2;
});
