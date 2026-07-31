import { useState } from "react";

import type { Host } from "../host";
import { useWorkbench } from "../session/store";

/**
 * The corner of the screen where a finished download says so.
 *
 * A corner rather than the settings page, because by the time the file has
 * landed the person who pressed 下载 has gone back to work — and an installer
 * sitting on disk that nobody is told about is a download that did not happen.
 * It is also why this is not a modal: installing stops the daemon and every
 * agent mid-turn, so interrupting someone to ask would be the one moment they
 * are guaranteed to say no.
 *
 * Rendered from the machine's state and nothing else. Two windows open on the
 * same machine show the same box, and closing one does not lose the other's.
 */
export function UpdateToast({ host }: { host: Host }) {
  const { download, dismissUpdate, downloadUpdate } = useWorkbench();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (download.state === "idle") return null;

  return (
    <div
      role="status"
      data-testid="update-toast"
      className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface p-3 text-xs shadow-lg"
    >
      {download.state === "fetching" ? (
        <Fetching version={download.version} received={download.received} total={download.total} />
      ) : null}

      {download.state === "failed" ? (
        <>
          <p className="text-danger" role="alert">
            下载 {download.version} 失败
          </p>
          <p className="mt-1 break-words text-muted">{download.message}</p>
          <Actions>
            <Secondary onClick={() => void dismissUpdate()}>关闭</Secondary>
            <Primary
              busy={busy}
              testId="retry-update"
              onClick={async () => {
                setBusy(true);
                setProblem(null);
                try {
                  await downloadUpdate();
                } finally {
                  setBusy(false);
                }
              }}
            >
              重试
            </Primary>
          </Actions>
        </>
      ) : null}

      {download.state === "ready" ? (
        <>
          <p className="font-medium">新版本 {download.version} 已下载</p>
          <p className="mt-1 text-muted">
            {host.installUpdate
              ? "安装会关掉 GeneHub，正在跑的会话会被打断；装完它自己会重新打开。"
              : "安装包在那台电脑上，去电脑上打开 GeneHub 完成安装。"}
          </p>
          {host.installUpdate ? null : (
            <p className="mt-1 break-all text-faint">{download.path}</p>
          )}
          {problem ? (
            <p className="mt-1 text-danger" role="alert">
              {problem}
            </p>
          ) : null}
          <Actions>
            <Secondary onClick={() => void dismissUpdate()}>稍后</Secondary>
            {host.installUpdate ? (
              <Primary
                busy={busy}
                testId="install-update"
                onClick={async () => {
                  setBusy(true);
                  setProblem(null);
                  try {
                    // Left on screen rather than dismissed: on the shell that
                    // can install, this window is about to close itself anyway,
                    // and on the one that cannot, a box that vanished the
                    // instant they clicked would leave "did that work?" with
                    // nowhere to look.
                    await host.installUpdate?.(download.path);
                  } catch (failed) {
                    setProblem(failed instanceof Error ? failed.message : String(failed));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                立即安装
              </Primary>
            ) : null}
          </Actions>
        </>
      ) : null}
    </div>
  );
}

/**
 * Progress, and no buttons.
 *
 * Nothing here can be pressed because there is nothing useful to press: the
 * fetch cannot be cancelled meaningfully — it is a file on this machine's own
 * disk, and interrupting it saves nobody anything — and installing is not yet
 * possible. It resolves itself, which is the honest reason to show it at all:
 * a download nobody can see is a download people start twice.
 */
function Fetching({
  version,
  received,
  total,
}: {
  version: string;
  received: number;
  total?: number;
}) {
  // No total means the release host sent no length. A bar that guessed one
  // would be a lie that moves; the byte count is the truth that does.
  const share = total && total > 0 ? Math.min(1, received / total) : null;

  return (
    <>
      <p className="font-medium">正在下载 {version}…</p>
      <div className="mt-2 h-1 overflow-hidden rounded bg-bg">
        {/* With no total, a full bar would read as "done" and a bar at zero as
            "stuck". Neither is true, so it pulses instead of measuring. */}
        <div
          data-testid="update-progress"
          className={
            share === null
              ? "h-full w-1/3 animate-pulse bg-accent"
              : "h-full bg-accent transition-[width] duration-200"
          }
          style={share === null ? undefined : { width: `${Math.round(share * 100)}%` }}
        />
      </div>
      <p className="mt-1 text-muted">
        {share === null
          ? megabytes(received)
          : `${Math.round(share * 100)}% · ${megabytes(received)} / ${megabytes(total!)}`}
      </p>
    </>
  );
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
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
  busy,
  testId,
  onClick,
}: {
  children: React.ReactNode;
  busy: boolean;
  testId: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="rounded bg-accent px-3 py-1 text-white disabled:opacity-40"
      disabled={busy}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
