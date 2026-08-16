import { APP_MANIFEST_URLS, CHANNEL } from "../channel";

/** Human-facing App page on the same website that owns this channel's feed. */
export function appDownloadPage(manifestUrls: readonly string[] = APP_MANIFEST_URLS): string {
  if (manifestUrls[0]) return new URL("/download", manifestUrls[0]).toString();
  if (CHANNEL !== "dev" && typeof window !== "undefined" && /^https?:$/.test(window.location.protocol)) {
    return new URL("/download", window.location.origin).toString();
  }
  return "https://genethub.com/download";
}

export const APP_DOWNLOAD_PAGE = appDownloadPage();
