// The pinned CPython the product's own install script installs, cached once
// per machine for every test process: the archive (checked against the
// script's pin) and the tree the shipped installer unpacks from it. Nothing
// here knows any case; callers decide what to seed or point at the mirror.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { machine, userInfo } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BlockedError } from "../types.ts";

const RUNTIME_SCRIPTS = "scripts/python-runtime";
/** The installer scripts' own download budget. */
const INSTALL_BUDGET_MS = 15 * 60_000;

/** The pinned build the shipped install script installs, read from it. */
export interface PinnedPythonRuntime {
  version: string;
  release: string;
  triple: string;
  sha256: string;
  /** The archive name exactly as the installer requests it (URL-encoded). */
  file: string;
  /** What the installer appends to each `GENEHUB_PYTHON_MIRRORS` base. */
  mirrorPath: string;
  /** The installer's built-in download URLs, in the order it tries them. */
  upstream: string[];
  /** `python-<version>-<release>` under `<data>/agents/runtime/`. */
  dirName: string;
}

/** This host's build triple, in the names `python.pin` uses. */
function hostTriple(): string {
  const cpu = machine();
  const arm = cpu === "arm64" || cpu === "aarch64";
  if (process.platform === "linux" && (arm || cpu === "x86_64")) return arm ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  if (process.platform === "darwin" && (arm || cpu === "x86_64")) return arm ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  throw new BlockedError(`the pinned Python runtime is not cached on ${process.platform}/${cpu}`);
}

/** The shipped pin and script are the source of truth; this only reads them. */
export function readPinnedPythonRuntime(openRoot: string): PinnedPythonRuntime {
  const dir = path.join(openRoot, RUNTIME_SCRIPTS);
  const pin: Record<string, string> = {};
  for (const line of readFileSync(path.join(dir, "python.pin"), "utf8").split("\n")) {
    const match = /^([^#=\s][^=]*)=(\S+)\s*$/.exec(line);
    if (match) pin[match[1]!.trim()] = match[2]!;
  }
  const triple = hostTriple();
  const version = pin.version;
  const release = pin.release;
  const sha256 = pin[`sha256.${triple}`];
  if (!version || !release) throw new Error("python.pin no longer pins version= and release=");
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) throw new BlockedError(`python.pin pins no Python build for ${triple}`);
  const script = readFileSync(path.join(dir, "install-python.sh"), "utf8");
  const fileTemplate = /^\s*file="([^"]+)"\s*$/m.exec(script)?.[1];
  const mirrorTemplate = /urls="\$urls \$\{base%\/\}\/([^"\s]+)"/.exec(script)?.[1];
  const upstreamTemplates = [...script.matchAll(/urls="\$urls (https:\/\/[^"\s]+)"/g)].map((match) => match[1]!);
  if (!fileTemplate || !mirrorTemplate || upstreamTemplates.length === 0) {
    throw new Error("install-python.sh no longer builds its download URLs the way this reader expects");
  }
  const vars: Record<string, string> = { version, release, triple };
  const expand = (template: string) => template.replace(/\$(\w+)/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`install-python.sh URL uses an unknown variable $${name}`);
    return value;
  });
  vars.file = expand(fileTemplate);
  return {
    version,
    release,
    triple,
    sha256,
    file: vars.file,
    mirrorPath: expand(mirrorTemplate),
    upstream: upstreamTemplates.map(expand),
    dirName: `python-${version}-${release}`,
  };
}

/** Whether `python` is the pinned build, by the installer's own `usable`
 * test (isolated mode, exact version). `-B` keeps the check from writing
 * bytecode into a tree other processes copy. */
