import DOMPurify from "dompurify";
import { useMemo } from "react";

/**
 * A single HTML file, rendered without an iframe.
 *
 * `artifact-skill.md` scopes this to documents with no JavaScript, and this
 * is what makes that safe to render straight into the page rather than
 * behind a sandboxed frame: DOMPurify strips `<script>`, every event-handler
 * attribute and `javascript:` URIs by default. Two further restrictions are
 * ours on purpose, past what DOMPurify does by default:
 *
 * - No `<style>` and no `style=`. Nothing scopes CSS from an unsandboxed
 *   fragment to itself — a rule as ordinary as `body { display: none }`
 *   would take out the whole workbench, not just this preview.
 * - No `src`/`srcset` on `<img>`/`<video>`/`<audio>`/`<source>` unless it is
 *   a `data:` URI. Same reasoning as `Markdown.tsx`'s blocked images: an
 *   element that fetches a remote URL can carry a tracking pixel or probe a
 *   loopback/private address, and this file is still text an agent wrote —
 *   trusted to display, not to make requests on the reader's behalf. A chart
 *   embedded as base64 still renders; one pointed at a URL does not.
 */
export function SanitizedHtml({ html }: { html: string }) {
  const clean = useMemo(() => sanitize(html), [html]);
  return (
    <div
      className="max-w-none overflow-auto rounded border border-line bg-white p-3 text-sm text-black [&_a]:text-blue-600 [&_a]:underline"
      // eslint-disable-next-line react/no-danger -- sanitized by `sanitize()` above; see this file's doc comment for exactly what is stripped.
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

const RESOURCE_ATTRS = ["src", "srcset"];
const RESOURCE_TAGS = new Set(["IMG", "VIDEO", "AUDIO", "SOURCE"]);

function sanitize(html: string): string {
  // Hooks are global to the DOMPurify module, not scoped to one call — added
  // and removed around a single synchronous `sanitize()` so two previews
  // rendering back to back never see one another's hooks.
  DOMPurify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style") node.parentNode?.removeChild(node);
  });
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    node.removeAttribute("style");
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    if (RESOURCE_TAGS.has(node.tagName)) {
      for (const attr of RESOURCE_ATTRS) {
        const value = node.getAttribute(attr);
        if (value && !value.trim().toLowerCase().startsWith("data:")) {
          node.removeAttribute(attr);
        }
      }
    }
  });
  try {
    return DOMPurify.sanitize(html, {
      FORBID_TAGS: [
        "script",
        "style",
        "iframe",
        "frame",
        "frameset",
        "object",
        "embed",
        "link",
        "meta",
        "base",
        "form",
      ],
      FORBID_ATTR: ["style"],
    });
  } finally {
    DOMPurify.removeAllHooks();
  }
}
