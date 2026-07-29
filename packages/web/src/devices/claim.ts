import type { ServerFrame } from "@genehub/proto";

import type { WebSocketLike } from "../protocol/client";
import { proof, randomNonce } from "./proof";
import type { PairedMachine } from "./machines";

/**
 * Redeeming a pairing invite, on a raw socket rather than through `Client`.
 *
 * `Client` says hello as soon as it opens, and a machine that requires a
 * credential will hang up on a hello without one — which is exactly the
 * situation a device claiming an invite is in. Rather than teach the handshake
 * a half-authenticated mode, this one exchange gets its own short function.
 */
export async function claimMachine(
  endpoint: string,
  code: string,
  deviceName: string,
  openSocket: (url: string) => WebSocketLike = (url) => new WebSocket(url) as WebSocketLike,
): Promise<PairedMachine> {
  const nonce = randomNonce();
  const request = {
    id: "claim",
    type: "device.claim",
    payload: {
      code,
      deviceName,
      nonce,
      proof: await proof("client", nonce, code),
    },
  };

  const socket = openSocket(endpoint);
  try {
    const frame = await exchange(socket, JSON.stringify(request));
    if (frame.type !== "result") throw new Error("配对时收到了预料之外的回复");
    if (!frame.ok || frame.payload?.type !== "claimed") {
      throw new Error(frame.error?.message ?? "配对失败");
    }

    const claimed = frame.payload.data;
    // The machine has to prove it knows the invite too. Without this, whoever
    // reached the rendezvous slot first could collect invites by pretending to
    // be the machine (`docs/security-model.md` §4.2).
    if (claimed.proof !== (await proof("server", nonce, code))) {
      throw new Error("对面不是这台机器，配对已中止");
    }

    return {
      machineId: claimed.deviceId,
      name: claimed.machineName,
      fingerprint: claimed.fingerprint,
      endpoint,
      deviceId: claimed.deviceId,
      secret: claimed.secret,
      pairedAt: new Date().toISOString(),
    };
  } finally {
    socket.close();
  }
}

/** Sends once the socket is open and resolves with the first frame back. */
function exchange(socket: WebSocketLike, request: string): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("连不上这台机器，链接可能已经过期"));
    socket.onerror = fail;
    socket.onclose = fail;
    socket.onopen = () => socket.send(request);
    socket.onmessage = (event) => {
      try {
        resolve(JSON.parse(String(event.data)) as ServerFrame);
      } catch {
        reject(new Error("配对时收到了无法解析的回复"));
      }
    };
  });
}

/** What the machine's owner will see this device called. */
export function deviceName(userAgent = navigator.userAgent): string {
  const platform = /iphone|ipad|android/i.test(userAgent)
    ? "手机"
    : /macintosh|mac os/i.test(userAgent)
      ? "Mac"
      : /windows/i.test(userAgent)
        ? "Windows"
        : /linux/i.test(userAgent)
          ? "Linux"
          : "浏览器";
  const browser = /edg\//i.test(userAgent)
    ? "Edge"
    : /chrome\//i.test(userAgent)
      ? "Chrome"
      : /firefox\//i.test(userAgent)
        ? "Firefox"
        : /safari\//i.test(userAgent)
          ? "Safari"
          : "浏览器";
  return `${platform} 上的 ${browser}`;
}
