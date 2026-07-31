/// <reference types="vite/client" />

/**
 * Build-time settings. Everything here is optional: a build of this repository
 * alone sets none of them, and the workbench has to work that way.
 */
interface ImportMetaEnv {
  /** A Hub to suggest, for a deployment that runs one. */
  readonly VITE_GENEHUB_HUB_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
