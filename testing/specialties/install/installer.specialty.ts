import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

function installerUnsupported(): boolean {
  return process.platform === "linux" && process.arch === "arm64";
}

function assetName(): string {
  const os = process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `genet-dev-${os}-${arch}.tar.gz`;
}

function scriptPath(openRoot: string): string {
  return path.join(openRoot, "scripts", "install.sh");
}

function writeCurlShim(tools: string): string {
  const curl = path.join(tools, "curl");
  writeFileSync(
    curl,
    `#!/bin/sh
set -eu
proto=
proto_redir=
max_redirs=
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --proto) proto="$2"; shift 2 ;;
    --proto-redir) proto_redir="$2"; shift 2 ;;
    --max-redirs) max_redirs="$2"; shift 2 ;;
    -o) output="$2"; shift 2 ;;
    --globoff|-fsSL) shift ;;
    -*) echo "unexpected curl option: $1" >&2; exit 91 ;;
    *) url="$1"; shift ;;
  esac
done
[ "$proto" = "=https" ] || { echo "curl protocol was not pinned" >&2; exit 92; }
[ "$proto_redir" = "=https" ] || { echo "curl redirect protocol was not pinned" >&2; exit 93; }
[ "$max_redirs" = 5 ] || { echo "curl redirects were not bounded" >&2; exit 94; }
case "$url" in
  https://downloads.example.invalid/*) ;;
  *) echo "unexpected URL: $url" >&2; exit 95 ;;
esac
cp "$GENEHUB_TEST_RELEASE/\${url##*/}" "$output"
`,
  );
  chmodSync(curl, 0o755);
  return curl;
}

function fakeRelease(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "genehub-install-release-"));
  const staged = path.join(dir, "staged");
  mkdirSync(staged, { recursive: true });
  const binary = path.join(staged, "genet-dev");
  writeFileSync(
    binary,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"${GENEHUB_TEST_CALLS:-/dev/null}\"\necho ok\n",
  );
  chmodSync(binary, 0o755);
  const host = path.join(staged, "genehub-host-dev");
  writeFileSync(host, "#!/bin/sh\necho genehub-host-dev\n");
  chmodSync(host, 0o755);
  writeFileSync(path.join(staged, "genehub_guest.wasm"), "guest-component-fixture");
  const tar = spawnSync(
    "tar",
    ["-czf", path.join(dir, assetName()), "-C", staged, "genet-dev", "genehub-host-dev", "genehub_guest.wasm"],
    { encoding: "utf8" },
  );
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  const sums = spawnSync("sha256sum", [assetName()], { cwd: dir, encoding: "utf8" });
  if (sums.status !== 0) throw new Error(`sha256sum failed: ${sums.stderr}`);
  writeFileSync(path.join(dir, "SHA256SUMS"), sums.stdout);
  return dir;
}

