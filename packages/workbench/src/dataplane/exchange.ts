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
