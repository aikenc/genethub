import type {
  ExchangeRequestHead,
  ExchangeResponseHead,
} from "@genehub/proto";

import { DataEndpoint, DataPlaneError, type DataStream } from "./endpoint";

export interface ExchangeResponse {
  head: ExchangeResponseHead;
  body: AsyncIterable<Uint8Array>;
  stream: DataStream;
}

export async function exchange(
  endpoint: DataEndpoint,
  head: ExchangeRequestHead,
  body: Uint8Array = new Uint8Array(),
): Promise<ExchangeResponse> {
  const stream = endpoint.open(head);
  if (body.byteLength > 0) await stream.write(body);
  await stream.finish();
  const response = await stream.responseHead;
  return { head: response, body: stream.body(), stream };
}

export async function collectBody(
  body: AsyncIterable<Uint8Array>,
  maximum: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    length += chunk.byteLength;
    if (length > maximum) throw new DataPlaneError("exchange response body is too large");
    chunks.push(chunk);
  }
  const value = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
}

export interface ExactBodyOptions {
  /** Maximum interval without receiving another non-empty body chunk or FIN. */
  stallTimeoutMs?: number;
  onStall?: () => void;
  stallError?: () => Error;
}

/**
 * Collects a finite response directly into its declared final allocation.
 *
 * Unlike `collectBody`, this does not retain every chunk and then copy all of
 * them a second time. An optional stall deadline is renewed by each chunk, so
 * a large response that keeps progressing may legitimately outlive one timer
 * interval while a dead carrier is still bounded.
 */
export async function collectBodyExact(
  body: AsyncIterable<Uint8Array>,
  exact: number,
  maximum: number,
  options: ExactBodyOptions = {},
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(exact) ||
    exact < 0 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 0 ||
    exact > maximum
  ) {
    throw new DataPlaneError("exchange response body has an invalid exact length");
  }
  if (
    options.stallTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.stallTimeoutMs) || options.stallTimeoutMs < 1)
  ) {
    throw new DataPlaneError("exchange response body has an invalid stall timeout");
  }

  const value = new Uint8Array(exact);
  const iterator = body[Symbol.asyncIterator]();
  let offset = 0;
  try {
    while (true) {
      const next = await nextBodyChunk(iterator, options);
      if (next.done) break;
      const chunk = next.value;
      if (chunk.byteLength === 0) {
        throw new DataPlaneError("exchange response body contained an empty chunk");
      }
      const end = offset + chunk.byteLength;
      if (end > exact) {
        throw new DataPlaneError("exchange response body exceeds its exact length");
      }
      value.set(chunk, offset);
      offset = end;
    }
  } catch (error) {
    try {
      void iterator.return?.().catch(() => {});
    } catch {
      // Preserve the exact length or timeout error that caused cancellation.
    }
    throw error;
  }
  if (offset !== exact) {
    throw new DataPlaneError("exchange response body ended before its exact length");
  }
  return value;
}

function nextBodyChunk(
  iterator: AsyncIterator<Uint8Array>,
  options: ExactBodyOptions,
): Promise<IteratorResult<Uint8Array>> {
  const pending = iterator.next();
  if (options.stallTimeoutMs === undefined) return pending;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        options.onStall?.();
        reject(
          options.stallError?.() ??
            new DataPlaneError("exchange response body stalled before completion"),
        );
      } catch (error) {
        reject(error);
      }
    }, options.stallTimeoutMs);
    pending.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
