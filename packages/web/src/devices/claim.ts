import { Client, type WebSocketLike } from "../protocol/client";
import type { PairedMachine } from "./machines";

/** Redeems one invitation over the same v3 E2EE data plane as every client. */
export async function claimMachine(
  endpoint: string,
  code: string,
  deviceName: string,
  openSocket: (url: string) => WebSocketLike = (url) =>
    new WebSocket(url) as WebSocketLike,
  deadlines: { connectTimeoutMs?: number; responseTimeoutMs?: number } = {},
): Promise<PairedMachine> {
  if (!/^inv_[0-9a-f]{32}\.[0-9a-f]{64}$/.test(code)) {
    throw new Error("配对链接不完整");
  }
  const split = code.indexOf(".");
  const inviteId = code.slice(0, split);
  const secret = code.slice(split + 1);
  const client = new Client({
    url: endpoint,
    clientName: "genehub-pairing",
    inviteCredential: { inviteId, secret },
    socketFactory: openSocket,
    connectTimeoutMs: deadlines.connectTimeoutMs ?? 10_000,
    helloTimeoutMs: deadlines.responseTimeoutMs ?? 10_000,
    requestTimeoutMs: deadlines.responseTimeoutMs ?? 10_000,
    maxQueuedRequests: 1,
    maxPendingRequests: 1,
    backoffMs: () => 60_000,
  });
  try {
    const ready = waitForReady(client, deadlines.connectTimeoutMs ?? 10_000);
    client.connect();
    await ready;
    const reply = await client.call({
      type: "device.claim",
      payload: { code: inviteId, deviceName },
    });
    if (reply?.type !== "claimed") {
      throw new Error("配对时收到了预料之外的回复");
    }
    const claimed = reply.data;
    return {
      machineId: claimed.machineId,
      name: claimed.machineName,
      fingerprint: claimed.fingerprint,
      endpoint,
      deviceId: claimed.deviceId,
      secret: claimed.secret,
      pairedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof Error) {
      if (/端到端身份验证|peer.*(auth|welcome)|credential|不是这台机器/i.test(error.message)) {
        throw new Error("对面不是这台机器，配对已中止", { cause: error });
      }
      if (/配对|连接.*超时|链接.*过期/.test(error.message)) throw error;
      if (/deadline|did not answer|request.*timed out/i.test(error.message)) {
        throw new Error("等待机器返回配对结果超时", { cause: error });
      }
    }
    throw new Error("配对通道中断", { cause: error });
  } finally {
    client.close();
  }
}

function waitForReady(client: Client, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      reject(new Error("连接这台机器超时，链接可能已经过期"));
    }, timeoutMs);
    stop = client.onStateChange((state) => {
      if (state === "ready") {
        clearTimeout(timer);
        stop();
        resolve();
      } else if (state === "closed") {
        clearTimeout(timer);
        stop();
        reject(new Error(client.failure?.message ?? "配对通道已关闭"));
      }
    });
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
    : /firefox\//i.test(userAgent)
      ? "Firefox"
      : /chrome\//i.test(userAgent)
        ? "Chrome"
        : /safari\//i.test(userAgent)
          ? "Safari"
          : "浏览器";
  return `${platform} 上的 ${browser}`;
}
