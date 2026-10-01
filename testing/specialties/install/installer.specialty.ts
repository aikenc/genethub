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

function assetName(prefix = "genet-local"): string {
  const os = process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${prefix}-${os}-${arch}.tar.gz`;
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

interface ReleaseNames {
  prefix: string;
  cli: string;
  host: string;
  guest: string;
  /** The component's name inside the tarball: the one its CLI looks for. */
  component: string;
}

const LOCAL_RELEASE: ReleaseNames = {
  prefix: "genet-local",
  cli: "genet-local",
  host: "genehub-host-local",
  guest: "guest-component-fixture",
  component: "genehub_guest.wasm",
};

function fakeRelease(names: ReleaseNames = LOCAL_RELEASE): string {
  const dir = mkdtempSync(path.join(tmpdir(), "genehub-install-release-"));
  const staged = path.join(dir, "staged");
  mkdirSync(staged, { recursive: true });
  const binary = path.join(staged, names.cli);
  writeFileSync(
    binary,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"${GENEHUB_TEST_CALLS:-/dev/null}\"\necho ok\n",
  );
  chmodSync(binary, 0o755);
  const host = path.join(staged, names.host);
  writeFileSync(host, `#!/bin/sh\necho ${names.host}\n`);
  chmodSync(host, 0o755);
  writeFileSync(path.join(staged, names.component), names.guest);
  const asset = assetName(names.prefix);
  const tar = spawnSync(
    "tar",
    ["-czf", path.join(dir, asset), "-C", staged, names.cli, names.host, names.component],
    { encoding: "utf8" },
  );
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  const sums = spawnSync("sha256sum", [asset], { cwd: dir, encoding: "utf8" });
  if (sums.status !== 0) throw new Error(`sha256sum failed: ${sums.stderr}`);
  writeFileSync(path.join(dir, "SHA256SUMS"), sums.stdout);
  return dir;
}

// What deployment serves: the tree's install.sh with only its `channel=`
// line rewritten.
function channelScript(openRoot: string, dir: string, channel: string): string {
  const source = readFileSync(scriptPath(openRoot), "utf8");
  const stamped = source.replace(/^channel=.*$/m, `channel=${channel}`);
  if (stamped === source) throw new Error("install.sh has no channel= line to stamp");
  const script = path.join(dir, `install-${channel}.sh`);
  writeFileSync(script, stamped);
  return script;
}

