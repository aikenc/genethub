/**
 * Site-relative base for workbench locators.
 *
 * Same rule as Asset Preview: a root deploy is `/`, a Cloud subpath keeps its
 * prefix, and a Tauri `./` bundle is treated as origin-rooted.
 */
export function siteBasePath(): string {
  const configured = import.meta.env.BASE_URL || "/";
  return configured.startsWith("/") ? configured : "/";
}

export function withSiteBase(pathAndSearch: string, basePath = siteBasePath()): string {
  if (!pathAndSearch.startsWith("/") || pathAndSearch.startsWith("//")) {
    throw new TypeError("GeneHub path must be site-relative");
  }
  const base = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  return `${base}${pathAndSearch}`;
}

export function stripSiteBase(
  pathname: string,
  search = "",
  basePath = siteBasePath(),
): { pathname: string; search: string } {
  const base = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  const app =
    !base || pathname === base
      ? pathname === base
        ? "/"
        : pathname
      : pathname.startsWith(`${base}/`)
        ? pathname.slice(base.length)
        : "/";
  return { pathname: app, search };
}
