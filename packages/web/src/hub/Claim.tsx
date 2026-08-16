import type { HubClaim } from "@genehub/proto";

import { QrCode } from "../devices/QrCode";
import type { Host } from "../host";

/**
 * The only ways back into an identity that has no password.
 *
 * Shown as soon as they exist and never fetched again: the Hub keeps a hash of
 * the recovery key and nothing more, so this render is the one chance anyone
 * has to write it down.
 */
export function Claim({ claim, host }: { claim: HubClaim; host: Host }) {
  return (
    <div className="space-y-2 rounded border border-accent/50 bg-accent/5 p-3">
      <p className="text-xs text-muted">用另一台设备扫这个码，就能打开同一个身份。链接只能用一次。</p>
      <div className="flex items-center gap-3">
        <QrCode value={claim.claimUrl} size={128} />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="break-all font-mono text-[11px] text-faint">{claim.claimUrl}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded border border-line px-2 py-1 text-xs"
              onClick={() => host.openExternal(claim.claimUrl)}
            >
              在浏览器里打开
            </button>
          </div>
        </div>
      </div>
      {claim.recoveryKey ? (
        <div>
          <p className="text-xs text-fg">恢复密钥（只显示这一次）</p>
          <code className="mt-1 block break-all rounded bg-surface p-2 font-mono text-[11px]">
            {claim.recoveryKey}
          </code>
        </div>
      ) : null}
    </div>
  );
}
