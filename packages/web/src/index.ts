/**
 * The package entry point for anyone embedding the workbench.
 *
 * Another repository can import `App` and mount it itself, optionally passing
 * extra tabs of its own. Nothing here knows what those tabs contain: an
 * injected page talks to whatever backend it belongs to, which is what keeps
 * this package free of any notion of accounts.
 */

export { App } from "./App";
export { detectHost, browserHost, desktopHost } from "./host";
export type { Endpoint, Host, Notification } from "./host";
export { Client } from "./protocol/client";
export { useWorkbench } from "./session/store";
export type { ExtraTab } from "./shell/tabs";
