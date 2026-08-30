#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { catalogDigest, loadCatalog } from "../infrastructure/engine/catalog.ts";
import { artifactIdentity, repoIdentity, runsIgnored } from "../infrastructure/engine/git.ts";
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
import { runNodeSequence } from "../infrastructure/adapters/node.ts";
import { runRustLegacyUnit } from "../infrastructure/adapters/rust-legacy.ts";
import { createRunStore } from "../infrastructure/evidence/run-store.ts";
import {
  listHumanDecisions,
  recordHumanDecision,
} from "../infrastructure/interaction/human-decision.ts";
import { parseSummaryLanguage, renderRunSummary } from "../infrastructure/evidence/summary.ts";
import { checkGovernance } from "../infrastructure/lint/governance.ts";
import { lintLayers } from "../infrastructure/lint/layers.ts";
import { qualificationReasons } from "../policies/gates.ts";
import {
  POLICY_VERSION,
  RUNNER_VERSION,
  type GateName,
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

function optionMissingValue(args: string[], name: string): boolean {
  return args.some(
    (argument, index) =>
      argument === name && (!args[index + 1] || args[index + 1]!.startsWith("--")),
  );
}

function tagsOf(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--tags" && args[i + 1]) out.push(args[i + 1]!);
  }
  return out;
}

