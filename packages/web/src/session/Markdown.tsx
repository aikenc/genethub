import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import http from "highlight.js/lib/languages/http";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const HIGHLIGHT_BYTES = 256 * 1024;
const MERMAID_BYTES = 128 * 1024;

for (const [name, language] of [
  ["bash", bash],
  ["css", css],
  ["diff", diff],
  ["go", go],
  ["http", http],
  ["ini", ini],
  ["java", java],
  ["javascript", javascript],
  ["json", json],
  ["markdown", markdown],
  ["plaintext", plaintext],
  ["python", python],
  ["rust", rust],
  ["sql", sql],
  ["typescript", typescript],
  ["xml", xml],
  ["yaml", yaml],
] as const) {
  hljs.registerLanguage(name, language);
}

const LANGUAGE_ALIASES: Record<string, string> = {
  cjs: "javascript",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  text: "plaintext",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
};

export type MarkdownVariant = "chat" | "document";

/** Safe, styled GFM used by both conversations and standalone documents. */
export const Markdown = memo(function Markdown({
  text,
  variant = "chat",
}: {
  text: string;
  variant?: MarkdownVariant;
}) {
  return (
    <div
      className={`gh-markdown gh-markdown-${variant} break-words text-fg`}
      data-testid="markdown"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{children}</p>,
          h1: ({ children }) => <h1>{children}</h1>,
          h2: ({ children }) => <h2>{children}</h2>,
          h3: ({ children }) => <h3>{children}</h3>,
          h4: ({ children }) => <h4>{children}</h4>,
          h5: ({ children }) => <h5>{children}</h5>,
          h6: ({ children }) => <h6>{children}</h6>,
          ul: ({ children, className }) => <ul className={className}>{children}</ul>,
          ol: ({ children, className }) => <ol className={className}>{children}</ol>,
          li: ({ children, className }) => <li className={className}>{children}</li>,
          blockquote: ({ children }) => <blockquote>{children}</blockquote>,
          hr: () => <hr />,
          strong: ({ children }) => <strong>{children}</strong>,
          em: ({ children }) => <em>{children}</em>,
          del: ({ children }) => <del>{children}</del>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          code: ({ className, children }) => {
            const text = String(children).replace(/\n$/, "");
            const language = className?.replace(/^language-/, "");
            if (!className?.startsWith("language-") && !text.includes("\n")) {
              return <code className="gh-inline-code">{text}</code>;
            }
            if (language?.toLowerCase() === "mermaid") {
              return <MermaidDiagram source={text} />;
            }
            return <Code text={text} language={language} />;
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="gh-table-wrap touch-pan-x">
              <table>{children}</table>
            </div>
          ),
          th: ({ children }) => <th>{children}</th>,
          td: ({ children }) => <td>{children}</td>,
          input: ({ type, checked, disabled }) => (
            <input type={type} checked={checked} disabled={disabled} readOnly />
          ),
          // Model/document-authored images never trigger a request. An image
          // can still be previewed explicitly through its authenticated Asset
          // Preview URL; merely rendering Markdown is not authorization to load.
          img: ({ alt }) => (
            <span className="gh-blocked-image">
              图片已阻止{alt ? `：${alt}` : ""}
            </span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function Code({ text, language }: { text: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const highlighted = highlight(text, language);
  return (
    <div className="gh-code-block">
      <div className="gh-code-header">
        <span>{language || highlighted.language || "code"}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>
        <code
          className="hljs"
          // highlight.js escapes source text before adding its own spans.
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      </pre>
    </div>
  );
}

function highlight(text: string, requested?: string): { html: string; language?: string } {
  if (new TextEncoder().encode(text).byteLength > HIGHLIGHT_BYTES) {
    return { html: escapeHtml(text), language: requested };
  }
  const normalized = requested?.toLowerCase();
  const language = normalized ? (LANGUAGE_ALIASES[normalized] ?? normalized) : undefined;
  try {
    if (language && hljs.getLanguage(language)) {
      return { html: hljs.highlight(text, { language }).value, language };
    }
    const detected = hljs.highlightAuto(text);
    return { html: detected.value, language: detected.language };
  } catch {
    return { html: escapeHtml(text), language: requested };
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

let diagramSequence = 0;
let mermaidReady: Promise<(typeof import("mermaid"))["default"]> | null = null;

function MermaidDiagram({ source }: { source: string }) {
  const id = useRef(`gh-mermaid-${++diagramSequence}`);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; url: string }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ kind: "loading" });

    if (new TextEncoder().encode(source).byteLength > MERMAID_BYTES) {
      setState({ kind: "error", message: "流程图源码过大，无法安全渲染" });
      return () => {};
    }

    void loadMermaid()
      .then((mermaid) => mermaid.render(id.current, source))
      .then(({ svg }) => {
        const safe = safeMermaidSvg(svg);
        objectUrl = URL.createObjectURL(new Blob([safe], { type: "image/svg+xml" }));
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
          return;
        }
        setState({ kind: "ready", url: objectUrl });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : "流程图语法无效",
          });
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source]);

  return (
    <figure className="gh-mermaid" data-testid="mermaid-diagram">
      {state.kind === "loading" ? (
        <p role="status">正在绘制流程图…</p>
      ) : state.kind === "error" ? (
        <div role="alert">
          <p>流程图无法渲染：{state.message}</p>
          <pre>{source}</pre>
        </div>
      ) : (
        <img src={state.url} alt="Markdown 流程图" />
      )}
    </figure>
  );
}

function loadMermaid(): Promise<(typeof import("mermaid"))["default"]> {
  mermaidReady ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      flowchart: { htmlLabels: false, useMaxWidth: true },
    });
    return mermaid;
  });
  return mermaidReady;
}

/**
 * Mermaid already runs in strict mode. This second, small boundary is what lets
 * us expose the result as an SVG image without retaining active/linkable SVG
 * nodes should a future Mermaid release broaden its output.
 */
function safeMermaidSvg(svg: string): string {
  const document_ = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (document_.querySelector("parsererror")) throw new Error("流程图输出无效");
  document_.querySelectorAll("script, foreignObject, image, a").forEach((node) => node.remove());
  document_.querySelectorAll("*").forEach((node) => {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (
        name.startsWith("on") ||
        ((name === "href" || name === "xlink:href") && !value.startsWith("#")) ||
        (name === "style" && /url\s*\(\s*['\"]?(?!#)/i.test(attribute.value))
      ) {
        node.removeAttribute(attribute.name);
      }
    }
  });
  return new XMLSerializer().serializeToString(document_.documentElement);
}
