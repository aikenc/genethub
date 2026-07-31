// Which release channel this build belongs to.
//
// Written wholesale by `scripts/channel.mjs` — edit that script, not this
// file. The tree always says "dev"; a release build is the workflow stamping
// its channel in before it compiles.
export const CHANNEL: "dev" | "official" | "beta" | "alpha" = "dev";
export const PRODUCT = "GeneHub Dev";