function usage(): string {
  return `testctl <lint|governance|plan|run|inspect|interactions|decide|compare|list|prune> [options]
  lint [--open <path>] [--cloud <path>]
  governance check [--open <path>] [--cloud <path>]
  plan --gate <gate> [--open <path>] [--cloud <path>] [--tags <tag>]
  run --space <abs> --gate <gate> --topic <slug> [--tags <tag>] [--environments <n>] [--summary-language <en|zh-CN>] [--open <path>] [--cloud <path>] [--max-run-ms <ms>]
  inspect --run <abs> [--failed|--case <id>] [--artifacts]
  interactions --run <abs>
  decide --run <abs> --request <id> --edge <id>
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
  for (const option of [
    "--open",
    "--cloud",
    "--gate",
    "--tags",
    "--space",
    "--topic",
    "--environments",
    "--summary-language",
    "--max-run-ms",
    "--run",
    "--case",
    "--request",
    "--edge",
    "--base",
    "--candidate",
    "--before",
  ]) {
    if (optionMissingValue(args, option)) {
      process.stderr.write(`${option} needs a value\n`);
      return 2;
    }
  }
  const openRoot = path.resolve(flag(args, "--open", OPEN_DEFAULT));
  const cloud = flag(args, "--cloud");
  const cloudRoot = cloud ? path.resolve(cloud) : undefined;

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
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.findings.length === 0 ? 0 : 2;
  }

  if (command === "plan") {
    const gate = (flag(args, "--gate", "change") || "change") as GateName;
    const cases = await loadCatalog({ openRoot, cloudRoot });
    const plan = planCases(cases, gate, tagsOf(args));
    process.stdout.write(
      `${JSON.stringify({ gate, units: plan.units.map((unit) => ({ id: unit.id, ms: unit.meta.expectedDurationMs, runner: unit.meta.runner })), skipped: plan.skipped, estimatedMs: plan.estimatedMs }, null, 2)}\n`,
    );
    return 0;
  }

  if (command === "run") {
    const space = flag(args, "--space");
    const topic = flag(args, "--topic", "change");
    const gate = (flag(args, "--gate", "change") || "change") as GateName;
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
    const cases = await loadCatalog({ openRoot, cloudRoot });
    const plan = planCases(cases, gate, tagsOf(args));
    if (plan.units.length === 0) {
      process.stderr.write("selected test plan is empty; refusing a false-green run\n");
      return 2;
    }
    const store = createRunStore(space, topic);
    const startedAt = new Date();
    const results: UnitResult[] = [];
    const sequenceGroups = new Map<string, WorkUnit[]>();
    const ordinaryUnits: WorkUnit[] = [];
    for (const unit of plan.units) {
      const sequence = unit.meta.sequence;
      if (!sequence) {
        ordinaryUnits.push(unit);
        continue;
      }
      const group = sequenceGroups.get(sequence.id) ?? [];
      group.push(unit);
      sequenceGroups.set(sequence.id, group);
    }
    for (const [id, units] of sequenceGroups) {
      const orders = new Set(units.map((unit) => unit.meta.sequence?.order));
      if (
        units.some((unit) => unit.meta.runner !== "node") ||
        orders.size !== units.length ||
        units.some((unit) => !Number.isInteger(unit.meta.sequence?.order) || (unit.meta.sequence?.order ?? 0) < 1)
      ) {
        throw new Error(`invalid node sequence ${id}`);
      }
      units.sort((left, right) => left.meta.sequence!.order - right.meta.sequence!.order);
    }
    const scheduler = createScheduler(ordinaryUnits, defaultBudget(environments));
    // Every environment compiles the same component on each daemon start;
    // a shared, machine-local cache (target/ is gitignored) turns that into
    // one compile per artifact hash. The host only honours this on the local
    // channel — released builds always recompile.
    const componentCache = path.join(openRoot, "target", "test-component-cache");
    mkdirSync(componentCache, { recursive: true });
    const extraEnv: Record<string, string> = {
      TESTCTL_OPEN_ROOT: openRoot,
      TESTCTL_CLOUD_ROOT: cloudRoot ?? "",
      GENEHUB_TEST_COMPONENT_CACHE_DIR: componentCache,
      TESTCTL_INTERACTION_DIR: path.join(store.dir, "interactions"),
      TESTCTL_FAILURE_STAGING_DIR: path.join(store.dir, ".internal", "failure-evidence"),
    };
    const runDeadline = maxRunMs > 0 ? Date.now() + maxRunMs : Number.POSITIVE_INFINITY;
    const inflight = new Set<Promise<void>>();

    const recordResult = (result: UnitResult, unit: WorkUnit, browserArtifacts?: string) => {
      results.push(result);
      store.writeResult(result);
      if (result.status === "passed" && browserArtifacts) {
        rmSync(browserArtifacts, { recursive: true, force: true });
      }
      if (result.status !== "passed" && result.status !== "not-applicable") {
        store.writeFailure(
          result,
          [result.message ?? result.blockedReason ?? result.status, result.diagnostic].filter(Boolean).join("\n\n"),
        );
      }
      if (result.status === "passed" && result.message && unit.meta.retention) {
        store.writeReport(result);
      }
    };

    for (const units of [...sequenceGroups.values()].sort((left, right) => left[0]!.id.localeCompare(right[0]!.id))) {
      const sequenceResults = await runNodeSequence(units, extraEnv, runDeadline);
      for (const [index, result] of sequenceResults.entries()) {
        recordResult(result, units[index]!);
      }
    }

    const startOne = (unit: WorkUnit) => {
      const env = { ...extraEnv };
      if (unit.meta.runner === "playwright") {
        env.TESTCTL_BROWSER_ARTIFACTS = path.join(
          store.dir,
          "failures",
          unit.caseId.replace(/[^\w.-]+/g, "_"),
        );
      }
      const task = runUnit(unit, env, openRoot).then((result) => {
        completeUnit(scheduler, unit, result.durationMs);
        recordResult(result, unit, env.TESTCTL_BROWSER_ARTIFACTS);
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

    const endedAt = new Date();
    const counts = emptyCounts();
    for (const result of results) addResult(counts, result);
    const status = rollupStatus(results);
    const open = repoIdentity(openRoot);
    const cloud = cloudRoot
      ? repoIdentity(cloudRoot)
      : { path: "", sha: "n/a", branch: "n/a", dirty: false, dirtyDigest: "n/a" };
    const artifact = artifactIdentity(openRoot);
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
    const manifest: RunManifest = {
      schema: "genehub.test-run.v1",
      runId: path.basename(store.dir),
      topic,
      gate,
      status,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      localTime: startedAt.toString(),
      rfc3339: startedAt.toISOString(),
      utc: startedAt.toISOString(),
      trigger: "testctl",
      runnerVersion: RUNNER_VERSION,
      open,
      cloud,
      artifact,
      catalogDigest: catalogDigest(cases),
      selected: results.map((item) => item.caseId),
      notExecuted: plan.skipped,
      counts,
      qualification: {
        gate,
        policyVersion: POLICY_VERSION,
        qualified: reasons.length === 0 && status === "passed",
        reasons,
      },
      governanceDigest: checkGovernance(openRoot, cloudRoot).digest,
      environments,
      resultsPath: path.join(store.dir, "results.ndjson"),
      leak: { processes: 0, ports: 0 },
    };
    const failed = results.filter((item) => item.status !== "passed" && item.status !== "not-applicable");
    const slowest = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
    const summary = renderRunSummary({ manifest, failed, slowest, runDir: store.dir, language: summaryLanguage });
    store.finalize(manifest, summary);
    process.stdout.write(`${store.dir}\n${status}\n`);
    return status === "passed" ? 0 : 1;
  }

  if (command === "inspect") {
    const runDir = flag(args, "--run");
    if (!runDir) {
      process.stderr.write("--run is required\n");
      return 2;
    }
    const manifest = JSON.parse(readFileSync(path.join(runDir, "manifest.json"), "utf8"));
    const results = readFileSync(path.join(runDir, "results.ndjson"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as UnitResult);
    const caseId = flag(args, "--case");
    const filtered = caseId
      ? results.filter((item) => item.caseId === caseId)
      : has(args, "--failed")
        ? results.filter((item) => item.status !== "passed")
        : results;
    const diagnostics = Object.fromEntries(
      filtered
        .filter((item) => item.status !== "passed" && item.status !== "not-applicable")
        .map((item) => {
          const file = path.join(
            runDir,
            "failures",
            item.caseId.replace(/[^\w.-]+/g, "_"),
            "diagnostic.md",
          );
          return [item.caseId, existsSync(file) ? readFileSync(file, "utf8") : null];
        }),
    );
    const artifacts = Object.fromEntries(
      filtered
        .filter((item) => item.status !== "passed" && item.status !== "not-applicable")
        .map((item) => {
          const evidence = path.join(
            runDir,
            "failures",
            item.caseId.replace(/[^\w.-]+/g, "_"),
            "evidence",
          );
          if (!existsSync(evidence)) return [item.caseId, []];
          const indexes: unknown[] = [];
          for (const unit of readdirSync(evidence, { withFileTypes: true })) {
            if (!unit.isDirectory()) continue;
            const index = path.join(evidence, unit.name, "artifact-index.json");
            if (!existsSync(index)) continue;
            const parsed = JSON.parse(readFileSync(index, "utf8")) as {
              storageMap?: unknown;
              sessions?: unknown[];
              files?: Array<{ kind?: string; truncated?: boolean; omittedReason?: string }>;
              diagnostics?: unknown[];
              [key: string]: unknown;
            };
            const root = path.relative(runDir, path.dirname(index)).split(path.sep).join("/");
            if (has(args, "--artifacts")) {
              indexes.push({ root, index: parsed });
              continue;
            }
            const kinds: Record<string, number> = {};
            for (const file of parsed.files ?? []) {
              const kind = file.kind ?? "unknown";
              kinds[kind] = (kinds[kind] ?? 0) + 1;
            }
            indexes.push({
              root,
              indexPath: `${root}/artifact-index.json`,
              storageMap: parsed.storageMap,
              sessions: parsed.sessions ?? [],
              fileCount: parsed.files?.length ?? 0,
              filesByKind: kinds,
              truncatedFiles: parsed.files?.filter((file) => file.truncated).length ?? 0,
              omittedFiles: parsed.files?.filter((file) => file.omittedReason).length ?? 0,
              diagnostics: parsed.diagnostics ?? [],
            });
          }
          return [item.caseId, indexes];
        }),
    );
    const selectedCases = new Set(filtered.map((item) => item.caseId));
    const interactions = listHumanDecisions(runDir).filter((record) =>
      selectedCases.has(record.request.caseId)
    );
    // Keep the requested evidence first. Large catalogs can make
    // manifest.notExecuted exceed bounded terminal capture; putting results
    // after it made `inspect --case/--failed` hide the very failure requested.
    process.stdout.write(`${JSON.stringify({ results: filtered, diagnostics, artifacts, interactions, manifest }, null, 2)}\n`);
    return 0;
  }

  if (command === "interactions") {
    const runDir = flag(args, "--run");
    if (!runDir) {
      process.stderr.write("--run is required\n");
      return 2;
    }
    process.stdout.write(`${JSON.stringify({ requests: listHumanDecisions(runDir) }, null, 2)}\n`);
    return 0;
  }

  if (command === "decide") {
    const runDir = flag(args, "--run");
    const requestId = flag(args, "--request");
    const edgeId = flag(args, "--edge");
    if (!runDir || !requestId || !edgeId) {
      process.stderr.write("decide requires --run, --request, and --edge\n");
      return 2;
    }
    try {
      process.stdout.write(
        `${JSON.stringify(recordHumanDecision(runDir, requestId, edgeId), null, 2)}\n`,
      );
      return 0;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
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

void main().then((code) => process.exit(code));
