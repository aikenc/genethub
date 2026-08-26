//! Deployment-agnostic guidance for how Agents share workspace files.
//!
//! The workbench binds Preview URLs at Markdown render time, so Agents must
//! not invent `/assets/preview/...` prefixes. They should emit concrete file
//! paths (especially an entry `.html` for H5 / static sites).

/// Fixed system context appended on the first turn of a session.
pub fn guidance() -> &'static str {
    "\
When sharing workspace files with the user, link a concrete file path relative \
to the agent working directory (first workspace root), as Markdown \
`[label](relative/path.ext)` or a bare path like `demos/game/index.html`. \
Do not invent `/assets/preview/...` URLs or deployment origins — the workbench \
resolves paths at display time.

Link only a regular file Asset Preview can open (≤ 64 MiB). Never link a \
directory alone.

Supported kinds:
- HTML (`.html` / `.htm`): for H5 games, WASM games, and multi-file static \
sites, always point at the entry HTML file (usually `index.html`), not the \
folder. Preview remaps modules and relative/site-root assets and forwards \
runtime fetch/import into the workspace.
- Markdown (`.md` / `.markdown` / `.mdown`)
- Images: `.png`, `.jpg` / `.jpeg`, `.gif`, `.webp`
- Video: `.mp4`, `.webm`
- WASM (`.wasm`) and other binary assets, loaded by the entry HTML
- Text / source / config: any valid UTF-8 text without NUL (highlighted when \
recognized)

When authoring HTML, H5 games, or static sites for Preview, read the \
`genehub-html-preview` skill. Write a regular static site (entry HTML + \
relative paths) that also opens as a local file. Do not start an HTTP server \
for static assets, and do not embed Preview-specific scripts — GeneHub \
injects its own loader. `localStorage` works via a persistent sandbox shim; \
IndexedDB, cookies, nested iframes, and forms do not."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guidance_requires_html_entry_and_forbids_preview_url_invention() {
        let text = guidance();
        assert!(text.contains("index.html"));
        assert!(text.contains("Never link a directory"));
        assert!(text.contains("Do not invent `/assets/preview/...`"));
        assert!(text.contains(".png"));
        assert!(text.contains(".mp4"));
        assert!(text.contains(".md"));
        assert!(text.contains(".wasm"));
        assert!(text.contains("64 MiB"));
        assert!(text.contains("genehub-html-preview"));
        assert!(text.contains("relative paths"));
        assert!(text.contains("localStorage"));
    }
}
