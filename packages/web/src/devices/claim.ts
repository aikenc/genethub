import type { ServerFrame } from "@genehub/proto";

import type { WebSocketLike } from "../protocol/client";
import {
  channelClientProof,
  channelServerProof,
  deriveChannelSessionKey,
  openChannelFrame,
  randomNonce,
  sealChannelFrame,
} from "./proof";
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
  deadlines: { connectTimeoutMs?: number; responseTimeoutMs?: number } = {},
): Promise<PairedMachine> {
  if (!/^inv_[0-9a-f]{32}\.[0-9a-f]{64}$/.test(code)) {
    throw new Error("配对链接不完整");
  }
  const split = code.indexOf(".");
  const inviteId = code.slice(0, split);
  const secret = code.slice(split + 1);
  const context = `invite:${inviteId}`;
  const nonce = randomNonce();
  const hello = {
    id: "claim-hello",
    type: "hello",
    payload: {
      clientName: "genehub-client",
      protocolVersion: 2,
      invite: {
        inviteId,
        nonce,
        proof: await channelClientProof(secret, context, nonce),
      },
    },
  };

  const socket = openSocket(endpoint);
  try {
    await opened(socket, deadlines.connectTimeoutMs ?? 10_000);
    socket.send(JSON.stringify(hello));
    const helloFrame = await nextFrame(
      socket,
      deadlines.responseTimeoutMs ?? 10_000,
      "配对通道没有及时返回认证回复",
    );
    if (
      helloFrame.type !== "result" ||
      helloFrame.id !== hello.id ||
      !helloFrame.ok ||
      helloFrame.payload?.type !== "hello" ||
      !helloFrame.payload.data.serverNonce
    ) {
      throw new Error("配对通道认证失败");
    }
    const helloReply = helloFrame.payload.data;
    const serverNonce = helloReply.serverNonce!;
    const expected = await channelServerProof(
      secret,
      context,
      nonce,
      serverNonce,
    );
    if (helloReply.proof !== expected) throw new Error("对面不是这台机器，配对已中止");
    const key = await deriveChannelSessionKey(secret, context, nonce, serverNonce);
    const inner = JSON.stringify({
      id: "claim",
      type: "device.claim",
      payload: { code: inviteId, deviceName, nonce: "", proof: "" },
    });
    const sealed = await sealChannelFrame(key, "client-to-daemon", 1, inner);
    socket.send(
      JSON.stringify({
        id: "claim",
        type: "authenticated",
        payload: { sequence: 1, body: sealed.body, mac: sealed.mac },
      }),
    );
    const wire = await nextFrame(
      socket,
      deadlines.responseTimeoutMs ?? 10_000,
      "配对通道没有及时返回配对结果",
    );
    if (wire.type !== "authenticated" || wire.sequence !== 1) {
      throw new Error("配对响应没有通过通道认证");
    }
    const plaintext = await openChannelFrame(
      key,
      "daemon-to-client",
      1,
      wire.body,
      wire.mac,
    );
    const frame = JSON.parse(plaintext) as ServerFrame;
    if (frame.type !== "result" || frame.id !== "claim") {
      throw new Error("配对时收到了预料之外的回复");
    }
    if (!frame.ok || frame.payload?.type !== "claimed") {
      throw new Error(frame.error?.message ?? "配对失败");
    }

    const claimed = frame.payload.data;
    return {
      machineId: claimed.machineId,
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

function opened(socket: WebSocketLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("连接这台机器超时，链接可能已经过期"));
    }, timeoutMs);
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("连不上这台机器，链接可能已经过期"));
    };
    socket.onerror = fail;
    socket.onclose = fail;
    socket.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
  });
}

function nextFrame(
  socket: WebSocketLike,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(timeoutMessage))),
      timeoutMs,
    );
    socket.onerror = () => finish(() => reject(new Error("配对通道中断")));
    socket.onclose = () => finish(() => reject(new Error("配对通道已关闭")));
    socket.onmessage = (event) => {
      try {
        if (typeof event.data !== "string" || event.data.length > 4 * 1024 * 1024) {
          throw new Error("oversized pairing frame");
        }
        const frame = JSON.parse(event.data) as ServerFrame;
        finish(() => resolve(frame));
      } catch {
        finish(() => reject(new Error("配对时收到了无法解析的回复")));
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
