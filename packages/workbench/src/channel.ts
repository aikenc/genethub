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
export const CHANNEL: ReleaseChannel = isReleaseChannel(hostedChannel)
  ? hostedChannel
  : STAMPED_CHANNEL;
const PRODUCTS: Record<ReleaseChannel, string> = {
  dev: "GeneHub Dev",
  official: "GeneHub",
  beta: "GeneHub Beta",
  alpha: "GeneHub Alpha",
};
export const PRODUCT = import.meta.env.VITE_GENEHUB_BRAND || PRODUCTS[CHANNEL];
// The desktop shell checks its own release independently from whichever
// daemon the workbench currently controls. In a browser this stays unused;
// in a source build it is empty, because dev is not on a release scale.
export const MANIFEST_URL = "";

function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return value === "dev" || value === "official" || value === "beta" || value === "alpha";
}
