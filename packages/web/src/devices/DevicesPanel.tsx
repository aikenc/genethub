import type { DeviceInfo, DeviceInvite, RemoteAccess } from "@genehub/proto";
import { useEffect, useState } from "react";

import type { Host } from "../host";
import { Claim } from "../hub/Claim";
import { useWorkbench } from "../session/store";
import { forgetMachine, listMachines, pairingLink, type PairedMachine } from "./machines";
import { QrCode } from "./QrCode";

/**
 * Two lists that look alike and mean different things, so they are labelled
 * rather than merged.
 *
 * The left one comes from the machine: it is the authorized-devices list, and
 * it is what decides who gets in. The right one comes from this browser's own
 * storage: it is a memory of what this browser paired with, and it decides
 * nothing. Merging them would suggest a directory exists somewhere. None does.
 */
export function DevicesPanel({
  origin = window.location.origin,
  host,
}: {
  origin?: string;
  /** Only needed to open the generated link; the page works without it. */
  host?: Host;
}) {
  const { devices, remote, refreshDevices, invite, revokeDevice, attachRelay, detachRelay } =
    useWorkbench();
  const [machines, setMachines] = useState<PairedMachine[]>(() => listMachines());

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-6">
      <OnAPhone host={host} />
      <ThisMachine
        devices={devices}
        remote={remote}
        origin={origin}
        onInvite={invite}
        onRevoke={revokeDevice}
        onAttach={attachRelay}
        onDetach={detachRelay}
      />
      <MyMachines machines={machines} onForget={(id) => setMachines(forgetMachine(id))} />
    </div>
  );
}

/**
 * The one thing people come to this page for: a link, and a code to point a
 * phone at.
 *
 * It sits at the top and not in settings because it is not a setting — it is the
 * answer to "how do I use this from the sofa". Where the link comes from depends
 * on how this machine is reachable, and the two cases are genuinely different:
 * through a Hub, the link signs the other browser into the same identity; on
 * your own relay, it pairs the other device with this machine directly. Below,
 * as it always has.
 */
function OnAPhone({ host }: { host?: Host }) {
  const { hub, claim, claimLink, openTab } = useWorkbench();
  const [busy, setBusy] = useState(false);
  const paired = hub?.state === "paired";

  return (
    <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">在手机上打开</h2>
          <p className="text-xs text-muted">
            {paired
              ? "扫码或把链接发到另一台设备，看到的是同一个工作台。"
              : "先把这台机器连上 Hub，手机才有地方找到它。"}
          </p>
        </div>
        {paired ? (
          <button
            type="button"
            className="shrink-0 rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void claimLink().finally(() => setBusy(false));
            }}
          >
            生成链接和二维码
          </button>
        ) : (
          <button
            type="button"
            className="shrink-0 rounded border border-line px-3 py-1.5 text-xs hover:border-accent"
            onClick={() => openTab("settings")}
          >
            去连接 Hub
          </button>
        )}
      </div>
      {claim && host ? <Claim claim={claim} host={host} /> : null}
    </section>
  );
}

