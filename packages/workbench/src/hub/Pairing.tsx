import type { HubClaim, HubStatus } from "@genehub/proto";
import { useEffect, useState } from "react";

import type { Host } from "../host";

import { openAccount } from "./account";
import { Claim } from "./Claim";

/**
 * Approving a pairing code means signing in, and where that happens is the
 * shell's call. The desktop app opens a window of its own; being thrown out to
 * the system browser and back is the worst minute of a first install.
 *
 * Only the pairing-code path reaches this. The ordinary one does not open
 * anything: the Hub enrolls the machine on the spot, which is the whole point
 * of `hub.trial`.
 */
function openSignIn(host: Host, url: string): void {
  if (host.openWindow) host.openWindow(url);
  else host.openExternal(url);
}

/**
 * Connecting this machine to a Hub, so a phone or another browser can reach it.
 *
 * Everything here renders from `HubStatus`, which the daemon owns. The UI never
 * tracks "we are in step two of pairing" itself: a reload, a crash, or a second
 * window would each have their own idea of the step, and the one on the machine
 * is the only one that is true.
 */
export function Pairing({
  status,
  claim,
  host,
  onPair,
  onTrial,
  onClaimLink,
  onUnpair,
  defaultHubUrl = "",
}: {
  status: HubStatus | null;
  /** Owned by the store, because the tray can ask for one too. */
  claim?: HubClaim | null;
  host: Host;
  onPair(hubUrl: string): Promise<void>;
  onTrial?(hubUrl: string): Promise<unknown>;
  onClaimLink?(): Promise<unknown>;
  onUnpair(): Promise<void>;
  defaultHubUrl?: string;
}) {
  const [hubUrl, setHubUrl] = useState(defaultHubUrl);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status && "hubUrl" in status) setHubUrl(status.hubUrl);
  }, [status]);

  if (!status) return null;

  if (status.state === "paired") {
    return (
      <section className="space-y-2 rounded-lg border border-line bg-surface p-4">
        <Row label="已连接" value={status.hubUrl} />
        <Row label="机器 ID" value={status.machineId} />
        <p className="text-xs text-muted">
          {status.online
            ? "远程可达：手机和其他浏览器现在能找到这台电脑。"
            : "已配对，但当前连不上 Hub。同机 loopback 仍可用；跨设备需要 Relay。"}
        </p>
        {claim ? <Claim claim={claim} host={host} /> : null}
        <div className="flex flex-wrap gap-2">
          {/* The account itself lives on the Hub, and so does its page. This
              opens it already signed in as this machine's owner. */}
          <button
            type="button"
            className="rounded border border-line px-3 py-1.5 text-xs hover:border-accent"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void openAccount(host).finally(() => setBusy(false));
            }}
          >
            打开我的账户
          </button>
          {onClaimLink ? (
            <button
              type="button"
              className="rounded border border-line px-3 py-1.5 text-xs hover:border-accent"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onClaimLink().finally(() => setBusy(false));
              }}
            >
              在别的设备上打开
            </button>
          ) : null}
          <button
            type="button"
            className="rounded border border-line px-3 py-1.5 text-xs hover:border-danger hover:text-danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onUnpair().finally(() => setBusy(false));
            }}
          >
            断开连接
          </button>
        </div>
      </section>
    );
  }

  if (status.state === "pairing") {
    return (
      <section className="space-y-3 rounded-lg border border-accent/50 bg-accent/5 p-4 text-center">
        <p className="text-sm text-muted">在浏览器里打开下面的地址，输入这个配对码：</p>
        <p className="font-mono text-3xl tracking-[0.3em]" data-testid="user-code">
          {status.userCode}
        </p>
        <button
          type="button"
          className="rounded bg-accent px-4 py-2 text-sm text-white"
          onClick={() => openSignIn(host, status.verificationUriComplete)}
        >
          打开授权页面
        </button>
        <p className="text-xs text-muted">{status.verificationUri}</p>
      </section>
    );
  }

  // The one-click path exists only where this build knows a Hub to connect to
  // and the deployment lets a machine enroll without anyone approving it. An
  // open-source build knows neither, and inventing an address for it would be
  // a button that fails for everyone who presses it.
  const automatic = onTrial && defaultHubUrl.trim().length > 0;

  return (
    <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
      <p className="text-sm">
        连接之后，手机和其他电脑上的浏览器就能远程使用这台机器。不连接也不影响本机使用。
      </p>
      {status.state === "failed" ? (
        <p className="text-xs text-danger" role="alert">
          {status.message}
        </p>
      ) : null}
      {claim ? <Claim claim={claim} host={host} /> : null}

      {automatic ? (
        // Two ways in, side by side. The second one used to be reachable only
        // by opening a fold labelled "连到自己的 Hub", which is the wrong
        // sentence for the person it is for: someone who already has an
        // account and is installing on their second computer. Hidden behind
        // that wording, their choice was to start over as a new stranger.
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="connect-hub"
              className="rounded bg-accent px-4 py-2 text-sm text-white disabled:opacity-40"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onTrial(defaultHubUrl.trim()).finally(() => setBusy(false));
              }}
            >
              {busy ? "连接中…" : "连接"}
            </button>
            <button
              type="button"
              data-testid="pair-hub"
              className="rounded border border-line px-4 py-2 text-sm hover:border-accent disabled:opacity-40"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onPair(defaultHubUrl.trim()).finally(() => setBusy(false));
              }}
            >
              用已有身份连接
            </button>
          </div>
          <p className="text-xs text-muted">
            直接连不用注册，在这个应用里就完成了。已经有账号的话走右边那个，这台电脑会记到你名下。
          </p>
        </div>
      ) : null}

      <Custom expanded={!automatic}>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
            aria-label="Hub 地址"
            placeholder="https://hub.example.com"
            value={hubUrl}
            onChange={(event) => setHubUrl(event.target.value)}
          />
          <button
            type="button"
            className="rounded border border-line px-4 py-1.5 text-sm hover:border-accent disabled:opacity-40"
            disabled={busy || hubUrl.trim().length === 0}
            onClick={() => {
              setBusy(true);
              void onPair(hubUrl.trim()).finally(() => setBusy(false));
            }}
          >
            获取配对码
          </button>
        </div>
        <p className="text-xs text-muted">
          连自建的 Hub 用这里。会给一个配对码，需要在浏览器里确认一次。
        </p>
        {onTrial ? (
          <button
            type="button"
            className="text-xs text-accent disabled:opacity-40"
            disabled={busy || hubUrl.trim().length === 0}
            onClick={() => {
              setBusy(true);
              void onTrial(hubUrl.trim()).finally(() => setBusy(false));
            }}
          >
            先体验：不注册，直接连上
          </button>
        ) : null}
      </Custom>
    </section>
  );
}

/**
 * The manual path, folded away where there is a one-click one.
 *
 * Folded rather than removed: someone running their own Hub is a real user of
 * this product, and the address box being the first thing on the page is what
 * made connecting look like homework for everybody else.
 */
function Custom({ expanded, children }: { expanded: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(expanded);
  if (open) return <div className="space-y-2 border-t border-line pt-3">{children}</div>;
  return (
    <button
      type="button"
      data-testid="custom-hub"
      className="text-xs text-muted underline decoration-dotted hover:text-fg"
      onClick={() => setOpen(true)}
    >
      连到自己的 Hub（用配对码）
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex justify-between gap-4 text-sm">
      <span className="text-muted">{label}</span>
      <span className="truncate font-mono text-xs">{value}</span>
    </p>
  );
}
