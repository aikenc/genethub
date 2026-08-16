import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import clojure from "highlight.js/lib/languages/clojure";
import cmake from "highlight.js/lib/languages/cmake";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import erlang from "highlight.js/lib/languages/erlang";
import go from "highlight.js/lib/languages/go";
import gradle from "highlight.js/lib/languages/gradle";
import graphql from "highlight.js/lib/languages/graphql";
import groovy from "highlight.js/lib/languages/groovy";
import haskell from "highlight.js/lib/languages/haskell";
import http from "highlight.js/lib/languages/http";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lisp from "highlight.js/lib/languages/lisp";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import matlab from "highlight.js/lib/languages/matlab";
import nginx from "highlight.js/lib/languages/nginx";
import objectivec from "highlight.js/lib/languages/objectivec";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import properties from "highlight.js/lib/languages/properties";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import wasm from "highlight.js/lib/languages/wasm";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  resolveArtifactRef,
  type ArtifactResolveContext,
} from "../preview/resolveArtifactRef";
import { useWorkbench } from "./store";

const HIGHLIGHT_BYTES = 256 * 1024;
const MERMAID_BYTES = 128 * 1024;

for (const [name, language] of [
  ["bash", bash],
  ["c", c],
  ["clojure", clojure],
  ["cmake", cmake],
  ["cpp", cpp],
  ["csharp", csharp],
  ["css", css],
  ["dart", dart],
  ["diff", diff],
  ["dockerfile", dockerfile],
  ["elixir", elixir],
  ["erlang", erlang],
  ["go", go],
  ["gradle", gradle],
  ["graphql", graphql],
  ["groovy", groovy],
  ["haskell", haskell],
  ["http", http],
  ["ini", ini],
  ["java", java],
  ["javascript", javascript],
  ["json", json],
  ["kotlin", kotlin],
  ["lisp", lisp],
  ["lua", lua],
  ["makefile", makefile],
  ["markdown", markdown],
  ["matlab", matlab],
  ["nginx", nginx],
  ["objectivec", objectivec],
  ["perl", perl],
  ["php", php],
  ["plaintext", plaintext],
  ["powershell", powershell],
  ["properties", properties],
  ["protobuf", protobuf],
  ["python", python],
  ["r", r],
  ["ruby", ruby],
  ["rust", rust],
  ["scala", scala],
  ["sql", sql],
  ["swift", swift],
  ["typescript", typescript],
  ["wasm", wasm],
  ["xml", xml],
  ["yaml", yaml],
] as const) {
  hljs.registerLanguage(name, language);
}

const LANGUAGE_ALIASES: Record<string, string> = {
  cc: "cpp",
  cjs: "javascript",
  cs: "csharp",
  ex: "elixir",
  exs: "elixir",
  h: "c",
  hpp: "cpp",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  mjs: "javascript",
  m: "objectivec",
  mm: "objectivec",
  pl: "perl",
  pm: "perl",
  proto: "protobuf",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  text: "plaintext",
  ts: "typescript",
  tsx: "typescript",
  wat: "wasm",
  yml: "yaml",
};

const FILE_LANGUAGES: Record<string, string> = {
  "cmakelists.txt": "cmake",
  "cargo.lock": "ini",
  "dockerfile": "dockerfile",
  "gemfile": "ruby",
  "makefile": "makefile",
  "nginx.conf": "nginx",
  "package-lock.json": "json",
  "pnpm-lock.yaml": "yaml",
};

/** Best-effort language hint shared by standalone text Preview and Markdown code. */
export function languageForPath(path: string): string | undefined {
  const file = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (file.endsWith(".code-workspace")) return "json";
  if (FILE_LANGUAGES[file]) return FILE_LANGUAGES[file];
  const extension = file.includes(".") ? file.split(".").at(-1) : undefined;
  if (!extension) return undefined;
  const direct: Record<string, string> = {
    bash: "bash",
    c: "c",
    cc: "cpp",
    cfg: "ini",
    clj: "clojure",
    cljs: "clojure",
    cmake: "cmake",
    conf: "ini",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    dart: "dart",
    diff: "diff",
    env: "ini",
    erl: "erlang",
    ex: "elixir",
    exs: "elixir",
    fish: "bash",
    go: "go",
    gradle: "gradle",
    gql: "graphql",
    graphql: "graphql",
    groovy: "groovy",
    h: "c",
    hpp: "cpp",
    hs: "haskell",
    htm: "xml",
    html: "xml",
    http: "http",
    ini: "ini",
    java: "java",
    js: "javascript",
    json: "json",
    json5: "json",
    jsonc: "json",
    jsonl: "json",
    jsx: "javascript",
    kt: "kotlin",
    kts: "kotlin",
    lisp: "lisp",
    lock: "ini",
    lua: "lua",
    m: "objectivec",
    markdown: "markdown",
    md: "markdown",
    mdown: "markdown",
    mjs: "javascript",
    mm: "objectivec",
    nginx: "nginx",
    php: "php",
    pl: "perl",
    pm: "perl",
    properties: "properties",
    proto: "protobuf",
    ps1: "powershell",
    py: "python",
    r: "r",
    rb: "ruby",
    rs: "rust",
    scala: "scala",
    sh: "bash",
    sql: "sql",
    swift: "swift",
    toml: "ini",
    ts: "typescript",
    tsx: "typescript",
    wasm: "wasm",
    wat: "wasm",
    workspace: "json",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
  };
  return direct[extension];
}

export type MarkdownVariant = "chat" | "document";

