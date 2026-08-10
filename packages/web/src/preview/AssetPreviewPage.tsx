import { useCallback, useEffect, useMemo, useState } from "react";

import type { AssetPreviewMetadata } from "@genehub/proto";

import { detectHost, type Endpoint, type Host } from "../host";
import { Client, type AssetPreviewResult, type ProtocolDial } from "../protocol/client";
import { HighlightedCode, languageForPath, Markdown } from "../session/Markdown";
import { readRtcEnabled } from "../settings/rtc";
import { remapHtmlSite } from "./htmlSite";
import type { AssetPreviewLocation } from "./url";

type ViewState =
  | { kind: "loading" }
  | { kind: "ready"; result: AssetPreviewResult; client: Client }
  | { kind: "error"; message: string };

export function AssetPreviewPage({
  source,
  host = detectHost(),
  chrome = "page",
  client: sharedClient = null,
}: {
  source: AssetPreviewLocation;
  host?: Host;
  /** `embedded` omits page chrome when hosted inside the workbench float. */
  chrome?: "page" | "embedded";
  /**
   * Workbench float must reuse the live Client. Opening a second Fabric
   * session here closes the workbench socket and, under reconnect, storms the
   * control plane ("too many connection attempts").
   */
  client?: Client | null;
}) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    let owned: Client | null = null;
    setState({ kind: "loading" });
    emitPreviewDiagnostic("log", {
      topic: "preview-load",
      path: source.path,
      workspaceHandle: source.workspaceHandle,
      deviceHandle: source.deviceHandle,
      phase: "start",
      shared: Boolean(sharedClient),
    });
    void (async () => {
      try {
        let active: Client;
        if (sharedClient) {
          if (sharedClient.identity?.machineId !== source.deviceHandle) {
            throw new Error("当前连接的设备与预览目标不一致");
          }
          active = sharedClient;
        } else {
          const endpoint =
            (await endpointForDevice(host, source.deviceHandle)) ??
            (await host.endpoint());
          if (!endpoint) throw new Error("这台浏览器尚未获准连接资源所在的设备");
          owned = connect(endpoint, host, source.deviceHandle);
          await ready(owned);
          if (owned.identity?.machineId !== source.deviceHandle) {
            throw new Error("链接指向的设备与当前连接不一致");
          }
          active = owned;
        }
        const result = await active.preview(source.workspaceHandle, source.path);
        if (cancelled) {
          owned?.close();
          return;
        }
        emitPreviewDiagnostic("log", {
          topic: "preview-load",
          path: source.path,
          kind: result.metadata.kind,
          sourceBytes: result.metadata.sourceBytes,
          phase: "ready",
          shared: Boolean(sharedClient),
        });
        setState({ kind: "ready", result, client: active });
        // Dialed clients stay in `owned` so effect cleanup closes them. Shared
        // workbench clients must never be closed from Preview.
      } catch (error) {
        owned?.close();
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "无法预览这个文件";
          emitPreviewDiagnostic("error", {
            message,
            path: source.path,
            phase: "load-failed",
          });
          setState({
            kind: "error",
            message,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      owned?.close();
    };
  }, [host, sharedClient, source.deviceHandle, source.path, source.workspaceHandle]);

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-bg text-fg">
      {chrome === "page" ? (
        <header className="flex min-h-11 shrink-0 items-center gap-3 border-b border-line px-4 py-2">
          <span className="min-w-0 truncate font-mono text-xs">{source.path}</span>
          <span className="ml-auto shrink-0 text-[11px] text-faint">
            {source.workspaceHandle}
          </span>
        </header>
      ) : null}
      {state.kind === "loading" ? (
        <p role="status" className="m-auto text-sm text-muted">正在安全读取文件…</p>
      ) : state.kind === "error" ? (
        <section role="alert" className="m-auto max-w-lg px-6 text-center">
          <p className="text-sm">无法预览</p>
          <p className="mt-2 text-xs text-muted">{state.message}</p>
        </section>
      ) : (
        <PreviewDocument
          result={state.result}
          path={source.path}
          deviceHandle={source.deviceHandle}
          workspaceHandle={source.workspaceHandle}
          client={state.client}
        />
      )}
    </main>
  );
}

