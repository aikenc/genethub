import type { ServicePreviewDescriptor } from "@genehub/proto/service-preview";
import type { Client } from "../protocol/client";
import type { DataStream } from "../dataplane/endpoint";
import { DataReset } from "../dataplane/frame";
import { collectBody } from "../dataplane/exchange";

export const SERVICE_PACKET_LIMIT = 256 * 1024;
export function servicePacket(value: unknown | Uint8Array): Uint8Array {
  const bytes =
    value instanceof Uint8Array
      ? value
      : new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(bytes.length + 5);
  if (bytes.length + 1 > SERVICE_PACKET_LIMIT) throw new Error("服务消息过大");
  new DataView(frame.buffer).setUint32(0, bytes.length + 1);
  frame[4] = value instanceof Uint8Array ? 1 : 0;
  frame.set(bytes, 5);
  return frame;
}
export async function* servicePackets(
  stream: DataStream,
): AsyncGenerator<Uint8Array> {
  let pending = new Uint8Array(0);
  for await (const chunk of stream.body()) {
    const merged = new Uint8Array(pending.length + chunk.length);
    merged.set(pending);
    merged.set(chunk, pending.length);
    pending = merged;
    while (pending.length >= 4) {
      const size = new DataView(
        pending.buffer,
        pending.byteOffset,
        4,
      ).getUint32(0);
      if (!size || size > SERVICE_PACKET_LIMIT)
        throw new Error("服务帧长度无效");
      if (pending.length < size + 4) break;
      const packet = pending.slice(4, size + 4);
      pending = pending.slice(size + 4);
      yield packet;
    }
    if (pending.length > SERVICE_PACKET_LIMIT + 4)
      throw new Error("服务缓冲超限");
  }
  if (pending.length) throw new Error("服务帧不完整");
}
export class ServicePreviewClient {
  private readonly streams = new Set<DataStream>();
  private closed = false;
  constructor(
    readonly client: Client,
    readonly workspaceHandle: string,
    readonly entryPath: string,
    readonly descriptor: ServicePreviewDescriptor,
  ) {}
  static async discover(
    client: Client,
    workspaceHandle: string,
    entryPath: string,
  ): Promise<ServicePreviewClient | null> {
    const stream = client.openServicePreview({
      workspaceHandle,
      entryPath,
      operation: "describe",
    });
    try {
      await stream.finish();
      const head = await stream.responseHead;
      if (head.status === 404) return null;
      if (head.status !== 200 || head.error)
        throw new Error(head.error?.message ?? "服务预览不可用");
      const value = JSON.parse(
        new TextDecoder().decode(await collectBody(stream.body(), 16 * 1024)),
      ) as ServicePreviewDescriptor;
      if (
        value.version !== 1 ||
        !/^[a-f0-9]{32}$/.test(value.runId) ||
        !Array.isArray(value.routes)
      )
        throw new Error("服务预览版本或身份无效");
      return new ServicePreviewClient(
        client,
        workspaceHandle,
        entryPath,
        value,
      );
    } finally {
      stream.reset(DataReset.Cancelled);
    }
  }
  async ice(allowTurn: boolean): Promise<RTCIceServer[]> {
    const stream = this.client.openServicePreview({
      workspaceHandle: this.workspaceHandle,
      entryPath: this.entryPath,
      operation: "ice",
      runId: this.descriptor.runId,
      allowTurn,
    });
    this.streams.add(stream);
    try {
      await stream.finish();
      const head = await stream.responseHead;
      if (head.status !== 200 || head.error)
        throw new Error("Channel ICE 或 TURN 凭证不可用");
      const value = JSON.parse(
        new TextDecoder().decode(await collectBody(stream.body(), 16 * 1024)),
      );
      if (!Array.isArray(value.iceServers)) throw new Error("ICE 配置无效");
      return value.iceServers;
    } finally {
      this.streams.delete(stream);
      stream.reset(DataReset.Cancelled);
    }
  }
  allows(path: string, websocket = false): boolean {
    return (
      path.startsWith("/api/") &&
      !/[\\\r\n#]/.test(path) &&
      this.descriptor.routes.some(
        (r) => path.startsWith(r.prefix) && (!websocket || r.websocket),
      )
    );
  }
  private open(): DataStream {
    if (this.closed) throw new Error("服务预览已关闭");
    const stream = this.client.openServicePreview({
      workspaceHandle: this.workspaceHandle,
      entryPath: this.entryPath,
      operation: "connect",
      runId: this.descriptor.runId,
    });
    this.streams.add(stream);
    void stream.done.finally(() => this.streams.delete(stream)).catch(() => {});
    return stream;
  }
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.allows(path)) throw new Error("未登记的服务路径");
    if (init.signal?.aborted)
      throw new DOMException("请求已取消", "AbortError");
    const stream = this.open();
    const abort = () => stream.reset(DataReset.Cancelled);
    init.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => init.signal?.removeEventListener("abort", abort);
    void stream.done.finally(cleanup).catch(() => {});
    try {
      const head = await stream.responseHead;
      if (head.status !== 200 || head.error)
        throw new Error("后端运行已失效或连接策略拒绝");
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      await stream.write(
        servicePacket({
          kind: "http",
          path,
          method: init.method ?? "GET",
          headers,
        }),
      );
      if (init.body != null) {
        const bytes = new Uint8Array(
          await new Response(init.body).arrayBuffer(),
        );
        if (bytes.length > 8 * 1024 * 1024) throw new Error("上传超过 8 MiB");
        for (let i = 0; i < bytes.length; i += 32 * 1024)
          await stream.write(servicePacket(bytes.slice(i, i + 32 * 1024)));
      }
      await stream.write(servicePacket({ kind: "end" }));
      const packets = servicePackets(stream);
      const first = await packets.next();
      if (first.done || first.value[0] !== 0)
        throw new Error("缺少 HTTP 响应头");
      const response = JSON.parse(
        new TextDecoder().decode(first.value.slice(1)),
      );
      if (response.kind !== "head") throw new Error("无效 HTTP 响应");
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const packet = await packets.next();
              if (packet.done) throw new Error("响应提前结束");
              if (packet.value[0] === 1)
                controller.enqueue(packet.value.slice(1));
              else if (
                JSON.parse(new TextDecoder().decode(packet.value.slice(1)))
                  .kind === "end"
              ) {
                controller.close();
                await stream.finish();
              } else throw new Error("响应流协议错误");
            } catch (e) {
              controller.error(e);
              abort();
            }
          },
          cancel() {
            abort();
          },
        },
        { highWaterMark: 1 },
      );
      if (init.method === "HEAD" || [204, 205, 304].includes(response.status)) {
        void body.cancel();
        return new Response(null, {
          status: response.status,
          headers: response.headers,
        });
      }
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (e) {
      abort();
      cleanup();
      throw e;
    }
  }
  async websocket(
    path: string,
    onPacket: (packet: Uint8Array) => Promise<void>,
  ): Promise<{
    send(value: unknown | Uint8Array): Promise<void>;
    close(): void;
  }> {
    if (!this.allows(path, true)) throw new Error("未登记的 WebSocket 路径");
    const stream = this.open();
    try {
      const head = await stream.responseHead;
      if (head.status !== 200 || head.error) throw new Error("服务连接失败");
      await stream.write(servicePacket({ kind: "ws", path }));
      void (async () => {
        try {
          for await (const packet of servicePackets(stream))
            await onPacket(packet);
        } finally {
          stream.reset(DataReset.Cancelled);
        }
      })().catch(() => {
        void onPacket(
          new Uint8Array([
            0,
            ...new TextEncoder().encode(
              JSON.stringify({
                kind: "close",
                code: 1006,
                reason: "服务连接中断",
              }),
            ),
          ]),
        ).catch(() => {});
      });
      return {
        send: (value) => stream.write(servicePacket(value)),
        close: () => stream.reset(DataReset.Cancelled),
      };
    } catch (e) {
      stream.reset(DataReset.Cancelled);
      throw e;
    }
  }
  close() {
    this.closed = true;
    for (const stream of this.streams) stream.reset(DataReset.Cancelled);
    this.streams.clear();
  }
}
