import type { Reply, Request, ServerFrame } from "@genehub/proto";

/**
 * Business protocol v4's exact boundary types.
 *
 * Keep this module boring. It is the named endpoint of adjacent adapters, not
 * a place for networking, React state or product behavior. When v5 exists,
 * `adapters/v4-to-v5.ts` will be the only module allowed to know both shapes.
 */
export const VERSION = 4 as const;

export type V4Request = Request;
export type V4Reply = Reply;
export type V4ServerFrame = ServerFrame;

export function request(value: Request): V4Request {
  return value;
}

export function reply(value: unknown): V4Reply {
  return value as V4Reply;
}

export function serverFrame(value: unknown): V4ServerFrame {
  return value as V4ServerFrame;
}
