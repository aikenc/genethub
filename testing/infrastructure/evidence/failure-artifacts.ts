import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { WorkUnit } from "../types.ts";
import type { EnvironmentLease } from "../environment/lease.ts";
import { redactText, redactValue } from "./redact.ts";

const PER_FILE_LIMIT = 8 * 1024 * 1024;
const TOTAL_TEXT_LIMIT = 64 * 1024 * 1024;
const MAX_DISCOVERED_FILES = 4_096;
const MAX_DISCOVERED_DIRECTORIES = 20_000;
const TEXT_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".ndjson",
  ".txt",
  ".yaml",
  ".yml",
]);
const PRUNED_DIRECTORIES = new Set([
  ".git",
  ".pnpm-store",
  ".test-runtime",
  "build",
  "dist",
  "node_modules",
  "target",
]);

export interface FailureArtifactRecord {
  kind: "log" | "session" | "project-state" | "workspace-control" | "runtime-log";
  sourcePath: string;
  artifactPath?: string;
  originalBytes: number;
  capturedBytes: number;
  sha256: string;
  truncated: boolean;
  omittedReason?: string;
}

export interface FailureSessionRecord {
  sessionId: string;
  role: "pm" | "worker" | "ordinary" | "unknown";
  agentId?: string;
  controllerSessionId?: string;
  workPackageId?: string;
  sourcePath: string;
  artifactPath: string;
}

export interface FailureArtifactIndex {
  schema: "genehub.test-failure-artifacts.v1";
  caseId: string;
  unitId: string;
  capturedAt: string;
  storageMap: {
    leaseRoot: "<lease-root>";
    daemonData: "<lease-root>/data";
    workspaceRoot: "<lease-root>/workspace";
    projectState: "<lease-root>/data/pm-projects/<project-workspace-id>.json";
    sessions: "<workspace>/.genethub/sessions/<session-id>/";
  };
  limits: {
    perFileBytes: number;
    totalTextBytes: number;
    maxFiles: number;
  };
  files: FailureArtifactRecord[];
  sessions: FailureSessionRecord[];
  diagnostics: string[];
}

interface CaptureContext {
  lease: EnvironmentLease;
  output: string;
  files: FailureArtifactRecord[];
  sessions: FailureSessionRecord[];
  diagnostics: string[];
  capturedBytes: number;
  discoveredFiles: number;
  secretValues: string[];
}

export interface FailureRunnerOutput {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+$/, "_");
  return normalized || "_";
}

function logicalPath(lease: EnvironmentLease, value: string): string {
  const absolute = path.resolve(value);
  const root = path.resolve(lease.root);
  if (absolute === root) return "<lease-root>";
  if (absolute.startsWith(`${root}${path.sep}`)) {
    return `<lease-root>/${path.relative(root, absolute).split(path.sep).join("/")}`;
  }
  return redactText(absolute);
}

function safeRelative(value: string): string {
  return value
    .split(path.sep)
    .filter((part) => part && part !== "." && part !== "..")
    .map(safeSegment)
    .join("/");
}

function digestFile(file: string): string {
  const digest = createHash("sha256");
  const fd = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(128 * 1024);
  try {
    for (;;) {
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (size === 0) break;
      digest.update(buffer.subarray(0, size));
    }
  } finally {
    closeSync(fd);
  }
  return digest.digest("hex");
}

function readBoundedText(file: string, size: number): { text?: string; truncated: boolean; reason?: string } {
  const readSize = Math.min(size, PER_FILE_LIMIT);
  let bytes: Buffer;
  let truncated = size > PER_FILE_LIMIT;
  if (!truncated) {
    bytes = readFileSync(file);
  } else {
    const half = Math.floor(PER_FILE_LIMIT / 2);
    const head = Buffer.allocUnsafe(half);
    const tail = Buffer.allocUnsafe(PER_FILE_LIMIT - half);
    const fd = openSync(file, "r");
    try {
      readSync(fd, head, 0, head.length, 0);
      readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
    } finally {
      closeSync(fd);
    }
    bytes = Buffer.concat([
      head,
      Buffer.from(`\n\n[... testctl omitted ${size - readSize} bytes ...]\n\n`),
      tail,
    ]);
  }
  if (bytes.includes(0)) return { truncated, reason: "binary file contains NUL bytes" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), truncated };
  } catch {
    return { truncated, reason: "file is not valid UTF-8 text" };
  }
}

