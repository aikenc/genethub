/**
 * Where a freshly attached workbench should land, taken from the address bar.
 *
 * Consumed once by `land`, so a later workspace switch does not re-apply a
 * stale session from the URL that brought us here.
 */
export type LandingIntent = {
  workspaceId: string | null;
  sessionId: string | null;
  previewPath: string | null;
  /** Shareable strip tokens from `?tabs=`. Restored without stealing focus. */
  tabs?: string[];
};

let pending: LandingIntent | null = null;

export function setLandingIntent(intent: LandingIntent | null): void {
  pending = intent;
}

export function takeLandingIntent(): LandingIntent | null {
  const value = pending;
  pending = null;
  return value;
}
