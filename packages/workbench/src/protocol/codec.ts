import type { Reply, Request, ServerFrame } from "@genehub/proto";

import { ADJACENT_PROTOCOL_ADAPTERS } from "./adapters";
import * as v3 from "./versions/v3";

export const WEB_PROTOCOL_VERSION = v3.VERSION;
export const RETAINED_WEB_PROTOCOLS = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * A pure N -> N+1 business conversion. Requests travel backwards through the
 * chain; replies and pushed frames travel forwards. An adapter owns no I/O,
 * state or business behavior, so deleting an expired generation is deleting
 * one isolated module and its fixtures.
 */
export interface AdjacentProtocolAdapter {
  readonly from: number;
  readonly to: number;
  downgradeRequest(request: unknown): unknown;
  upgradeReply(reply: unknown): unknown;
  upgradeServerFrame(frame: unknown): unknown;
}

export interface ProtocolCodec {
  readonly version: number;
  encodeRequest(request: Request): Uint8Array;
  decodeReply(bytes: Uint8Array): Reply;
  decodeServerFrame(bytes: Uint8Array): ServerFrame;
}

export class UnsupportedBusinessProtocolError extends Error {
  constructor(
    public readonly requested: number,
    public readonly latest: number,
    message = protocolErrorMessage(requested, latest),
  ) {
    super(message);
    this.name = "UnsupportedBusinessProtocolError";
  }
}

/** Selects and composes a retained protocol without leaking it into callers. */
export function protocolCodec(
  requested: number,
  adapters: readonly AdjacentProtocolAdapter[] = ADJACENT_PROTOCOL_ADAPTERS,
  latest: number = WEB_PROTOCOL_VERSION,
): ProtocolCodec {
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new UnsupportedBusinessProtocolError(requested, latest, "daemon 返回了无效的业务协议版本");
  }
  const oldest = Math.max(1, latest - RETAINED_WEB_PROTOCOLS + 1);
  if (requested < oldest || requested > latest) {
    throw new UnsupportedBusinessProtocolError(requested, latest);
  }

  const bySource = new Map<number, AdjacentProtocolAdapter>();
  for (const adapter of adapters) {
    if (adapter.to !== adapter.from + 1) {
      throw new Error(`protocol adapter ${adapter.from}->${adapter.to} is not adjacent`);
    }
    if (bySource.has(adapter.from)) {
      throw new Error(`more than one protocol adapter starts at v${adapter.from}`);
    }
    bySource.set(adapter.from, adapter);
  }

  const chain: AdjacentProtocolAdapter[] = [];
  for (let version = requested; version < latest; version += 1) {
    const adapter = bySource.get(version);
    if (!adapter || adapter.to !== version + 1) {
      throw new UnsupportedBusinessProtocolError(
        requested,
        latest,
        `网页缺少业务协议 v${version}→v${version + 1} 适配器，请刷新后重试`,
      );
    }
    chain.push(adapter);
  }

  return {
    version: requested,
    encodeRequest(request) {
      let value: unknown = v3.request(request);
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        value = chain[index]!.downgradeRequest(value);
      }
      return encodeJson(value);
    },
    decodeReply(bytes) {
      let value: unknown = decodeJson(bytes);
      for (const adapter of chain) value = adapter.upgradeReply(value);
      return v3.reply(value);
    },
    decodeServerFrame(bytes) {
      let value: unknown = decodeJson(bytes);
      for (const adapter of chain) value = adapter.upgradeServerFrame(value);
      return v3.serverFrame(value);
    },
  };
}

function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes)) as unknown;
}

function protocolErrorMessage(requested: number, latest: number): string {
  if (requested > latest) {
    return `daemon 使用业务协议 v${requested}，当前网页只支持到 v${latest}；请刷新网页`;
  }
  return `daemon 使用的业务协议 v${requested} 已超出网页保留的 ${RETAINED_WEB_PROTOCOLS} 代兼容窗口；请升级 App`;
}