function PreviewDocument({
  result,
  path,
  deviceHandle,
  workspaceHandle,
  client,
}: {
  result: AssetPreviewResult;
  path: string;
  deviceHandle: string;
  workspaceHandle: string;
  client: Client;
}) {
  const { metadata, bytes } = result;
  const rootHandle = path.split("/")[0] ?? "";
  const loadPreview = useCallback(
    async (assetPath: string) => {
      try {
        const loaded = await client.preview(workspaceHandle, assetPath);
        return { bytes: loaded.bytes, mediaType: loaded.metadata.mediaType };
      } catch {
        return null;
      }
    },
    [client, workspaceHandle],
  );

  if (metadata.kind === "markdown") {
    return (
      <article className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain touch-pan-y">
        <div className="mx-auto max-w-4xl px-5 py-6 sm:px-8 sm:py-10">
          <Markdown
            text={decodeText(bytes)}
            variant="document"
            artifact={{
              deviceHandle,
              workspaceHandle,
              folders: [{ root: "", rootHandle }],
              documentPath: path,
              loadPreview,
            }}
          />
        </div>
      </article>
    );
  }
  if (metadata.kind === "text") {
    return (
      <HighlightedCode
        text={decodeText(bytes)}
        language={languageForPath(path)}
        document
      />
    );
  }
  if (metadata.kind === "html") {
    return (
      <HtmlDocument
        bytes={bytes}
        metadata={metadata}
        entryPath={path}
        fetchAsset={loadPreview}
      />
    );
  }
  return <BlobDocument bytes={bytes} metadata={metadata} />;
}

function BlobDocument({
  bytes,
  metadata,
}: {
  bytes: Uint8Array;
  metadata: AssetPreviewMetadata;
}) {
  const url = useMemo(
    () =>
      URL.createObjectURL(
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: metadata.mediaType }),
      ),
    [bytes, metadata.mediaType],
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return metadata.kind === "image" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/5 p-4">
      <img src={url} alt="预览" className="max-h-full max-w-full object-contain" />
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-4">
      <video src={url} controls className="max-h-full max-w-full" />
    </div>
  );
}

