/**
 * Which build of the page this is.
 *
 * Printed in settings next to the daemon's version, and it is not the same
 * question. The daemon runs on the machine being driven and updates itself; the
 * page is a separate artefact, served from wherever it was last deployed to,
 * and the two can be months apart without anything looking wrong. Settings used
 * to show only the daemon's number, which read as *the* version — so a stale
 * deployment looked like a fixed bug that had come back.
 *
 * `build-stamp.js` writes the value at bundle time.
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
