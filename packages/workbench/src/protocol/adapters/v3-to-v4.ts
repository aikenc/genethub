import type { AdjacentProtocolAdapter } from "../codec";
import type { V3Reply, V3Request, V3ServerFrame } from "../versions/v3";
import type { V4Request } from "../versions/v4";

/** Translate only protocol-owned fields; never traverse tool/user JSON data. */
function card(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const { detail, ...current } = value as Record<string, unknown>;
  return { ...current, summary: current.summary ?? current.title,
    description: current.description ?? detail };
}
function event(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const frame = value as Record<string, unknown>;
  if (frame.type === "permissionRequested") return { ...frame, request: card(frame.request) };
  if (frame.type === "permissionResolved" && (frame.outcome as { outcome?: string })?.outcome === "timedOut") {
    throw new Error("此旧端包含已退役的自动超时决策，请升级 daemon。");
  }
  return value;
}
function sequenced(value: unknown): unknown {
  const frame = value as Record<string, unknown>;
  return { ...frame, event: event(frame.event) };
}
function snapshot(value: unknown): unknown {
  const frame = value as Record<string, unknown>;
  return { ...frame, pendingPermissions: (frame.pendingPermissions as unknown[]).map(card) };
}
function workspace(value: unknown): unknown {
  const { pipeSpace: _retired, ...current } = value as Record<string, unknown>;
  return current;
}
function reply(value: V3Reply): unknown {
  if (value.type === "workspace") return { ...value, data: workspace(value.data) };
  if (value.type === "workspaces") return { ...value, data: value.data.map(workspace) };
  if (value.type === "snapshot") return { ...value, data: snapshot(value.data) };
  if (value.type === "subscribed") return { ...value, data: { ...value.data,
    snapshot: snapshot(value.data.snapshot), replayed: value.data.replayed.map(sequenced) } };
  return value;
}
function server(value: V3ServerFrame): unknown {
  if (value.type === "event") return { ...value, payload: sequenced(value.payload) };
  return value;
}

export const v3ToV4: AdjacentProtocolAdapter = {
  from: 3, to: 4,
  downgradeRequest(value) {
    const request = value as V4Request;
    if (request.type === "settings.setProvider") {
      const { modelContextWindows, ...payload } = request.payload;
      if (modelContextWindows && Object.keys(modelContextWindows).length) {
        throw new Error("此 daemon 不支持模型窗口配置，请升级后保存。");
      }
      return { ...request, payload } satisfies V3Request;
    }
    if (request.type === "subscribe") {
      // v3 has no stream incarnation. Request a fresh snapshot on every attach.
      const { sinceEpoch: _epoch, ...payload } = request.payload;
      return { ...request, payload: { ...payload, sinceSeq: 0 } } satisfies V3Request;
    }
    if (request.type === "session.send") {
      return { ...request, payload: { ...request.payload, artifactPreviewBaseUrl: null } } satisfies V3Request;
    }
    return request;
  },
  upgradeReply(value) { return reply(value as V3Reply); },
  upgradeServerFrame(value) { return server(value as V3ServerFrame); },
};
