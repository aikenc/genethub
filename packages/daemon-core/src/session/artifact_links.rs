//! Deployment-independent product guidance for sharing workspace artifacts.
//!
//! The browser binds preview URLs at render time. The portable application
//! therefore tells every Agent to emit concrete workspace paths and never
//! forwards a client-provided deployment origin into a model prompt.

pub const fn guidance() -> &'static str {
    "When sharing workspace files with the user, link a concrete file path relative \
to the agent working directory (first workspace root), as Markdown \
`[label](relative/path.ext)` or a bare path like `demos/game/index.html`. \
Do not invent `/assets/preview/...` URLs or deployment origins — the workbench \
resolves paths at display time.\n\n\
Link only a regular file Asset Preview can open (≤ 4 MiB). Never link a \
directory alone.\n\n\
Supported kinds:\n\
- HTML (`.html` / `.htm`): for H5 games and multi-file static sites, always \
point at the entry HTML file (usually `index.html`), not the folder.\n\
- Markdown (`.md` / `.markdown` / `.mdown`)\n\
- Images: `.png`, `.jpg` / `.jpeg`, `.gif`, `.webp`\n\
- Video: `.mp4`, `.webm`\n\
- Text / source / config: any valid UTF-8 text without NUL (highlighted when \
recognized)"
}

pub fn tagged_guidance() -> String {
    format!(
        "<genehub_system_guidance>\n{}\n</genehub_system_guidance>\n\n\
The next block is the user's request.",
        guidance()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guidance_requires_an_entry_file_and_forbids_preview_url_invention() {
        let text = guidance();
        assert!(text.contains("index.html"));
        assert!(text.contains("Never link a directory"));
        assert!(text.contains("Do not invent `/assets/preview/...`"));
        assert!(text.contains(".png"));
        assert!(text.contains(".mp4"));
        assert!(text.contains(".md"));
    }

    #[test]
    fn fallback_context_is_separate_from_the_user_request() {
        let text = tagged_guidance();
        assert!(text.starts_with("<genehub_system_guidance>"));
        assert!(text.ends_with("The next block is the user's request."));
    }
}
