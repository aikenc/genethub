import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { versionForChannel } from "../../scripts/product-version.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
function revision(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

// Git tags (including failed release tags) never determine a product version.
export function buildIdentity(host, env = process.env) {
  const channel = env.VITE_GENEHUB_CHANNEL ?? "local";
  const releaseVersion = env.RELEASE_VERSION ?? null;
  if (releaseVersion !== null) versionForChannel(releaseVersion, channel);
  return {
    schema: "genehub.product-build.v1",
    channel,
    releaseVersion,
    openSha: revision(root),
    ...(host ? { cloudSha: revision(host.root) } : {}),
  };
}
export function buildStamp(host) {
  const id = buildIdentity(host);
  return `${id.openSha.slice(0, 12)}${id.cloudSha ? ` · cloud ${id.cloudSha.slice(0, 12)}` : ""}`;
}
export function buildDefines(host) {
  return {
    __WORKBENCH_BUILD__: JSON.stringify(buildStamp(host)),
    __PRODUCT_VERSION__: JSON.stringify(buildIdentity(host).releaseVersion),
  };
}
// Dist carries the same identity compiled into the JS. A publisher cannot relabel it.
export function productIdentityPlugin(host) {
  return {
    name: "genehub-product-identity",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: ".product-build.json",
        source: JSON.stringify(buildIdentity(host)) + "\n",
      });
    },
  };
}
