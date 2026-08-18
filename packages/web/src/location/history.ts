import { stripSiteBase, withSiteBase } from "./base";

export const LOCATION_MOVED = "genehub:moved";

export function currentAppHref(
  location: Pick<Location, "pathname" | "search"> = window.location,
): string {
  const { pathname, search } = stripSiteBase(location.pathname, location.search);
  return `${pathname}${search}`;
}

export function goApp(
  pathAndSearch: string,
  mode: "push" | "replace" = "push",
  location: Pick<Location, "pathname" | "search"> = window.location,
): void {
  const destination = withSiteBase(pathAndSearch);
  const current = `${location.pathname}${location.search}`;
  if (current === destination) return;
  if (mode === "replace") window.history.replaceState(window.history.state, "", destination);
  else window.history.pushState(window.history.state, "", destination);
  window.dispatchEvent(new Event(LOCATION_MOVED));
}

export function readAppHref(): { pathname: string; search: string } {
  return stripSiteBase(window.location.pathname, window.location.search);
}