function ThisMachine({
  devices,
  remote,
  origin,
  onInvite,
  onRevoke,
  onAttach,
  onDetach,
}: {
  devices: DeviceInfo[];
  remote: RemoteAccess | null;
  origin: string;
  onInvite(): Promise<DeviceInvite | null>;
  onRevoke(deviceId: string): Promise<void>;
  onAttach(relayUrl: string, joinToken: string): Promise<void>;
  onDetach(): Promise<void>;
}) {
  const [relayUrl, setRelayUrl] = useState("");
  const [joinToken, setJoinToken] = useState("");
  const [invite, setInvite] = useState<DeviceInvite | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (remote?.relayUrl) setRelayUrl(remote.relayUrl);
  }, [remote?.relayUrl]);

  const attached = Boolean(remote?.relayUrl);
  const link =
    invite?.rendezvousUrl && invite.code
      ? pairingLink(origin, invite.code, invite.rendezvousUrl)
      : null;

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-sm font-medium">这台机器</h2>
        <p className="text-xs text-muted">
          谁能远程连进来，由这份名单决定。撤销一台设备，它的连接立刻断开。
        </p>
      </header>

      <div className="space-y-2 rounded-lg border border-line bg-surface p-4">
        <p className="text-xs text-muted">
          {attached
            ? remote?.online
              ? "远程可达：其他设备现在能找到这台机器。"
              : "已设置中转，但当前连不上。本机和局域网仍然可用。"
            : "填一个中转地址，其他设备就能从外网连过来。不填也不影响本机使用。"}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="flex-1 rounded border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
            aria-label="中转地址"
            placeholder="https://relay.example.com"
            value={relayUrl}
            onChange={(event) => setRelayUrl(event.target.value)}
          />
          <input
            className="w-full rounded border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent sm:w-48"
            aria-label="接入令牌"
            placeholder="接入令牌（可选）"
            value={joinToken}
            onChange={(event) => setJoinToken(event.target.value)}
          />
          <button
            type="button"
            className="rounded bg-accent px-4 py-1.5 text-sm text-white disabled:opacity-40"
            disabled={busy || relayUrl.trim().length === 0}
            onClick={() => {
              setBusy(true);
              void onAttach(relayUrl.trim(), joinToken.trim()).finally(() => setBusy(false));
            }}
          >
            {attached ? "更新" : "开启远程访问"}
          </button>
        </div>
        {attached ? (
          <button
            type="button"
            className="rounded border border-line px-3 py-1 text-xs hover:border-danger hover:text-danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onDetach().finally(() => setBusy(false));
            }}
          >
            关闭远程访问
          </button>
        ) : null}
      </div>

      <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">添加设备</span>
          <button
            type="button"
            className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
            disabled={busy || !attached}
            onClick={() => {
              setBusy(true);
              void onInvite()
                .then(setInvite)
                .finally(() => setBusy(false));
            }}
          >
            生成配对链接
          </button>
        </div>
        {!attached ? (
          // Not an arbitrary rule: a machine does not know its own address on
          // the network, so without a meeting point there is nothing to put in
          // a link.
          <p className="text-xs text-muted">先开启远程访问，配对链接才有地方可去。</p>
        ) : null}
        {link ? (
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            <QrCode value={link} />
            <div className="min-w-0 flex-1 space-y-2">
              {/* The copyable link is not a fallback. Scanning needs camera
                  access, which browsers only grant over HTTPS, and a
                  self-hosted deployment often has none. */}
              <p className="text-xs text-muted">扫码，或者把这个链接复制到另一台设备上打开：</p>
              <code
                className="block w-full break-all rounded border border-line bg-bg p-2 text-[11px]"
                data-testid="pairing-link"
              >
                {link}
              </code>
              <p className="text-xs text-faint">一次有效，15 分钟内用掉。</p>
            </div>
          </div>
        ) : null}
      </div>

      <div className="rounded-lg border border-line bg-surface">
        {devices.length === 0 ? (
          <p className="p-4 text-xs text-faint">还没有别的设备被授权。</p>
        ) : (
          <ul className="divide-y divide-line">
            {devices.map((device) => (
              <li key={device.id} className="flex items-center gap-3 p-3">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    device.connected ? "bg-ok" : "bg-faint"
                  }`}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-sm">{device.name || device.id}</span>
                <span className="shrink-0 text-[11px] text-faint">
                  {device.connected ? "在线" : shortTime(device.lastSeenAt ?? device.pairedAt)}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded border border-line px-2 py-1 text-xs hover:border-danger hover:text-danger"
                  onClick={() => void onRevoke(device.id)}
                >
                  撤销
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function MyMachines({
  machines,
  onForget,
}: {
  machines: PairedMachine[];
  onForget(machineId: string): void;
}) {
  return (
    <section className="space-y-3">
      <header>
        <h2 className="text-sm font-medium">我的机器</h2>
        <p className="text-xs text-muted">
          这份列表只存在这个浏览器里。换一个浏览器要重新配对一次。
        </p>
      </header>
      <div className="rounded-lg border border-line bg-surface">
        {machines.length === 0 ? (
          <p className="p-4 text-xs text-faint">还没有配对过其他机器。</p>
        ) : (
          <ul className="divide-y divide-line">
            {machines.map((machine) => (
              <li key={machine.machineId} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{machine.name}</p>
                  <p className="truncate font-mono text-[11px] text-faint">{machine.fingerprint}</p>
                </div>
                <a
                  className="shrink-0 rounded bg-accent px-3 py-1 text-xs text-white"
                  href={`#endpoint=${encodeURIComponent(machine.endpoint)}`}
                >
                  连接
                </a>
                <button
                  type="button"
                  className="shrink-0 rounded border border-line px-2 py-1 text-xs hover:border-danger hover:text-danger"
                  onClick={() => onForget(machine.machineId)}
                >
                  忘掉
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function shortTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleDateString();
}
