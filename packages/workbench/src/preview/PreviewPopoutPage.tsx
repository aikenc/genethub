import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SessionArtifactBundle } from "@genehub/proto";

import { emitClientDiagnostic, registerDiagnosticClient } from "../diagnostics";
import type { Host } from "../host";
import { Client } from "../protocol/client";
import { readRtcEnabled } from "../settings/rtc";
import { AssetPreviewPage } from "./AssetPreviewPage";
import {
  createPreviewPopoutChannel,
  previewPopoutArtifact,
  previewPopoutReady,
  takePreviewPopoutBridge,
  type PortablePreviewTicket,
  type PreviewPopoutContext,
} from "./popout";
import { runtimeArtifactDraftLine } from "./sessionArtifactUpload";
import type { AssetPreviewLocation } from "./url";

export function PreviewPopoutPage({
  source,
  context,
  portableTicket = null,
  host,
}: {
  source: AssetPreviewLocation;
  context: PreviewPopoutContext | null;
  portableTicket?: PortablePreviewTicket | null;
  host?: Host;
}) {
  const channelRef = useRef<ReturnType<typeof createPreviewPopoutChannel> | null>(null);
  const [savedWorkspacePath, setSavedWorkspacePath] = useState<string | null>(null);
  const inherited = useMemo(
    () => (context ? takePreviewPopoutBridge(context, source) : null),
    [context, source.deviceHandle, source.path, source.workspaceHandle],
  );
  const effectiveContext = inherited?.context ?? context;
  const sharedClient = inherited?.client ?? null;

  // A copied link opened in a fresh browser has no opener to inherit from;
  // the fragment-carried one-time Hub ticket is its whole credential. The
  // ticket is spent by this dial, so reconnect after a drop is impossible —
  // the page then says the link expired instead of silently retrying.
  const [portable, setPortable] = useState<
    | { kind: "connecting" }
    | { kind: "ready"; client: Client }
    | { kind: "failed"; message: string }
    | null
  >(null);
  useEffect(() => {
    if (!portableTicket || sharedClient) {
      setPortable(null);
      return;
    }
    let cancelled = false;
    let owned: Client | null = null;
    let unregisterDiagnosticClient: (() => void) | null = null;
    setPortable({ kind: "connecting" });
    void (async () => {
      try {
        owned = new Client({
          url: portableTicket.url,
          fabricRouteTicket: portableTicket.fabricRouteTicket,
          channelCredential: {
            capabilityId: portableTicket.channelCapability,
            secret: portableTicket.channelSecret,
          },
          rtcEnabled: readRtcEnabled(),
          onDiagnostic: emitClientDiagnostic,
        });
        unregisterDiagnosticClient = registerDiagnosticClient(owned);
        owned.connect();
        await untilReady(owned);
        if (owned.identity?.machineId !== source.deviceHandle) {
          throw new Error("链接指向的设备与当前连接不一致");
        }
        if (cancelled) {
          owned.close();
          return;
        }
        setPortable({ kind: "ready", client: owned });
      } catch (error) {
        unregisterDiagnosticClient?.();
        owned?.close();
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "";
          setPortable({
            kind: "failed",
            message: `预览链接已失效，请回到原设备重新复制。${message}`.trim(),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      unregisterDiagnosticClient?.();
      owned?.close();
    };
  }, [
    portableTicket,
    sharedClient,
    source.deviceHandle,
  ]);

  useEffect(() => {
    if (!effectiveContext) return;
    const channel = createPreviewPopoutChannel(() => {});
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      channel.close();
    };
  }, [effectiveContext]);

  const reportReady = useCallback(() => {
    if (!effectiveContext) return;
    channelRef.current?.post(previewPopoutReady(effectiveContext));
  }, [effectiveContext]);

  const reportSaved = useCallback(
    (bundle: SessionArtifactBundle) => {
      if (!effectiveContext?.sessionId) return;
      setSavedWorkspacePath(bundle.workspacePath);
      channelRef.current?.post(
        previewPopoutArtifact(
          { id: effectiveContext.id, sessionId: effectiveContext.sessionId },
          bundle.workspacePath,
        ),
      );
    },
    [effectiveContext],
  );

  const portableClient = portable?.kind === "ready" ? portable.client : null;

  if (portableTicket && !sharedClient && portable?.kind !== "ready") {
    return (
      <p role="status" className="m-auto p-6 text-center text-sm text-muted">
        {portable?.kind === "failed" ? portable.message : "正在连接资源所在的设备…"}
      </p>
    );
  }

  return (
    <>
      <AssetPreviewPage
        source={source}
        host={host}
        client={sharedClient ?? portableClient}
        runtimeSessionId={effectiveContext?.sessionId ?? null}
        onRuntimeArtifactSaved={effectiveContext?.sessionId ? reportSaved : undefined}
        onRuntimeReady={effectiveContext ? reportReady : undefined}
      />
      {savedWorkspacePath ? (
        <RuntimeArtifactReceipt
          key={savedWorkspacePath}
          workspacePath={savedWorkspacePath}
          onClose={() => setSavedWorkspacePath(null)}
        />
      ) : null}
    </>
  );
}

function untilReady(client: Client): Promise<void> {
  if (client.connectionState === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      reject(new Error("连接超时"));
    }, 15_000);
    stop = client.onStateChange((state) => {
      if (state === "ready") {
        clearTimeout(timer);
        stop();
        resolve();
      } else if (state === "closed") {
        clearTimeout(timer);
        stop();
        reject(new Error(client.failure?.message ?? "设备拒绝了连接"));
      }
    });
  });
}

function RuntimeArtifactReceipt({
  workspacePath,
  onClose,
}: {
  workspacePath: string;
  onClose: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const draftLine = runtimeArtifactDraftLine(workspacePath);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(draftLine);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="运行产物已保存"
        className="w-full max-w-lg rounded-xl border border-line bg-surface p-4 text-fg shadow-2xl"
      >
        <h2 className="text-sm font-medium">运行产物已保存</h2>
        <p className="mt-1 text-xs text-muted">
          原窗口在线时会自动加入输入框；也可以复制下面这行手动粘贴。
        </p>
        <textarea
          aria-label="运行产物引用"
          className="mt-3 h-20 w-full resize-none rounded border border-line bg-bg p-2 font-mono text-xs text-fg outline-none focus:border-accent"
          readOnly
          value={draftLine}
          onFocus={(event) => event.currentTarget.select()}
        />
        {copyState === "failed" ? (
          <p role="alert" className="mt-2 text-xs text-danger">
            自动复制失败，请长按或选中上面的内容复制。
          </p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-line px-3 py-1.5 text-xs hover:bg-raised"
            onClick={onClose}
          >
            关闭
          </button>
          <button
            type="button"
            className="rounded bg-accent px-3 py-1.5 text-xs text-white hover:opacity-90"
            onClick={() => void copy()}
          >
            {copyState === "copied" ? "已复制" : "复制"}
          </button>
        </div>
      </section>
    </div>
  );
}
