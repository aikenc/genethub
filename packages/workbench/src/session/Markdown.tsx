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
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  resolveArtifactRef,
  type ArtifactResolveContext,
} from "../preview/resolveArtifactRef";
import {
  isSafeInlineImageDataUrl,
  thumbDataUrl,
  thumbForPath,
  type InlineImage,
} from "./roundGallery";
import { useWorkbench, type PreviewFloatRequest } from "./store";

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

/** Allow forwarded/copied image thumbs; keep the default protocol denylist. */
function markdownUrlTransform(value: string): string {
  return isSafeInlineImageDataUrl(value) ? value.trim() : defaultUrlTransform(value);
}

export type MarkdownArtifactProps = ArtifactResolveContext & {
  /** Session that owns links rendered in this Markdown. */
  sessionId?: string;
  /** Session-inlined thumbs; tiles use these instead of fetching the original. */
  inlineImages?: readonly InlineImage[];
  /** Authenticated workspace read used to inline local images. */
  loadPreview?: (
    path: string,
  ) => Promise<{ bytes: Uint8Array; mediaType: string } | null>;
};

type MarkdownRender = {
  artifact: MarkdownArtifactProps | null;
  openPreviewFloat: (target: PreviewFloatRequest) => void;
};

const MarkdownRenderContext = createContext<MarkdownRender>({
  artifact: null,
  openPreviewFloat: () => {},
});

type MarkdownChildren = { children?: ReactNode; className?: string };

function MarkdownParagraph({ children }: MarkdownChildren) {
  return <p>{children}</p>;
}
function MarkdownH1({ children }: MarkdownChildren) {
  return <h1>{children}</h1>;
}
function MarkdownH2({ children }: MarkdownChildren) {
  return <h2>{children}</h2>;
}
function MarkdownH3({ children }: MarkdownChildren) {
  return <h3>{children}</h3>;
}
function MarkdownH4({ children }: MarkdownChildren) {
  return <h4>{children}</h4>;
}
function MarkdownH5({ children }: MarkdownChildren) {
  return <h5>{children}</h5>;
}
function MarkdownH6({ children }: MarkdownChildren) {
  return <h6>{children}</h6>;
}
function MarkdownUl({ children, className }: MarkdownChildren) {
  return <ul className={className}>{children}</ul>;
}
function MarkdownOl({ children, className }: MarkdownChildren) {
  return <ol className={className}>{children}</ol>;
}
function MarkdownLi({ children, className }: MarkdownChildren) {
  return <li className={className}>{children}</li>;
}
function MarkdownBlockquote({ children }: MarkdownChildren) {
  return <blockquote>{children}</blockquote>;
}
function MarkdownHr() {
  return <hr />;
}
function MarkdownStrong({ children }: MarkdownChildren) {
  return <strong>{children}</strong>;
}
function MarkdownEm({ children }: MarkdownChildren) {
  return <em>{children}</em>;
}
function MarkdownDel({ children }: MarkdownChildren) {
  return <del>{children}</del>;
}
function MarkdownPre({ children }: MarkdownChildren) {
  return <>{children}</>;
}
function MarkdownTable({ children }: MarkdownChildren) {
  return (
    <div className="gh-table-wrap">
      <table>{children}</table>
    </div>
  );
}
function MarkdownTh({ children }: MarkdownChildren) {
  return <th>{children}</th>;
}
function MarkdownTd({ children }: MarkdownChildren) {
  return <td>{children}</td>;
}
function MarkdownInput({
  type,
  checked,
  disabled,
}: {
  type?: string;
  checked?: boolean;
  disabled?: boolean;
}) {
  return <input type={type} checked={checked} disabled={disabled} readOnly />;
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { artifact, openPreviewFloat } = useContext(MarkdownRenderContext);
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
    const open = (event: { preventDefault: () => void }) => {
      event.preventDefault();
      openPreviewFloat({
        deviceHandle: artifact.deviceHandle,
        workspaceHandle: artifact.workspaceHandle,
        path: resolved.path,
        sessionId: artifact.sessionId ?? null,
      });
    };
    // Agents share workspace pictures as ordinary file links; a
    // link that points at an image renders the picture inline and
    // keeps the caption as the preview opener.
    if (isImageLinkPath(resolved.path)) {
      return (
        <MarkdownImageRef
          path={resolved.path}
          href={resolved.href}
          artifact={artifact}
          onOpen={open}
        >
          {children}
        </MarkdownImageRef>
      );
    }
    return (
      <a href={resolved.href} onClick={open}>
        {children}
      </a>
    );
  }
  return (
    <a href={resolved.href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function MarkdownCode({ className, children }: MarkdownChildren) {
  const text = String(children).replace(/\n$/, "");
  const language = className?.replace(/^language-/, "");
  if (!className?.startsWith("language-") && !text.includes("\n")) {
    return <code className="gh-inline-code">{text}</code>;
  }
  if (language?.toLowerCase() === "mermaid") {
    return <MermaidDiagram source={text} />;
  }
  return <HighlightedCode text={text} language={language} />;
}

function MarkdownImg({ src, alt }: { src?: string; alt?: string }) {
  const { artifact } = useContext(MarkdownRenderContext);
  return <MarkdownImage src={src} alt={alt} artifact={artifact} />;
}

/**
 * Stable element constructors. Inline `components={{ p: () => <p/> }}` creates a
 * new component type on every render, so React remounts the document and the
 * native selection disappears (workbench store ticks about every 2s).
 */
const MARKDOWN_COMPONENTS: Components = {
  p: MarkdownParagraph,
  h1: MarkdownH1,
  h2: MarkdownH2,
  h3: MarkdownH3,
  h4: MarkdownH4,
  h5: MarkdownH5,
  h6: MarkdownH6,
  ul: MarkdownUl,
  ol: MarkdownOl,
  li: MarkdownLi,
  blockquote: MarkdownBlockquote,
  hr: MarkdownHr,
  strong: MarkdownStrong,
  em: MarkdownEm,
  del: MarkdownDel,
  a: MarkdownLink,
  code: MarkdownCode,
  pre: MarkdownPre,
  table: MarkdownTable,
  th: MarkdownTh,
  td: MarkdownTd,
  input: MarkdownInput,
  img: MarkdownImg,
};

/**
 * An unclosed fence at the end of a streaming reply would otherwise swallow
 * every later line as one code block, then collapse when the closer arrives.
 * Freeze the closed prefix; keep the open fence as plain text until it closes.
 */
export function splitStreamingMarkdown(text: string): { stable: string; tail: string } {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  let fence: { marker: string; length: number; start: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(lines[index] ?? "");
    if (!match) continue;
    const marker = match[2]![0]!;
    const length = match[2]!.length;
    const info = match[3] ?? "";
    if (!fence) {
      if (marker === "`" && info.includes("`")) continue;
      fence = { marker, length, start: index };
      continue;
    }
    if (marker !== fence.marker || length < fence.length || info.trim() !== "") continue;
    fence = null;
  }
  if (!fence) return { stable: text, tail: "" };
  return {
    stable: lines.slice(0, fence.start).join("\n"),
    tail: lines.slice(fence.start).join("\n"),
  };
}

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
  const render = useMemo(
    () => ({ artifact, openPreviewFloat }),
    [artifact, openPreviewFloat],
  );
  const { stable, tail } =
    variant === "chat" ? splitStreamingMarkdown(text) : { stable: text, tail: "" };
  return (
    <MarkdownRenderContext.Provider value={render}>
      <div
        className={`gh-markdown gh-markdown-${variant} break-words text-fg`}
        data-testid="markdown"
      >
        {stable ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={MARKDOWN_COMPONENTS}
            urlTransform={markdownUrlTransform}
          >
            {stable}
          </ReactMarkdown>
        ) : null}
        {tail ? (
          <pre className="gh-markdown-stream-tail" data-testid="markdown-stream-tail">
            {tail}
          </pre>
        ) : null}
      </div>
    </MarkdownRenderContext.Provider>
  );
});

