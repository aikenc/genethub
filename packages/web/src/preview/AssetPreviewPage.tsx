import { useEffect, useMemo, useState } from "react";

import type { AssetPreviewMetadata } from "@genehub/proto";

import { detectHost, type Endpoint, type Host } from "../host";
import { Client, type AssetPreviewResult, type ProtocolDial } from "../protocol/client";
import { HighlightedCode, languageForPath, Markdown } from "../session/Markdown";
import { readRtcEnabled } from "../settings/rtc";
import type { AssetPreviewLocation } from "./url";

type ViewState =
  | { kind: "loading" }
  | { kind: "ready"; result: AssetPreviewResult }
  | { kind: "error"; message: string };

export function AssetPreviewPage({
  source,
  host = detectHost(),
}: {
  source: AssetPreviewLocation;
  host?: Host;
}) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    let client: Client | null = null;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const endpoint =
          (await endpointForDevice(host, source.deviceHandle)) ??
          (await host.endpoint());
        if (!endpoint) throw new Error("这台浏览器尚未获准连接资源所在的设备");
        client = connect(endpoint, host, source.deviceHandle);
        await ready(client);
        if (client.identity?.machineId !== source.deviceHandle) {
          throw new Error("链接指向的设备与当前连接不一致");
        }
        const result = await client.preview(source.workspaceHandle, source.path);
        if (!cancelled) setState({ kind: "ready", result });
      } catch (error) {
        if (!cancelled) {
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : "无法预览这个文件",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      client?.close();
    };
  }, [host, source.deviceHandle, source.path, source.workspaceHandle]);

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-bg text-fg">
      <header className="flex min-h-11 shrink-0 items-center gap-3 border-b border-line px-4 py-2">
        <span className="min-w-0 truncate font-mono text-xs">{source.path}</span>
        <span className="ml-auto shrink-0 text-[11px] text-faint">
          {source.workspaceHandle}
        </span>
      </header>
      {state.kind === "loading" ? (
        <p role="status" className="m-auto text-sm text-muted">正在安全读取文件…</p>
      ) : state.kind === "error" ? (
        <section role="alert" className="m-auto max-w-lg px-6 text-center">
          <p className="text-sm">无法预览</p>
          <p className="mt-2 text-xs text-muted">{state.message}</p>
        </section>
      ) : (
        <PreviewDocument result={state.result} path={source.path} />
      )}
    </main>
  );
}

function PreviewDocument({
  result,
  path,
}: {
  result: AssetPreviewResult;
  path: string;
}) {
  const { metadata, bytes } = result;
  if (metadata.kind === "markdown") {
    return (
      <article className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain touch-pan-y">
        <div className="mx-auto max-w-4xl px-5 py-6 sm:px-8 sm:py-10">
          <Markdown text={decodeText(bytes)} variant="document" />
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
    return <HtmlDocument bytes={bytes} metadata={metadata} />;
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
}: {
  bytes: Uint8Array;
  metadata: AssetPreviewMetadata;
}) {
  const srcDoc = useMemo(() => isolatedHtml(decodeText(bytes)), [bytes]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-center text-[11px] text-amber-700 dark:text-amber-300">
        活动 HTML · 网络已开启 · {metadata.sourceBytes} bytes
      </p>
      <iframe
        title="HTML 文件预览"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; usb 'none'; serial 'none'; display-capture 'none'; fullscreen 'none'; presentation 'none'"
        srcDoc={srcDoc}
        className="min-h-0 flex-1 border-0 bg-white"
      />
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
    "script-src 'unsafe-inline' https:",
    "style-src 'unsafe-inline' https:",
    "img-src data: blob: https:",
    "media-src data: blob: https:",
    "font-src data: https:",
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
  return `<!doctype html>\n${document_.documentElement.outerHTML}`;
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
