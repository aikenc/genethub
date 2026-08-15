import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SessionArtifactBundle } from "@genehub/proto";

import type { Host } from "../host";
import { AssetPreviewPage } from "./AssetPreviewPage";
import {
  createPreviewPopoutChannel,
  previewPopoutArtifact,
  previewPopoutReady,
  takePreviewPopoutBridge,
  type PreviewPopoutContext,
} from "./popout";
import { runtimeArtifactDraftLine } from "./sessionArtifactUpload";
import type { AssetPreviewLocation } from "./url";

export function PreviewPopoutPage({
  source,
  context,
  host,
}: {
  source: AssetPreviewLocation;
  context: PreviewPopoutContext | null;
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

  return (
    <>
      <AssetPreviewPage
        source={source}
        host={host}
        client={sharedClient}
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
