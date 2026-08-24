import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { PRODUCT } from "./channel";
import { parsePortablePreviewTicket, parsePreviewPopout } from "./preview/popout";
import { PreviewPopoutPage } from "./preview/PreviewPopoutPage";
import { parseAssetPreviewPath } from "./preview/url";
import { watchViewport } from "./shell/viewport";
import "./theme.css";
import { applyUiScale, useUiScale } from "./theme/scale";
import { applyTheme, useTheme, watchSystemTheme } from "./theme/store";

// Fallback until the workbench knows which machine / workspace / session is
// on screen. The desktop window takes its chrome title from tauri.conf.json.
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
applyUiScale(useUiScale.getState().scale);
watchSystemTheme((theme) => useTheme.getState().systemChanged(theme));
// Belongs to the window, not to any component: the keyboard can arrive while
// any pane is open, and every one of them is inside the same fixed box.
watchViewport();

const preview = parseAssetPreviewPath(window.location.pathname);
const previewPopout = preview
  ? parsePreviewPopout(window.location.search, window.location.hash)
  : null;
const previewTicket = preview
  ? parsePortablePreviewTicket(window.location.search, window.location.hash)
  : null;

createRoot(root).render(
  <StrictMode>
    {preview ? (
      <PreviewPopoutPage
        source={preview}
        context={previewPopout}
        portableTicket={previewTicket}
      />
    ) : (
      <App />
    )}
  </StrictMode>,
);