function runInstall(
  openRoot: string,
  release: string,
  bin: string,
  extra: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const tools = mkdtempSync(path.join(tmpdir(), "genehub-install-tools-"));
  writeCurlShim(tools);
  const result = spawnSync("sh", [scriptPath(openRoot)], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${tools}:${process.env.PATH ?? ""}`,
      GENEHUB_TEST_RELEASE: release,
      GENEHUB_DEV_DOWNLOAD_BASE: "https://downloads.example.invalid",
      GENEHUB_DEV_BIN_DIR: bin,
      ...extra,
    },
  });
  rmSync(tools, { recursive: true, force: true });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

defineSpecialty(
  {
    id: "specialty.install.binaries-and-logic-on-path",
    title: "Installing puts binaries and logic where the path can find them",
    oracle: "install.sh lands an executable genet-dev and genehub-host-dev plus genehub_guest.wasm and says PATH/start",
    catches: ["installer writes a truncated file", "guest component or shell omitted"],
    tags: ["core", "install", "parity"],
    expectedDurationMs: 8_000,
    timeoutMs: 30_000,
    surfaces: ["install"],
  },
  async (t) => {
    if (installerUnsupported()) return;
    const release = fakeRelease();
    const home = mkdtempSync(path.join(tmpdir(), "genehub-install-home-"));
    const bin = path.join(home, "bin");
    try {
      const output = runInstall(t.openRoot, release, bin);
      t.assertions.assert(output.status === 0, `install failed: ${output.stderr}`);
      const installed = path.join(bin, "genet-dev");
      t.assertions.assert(existsSync(installed), "genet-dev was not installed");
      const ran = spawnSync(installed, [], { encoding: "utf8" });
      t.assertions.assert(ran.status === 0, "genet-dev did not run");
      t.assertions.assert(existsSync(path.join(bin, "genehub-host-dev")), "genehub-host-dev was not installed");
      t.assertions.assert(
        readFileSync(path.join(bin, "genehub_guest.wasm"), "utf8") === "guest-component-fixture",
        "installed guest component did not match",
      );
      t.assertions.assert(output.stdout.includes("not on your PATH"), `no PATH hint in:\n${output.stdout}`);
      t.assertions.assert(output.stdout.includes("genet-dev daemon start"), `did not say what to run:\n${output.stdout}`);
    } finally {
      rmSync(release, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  {
    id: "specialty.install.restart-daemon-with-new-binary",
    title: "An explicit install can restart the daemon with the new binary",
    oracle: "GENEHUB_RESTART_DAEMON=1 makes the newly installed CLI receive daemon restart",
    catches: ["restart talks to the old binary"],
    tags: ["core", "install", "parity"],
    expectedDurationMs: 8_000,
    timeoutMs: 30_000,
    surfaces: ["install"],
  },
  async (t) => {
    if (installerUnsupported()) return;
    const release = fakeRelease();
    const home = mkdtempSync(path.join(tmpdir(), "genehub-install-home-"));
    const bin = path.join(home, "bin");
    const calls = path.join(home, "calls");
    try {
      const output = runInstall(t.openRoot, release, bin, {
        GENEHUB_RESTART_DAEMON: "1",
        GENEHUB_TEST_CALLS: calls,
      });
      t.assertions.assert(output.status === 0, `update failed: ${output.stderr}`);
      t.assertions.assert(
        readFileSync(calls, "utf8") === "daemon restart\n",
        "the installer did not restart through the newly installed CLI",
      );
    } finally {
      rmSync(release, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  {
    id: "specialty.install.unsafe-bases-refused",
    title: "Unsafe download bases are refused before fetching",
    oracle: "http, file, credentials, query and fragment bases fail with download base",
    catches: ["file:// install", "http fallback"],
    tags: ["core", "install", "parity"],
    expectedDurationMs: 3_000,
    timeoutMs: 15_000,
    surfaces: ["install"],
  },
  async (t) => {
    for (const base of [
      "http://downloads.example.invalid",
      "file:///tmp/release",
      "https://user:secret@downloads.example.invalid",
      "https://downloads.example.invalid/release?channel=dev",
      "https://downloads.example.invalid/release#asset",
    ]) {
      const output = spawnSync("sh", [scriptPath(t.openRoot)], {
        encoding: "utf8",
        env: { ...process.env, GENEHUB_DEV_DOWNLOAD_BASE: base },
      });
      t.assertions.assert(output.status !== 0, `unsafe download base was accepted: ${base}`);
      t.assertions.assert(
        (output.stderr ?? "").includes("download base"),
        `unsafe base ${base} had an unhelpful refusal: ${output.stderr}`,
      );
    }
  },
);

defineSpecialty(
  {
    id: "specialty.install.https-pin",
    title: "Every fetch is pinned to https including redirects",
    oracle: "install.sh still contains curl --proto/=https pin, redirect cap, globoff, and wget https-only",
    catches: ["plain http curl", "unbounded redirects"],
    tags: ["core", "install", "parity"],
    expectedDurationMs: 400,
    timeoutMs: 10_000,
    surfaces: ["install"],
  },
  async (t) => {
    const script = readFileSync(scriptPath(t.openRoot), "utf8");
    t.assertions.assert(script.includes("--proto '=https'"), "curl proto pin missing");
    t.assertions.assert(script.includes("--proto-redir '=https'"), "curl redirect proto pin missing");
    t.assertions.assert(script.includes("--max-redirs 5"), "curl redirect cap missing");
    t.assertions.assert(script.includes("--globoff"), "curl globoff missing");
    t.assertions.assert(script.includes("wget --https-only --max-redirect=5"), "wget https pin missing");
  },
);

defineSpecialty(
  {
    id: "specialty.install.checksum-mismatch",
    title: "A download that does not match its checksum is not installed",
    oracle: "corrupting the tarball makes install.sh exit checksum mismatch and leave no binary",
    catches: ["checksum ignored"],
    tags: ["core", "install", "parity"],
    expectedDurationMs: 8_000,
    timeoutMs: 30_000,
    surfaces: ["install"],
  },
  async (t) => {
    if (installerUnsupported()) return;
    const release = fakeRelease();
    const home = mkdtempSync(path.join(tmpdir(), "genehub-install-home-"));
    const bin = path.join(home, "bin");
    try {
      const asset = path.join(release, assetName());
      t.assertions.assert(existsSync(asset), `release asset missing: ${asset}`);
      const bytes = Buffer.from(readFileSync(asset));
      if (bytes.length === 0) throw new Error("release asset is empty");
      bytes[bytes.length - 1]! ^= 0xff;
      writeFileSync(asset, bytes);
      const output = runInstall(t.openRoot, release, bin);
      t.assertions.assert(output.status !== 0, "a corrupt download was accepted");
      t.assertions.assert(output.stderr.includes("checksum mismatch"), `unhelpful refusal: ${output.stderr}`);
      t.assertions.assert(!existsSync(path.join(bin, "genet-dev")), "installed anyway");
    } finally {
      rmSync(release, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  {
    id: "specialty.install.no-checksums-refused",
    title: "A release with no checksums is refused rather than trusted",
    oracle: "removing SHA256SUMS makes install.sh say cannot be verified",
    catches: ["missing sums treated as optional"],
    tags: ["core", "install", "parity"],
    expectedDurationMs: 8_000,
    timeoutMs: 30_000,
    surfaces: ["install"],
  },
  async (t) => {
    if (installerUnsupported()) return;
    const release = fakeRelease();
    const home = mkdtempSync(path.join(tmpdir(), "genehub-install-home-"));
    const bin = path.join(home, "bin");
    try {
      rmSync(path.join(release, "SHA256SUMS"));
      const output = runInstall(t.openRoot, release, bin);
      t.assertions.assert(output.status !== 0, "an unverifiable download was accepted");
      t.assertions.assert(output.stderr.includes("cannot be verified"), `unhelpful refusal: ${output.stderr}`);
    } finally {
      rmSync(release, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  {
    id: "specialty.install.dev-tree-needs-base",
    title: "The tree installer refuses without an explicit download base",
    oracle: "dev install.sh without GENEHUB_DEV_DOWNLOAD_BASE exits mentioning channel: dev",
    catches: ["source checkout silently installs official"],
    tags: ["core", "install", "parity"],
    expectedDurationMs: 2_000,
    timeoutMs: 15_000,
    surfaces: ["install"],
  },
  async (t) => {
    const env = { ...process.env };
    delete env.GENEHUB_DEV_DOWNLOAD_BASE;
    const output = spawnSync("sh", [scriptPath(t.openRoot)], { encoding: "utf8", env });
    t.assertions.assert(output.status !== 0, "a dev install.sh ran anyway");
    t.assertions.assert(
      (output.stderr ?? "").includes("channel: dev"),
      `the refusal does not say why:\n${output.stderr}`,
    );
  },
);