function captureFile(
  context: CaptureContext,
  file: string,
  artifactRelative: string,
  kind: FailureArtifactRecord["kind"],
): void {
  if (context.discoveredFiles >= MAX_DISCOVERED_FILES) {
    context.diagnostics.push(`file discovery stopped after ${MAX_DISCOVERED_FILES} entries`);
    return;
  }
  context.discoveredFiles += 1;
  let size: number;
  let sha256: string;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return;
    size = stat.size;
    sha256 = digestFile(file);
  } catch (error) {
    context.diagnostics.push(`unable to inspect ${logicalPath(context.lease, file)}: ${String(error)}`);
    return;
  }
  const record: FailureArtifactRecord = {
    kind,
    sourcePath: logicalPath(context.lease, file),
    originalBytes: size,
    capturedBytes: 0,
    sha256,
    truncated: false,
  };
  if (context.capturedBytes >= TOTAL_TEXT_LIMIT) {
    record.omittedReason = "failure artifact total text limit reached";
    context.files.push(record);
    return;
  }
  const bounded = readBoundedText(file, size);
  record.truncated = bounded.truncated;
  if (bounded.text === undefined) {
    record.omittedReason = bounded.reason;
    context.files.push(record);
    return;
  }
  const aliased = bounded.text.split(context.lease.root).join("<lease-root>");
  const withoutKnownSecrets = context.secretValues.reduce(
    (text, secret) => text.split(secret).join("[redacted]"),
    aliased,
  );
  let sanitized = redactText(withoutKnownSecrets);
  const remaining = TOTAL_TEXT_LIMIT - context.capturedBytes;
  if (Buffer.byteLength(sanitized) > remaining) {
    sanitized = `${Buffer.from(sanitized).subarray(0, remaining).toString("utf8")}\n[... testctl total artifact limit reached ...]\n`;
    record.truncated = true;
  }
  const destination = path.join(context.output, safeRelative(artifactRelative));
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, sanitized);
  record.artifactPath = path.relative(context.output, destination).split(path.sep).join("/");
  record.capturedBytes = Buffer.byteLength(sanitized);
  context.capturedBytes += record.capturedBytes;
  context.files.push(record);
}

function captureGeneratedText(
  context: CaptureContext,
  source: string,
  artifactRelative: string,
  value: string,
  originalBytes: number,
  truncated: boolean,
): void {
  const withoutKnownSecrets = context.secretValues.reduce(
    (text, secret) => text.split(secret).join("[redacted]"),
    value.split(context.lease.root).join("<lease-root>"),
  );
  let sanitized = redactText(withoutKnownSecrets);
  const remaining = TOTAL_TEXT_LIMIT - context.capturedBytes;
  if (Buffer.byteLength(sanitized) > remaining) {
    sanitized = `${Buffer.from(sanitized).subarray(0, Math.max(0, remaining)).toString("utf8")}\n[... testctl total artifact limit reached ...]\n`;
    truncated = true;
  }
  const destination = path.join(context.output, safeRelative(artifactRelative));
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, sanitized);
  const capturedBytes = Buffer.byteLength(sanitized);
  context.capturedBytes += capturedBytes;
  context.files.push({
    kind: "log",
    sourcePath: source,
    artifactPath: path.relative(context.output, destination).split(path.sep).join("/"),
    originalBytes,
    capturedBytes,
    sha256: createHash("sha256").update(value).digest("hex"),
    truncated,
  });
}

