import { useEffect, useRef } from "react";

import { currentAppHref, goApp, readAppHref } from "./history";
import { locatorsMatch } from "./locator";
import {
  formatWorkbenchPath,
  parseWorkbenchPath,
  workbenchLocationsEqual,
  type WorkbenchLocation,
} from "./workbench";

/**
 * Keeps the address bar equal to the workbench the user is looking at.
 *
 * Browser shells only. The desktop webview has no shareable origin, and writing
 * `/d/…` there would be a path the Tauri host does not serve.
 */
export function useWorkbenchHrefSync(
  enabled: boolean,
  location: WorkbenchLocation | null,
): void {
  const skipWrite = useRef(false);
  const hydrated = useRef(false);
  const previousPath = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !location) return;
    if (skipWrite.current) {
      skipWrite.current = false;
      previousPath.current = formatWorkbenchPath(location).split("?")[0] ?? null;
      return;
    }
    const currentLocation = readWorkbenchLocation();
    // Before land() consumes the address, the bar may still be more specific
    // than the store. After that first write, a closed preview or a shorter
    // path must be allowed to update the bar — otherwise `?preview=` sticks.
    if (
      !hydrated.current &&
      currentLocation &&
      locatorsMatch(currentLocation.deviceHandle, location.deviceHandle) &&
      ((currentLocation.workspaceId && !location.workspaceId) ||
        (currentLocation.sessionId && !location.sessionId) ||
        (currentLocation.preview && !location.preview))
    ) {
      return;
    }
    const next = formatWorkbenchPath({
      ...location,
      dialog: location.dialog ?? readWorkbenchDialog(),
    });
    if (currentAppHref() === next) {
      hydrated.current = true;
      previousPath.current = next.split("?")[0] ?? null;
      return;
    }
    const nextPath = next.split("?")[0] ?? next;
    const mode =
      !hydrated.current || previousPath.current === nextPath ? "replace" : "push";
    hydrated.current = true;
    previousPath.current = nextPath;
    goApp(next, mode);
  }, [enabled, location]);

  useEffect(() => {
    if (!enabled) return;
    const mark = () => {
      skipWrite.current = true;
    };
    window.addEventListener("popstate", mark);
    return () => window.removeEventListener("popstate", mark);
  }, [enabled]);
}

export function readWorkbenchLocation(): WorkbenchLocation | null {
  const { pathname, search } = readAppHref();
  return parseWorkbenchPath(pathname, search);
}

export function patchWorkbenchLocation(
  patch: Partial<WorkbenchLocation>,
  mode: "push" | "replace" = "push",
): WorkbenchLocation | null {
  const current = readWorkbenchLocation();
  if (!current) {
    if (patch.dialog === undefined) return null;
    const { pathname, search } = readAppHref();
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    if (patch.dialog) params.set("dialog", patch.dialog);
    else params.delete("dialog");
    const query = params.toString();
    goApp(query ? `${pathname || "/"}?${query}` : pathname || "/", mode);
    return null;
  }
  const next = { ...current, ...patch };
  if (workbenchLocationsEqual(current, next)) return current;
  goApp(formatWorkbenchPath(next), mode);
  return next;
}

export function readWorkbenchDialog(): WorkbenchLocation["dialog"] {
  return readWorkbenchLocation()?.dialog ?? parseBareDialog();
}

function parseBareDialog(): WorkbenchLocation["dialog"] {
  const { search } = readAppHref();
  const value = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get(
    "dialog",
  );
  if (value === "open-workspace" || value === "feedback" || value === "new-session") {
    return value;
  }
  return null;
}
