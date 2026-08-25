// Build identity: "local" for a source tree, otherwise the release channel.
//
// Written wholesale by `scripts/channel.mjs` — edit that script, not this
// file. The tree always says "local"; a release build is the workflow stamping
// its channel in before it compiles. The separately deployed Web sets
// VITE_GENEHUB_CHANNEL instead, so publishing a page never mutates the paired
// Open checkout just to stamp a native release identity.
export type BuildIdentity = "local" | "dev" | "beta" | "stable";
const STAMPED_CHANNEL: BuildIdentity = "local";
const hostedChannel = import.meta.env.VITE_GENEHUB_CHANNEL;
export const CHANNEL: BuildIdentity = isBuildIdentity(hostedChannel)
  ? hostedChannel
  : STAMPED_CHANNEL;
const PRODUCTS: Record<BuildIdentity, string> = {
  local: "GeneHub Local",
  dev: "GeneHub Dev",
  beta: "GeneHub Beta",
  stable: "GeneHub",
};
export const PRODUCT = import.meta.env.VITE_GENEHUB_BRAND || PRODUCTS[CHANNEL];

function isBuildIdentity(value: unknown): value is BuildIdentity {
  return value === "local" || value === "dev" || value === "beta" || value === "stable";
}