function walkFiles(
  root: string,
  visit: (file: string, relative: string) => void,
  options: { maxDepth?: number; filter?: (file: string, relative: string) => boolean } = {},
): void {
  if (!existsSync(root)) return;
  const stack: Array<{ directory: string; relative: string; depth: number }> = [
    { directory: root, relative: "", depth: 0 },
  ];
  let directories = 0;
  while (stack.length > 0 && directories < MAX_DISCOVERED_DIRECTORIES) {
    const current = stack.pop()!;
    directories += 1;
    let entries;
    try {
      entries = readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = path.join(current.relative, entry.name);
      const absolute = path.join(current.directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (PRUNED_DIRECTORIES.has(entry.name)) continue;
        if (options.maxDepth === undefined || current.depth < options.maxDepth) {
          stack.push({ directory: absolute, relative, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (!options.filter || options.filter(absolute, relative)) visit(absolute, relative);
    }
  }
}

function discoverSessionHomes(workspace: string): string[] {
  if (!existsSync(workspace)) return [];
  const out: string[] = [];
  const stack: Array<{ directory: string; depth: number }> = [{ directory: workspace, depth: 0 }];
  let directories = 0;
  while (stack.length > 0 && directories < MAX_DISCOVERED_DIRECTORIES) {
    const current = stack.pop()!;
    directories += 1;
    let entries;
    try {
      entries = readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const absolute = path.join(current.directory, entry.name);
      if (entry.name === ".genethub") {
        const sessions = path.join(absolute, "sessions");
        if (existsSync(sessions)) out.push(sessions);
        continue;
      }
      if (PRUNED_DIRECTORIES.has(entry.name) || current.depth >= 7) continue;
      stack.push({ directory: absolute, depth: current.depth + 1 });
    }
  }
  return out.sort();
}

function sessionRole(meta: Record<string, unknown>): FailureSessionRecord["role"] {
  const kind = String(meta.kind ?? "").toLowerCase();
  if (kind === "pm" || kind.includes("projectmanager") || kind.includes("project_manager")) return "pm";
  if (kind.includes("work") || (meta.work && typeof meta.work === "object")) return "worker";
  if (kind) return "ordinary";
  return "unknown";
}

function captureSessions(context: CaptureContext): void {
  for (const sessionsHome of discoverSessionHomes(context.lease.workspace)) {
    let sessionEntries;
    try {
      sessionEntries = readdirSync(sessionsHome, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of sessionEntries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const sessionRoot = path.join(sessionsHome, entry.name);
      const workspaceRelative = path.relative(context.lease.workspace, path.dirname(path.dirname(sessionsHome)));
      const artifactBase = path.join(
        "sessions",
        safeRelative(workspaceRelative || "workspace-root"),
        safeSegment(entry.name),
      );
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(readFileSync(path.join(sessionRoot, "meta.json"), "utf8")) as Record<string, unknown>;
      } catch {
        // A partially-created session is still valuable evidence.
      }
      const work = meta.work && typeof meta.work === "object" ? meta.work as Record<string, unknown> : {};
      context.sessions.push({
        sessionId: String(meta.id ?? entry.name),
        role: sessionRole(meta),
        ...(typeof meta.agentId === "string" ? { agentId: meta.agentId } : {}),
        ...(typeof work.controllerSessionId === "string" ? { controllerSessionId: work.controllerSessionId } : {}),
        ...(typeof work.workPackageId === "string" ? { workPackageId: work.workPackageId } : {}),
        sourcePath: logicalPath(context.lease, sessionRoot),
        artifactPath: artifactBase.split(path.sep).join("/"),
      });
      walkFiles(sessionRoot, (file, relative) => {
        captureFile(context, file, path.join(artifactBase, relative), "session");
      });
    }
  }
}

function captureLogs(context: CaptureContext): void {
  const roots: Array<{ root: string; prefix: string; kind: FailureArtifactRecord["kind"] }> = [
    { root: context.lease.logs, prefix: "logs/lease", kind: "log" },
    { root: path.join(context.lease.data, "logs"), prefix: "logs/product", kind: "log" },
    { root: path.join(context.lease.home, ".local", "share", "opencode", "log"), prefix: "logs/opencode-data", kind: "runtime-log" },
    { root: path.join(context.lease.home, ".local", "state", "opencode"), prefix: "logs/opencode-state", kind: "runtime-log" },
  ];
  const seen = new Set<string>();
  for (const source of roots) {
    if (!existsSync(source.root)) continue;
    let real: string;
    try {
      real = path.resolve(source.root);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    walkFiles(source.root, (file, relative) => {
      captureFile(context, file, path.join(source.prefix, relative), source.kind);
    }, {
      filter: (file) => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) || /(?:log|stderr|stdout)/i.test(path.basename(file)),
    });
  }
}

function captureProjectState(context: CaptureContext): void {
  const stateRoot = path.join(context.lease.data, "pm-projects");
  walkFiles(stateRoot, (file, relative) => {
    captureFile(context, file, path.join("project-state", relative), "project-state");
  }, { filter: (file) => path.extname(file).toLowerCase() === ".json" });

  walkFiles(context.lease.workspace, (file, relative) => {
    if (!relative.split(path.sep).includes(".genethub")) return;
    captureFile(context, file, path.join("workspace-control", relative), "workspace-control");
  }, {
    maxDepth: 8,
    filter: (file) => path.basename(file) === "workspace.json" || path.basename(file) === "pipespace.json" || path.basename(file) === "role.json",
  });
}

function processInventory(lease: EnvironmentLease): unknown[] {
  if (process.platform !== "linux" || !existsSync("/proc")) return [];
  const rows: unknown[] = [];
  for (const name of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    const base = path.join("/proc", name);
    try {
      const cwd = readlinkSync(path.join(base, "cwd"));
      if (!path.resolve(cwd).startsWith(path.resolve(lease.root))) continue;
      const stat = readFileSync(path.join(base, "stat"), "utf8");
      const closing = stat.lastIndexOf(")");
      const fields = stat.slice(closing + 2).split(" ");
      const executable = path.basename(readlinkSync(path.join(base, "exe")));
      rows.push({
        pid: Number(name),
        ppid: Number(fields[1] ?? 0),
        state: fields[0] ?? "?",
        executable,
        cwd: logicalPath(lease, cwd),
      });
    } catch {
      continue;
    }
  }
  return rows.sort((left, right) => Number((left as { pid: number }).pid) - Number((right as { pid: number }).pid));
}

function discoverGitRepositories(lease: EnvironmentLease): unknown[] {
  const repositories: unknown[] = [];
  const stack: Array<{ directory: string; depth: number }> = [{ directory: lease.workspace, depth: 0 }];
  while (stack.length > 0 && repositories.length < 64) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.name === ".git")) {
      const git = (args: string[]) => spawnSync("git", ["-C", current.directory, ...args], {
        encoding: "utf8",
        timeout: 5_000,
      }).stdout.trim();
      repositories.push({
        root: logicalPath(lease, current.directory),
        head: git(["rev-parse", "HEAD"]),
        branch: git(["branch", "--show-current"]),
        status: redactText(git(["status", "--short", "--branch"])),
      });
      continue;
    }
    if (current.depth >= 7) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || PRUNED_DIRECTORIES.has(entry.name)) continue;
      stack.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return repositories;
}

function environmentInventory(lease: EnvironmentLease, effectiveEnv: Record<string, string>): unknown {
  const keys = Object.keys(effectiveEnv)
    .filter((key) => /^(?:ALIYUN|GENEHUB|TESTCTL|XDG_)/.test(key))
    .sort();
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    const value = effectiveEnv[key]!;
    if (/(?:authorization|api[_-]?key|access[_-]?key|token|cookie|credential|pairing|secret|password|proof|challenge|machine[_-]?id|device[_-]?id|fingerprint)/i.test(key)) {
      values[key] = { present: value.length > 0 };
      continue;
    }
    values[key] = redactText(value.split(lease.root).join("<lease-root>"));
  }
  return values;
}

