---
name: genehub-html-preview
description: 为 Asset Preview 编写、预览或调试 GeneHub H5/HTML5 游戏、静态站点、相册与可视化。创建 index.html、链接工作区文件、使用相对资源/localStorage/fetch/图片/WASM，或 Preview 空白、缓慢、出现 SecurityError，以及用户要求 H5 demo、小游戏、相册或看板时使用。
---

# GeneHub HTML Preview

Preview opens the workspace file the user clicks. Write a **regular static site** that also opens when someone double-clicks `index.html` on a desktop. Do not embed GeneHub-specific loader scripts, do not invent `/assets/preview/...` URLs, and do not start an HTTP server for static assets.

GeneHub injects its own Preview loader. The page must not depend on that loader to run.

## Authoring

1. Emit an entry HTML file (usually `index.html`) plus assets next to it.
2. Use **relative paths** (`assets/photo.png`, `./app.js`, `../shared/style.css`). Site-root paths (`/assets/...`) and invented Preview URLs do not map back to the workspace.
3. Share the **entry file**, not a folder: `[相册](gallery/index.html)` or a bare `gallery/index.html`.
4. Keep each previewed file ≤ 64 MiB. A site may have many files; the entry HTML, each image, and each script is fetched on its own.
5. Default to static files. A local HTTP server is not required for ES modules, `fetch`, images, or WASM-from-bytes, and Preview does **not** currently proxy `127.0.0.1`.

## What works

| Need | Write this |
|---|---|
| CSS / JS / ES modules | `<link>`, `<script src>`, `import` / `import()` with **literal** relative specifiers |
| Images, audio, video | `<img src>`, `img.src =`, `new Image()`, `srcset`, `<video>` / `<audio>` / `<source>` — media loads on demand |
| Runtime data | `fetch("data.json")` or XHR with a relative URL |
| High scores / prefs | `localStorage` — Preview supplies a persistent same-interface shim |
| Tab-scoped scratch | `sessionStorage` — memory only; cleared when Preview reloads |
| HTTPS APIs / CDN | Absolute `https:` / `wss:` URLs (network is on) |
| WASM | Relative `.wasm` sibling via `fetch` + `WebAssembly.instantiate` |

`localStorage` is namespaced by device + workspace + the entry file's **directory**. Pages in the same folder share one store (like one origin). Limits: key ≤ 1 KB, value ≤ 128 KB, store ≤ 400 KB; over budget throws `QuotaExceededError`. The Preview info panel can clear it. File rename / move drops the store.

## What does not work

- **IndexedDB, Cache API, cookies** — still throw in the sandbox. Do not use them.
- **Nested `<iframe>`, `<object>`, `<form>` action** — blocked by CSP.
- **Absolute workspace paths, `file://`, `http://127.0.0.1`** — they are not the workspace.
- **`new Worker("w.js")` from a relative URL** — not rewritten; inline or blob workers only.
- **Non-literal dynamic `import(variable)`** — only string-literal specifiers are rewritten.
- A backend (Express / Flask / WebSocket server). Tell the user Preview is static-only; do not bind `0.0.0.0`.

## Sharing

Link only a regular file Preview can open. Supported kinds:

- HTML / HTM — always the entry file
- Markdown, images (png/jpg/gif/webp), video (mp4/webm)
- Other valid UTF-8 text without NUL

Never link a directory. Never invent a deployment origin or `/assets/preview/...` prefix — the workbench binds the Preview URL at display time.

## If Preview looks wrong

- Blank or `SecurityError` on `localStorage` — you are on an old build, or you touched IndexedDB/cookies. Use `localStorage` only.
- Media never appears — check relative paths and that files exist beside the entry.
- Long white screen on a huge JS/CSS graph — that graph is still inlined before first paint; keep the module graph small or split so the entry HTML can show chrome first.
- Runtime errors — the Preview info / diagnostic panel lists missing assets and console events. Fix the page; do not add a Preview-only workaround.
