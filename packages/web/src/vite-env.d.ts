/// <reference types="vite/client" />

/**
 * Build-time settings. Everything here is optional: a build of this repository
 * alone sets none of them, and the workbench has to work that way.
 */
interface ImportMetaEnv {
  /** A Hub to suggest, for a deployment that runs one. */
  readonly VITE_GENEHUB_HUB_URL?: string;
  /** Identifies one isolated source-tree deployment, for example `dev-ui`. */
  readonly VITE_GENEHUB_DEV_NAME?: string;
  /** Hosted Web release line; native builds instead use scripts/channel.mjs. */
  readonly VITE_GENEHUB_CHANNEL?: "dev" | "official" | "beta" | "alpha";
  /** Hosted product label paired with VITE_GENEHUB_CHANNEL. */
  readonly VITE_GENEHUB_BRAND?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