export function collectFailureArtifacts(input: {
  lease: EnvironmentLease;
  unit: WorkUnit;
  stagingRoot: string;
  effectiveEnv: Record<string, string>;
  runnerOutput?: FailureRunnerOutput;
}): string {
  const identity = createHash("sha256").update(input.unit.id).digest("hex").slice(0, 12);
  const output = path.join(input.stagingRoot, `${safeSegment(input.unit.caseId)}-${identity}`);
  mkdirSync(output, { recursive: true });
  const context: CaptureContext = {
    lease: input.lease,
    output,
    files: [],
    sessions: [],
    diagnostics: [],
    capturedBytes: 0,
    discoveredFiles: 0,
    secretValues: Object.entries(input.effectiveEnv)
      .filter(([key, value]) =>
        /(?:authorization|api[_-]?key|access[_-]?key|token|cookie|credential|pairing|secret|password|challenge|proof|machine[_-]?id|device[_-]?id|fingerprint)/i.test(key)
        && value.length >= 8
      )
      .map(([, value]) => value)
      .sort((left, right) => right.length - left.length),
  };
  captureLogs(context);
  captureSessions(context);
  captureProjectState(context);
  if (input.runnerOutput) {
    captureGeneratedText(
      context,
      "<test-worker>/stdout",
      "logs/test-worker/stdout.log",
      input.runnerOutput.stdout,
      input.runnerOutput.stdoutBytes,
      input.runnerOutput.stdoutTruncated,
    );
    captureGeneratedText(
      context,
      "<test-worker>/stderr",
      "logs/test-worker/stderr.log",
      input.runnerOutput.stderr,
      input.runnerOutput.stderrBytes,
      input.runnerOutput.stderrTruncated,
    );
  }

  const system = path.join(output, "system");
  mkdirSync(system, { recursive: true });
  writeFileSync(path.join(system, "processes.json"), `${JSON.stringify(redactValue(processInventory(input.lease)), null, 2)}\n`);
  writeFileSync(path.join(system, "git.json"), `${JSON.stringify(redactValue(discoverGitRepositories(input.lease)), null, 2)}\n`);
  writeFileSync(path.join(system, "environment.json"), `${JSON.stringify(environmentInventory(input.lease, input.effectiveEnv), null, 2)}\n`);

  const index: FailureArtifactIndex = {
    schema: "genehub.test-failure-artifacts.v1",
    caseId: input.unit.caseId,
    unitId: input.unit.id,
    capturedAt: new Date().toISOString(),
    storageMap: {
      leaseRoot: "<lease-root>",
      daemonData: "<lease-root>/data",
      workspaceRoot: "<lease-root>/workspace",
      projectState: "<lease-root>/data/pm-projects/<project-workspace-id>.json",
      sessions: "<workspace>/.genethub/sessions/<session-id>/",
    },
    limits: {
      perFileBytes: PER_FILE_LIMIT,
      totalTextBytes: TOTAL_TEXT_LIMIT,
      maxFiles: MAX_DISCOVERED_FILES,
    },
    files: context.files,
    sessions: context.sessions,
    diagnostics: context.diagnostics,
  };
  writeFileSync(path.join(output, "artifact-index.json"), `${JSON.stringify(redactValue(index), null, 2)}\n`);
  return output;
}