function runInstall(
  openRoot: string,
  release: string,
  bin: string,
  extra: Record<string, string> = {},
  script = scriptPath(openRoot),
): { status: number | null; stdout: string; stderr: string } {
  const tools = mkdtempSync(path.join(tmpdir(), "genehub-install-tools-"));
  writeCurlShim(tools);
  const result = spawnSync("sh", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${tools}:${process.env.PATH ?? ""}`,
      GENEHUB_TEST_RELEASE: release,
      GENEHUB_LOCAL_DOWNLOAD_BASE: "https://downloads.example.invalid",
      GENEHUB_LOCAL_BIN_DIR: bin,
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
    oracle: "install.sh lands an executable genet-local and genehub-host-local plus genehub_guest.wasm and says PATH/start",
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
      const installed = path.join(bin, "genet-local");
      t.assertions.assert(existsSync(installed), "genet-local was not installed");
      const ran = spawnSync(installed, [], { encoding: "utf8" });
      t.assertions.assert(ran.status === 0, "genet-local did not run");
      t.assertions.assert(existsSync(path.join(bin, "genehub-host-local")), "genehub-host-local was not installed");
      t.assertions.assert(
        readFileSync(path.join(bin, "genehub_guest.wasm"), "utf8") === "guest-component-fixture",
        "installed guest component did not match",
      );
      t.assertions.assert(output.stdout.includes("not on your PATH"), `no PATH hint in:\n${output.stdout}`);
      t.assertions.assert(output.stdout.includes("genet-local daemon start"), `did not say what to run:\n${output.stdout}`);
    } finally {
      rmSync(release, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  {
    id: "specialty.install.channels-share-bin-dir",
    title: "Installing one channel leaves another channel's files in the same directory alone",
    oracle: "beta then stable then beta into one bin dir: each channel's CLI, shell and component keep that channel's bytes",
    catches: ["two channels install the component under one name", "stable install replaces the component a beta daemon runs"],
    tags: ["core", "install"],
    expectedDurationMs: 10_000,
    timeoutMs: 45_000,
    surfaces: ["install"],
  },
  async (t) => {
    if (installerUnsupported()) return;
    const beta: ReleaseNames = {
      prefix: "genet-beta",
      cli: "genet-beta",
      host: "genehub-host-beta",
      guest: "beta-guest",
      component: "genehub_guest-beta.wasm",
    };
    const stable: ReleaseNames = {
      prefix: "genet",
      cli: "genet",
      host: "genehub-host",
      guest: "stable-guest",
      component: "genehub_guest.wasm",
    };
    const releases = { beta: fakeRelease(beta), stable: fakeRelease(stable) };
    const home = mkdtempSync(path.join(tmpdir(), "genehub-install-home-"));
    const bin = path.join(home, "bin");
    const install = (channel: "beta" | "stable") => {
      const base = channel === "beta" ? "GENEHUB_BETA" : "GENEHUB";
      const output = runInstall(
        t.openRoot,
        releases[channel],
        bin,
        { [`${base}_DOWNLOAD_BASE`]: "https://downloads.example.invalid", [`${base}_BIN_DIR`]: bin },
        channelScript(t.openRoot, home, channel),
      );
      t.assertions.assert(output.status === 0, `${channel} install failed: ${output.stderr}`);
    };
    const expectInstalled = (after: string) => {
      const files: Array<[string, string]> = [
        ["genehub_guest-beta.wasm", "beta-guest"],
        ["genehub_guest.wasm", "stable-guest"],
        ["genehub-host-beta", "#!/bin/sh\necho genehub-host-beta\n"],
        ["genehub-host", "#!/bin/sh\necho genehub-host\n"],
      ];
      for (const [file, bytes] of files) {
        const installed = path.join(bin, file);
        t.assertions.assert(existsSync(installed), `${file} missing after ${after}`);
        t.assertions.assert(readFileSync(installed, "utf8") === bytes, `${file} holds another channel's bytes after ${after}`);
      }
      for (const cli of ["genet-beta", "genet"]) {
        t.assertions.assert(existsSync(path.join(bin, cli)), `${cli} missing after ${after}`);
      }
    };
    try {
      install("beta");
      install("stable");
      expectInstalled("installing stable over beta");
      install("beta");
      expectInstalled("reinstalling beta over stable");
    } finally {
      rmSync(releases.beta, { recursive: true, force: true });
      rmSync(releases.stable, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  {
    id: "specialty.install.older-release-keeps-its-component-name",
    title: "A newer install script still installs an older release the way that release's CLI expects",
    oracle: "beta install.sh given a tarball that carries only genehub_guest.wasm installs the component under that name and creates no channel-named copy",
    catches: ["install script served ahead of the App renames the component its CLI cannot find"],
    tags: ["core", "install"],
    expectedDurationMs: 6_000,
    timeoutMs: 30_000,
    surfaces: ["install"],
  },
  async (t) => {
    if (installerUnsupported()) return;
    const older: ReleaseNames = {
      prefix: "genet-beta",
      cli: "genet-beta",
      host: "genehub-host-beta",
      guest: "older-beta-guest",
      component: "genehub_guest.wasm",
    };
    const release = fakeRelease(older);
    const home = mkdtempSync(path.join(tmpdir(), "genehub-install-home-"));
    const bin = path.join(home, "bin");
    try {
      const output = runInstall(
        t.openRoot,
        release,
        bin,
        { GENEHUB_BETA_DOWNLOAD_BASE: "https://downloads.example.invalid", GENEHUB_BETA_BIN_DIR: bin },
        channelScript(t.openRoot, home, "beta"),
      );
      t.assertions.assert(output.status === 0, `install failed: ${output.stderr}`);
      const shared = path.join(bin, "genehub_guest.wasm");
      t.assertions.assert(existsSync(shared) && readFileSync(shared, "utf8") === "older-beta-guest", "component not where the older CLI looks");
      t.assertions.assert(!existsSync(path.join(bin, "genehub_guest-beta.wasm")), "installed a name the older CLI never reads");
      t.assertions.assert(output.stdout.includes(shared), `install summary does not name ${shared}:\n${output.stdout}`);
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
        env: { ...process.env, GENEHUB_LOCAL_DOWNLOAD_BASE: base },
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
      t.assertions.assert(!existsSync(path.join(bin, "genet-local")), "installed anyway");
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
    id: "specialty.install.local-tree-needs-base",
    title: "The tree installer refuses without an explicit download base",
    oracle: "local install.sh without GENEHUB_LOCAL_DOWNLOAD_BASE exits mentioning channel: local",
    catches: ["source checkout silently installs stable"],
    tags: ["core", "install", "parity"],
    expectedDurationMs: 2_000,
    timeoutMs: 15_000,
    surfaces: ["install"],
  },
  async (t) => {
    const env = { ...process.env };
    delete env.GENEHUB_LOCAL_DOWNLOAD_BASE;
    const output = spawnSync("sh", [scriptPath(t.openRoot)], { encoding: "utf8", env });
    t.assertions.assert(output.status !== 0, "a local install.sh ran anyway");
    t.assertions.assert(
      (output.stderr ?? "").includes("channel: local"),
      `the refusal does not say why:\n${output.stderr}`,
    );
  },
);
