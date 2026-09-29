import { describe, expect, it } from "vitest";

import {
  WEB_PROTOCOL_VERSION,
  RETAINED_WEB_PROTOCOLS,
  UnsupportedBusinessProtocolError,
  protocolCodec,
  type AdjacentProtocolAdapter,
} from "./codec";

const text = new TextDecoder();

describe("WebProtocol adapters", () => {
  it("keeps v3 byte-compatible when no conversion is required", () => {
    const codec = protocolCodec(WEB_PROTOCOL_VERSION);
    expect(text.decode(codec.encodeRequest({ type: "agent.list" }))).toBe(
      '{"type":"agent.list"}',
    );
    expect(codec.decodeReply(new TextEncoder().encode('{"type":"ack"}'))).toEqual({
      type: "ack",
    });
  });

  it("composes adjacent conversions transitively in the correct direction", () => {
    const trace: string[] = [];
    const adjacent = (from: number): AdjacentProtocolAdapter => ({
      from,
      to: from + 1,
      downgradeRequest(value) {
        trace.push(`request:${from + 1}->${from}`);
        return { value, requestVersion: from };
      },
      upgradeReply(value) {
        trace.push(`reply:${from}->${from + 1}`);
        return { value, replyVersion: from + 1 };
      },
      upgradeServerFrame(value) {
        trace.push(`frame:${from}->${from + 1}`);
        return { value, frameVersion: from + 1 };
      },
    });
    const codec = protocolCodec(1, [adjacent(1), adjacent(2)], 3);

    codec.encodeRequest({ type: "agent.list" });
    codec.decodeReply(new TextEncoder().encode('{"type":"ack"}'));
    codec.decodeServerFrame(new TextEncoder().encode('{"type":"notice"}'));

    expect(trace).toEqual([
      "request:3->2",
      "request:2->1",
      "reply:1->2",
      "reply:2->3",
      "frame:1->2",
      "frame:2->3",
    ]);
  });

  it("fails closed on a missing adjacent adapter", () => {
    expect(() => protocolCodec(2, [], 3)).toThrowError(UnsupportedBusinessProtocolError);
  });

  it("keeps exactly eight protocol generations in scope", () => {
    const latest = 20;
    expect(() => protocolCodec(latest - RETAINED_WEB_PROTOCOLS, [], latest)).toThrow(
      "超出网页保留",
    );
    expect(() => protocolCodec(latest + 1, [], latest)).toThrow("请刷新网页");
  });
});

it("v3 translates only Human wire fields and leaves arbitrary payload data intact", () => {
  const codec = protocolCodec(3);
  const event = (event: unknown) => codec.decodeServerFrame(new TextEncoder().encode(JSON.stringify({
    type: "event", topic: "s1", payload: { seq: 1, event },
  })));
  const converted = event({ type: "permissionRequested", request: {
    id: "p1", title: "Confirm", detail: "Old description", options: [],
  } });
  expect(converted).toMatchObject({ payload: { event: { request: {
    id: "p1", summary: "Confirm", description: "Old description",
  } } } });
  expect(JSON.stringify(converted)).not.toContain('"detail"');
  expect(() => event({ type: "permissionResolved", requestId: "p1", outcome: {
    outcome: "timedOut", appliedDefault: "allow",
  } })).toThrow("自动超时决策");
  const data = { type: "item", turnId: "t1", item: { type: "toolCall", detail: {
    kind: "custom", payload: { outcome: "timedOut", detail: "user-owned data" },
  } } };
  expect(event(data)).toMatchObject({ payload: { event: data } });
});

it("v3 restores its inert send field but refuses the new window setting", () => {
  const codec = protocolCodec(3);
  expect(JSON.parse(text.decode(codec.encodeRequest({ type: "session.send", payload: {
    sessionId: "s1", text: "hello", attachments: [], continuesRound: null,
  } })))).toMatchObject({ payload: { artifactPreviewBaseUrl: null } });
  expect(() => codec.encodeRequest({ type: "settings.setProvider", payload: {
    providerId: "test", apiKey: null, baseUrl: null, label: null, dialect: null, models: null,
    modelContextWindows: { test: 524288 },
  } })).toThrow("不支持模型窗口");
});
