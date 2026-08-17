import type { Reply, Request, ServerFrame } from "@genehub/proto";

/**
 * Business protocol v3's exact boundary types.
 *
 * Keep this module boring. It is the named endpoint of adjacent adapters, not
 * a place for networking, React state or product behavior. When v4 exists,
 * `adapters/v3-to-v4.ts` will be the only module allowed to know both shapes.
 */
export const VERSION = 3 as const;

export type V3Request = Request;
export type V3Reply = Reply;
export type V3ServerFrame = ServerFrame;

export function request(value: Request): V3Request {
  return value;
}

export function reply(value: unknown): V3Reply {
  return value as V3Reply;
}

export function serverFrame(value: unknown): V3ServerFrame {
  return value as V3ServerFrame;
}
