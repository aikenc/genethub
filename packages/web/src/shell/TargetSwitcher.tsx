import { useEffect, useState } from "react";

import type { Endpoint, Host, Target } from "../host";
import { openAccount } from "../hub/account";
import { useWorkbench } from "../session/store";

/**
 * Which machine the workbench is pointed at, and how to point it somewhere
 * else.
 *
 * It sits at the top of the left column rather than inside a menu, because
 * everything below it belongs to one machine: the workspace tree is that
 * machine's local paths, the sessions are its sessions. A tree with no owner
 * named above it gets read as an account-wide directory, and then switching
 * machines looks like the workspaces disappeared.
 *
 * Nothing here knows about accounts. It renders whatever `Host.targets` hands
 * back, which is the local roster in a self-hosted copy and the account's
 * machines in the official one — the same control either way.
 */
export function TargetSwitcher({
  host,
  current,
  onPick,
  onNavigate,
  variant = "banner",
}: {
  host: Host;
  /** Where the workbench is connected now, for the resting label. */
  current: Endpoint | null;
  onPick(target: Target, endpoint: Endpoint): void;
  onNavigate(): void;
  /** Banner is a column header; row/menuitem sit in a tool or overflow list. */
  variant?: "banner" | "menuitem" | "row";
}) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const openTab = useWorkbench((state) => state.openTab);
  const connection = useWorkbench((state) => state.connection);
  const paired = useWorkbench((state) => state.hub?.state === "paired");

  const list = host.targets;
  const go = host.openTarget;

  // Read when the list is opened, not on mount: for a host that has to ask a
  // server this is a request, and the answer is stale by the time anyone looks
  // at it anyway.
  useEffect(() => {
    if (!open || !list) return;
    let cancelled = false;
    setProblem(null);
    void list()
      .then((found) => !cancelled && setTargets(found))
      .catch((error: unknown) => {
        if (!cancelled) setProblem(message(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, list]);

  if (!list || !go) return null;

  const pick = (target: Target) => {
    setSwitching(target.id);
    setProblem(null);
    void go(target.id)
      .then((endpoint) => {
        setSwitching(null);
        setOpen(false);
        onPick(target, endpoint);
        onNavigate();
      })
      .catch((error: unknown) => {
        setSwitching(null);
        setProblem(message(error));
      });
  };

  const compact = variant === "menuitem" || variant === "row";

  return (
    <div className="relative">
      <button
        type="button"
        role={variant === "menuitem" ? "menuitem" : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          variant === "row"
            ? "flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-muted hover:bg-sidebar-hover hover:text-fg"
            : compact
              ? "flex min-h-10 w-full items-center gap-2 px-3 text-left text-sm text-fg hover:bg-raised md:min-h-0 md:py-1.5 md:text-xs"
              : "flex min-h-11 w-full items-center gap-2 rounded-xl px-2 text-left hover:bg-sidebar-hover md:min-h-0 md:rounded-md md:py-1.5"
        }
        onClick={() => setOpen((shown) => !shown)}
      >
        {compact ? (
          <>
            <span className="min-w-0 flex-1 truncate">我的电脑</span>
            <span className="min-w-0 max-w-[5.5rem] truncate text-[10px] text-faint">
              {current?.label ?? "未连接"}
            </span>
            <span className="shrink-0 text-faint" aria-hidden>
              ▾
            </span>
          </>
        ) : (
          <>
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                connection === "ready" ? "bg-ok" : "bg-faint"
              }`}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] uppercase tracking-wide text-faint">机器</span>
              <span className="block truncate text-sm text-fg md:text-xs">
                {current?.label ?? "未连接"}
              </span>
            </span>
            <span className="shrink-0 text-faint" aria-hidden>
              ▾
            </span>
          </>
        )}
      </button>

      {open ? (
        <>
          {compact ? null : (
            <button
              type="button"
              aria-label="收起机器列表"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setOpen(false)}
            />
          )}
          <div
            role="listbox"
            aria-label="我能控制的机器"
            className={
              compact
                ? "border-t border-line bg-raised/30 py-1"
                : "absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-line-strong bg-surface py-1 shadow-[0_8px_30px_rgb(0_0_0_/0.35)]"
            }
          >
            {targets === null && !problem ? (
              <p className="px-3 py-2 text-xs text-faint">正在找…</p>
            ) : null}

            {targets?.map((target) => (
              <button
                key={target.id}
                type="button"
                role="option"
                aria-selected={target.label === current?.label}
                className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-sm text-fg hover:bg-raised disabled:opacity-50 md:min-h-0 md:py-1.5 md:text-xs"
                disabled={switching !== null}
                onClick={() => pick(target)}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    target.online === false ? "bg-faint" : "bg-ok"
                  }`}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">{target.label}</span>
                {/* Only the one that is different gets a word. Labelling every
                    remote machine "远程" spends a column on the majority case. */}
                {target.kind === "local" ? (
                  <span className="shrink-0 text-[10px] text-faint">本机</span>
                ) : null}
                {switching === target.id ? (
                  <span className="shrink-0 text-[10px] text-faint">连接中…</span>
                ) : null}
              </button>
            ))}

            {targets?.length === 0 ? (
              <p className="px-3 py-2 text-xs leading-snug text-faint">
                还没有配对过机器。
              </p>
            ) : null}

            {problem ? (
              <p className="px-3 py-2 text-xs leading-snug text-danger">{problem}</p>
            ) : null}

            <button
              type="button"
              className="mt-1 flex min-h-10 w-full items-center border-t border-line px-3 text-left text-sm text-muted hover:bg-raised hover:text-fg md:min-h-0 md:py-1.5 md:text-xs"
              onClick={() => {
                setOpen(false);
                openTab("devices");
                onNavigate();
              }}
            >
              配对新机器…
            </button>

            {/* Where the rest of this list comes from, for anyone wondering why
                a machine is missing or named something odd. The page is the
                Hub's and opens in a browser; this app has no account screen of
                its own, by design (`hub/account.ts`). */}
            {paired ? (
              <button
                type="button"
                className="flex min-h-10 w-full items-center px-3 text-left text-sm text-muted hover:bg-raised hover:text-fg md:min-h-0 md:py-1.5 md:text-xs"
                onClick={() => {
                  setOpen(false);
                  void openAccount(host);
                }}
              >
                我的账户…
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
