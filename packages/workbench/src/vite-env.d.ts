/// <reference types="vite/client" />

/**
 * Build-time settings. Everything here is optional: a build of this repository
 * alone sets none of them, and the workbench has to work that way.
 */
interface ImportMetaEnv {
  /** A Hub to suggest, for a deployment that runs one. */
  readonly VITE_GENEHUB_HUB_URL?: string;
  /** Identifies one isolated source-tree deployment, for example `dev-ui`. */
  readonly VITE_GENEHUB_LOCAL_NAME?: string;
  /** Hosted Vite override for the dest-stamped release channel. */
  readonly VITE_GENEHUB_CHANNEL?: string;
  /** Hosted Vite override for the on-screen product name. */
  readonly VITE_GENEHUB_BRAND?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
