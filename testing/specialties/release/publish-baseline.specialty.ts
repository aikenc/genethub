import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BlockedError, defineSpecialty, type CaseContext } from "../../framework/public.ts";

// Incident oracle: a newly installed .13 App already bundles the new WASM.
// A stale .12 Live manifest must neither set the next generation nor be edited.
// Exercise the operator's real offline planning entry, with REST response files.
function app(version: string, overrides: Record<string, unknown> = {}) {
  const tag = `v${version}`;
  return {
    id: 13002, tag_name: tag, draft: false, prerelease: true,
    published_at: "2026-09-10T04:30:00Z",
    html_url: `https://github.com/aikenc/genethub/releases/tag/${tag}`,
    assets: ["genehub_guest.wasm", "SHA256SUMS", "latest-beta.json",
      "GeneHub-beta-windows-x64-setup.exe", "genet-beta-linux-x64.tar.gz", "genet-beta-darwin-arm64.tar.gz",
    ].map((name) => ({ name, state: "uploaded", size: 100,
      browser_download_url: `https://github.com/aikenc/genethub/releases/download/${tag}/${name}` })),
    ...overrides,
  };
}

function planner(t: CaseContext, current: string | null, releases: unknown, extra: string[] = []) {
  const cloud = process.env.TESTCTL_CLOUD_ROOT;
  if (!cloud) throw new BlockedError("paired Cloud root is required for version rules");
  const stage = path.join(t.env.workspace, "stage");
  const dir = path.join(stage, "artifacts/manifests/component");
  mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, "latest-beta.json");
  const bytes = JSON.stringify({ schema: "genehub.release-manifest.v2", channel: "beta", releaseVersion: current });
  if (current) writeFileSync(manifest, bytes);
  const metadata = path.join(t.env.workspace, "releases.json");
  const metadataBytes = JSON.stringify(releases);
  writeFileSync(metadata, metadataBytes);
  const result = spawnSync(process.execPath, [path.join(t.openRoot, "scripts/publish-component.mjs"),
    "--plan", "--channel", "beta", "--stage", stage, "--cloud-root", cloud,
    "--app-releases", metadata, ...extra], { cwd: t.openRoot, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.error, undefined);
  if (current) assert.equal(readFileSync(manifest, "utf8"), bytes, "planning must preserve the old Live manifest");
  assert.equal(readFileSync(metadata, "utf8"), metadataBytes);
  return { ...result, metadataDigest: createHash("sha256").update(metadataBytes).digest("hex") };
}

function meta(id: string, title: string) {
  return { id: `specialty.release.publish-baseline-${id}`, title,
    oracle: "App .13 supersedes old Live .12 for version allocation without altering old artifacts",
    catches: ["old Live masks new App", "failed or wrong-channel releases advance baseline", "explicit version bypasses baseline"],
    tags: ["core", "contract", "release", "publish-baseline"], llm: { default: "none" as const },
    expectedDurationMs: 1500, timeoutMs: 30_000,
    resources: { environments: 1, cpu: 1, memoryMb: 256, io: 1, browser: 0 },
    surfaces: ["release-planner", "filesystem", "git"], productInterfaces: ["publish-component.mjs --plan"],
  };
}

defineSpecialty(meta("app-live", "New App advances Live allocation; later Lives continue on the new generation"), async (t) => {
  let result = planner(t, "0.12.1-beta.11", [app("0.13.0-beta.2")]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.version, "0.13.1-beta.1");
  assert.equal(plan.baseline.component, "0.12.1-beta.11");
  assert.equal(plan.baseline.product, "0.13.0-beta.2");
  assert.equal(plan.baseline.metadata.sha256, result.metadataDigest);
  assert.match(plan.source.openSha, /^[a-f0-9]{40}$/);
  assert.match(plan.source.cloudSha, /^[a-f0-9]{40}$/);
  result = planner(t, "0.13.1-beta.1", [app("0.13.0-beta.2")]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, "0.13.1-beta.2");
});

defineSpecialty(meta("release-evidence", "Drafts, missing assets, rolling tags and wrong channels cannot advance the App baseline"), async (t) => {
  const releases = [app("0.15.0-beta.1", { draft: true }), app("0.14.0-beta.1", { assets: [] }),
    app("0.13.0-beta.3", { published_at: null }), app("0.99.0-dev.1"),
    app("0.13.0-beta.9", { tag_name: "beta" }), app("0.12.0-beta.3"), app("0.13.0-beta.2")];
  const result = planner(t, "0.12.1-beta.11", releases);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, "0.13.1-beta.1");
  const missing = planner(t, "0.12.1-beta.11", []);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /no complete published Beta App/);
});

defineSpecialty(meta("reject-stale", "Explicit obsolete Live and stale App metadata fail before building"), async (t) => {
  for (const version of ["0.12.1-beta.12", "0.13.0-beta.3", "0.14.1-beta.1", "0.13.1-dev.1"]) {
    const result = planner(t, "0.12.1-beta.11", [app("0.13.0-beta.2")], ["--version", version]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Live version must stay/);
  }
  const stale = planner(t, "0.14.1-beta.1", [app("0.13.0-beta.2")]);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /refresh App release metadata/);
});

defineSpecialty(meta("first-live", "An App with no historical Live can plan its first Live"), async (t) => {
  const result = planner(t, null, [app("0.13.0-beta.2")]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, "0.13.1-beta.1");
  const malformed = planner(t, null, { version: "0.13.0-beta.2" });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /REST releases array/);
});