const IMAGE_LINK_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

function isImageLinkPath(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_LINK_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Authenticated inline load of a workspace image, shared by `![](…)` embeds
 * and image file links. Prefers a session-inlined thumb so tiles do not
 * fetch the original. */
function usePreviewImageUrl(
  previewPath: string | null,
  loadPreview: MarkdownArtifactProps["loadPreview"],
  inlineImages?: readonly InlineImage[],
): { url: string | null; failed: boolean } {
  const thumb = thumbForPath(inlineImages ?? [], previewPath);
  const thumbUrl = thumb ? thumbDataUrl(thumb) : null;
  const [url, setUrl] = useState<string | null>(thumbUrl);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    if (thumbUrl) {
      setUrl(thumbUrl);
      setFailed(false);
      return () => {};
    }
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
  }, [loadPreview, previewPath, thumbUrl]);

  return { url: thumbUrl ?? url, failed: thumbUrl ? false : failed };
}

function MarkdownImage({
  src,
  alt,
  artifact,
}: {
  src?: string;
  alt?: string;
  artifact?: MarkdownArtifactProps | null;
}) {
  const openPreviewFloat = useWorkbench((state) => state.openPreviewFloat);
  const inlineData = src && isSafeInlineImageDataUrl(src) ? src.trim() : null;
  const resolved = resolveArtifactRef(inlineData ? null : src, artifact);
  const previewPath = resolved.kind === "preview" ? resolved.path : null;
  const { url, failed } = usePreviewImageUrl(
    previewPath,
    artifact?.loadPreview,
    artifact?.inlineImages,
  );

  if (inlineData) {
    return <img src={inlineData} alt={alt ?? ""} className="gh-markdown-image" />;
  }

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
  const image = <img src={url} alt={alt ?? ""} className="gh-markdown-image" />;
  // An inline embed is still a workspace file: click it the same way a
  // picture link does, so the float preview can open the original.
  if (
    resolved.kind === "preview" &&
    previewPath &&
    artifact?.deviceHandle &&
    artifact.workspaceHandle
  ) {
    return (
      <button
        type="button"
        className="gh-markdown-image-ref"
        data-testid="markdown-image-embed"
        onClick={() =>
          openPreviewFloat({
            deviceHandle: artifact.deviceHandle,
            workspaceHandle: artifact.workspaceHandle,
            path: previewPath,
            sessionId: artifact.sessionId ?? null,
          })
        }
      >
        {image}
      </button>
    );
  }
  return image;
}

/** A file link that points at a workspace image: shows the picture inline
 * once loaded, opens the float preview on click, and degrades to the plain
 * link while loading or when the read fails. */
function MarkdownImageRef({
  path,
  href,
  artifact,
  onOpen,
  children,
}: {
  path: string;
  href: string;
  artifact?: MarkdownArtifactProps | null;
  onOpen: (event: { preventDefault: () => void }) => void;
  children?: ReactNode;
}) {
  const { url } = usePreviewImageUrl(path, artifact?.loadPreview, artifact?.inlineImages);

  if (!url) {
    return (
      <a href={href} onClick={onOpen}>
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      className="gh-markdown-image-ref"
      data-testid="markdown-image-ref"
      onClick={onOpen}
    >
      <img src={url} alt="" className="gh-markdown-image" />
      <span className="gh-markdown-image-ref-label">{children}</span>
    </button>
  );
}

export const HighlightedCode = memo(function HighlightedCode({
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
});

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
