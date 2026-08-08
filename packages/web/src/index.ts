/**
 * The package entry point for anyone embedding the workbench.
 *
 * Another repository can import `App` and mount it itself, optionally passing
 * extra tabs of its own. Nothing here knows what those tabs contain: an
 * injected page talks to whatever backend it belongs to, which is what keeps
 * this package free of any notion of accounts.
 */

// First, and for its side effects: the palette and the keyboard inset are set
// up by importing this package, not by the host remembering to ask.
import "./boot";

export { App } from "./App";
export { detectHost, browserHost, desktopHost, LOCAL_TARGET } from "./host";
export type { Endpoint, Host, Notification, Target } from "./host";
export { Client } from "./protocol/client";
export { AssetPreviewPage } from "./preview/AssetPreviewPage";
export { assetPreviewUrl, parseAssetPreviewPath } from "./preview/url";
export { useWorkbench } from "./session/store";
export type { ExtraTab } from "./shell/tabs";
