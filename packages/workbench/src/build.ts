/**
 * The page uses the same Product Version rules as App and Component. Its
 * explicitly injected version identifies this artifact; source SHAs provide
 * separate provenance. A remote daemon reports the version it actually runs,
 * which can differ until that device updates. Never copy a remote version or
 * infer the page's product identity from a Git tag.
 */

/**
 * Substituted by the bundler; nothing declares it at runtime.
 *
 * Declared here rather than in `vite-env.d.ts` because this source is compiled
 * by whoever embeds it, under their tsconfig, which does not see this package's
 * ambient files. A declaration the consumer cannot find is a build they cannot
 * make — the cloud console's went down exactly this way.
 */
declare const __WORKBENCH_BUILD__: string | undefined;
export const BUILD: string =
  // A bundler that did not apply the shared `define` leaves the identifier
  // standing rather than a string. Saying so is more use than an empty gap.
  typeof __WORKBENCH_BUILD__ === "string" && __WORKBENCH_BUILD__ ? __WORKBENCH_BUILD__ : "未标记";

/** Product identity is injected explicitly; Git descriptions are diagnostic only. */
declare const __PRODUCT_VERSION__: string | null | undefined;
export const PRODUCT_VERSION: string | null = typeof __PRODUCT_VERSION__ === "string" && __PRODUCT_VERSION__ ? __PRODUCT_VERSION__ : null;