function runsPinned(python: string, version: string): boolean {
  if (!existsSync(python)) return false;
  const probe = spawnSync(python, ["-I", "-B", "-c", "import sys; print(sys.version.split()[0])"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return probe.status === 0 && probe.stdout.trim() === version;
}

/** The machine user's cache, from the account database: a case process's
 * HOME and XDG_* name its own disposable lease. */
function cacheRoot(): string {
  return path.join(userInfo().homedir, ".cache", "genehub-testing");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Cross-process mutex: cases run in separate Node processes. The lock file
 * is created whole (link of a file already holding our pid), and a holder
 * that died is taken over. Losing it only costs a second download: the
 * install itself becomes visible by one atomic rename. */
function withFileLock<T>(lock: string, budgetMs: number, run: () => T): T {
  const mine = `${lock}.${process.pid}`;
  writeFileSync(mine, String(process.pid));
  const deadline = Date.now() + budgetMs;
  try {
    for (;;) {
      try {
        linkSync(mine, lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let holder = 0;
      try {
        holder = Number(readFileSync(lock, "utf8"));
      } catch {
        continue;
      }
      if (!Number.isInteger(holder) || holder <= 0 || !pidAlive(holder)) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new BlockedError(`another test process (pid ${holder}) has held ${lock} for ${budgetMs}ms`);
      sleepSync(250);
    }
  } finally {
    rmSync(mine, { force: true });
  }
  try {
    return run();
  } finally {
    rmSync(lock, { force: true });
  }
}

function sha256File(file: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

export interface PinnedPythonRuntimeCache {
  /** The installed `python-<version>-<release>` tree. */
  tree: string;
  /** A `GENEHUB_PYTHON_MIRRORS` base holding the pinned archive. */
  mirror: string;
}

const verifiedCaches = new Map<string, PinnedPythonRuntimeCache>();

/**
 * The pinned archive and the tree the shipped installer unpacks from it,
 * kept once per machine in the host user's cache (outside the repo and runs),
 * keyed by version, release, CPU and archive hash. The archive is fetched
 * once from the installer's own URLs and checked against its pin; the tree is
 * installed by the shipped installer itself, from that archive. A missing or
 * offline download blocks: the cases using it cannot run, they did not fail.
 */
export function pinnedPythonRuntimeCache(
  openRoot: string,
  /** False: only an already complete cache is returned; nothing is fetched,
   * installed or waited on (for the coordinator's own event loop). */
  options: { build?: boolean } = {},
): PinnedPythonRuntimeCache {
  const pinned = readPinnedPythonRuntime(openRoot);
  const cache = path.join(cacheRoot(), "script-agent-runtime",
    `${pinned.version}-${pinned.release}-${pinned.triple}-${pinned.sha256.slice(0, 12)}`);
  const known = verifiedCaches.get(cache);
  if (known) return known;
  const tree = path.join(cache, pinned.dirName);
  const python = path.join(tree, "bin", "python3");
  const mirror = path.join(cache, "mirror");
  const archive = path.join(mirror, ...decodeURIComponent(pinned.mirrorPath).split("/"));
  // The installer also marks the tree as not a place to install packages
  // into; a tree an older script unpacked lacks the marker and is rebuilt.
  const marked = () => {
    try {
      return readdirSync(path.join(tree, "lib")).some((entry) =>
        /^python3\.\d+$/.test(entry) && existsSync(path.join(tree, "lib", entry, "EXTERNALLY-MANAGED")));
    } catch {
      return false;
    }
  };
  const ready = () => sha256File(archive) === pinned.sha256 && runsPinned(python, pinned.version) && marked();
  if (!ready()) {
    if (options.build === false) throw new BlockedError(`the pinned Python runtime cache ${cache} is not complete`);
    mkdirSync(cache, { recursive: true });
    withFileLock(path.join(cache, ".lock"), INSTALL_BUDGET_MS, () => {
      if (sha256File(archive) !== pinned.sha256) fetchPinnedArchive(pinned, archive);
      if (runsPinned(python, pinned.version) && marked()) return;
      const scratch = mkdtempSync(path.join(cache, ".install-"));
      try {
        const run = spawnSync("sh", [path.join(openRoot, RUNTIME_SCRIPTS, "install-python.sh"), scratch], {
          encoding: "utf8",
          timeout: INSTALL_BUDGET_MS,
          maxBuffer: 1 << 20,
          env: { ...process.env, GENEHUB_PYTHON_MIRRORS: pathToFileURL(mirror).href },
        });
        const installed = path.join(scratch, pinned.dirName);
        let recorded: string | undefined;
        try {
          recorded = (JSON.parse(readFileSync(path.join(scratch, "python.json"), "utf8")) as { python?: string }).python;
        } catch {
          // reported below as the exit status
        }
        if (run.status !== 0 || recorded !== path.join(installed, "bin", "python3")) {
          throw new Error(`the shipped installer could not install Python ${pinned.version} from the cached archive: ${
            run.stderr?.trim() || run.error?.message || `exit ${run.status}`}`);
        }
        rmSync(tree, { recursive: true, force: true });
        renameSync(installed, tree);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
    if (!ready()) throw new Error(`the cached runtime ${cache} does not hold the pinned Python ${pinned.version}`);
  }
  const found = { tree, mirror: pathToFileURL(mirror).href };
  verifiedCaches.set(cache, found);
  return found;
}

/** Fetched with curl, which the installer itself requires on this path. */
function fetchPinnedArchive(pinned: PinnedPythonRuntime, archive: string): void {
  mkdirSync(path.dirname(archive), { recursive: true });
  const partial = `${archive}.${process.pid}.part`;
  const failures: string[] = [];
  try {
    for (const url of pinned.upstream) {
      const run = spawnSync("curl", ["-fsSL", "--retry", "2", "--connect-timeout", "15", "-o", partial, url], {
        encoding: "utf8",
        timeout: INSTALL_BUDGET_MS,
      });
      if (run.status === 0 && sha256File(partial) === pinned.sha256) {
        renameSync(partial, archive);
        return;
      }
      failures.push(`${new URL(url).host}: ${run.status === 0 ? "SHA-256 mismatch" : (run.stderr || run.error?.message || `exit ${run.status}`).trim()}`);
    }
  } finally {
    rmSync(partial, { force: true });
  }
  throw new BlockedError(`the pinned Python archive could not be fetched from the installer's URLs (${failures.join("; ")})`);
}
