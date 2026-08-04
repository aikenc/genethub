// Which release channel this build belongs to.
//
// Written wholesale by `scripts/channel.mjs` — edit that script, not this
// file. The tree always says "dev"; a release build is the workflow stamping
// its channel in before it compiles.
export const CHANNEL: "dev" | "official" | "beta" | "alpha" = "dev";
export const PRODUCT = "GeneHub Dev";
// The desktop shell checks its own release independently from whichever
// daemon the workbench currently controls. In a browser this stays unused;
// in a source build it is empty, because dev is not on a release scale.
export const MANIFEST_URL = "";