export type MarkdownArtifactProps = ArtifactResolveContext & {
  /** Session that owns links rendered in this Markdown. */
  sessionId?: string;
  /** Authenticated workspace read used to inline local images. */
  loadPreview?: (
    path: string,
  ) => Promise<{ bytes: Uint8Array; mediaType: string } | null>;
};

/** Safe, styled GFM used by both conversations and standalone documents. */
export const Markdown = memo(function Markdown({
  text,
  variant = "chat",
  artifact = null,
}: {
  text: string;
  variant?: MarkdownVariant;
  artifact?: MarkdownArtifactProps | null;
}) {
  const openPreviewFloat = useWorkbench((state) => state.openPreviewFloat);
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
          a: ({ href, children }) => {
            const resolved = resolveArtifactRef(href, artifact);
            if (resolved.kind === "blocked") {
              return (
                <span className="gh-blocked-link" title="此链接不在当前工作区内">
                  {children}
                </span>
              );
            }
            if (
              resolved.kind === "preview" &&
              artifact?.deviceHandle &&
              artifact.workspaceHandle
            ) {
              return (
                <a
                  href={resolved.href}
                  onClick={(event) => {
                    event.preventDefault();
                    openPreviewFloat({
                      deviceHandle: artifact.deviceHandle,
                      workspaceHandle: artifact.workspaceHandle,
                      path: resolved.path,
                      sessionId: artifact.sessionId ?? null,
                    });
                  }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a href={resolved.href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          code: ({ className, children }) => {
            const text = String(children).replace(/\n$/, "");
            const language = className?.replace(/^language-/, "");
            if (!className?.startsWith("language-") && !text.includes("\n")) {
              return <code className="gh-inline-code">{text}</code>;
            }
            if (language?.toLowerCase() === "mermaid") {
              return <MermaidDiagram source={text} />;
            }
            return <HighlightedCode text={text} language={language} />;
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="gh-table-wrap">
              <table>{children}</table>
            </div>
          ),
          th: ({ children }) => <th>{children}</th>,
          td: ({ children }) => <td>{children}</td>,
          input: ({ type, checked, disabled }) => (
            <input type={type} checked={checked} disabled={disabled} readOnly />
          ),
          // Bare http(s) images stay blocked. Workspace-relative / absolute
          // paths and Preview locators load through the authenticated reader.
          img: ({ src, alt }) => (
            <MarkdownImage src={src} alt={alt} artifact={artifact} />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function MarkdownImage({
  src,
  alt,
  artifact,
}: {
  src?: string;
  alt?: string;
  artifact?: MarkdownArtifactProps | null;
}) {
  const resolved = resolveArtifactRef(src, artifact);
  const previewPath = resolved.kind === "preview" ? resolved.path : null;
  const loadPreview = artifact?.loadPreview;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    if (!previewPath || !loadPreview) {
      if (previewPath) setFailed(true);
      return () => {};
    }
    void (async () => {
      try {
        const loaded = await loadPreview(previewPath);
        if (cancelled) return;
        if (!loaded || !loaded.mediaType.startsWith("image/")) {
          setFailed(true);
          return;
        }
        const objectUrl = URL.createObjectURL(
          new Blob([loaded.bytes.slice().buffer as ArrayBuffer], {
            type: loaded.mediaType,
          }),
        );
        revoke = objectUrl;
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [loadPreview, previewPath]);

  if (resolved.kind === "external" || resolved.kind === "blocked" || failed) {
    return (
      <span className="gh-blocked-image">
        图片已阻止{alt ? `：${alt}` : ""}
      </span>
    );
  }
  if (!url) {
    return (
      <span className="gh-blocked-image" role="status">
        图片加载中{alt ? `：${alt}` : ""}
      </span>
    );
  }
  return <img src={url} alt={alt ?? ""} className="gh-markdown-image" />;
}

export function HighlightedCode({
  text,
  language,
  document = false,
}: {
  text: string;
  language?: string;
  document?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const highlighted = highlight(text, language);
  return (
    <div className={"gh-code-block" + (document ? " gh-code-document" : "")}>
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
      /*
       * Top level, not only under `flowchart`: Mermaid 11 reads the per-diagram
       * flag for sizing but keeps putting node labels in `<foreignObject>`
       * unless this one is off. Those labels are HTML, and an SVG loaded as an
       * image never renders HTML — the diagram arrived as a set of empty boxes
       * with only the edge labels, which are plain `<text>`, still in it.
       */
      htmlLabels: false,
      /*
       * `useMaxWidth` writes `width="100%"`, which leaves an SVG-as-image with
       * no intrinsic width at all: the browser falls back to its 300px default
       * and every diagram, wide or narrow, was resampled to that. Off, the SVG
       * carries its real pixel size and the stylesheet decides how it fits.
       */
      flowchart: { htmlLabels: false, useMaxWidth: false },
      sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
      journey: { useMaxWidth: false },
      pie: { useMaxWidth: false },
      er: { useMaxWidth: false },
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
  /*
   * A diagram that reaches us with HTML labels cannot be shown: dropping the
   * `foreignObject` leaves empty shapes, and keeping it renders nothing either
   * once the SVG is an image. Say so and fall back to the source, rather than
   * putting a silently blank picture on screen.
   */
  if (document_.querySelector("foreignObject")) {
    throw new Error("流程图输出使用了无法安全渲染的 HTML 标签");
  }
  document_.querySelectorAll("script, image").forEach((node) => node.remove());
  // Unwrap rather than remove: the link is what we refuse, not its label.
  document_.querySelectorAll("a").forEach((node) => {
    node.replaceWith(...Array.from(node.childNodes));
  });
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
