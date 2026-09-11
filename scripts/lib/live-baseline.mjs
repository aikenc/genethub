import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const REPOSITORY = "aikenc/genethub";
const run = promisify(execFile);

// Release metadata is an operator input, not a signature or an installation
// receipt. Only complete, published App releases can advance the Beta baseline.
// The optional file is a saved GitHub REST /releases response for offline review.
export async function readPublishedApps(file) {
  if (file) {
    const bytes = await readFile(file);
    return { releases: JSON.parse(bytes), source: "reviewed-file", sha256: digest(bytes) };
  }
  // The release server already authenticates gh. Reuse it without reading or
  // forwarding credentials; machines without gh can use the public API below.
  try {
    const { stdout } = await run("gh", ["api", "--paginate", "--slurp", `repos/${REPOSITORY}/releases?per_page=100`], {
      timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    const pages = JSON.parse(stdout);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error("invalid paginated release response");
    return { releases: pages.flat(), source: "github-releases-gh", sha256: digest(stdout) };
  } catch {
    // Never include gh stderr: authentication diagnostics are not release data.
  }
  const releases = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`App release lookup failed: HTTP ${response.status}; save a fresh GitHub /releases response with --app-releases FILE`);
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error("App release lookup did not return an array");
    releases.push(...entries);
    if (entries.length < 100) return { releases, source: "github-releases", sha256: digest(JSON.stringify(releases)) };
  }
  throw new Error("App release history exceeds the lookup bound; use a reviewed --app-releases FILE");
}

export function betaLiveBaseline({ current, stableLatest, metadata, explicitVersion, versions }) {
  const { parseProductVersion, compareProductVersions, nextLiveVersion } = versions;
  if (!Array.isArray(metadata.releases)) throw new Error("--app-releases must contain a GitHub REST releases array");
  const live = current == null ? null : parseProductVersion(current);
  if (live && live.tag !== "beta") throw new Error("component baseline does not belong to beta");
  const requiredAssets = [
    "genehub_guest.wasm", "SHA256SUMS", "latest-beta.json",
    "GeneHub-beta-windows-x64-setup.exe",
    "genet-beta-linux-x64.tar.gz", "genet-beta-darwin-arm64.tar.gz",
  ];
  let app = null;
  for (const release of metadata.releases) {
    if (release?.draft !== false || release.prerelease !== true || !release.published_at ||
        !Number.isFinite(Date.parse(release.published_at)) || !Number.isSafeInteger(release.id) || release.id <= 0 ||
        typeof release.tag_name !== "string" || !release.tag_name.startsWith("v")) continue;
    const version = release.tag_name.slice(1);
    let parsed;
    try { parsed = parseProductVersion(version); } catch { continue; }
    if (parsed.tag !== "beta" || parsed.live !== 0) continue;
    const url = `https://github.com/${REPOSITORY}/releases/tag/${release.tag_name}`;
    if (release.html_url !== url || !Array.isArray(release.assets)) continue;
    if (!requiredAssets.every((name) => release.assets.some((asset) =>
      asset.name === name && asset.state === "uploaded" && Number.isSafeInteger(asset.size) && asset.size > 0 &&
      asset.browser_download_url === `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${name}`))) continue;
    if (!app || compareProductVersions(version, app.version) > 0) {
      app = { version, releaseId: release.id, url, publishedAt: release.published_at };
    }
  }
  if (!app) throw new Error("no complete published Beta App release found; refusing to infer the App baseline from tags or old Live alone");
  // A higher Live in an App generation missing from release metadata is not a
  // fallback: the snapshot may be stale or incomplete. Fail before publishing.
  const native = parseProductVersion(app.version);
  if (live && (live.epoch > native.epoch || (live.epoch === native.epoch && live.generation > native.generation))) {
    throw new Error("component baseline is ahead of the published App generation; refresh App release metadata");
  }
  const product = current && compareProductVersions(current, app.version) > 0 ? current : app.version;
  const next = nextLiveVersion(product, stableLatest);
  const version = explicitVersion ?? next;
  const parsed = parseProductVersion(version);
  if (parsed.tag !== "beta" || parsed.epoch !== native.epoch || parsed.generation !== native.generation ||
      parsed.live === 0 || compareProductVersions(version, next) < 0) {
    throw new Error(`Live version must stay on the published App generation and be at least ${next}`);
  }
  return {
    version,
    baseline: {
      app, component: current, product, nextLive: next,
      metadata: { source: metadata.source, sha256: metadata.sha256 },
    },
  };
}

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
