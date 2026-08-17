// Which release channel this build belongs to.
//
// Written wholesale by `scripts/channel.mjs` — edit that script, not this
// file. The tree always says "dev"; a release build is the workflow stamping
// its channel in before it compiles. The separately deployed hosted Web sets
// VITE_GENEHUB_CHANNEL instead, so publishing a page never mutates the paired
// Open checkout just to stamp a native release identity.
export type ReleaseChannel = "dev" | "official" | "beta" | "alpha";
const STAMPED_CHANNEL: ReleaseChannel = "dev";
const hostedChannel = import.meta.env.VITE_GENEHUB_CHANNEL;
export const CHANNEL: ReleaseChannel = isReleaseChannel(hostedChannel) ? hostedChannel : STAMPED_CHANNEL;
const PRODUCTS: Record<ReleaseChannel, string> = {
  dev: "GeneHub Dev",
  official: "GeneHub",
  beta: "GeneHub Beta",
  alpha: "GeneHub Alpha",
};
export const PRODUCT = import.meta.env.VITE_GENEHUB_BRAND || PRODUCTS[CHANNEL];
// Fixed discovery feeds. The App feed also supplies the channel-local human
// download page when Platform reports an ABI mismatch. Dev has no remote feed.
export const APP_MANIFEST_URLS: readonly string[] = [];
export const LOGIC_MANIFEST_URLS: readonly string[] = [];
export const WEB_APP_URL = "http://127.0.0.1:5173/app";

function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return value === "dev" || value === "official" || value === "beta" || value === "alpha";
}
