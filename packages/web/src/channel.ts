// Which release channel this build belongs to.
//
// Written wholesale by `scripts/channel.sh` — edit that script, not this
// file. The tree always says "official"; a beta build is the release workflow
// stamping "beta" in before it compiles.
export const CHANNEL: "official" | "beta" = "official";
export const PRODUCT = "GeneHub";
