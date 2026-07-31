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

/**
 * Which build this page is, substituted at bundle time from `build-stamp.js`.
 *
 * Declared, not guaranteed: a host that bundles the workbench without the
 * shared `define` leaves the identifier standing, so `build.ts` reads it
 * through `typeof` rather than assuming a string is there.
 */
declare const __WORKBENCH_BUILD__: string | undefined;