function HtmlDocument({
  bytes,
  metadata,
  entryPath,
  fetchAsset,
}: {
  bytes: Uint8Array;
  metadata: AssetPreviewMetadata;
  entryPath: string;
  fetchAsset: (path: string) => Promise<{ bytes: Uint8Array; mediaType: string } | null>;
}) {
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [status, setStatus] = useState("正在解析静态资源…");

  useEffect(() => {
    let cancelled = false;
    const blobUrls: string[] = [];
    setSrcDoc(null);
    setStatus("正在解析静态资源…");
    void (async () => {
      try {
        const remapped = await remapHtmlSite({
          entryPath,
          html: decodeText(bytes),
          fetchAsset,
        });
        blobUrls.push(...remapped.blobUrls);
        if (cancelled) {
          for (const url of blobUrls) URL.revokeObjectURL(url);
          return;
        }
        const statusText =
          remapped.warnings.length > 0
            ? `静态多文件 · 动态加载不可用 · 网络已开启 · ${metadata.sourceBytes} bytes · ${remapped.warnings.length} 个资源未加载`
            : `静态多文件 · 动态加载不可用 · 网络已开启 · ${metadata.sourceBytes} bytes`;
        setSrcDoc(isolatedHtml(remapped.html));
        setStatus(statusText);
        emitPreviewDiagnostic("log", {
          topic: "html-site",
          path: entryPath,
          warnings: remapped.warnings.length,
          blobUrls: remapped.blobUrls.length,
          status: statusText.slice(0, 500),
          phase: "remapped",
        });
        for (const warning of remapped.warnings.slice(0, 20)) {
          emitPreviewDiagnostic("resource", {
            path: entryPath,
            message: warning.slice(0, 500),
            phase: "remap-warning",
          });
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "资源解析失败";
          setSrcDoc(isolatedHtml(decodeText(bytes)));
          setStatus(
            `单文件回退 · 网络已开启 · ${metadata.sourceBytes} bytes · ${message}`,
          );
          emitPreviewDiagnostic("error", {
            path: entryPath,
            message,
            phase: "remap-fallback",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const url of blobUrls) URL.revokeObjectURL(url);
    };
  }, [bytes, entryPath, fetchAsset, metadata.sourceBytes]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-center text-[11px] text-amber-700 dark:text-amber-300">
        {status}
      </p>
      {srcDoc ? (
        <iframe
          title="HTML 文件预览"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; usb 'none'; serial 'none'; display-capture 'none'; fullscreen 'none'; presentation 'none'"
          srcDoc={srcDoc}
          className="min-h-0 flex-1 border-0 bg-white"
        />
      ) : (
        <p role="status" className="m-auto text-sm text-muted">
          正在准备 HTML 预览…
        </p>
      )}
    </div>
  );
}

export function isolatedHtml(source: string): string {
  const document_ = new DOMParser().parseFromString(source, "text/html");
  document_.querySelectorAll("base, meta[http-equiv]").forEach((node) => {
    if (
      node.tagName.toLowerCase() === "base" ||
      node.getAttribute("http-equiv")?.toLowerCase() === "content-security-policy"
    ) {
      node.remove();
    }
  });
  const policy = document_.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = [
    "default-src 'none'",
    "script-src 'unsafe-inline' https: blob:",
    "style-src 'unsafe-inline' https: blob:",
    "img-src data: blob: https:",
    "media-src data: blob: https:",
    "font-src data: blob: https:",
    "connect-src https: wss:",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri https://preview.invalid",
    "navigate-to 'none'",
  ].join("; ");
  const base = document_.createElement("base");
  base.href = "https://preview.invalid/";
  document_.head.prepend(base);
  document_.head.prepend(policy);
  // Opaque sandboxed iframe consoles never reach the parent recorder. Bridge
  // load/CSP/script failures out via postMessage so feedback can see them.
  const bridge = document_.createElement("script");
  bridge.textContent = PREVIEW_DIAG_BRIDGE;
  document_.documentElement.appendChild(bridge);
  return `<!doctype html>\n${document_.documentElement.outerHTML}`;
}

/** Keep in sync with console/src/diagnostics.ts PREVIEW_MESSAGE_SOURCE. */
const PREVIEW_DIAG_SOURCE = "genehub-preview-diag";

const PREVIEW_DIAG_BRIDGE = `(function(){
  function send(kind, detail){
    try {
      parent.postMessage({ source: ${JSON.stringify(PREVIEW_DIAG_SOURCE)}, kind: kind, detail: detail || {} }, "*");
    } catch (e) {}
  }
  window.addEventListener("error", function(e){
    var t = e.target;
    if (t && t !== window && t.tagName) {
      send("resource", {
        tag: String(t.tagName).toLowerCase(),
        src: String(t.currentSrc || t.src || t.href || "").slice(0, 500),
        message: "resource load failed"
      });
      return;
    }
    send("error", {
      message: String(e.message || "error").slice(0, 500),
      source: String(e.filename || "").slice(0, 500),
      line: e.lineno || 0,
      column: e.colno || 0
    });
  }, true);
  window.addEventListener("unhandledrejection", function(e){
    var reason = e.reason;
    send("error", {
      message: String(reason && reason.message ? reason.message : reason).slice(0, 500)
    });
  });
  window.addEventListener("securitypolicyviolation", function(e){
    send("csp", {
      violatedDirective: String(e.violatedDirective || "").slice(0, 200),
      effectiveDirective: String(e.effectiveDirective || "").slice(0, 200),
      blockedURI: String(e.blockedURI || "").slice(0, 500),
      disposition: String(e.disposition || ""),
      sample: String(e.sample || "").slice(0, 200)
    });
  });
  ["warn", "error"].forEach(function(level){
    var original = console[level].bind(console);
    console[level] = function(){
      var text = Array.prototype.slice.call(arguments).map(function(arg){
        return typeof arg === "string" ? arg : (function(){ try { return JSON.stringify(arg); } catch (e) { return String(arg); } })();
      }).join(" ").slice(0, 500);
      send("console", { level: level, text: text });
      return original.apply(console, arguments);
    };
  });
  send("log", { topic: "html-preview-iframe", phase: "bridge-ready" });
})();`;

function emitPreviewDiagnostic(
  kind: string,
  detail: Record<string, string | number | boolean | null>,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("genehub:preview-diagnostic", { detail: { kind, detail } }),
  );
}

async function endpointForDevice(host: Host, machineId: string): Promise<Endpoint | null> {
  if (!host.targets || !host.openTarget) return null;
  const target = (await host.targets()).find(
    (candidate) => (candidate.deviceHandle ?? candidate.id) === machineId,
  );
  return target ? host.openTarget(target.id) : null;
}

function connect(endpoint: Endpoint, host: Host, deviceHandle: string): Client {
  const client = new Client({
    ...dial(endpoint),
    credential: endpoint.credential,
    rtcEnabled: readRtcEnabled(),
    redial: async () => {
      const fresh =
        (await endpointForDevice(host, deviceHandle)) ??
        (await host.endpoint());
      if (!fresh) throw new Error("资源所在设备已离线");
      return dial(fresh);
    },
  });
  client.connect();
  return client;
}

function dial(endpoint: Endpoint): ProtocolDial {
  return {
    url: endpoint.url,
    fabricRouteTicket: endpoint.fabricRouteTicket,
    channelCredential: endpoint.channelCredential,
    localServerProof: endpoint.localServerProof,
  };
}

function ready(client: Client): Promise<void> {
  if (client.connectionState === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      reject(new Error("连接资源所在设备超时"));
    }, 15_000);
    stop = client.onStateChange((state) => {
      if (state === "ready") {
        clearTimeout(timer);
        stop();
        resolve();
      } else if (state === "closed") {
        clearTimeout(timer);
        stop();
        reject(new Error(client.failure?.message ?? "资源所在设备拒绝了连接"));
      }
    });
  });
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
