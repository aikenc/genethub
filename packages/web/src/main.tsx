import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { PRODUCT } from "./channel";
import { AssetPreviewPage } from "./preview/AssetPreviewPage";
import { parseAssetPreviewPath } from "./preview/url";
import { watchViewport } from "./shell/viewport";
import "./theme.css";
import { applyTheme, useTheme, watchSystemTheme } from "./theme/store";

// The tab title is the one place a browser build still names the product;
// the desktop window takes its title from tauri.conf.json instead.
document.title = PRODUCT;

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

/*
 * Before the first render, not inside a component.
 *
 * The stylesheet is render-blocking and this module runs after it and before
 * React puts anything on screen, so the very first frame already has the right
 * class on `<html>`. Doing it in an effect instead would paint one frame of the
 * other palette on every launch.
 *
 * An inline script in `index.html` would be a shade earlier still, and is what
 * most apps do — but the desktop CSP allows scripts from `'self'` only, and
 * opening it to inline scripts to save part of a frame is a bad trade.
 */
applyTheme(useTheme.getState().resolved);
watchSystemTheme((theme) => useTheme.getState().systemChanged(theme));
// Belongs to the window, not to any component: the keyboard can arrive while
// any pane is open, and every one of them is inside the same fixed box.
watchViewport();

const preview = parseAssetPreviewPath(window.location.pathname);

createRoot(root).render(
  <StrictMode>
    {preview ? <AssetPreviewPage source={preview} /> : <App />}
  </StrictMode>,
);
