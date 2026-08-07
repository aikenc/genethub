export const RTC_ENABLED_KEY = "genehub.rtc.enabled";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** RTC is opt-out: capable clients try a direct path without changing authority. */
export function readRtcEnabled(storage: Storage | null = browserStorage()): boolean {
  return storage?.getItem(RTC_ENABLED_KEY) !== "false";
}

export function writeRtcEnabled(
  enabled: boolean,
  storage: Storage | null = browserStorage(),
): void {
  storage?.setItem(RTC_ENABLED_KEY, String(enabled));
}
