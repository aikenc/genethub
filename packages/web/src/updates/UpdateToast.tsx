import { useEffect, useState } from "react";

import type { Host } from "../host";
import { useWorkbench } from "../session/store";
import { appDownloadPage } from "./links";

/** A non-modal signed-Wasm action surfaced from the stable Platform control. */
export function UpdateToast({ host }: { host: Host }) {
  const { patch, patching, applyPatch, clearPatch } = useWorkbench();
  const [confirmingTermination, setConfirmingTermination] = useState(false);

  useEffect(() => setConfirmingTermination(false), [patch]);

  if (!patch) return null;

  if (patch.type === "status") {
    const availability = patch.availability;
    if (availability.type === "current" || availability.type === "unconfigured") return null;
    if (availability.type === "available") {
      return (
        <Toast>
          <p className="font-medium">Wasm 补丁 r{availability.artifact.logicRevision} 可用</p>
          <p className="mt-1 text-muted">验证签名后冷启动新实例；有活动任务时不会更新。</p>
          <Actions>
            <Secondary onClick={clearPatch}>稍后</Secondary>
            <Primary disabled={patching} onClick={() => void applyPatch(false)}>
              {patching ? "更新中…" : "立即更新"}
            </Primary>
          </Actions>
        </Toast>
      );
    }
    if (availability.type === "requiresApp") {
      return (
        <Toast>
          <p className="font-medium">需要更新 App 安装包</p>
          <p className="mt-1 text-muted">
            此补丁需要 Platform ABI {availability.requiredPlatformAbi}，当前 App 无法直接应用。
          </p>
          <Actions>
            <Secondary onClick={clearPatch}>稍后</Secondary>
            <Primary onClick={() => host.openExternal(appDownloadPage(availability.appManifestUrls))}>
              查看安装包
            </Primary>
          </Actions>
        </Toast>
      );
    }
    return (
      <Toast>
        <p className="font-medium">补丁发布已暂停</p>
        <p className="mt-1 text-muted">{availability.reason}</p>
        <Actions><Secondary onClick={clearPatch}>知道了</Secondary></Actions>
      </Toast>
    );
  }

  if (patch.type === "busy") {
    const count =
      patch.blockers.activeSessions + patch.blockers.terminals + patch.blockers.nativeResources;
    return (
      <Toast>
        {confirmingTermination ? (
          <>
            <p className="font-medium">确认终止活动任务？</p>
            <p className="mt-1 text-muted">
              这会关闭 {count} 项活动工作，然后冷启动新的 Wasm 实例。未完成的任务不会继续运行。
            </p>
            <Actions>
              <Secondary onClick={() => setConfirmingTermination(false)}>取消</Secondary>
              <Primary disabled={patching} onClick={() => void applyPatch(true)}>
                {patching ? "终止中…" : "确认终止并更新"}
              </Primary>
            </Actions>
          </>
        ) : (
          <>
            <p className="font-medium">有活动任务，补丁尚未应用</p>
            <p className="mt-1 text-muted">
              共 {count} 项活动工作。可以等待任务结束，或明确终止后更新。
            </p>
            <Actions>
              <Secondary onClick={clearPatch}>等待</Secondary>
              <Primary disabled={patching} onClick={() => setConfirmingTermination(true)}>
                终止任务并更新
              </Primary>
            </Actions>
          </>
        )}
      </Toast>
    );
  }

  return (
    <Toast>
      <p className="font-medium">Wasm 已更新到 r{patch.active.logicRevision}</p>
      <p className="mt-1 text-muted">daemon 进程未重启，后续请求已切换到新实例。</p>
      <Actions><Secondary onClick={clearPatch}>完成</Secondary></Actions>
    </Toast>
  );
}

function Toast({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      data-testid="update-toast"
      className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface p-3 text-xs shadow-lg"
    >
      {children}
    </div>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-3 flex justify-end gap-2">{children}</div>;
}

function Secondary({ children, onClick }: { children: React.ReactNode; onClick(): void }) {
  return (
    <button
      type="button"
      data-testid="dismiss-update"
      className="rounded border border-line px-2 py-1 hover:border-accent"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Primary({
  children,
  disabled = false,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="rounded bg-accent px-3 py-1 text-white disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
