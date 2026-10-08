import type { CallerAuthority, PermissionRequest, ProviderOperationReceipt } from "@genehub/proto";
import { useEffect, useRef, useState } from "react";
import { useWorkbench } from "../session/store";

/** The secret belongs to this component until submitted directly to daemon. */
export function ProviderConfigurationCard({ request, sessionId }: { request: PermissionRequest; sessionId: string }) {
  const client = useWorkbench(state => state.client);
  const submit = useWorkbench(state => state.submitProviderConfiguration);
  const [operation, setOperation] = useState<ProviderOperationReceipt | null>(null);
  const [authority, setAuthority] = useState<CallerAuthority | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const actionId = request.id.slice("provider-".length);
  useEffect(() => {
    let disposed = false;
    setKey(""); setOperation(null); setAuthority(null); setError(null);
    if (client) void Promise.all([
      client.call({ type: "provider.operation", payload: { sessionId, operation: { type: "get", actionId } } }),
      client.call({ type: "caller.authority" }),
    ])
      .then(([reply, access]) => {
        if (disposed) return;
        if (reply?.type === "providerOperation") setOperation(reply.data);
        if (access?.type === "callerAuthority") setAuthority(access.data);
      })
      .catch(() => { if (!disposed) setError("无法读取配置请求，请重新连接后再试。"); });
    return () => { disposed = true; };
  }, [client, sessionId, actionId]);
  const answer = async (approved: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    const credential = key || undefined;
    setKey("");
    try {
      if (!approved && operation && ["unknown", "applying", "saved"].includes(operation.state)) {
        await client?.call({ type: "session.respondPermission", payload: { sessionId, requestId: request.id, outcome: { outcome: "canceled" } } });
        return;
      }
      const receipt = await submit(sessionId, actionId, approved, approved ? credential : undefined);
      if (receipt) setOperation(receipt);
      else setError("未完成提交。请查看上方错误；需要时重新输入密钥。");
    } catch { setError("未完成操作，请重新连接并检查原配置回执。"); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const canSubmit = authority?.grants.includes("settings") === true;
  return <section className="rounded-xl border border-accent/60 bg-raised px-4 py-4" aria-label="模型服务配置确认">
    <h2 className="text-base font-semibold">{request.title}</h2>
    <p className="mt-1 text-sm text-muted">确认后保存到当前连接的机器，并验证模型调用；原会话会自动继续。</p>
    <p className="mt-3 whitespace-pre-wrap break-words text-sm">{request.detail}</p>
    <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); void answer(true); }}>
      <label className="block text-sm">API Key
        <input type="password" aria-label="Provider API Key" autoComplete="off" spellCheck={false}
          value={key} onChange={event => setKey(event.target.value)} disabled={busy || !canSubmit} maxLength={16384}
          placeholder={operation?.keyRequired ? "请输入密钥" : "留空沿用已保存的密钥"}
          className="mt-1 block w-full rounded border border-line bg-surface px-3 py-2" />
      </label>
      <p className="text-xs text-muted">密钥直接交给机器保存，不发送给 Agent，也不写入对话记录。</p>
      {authority && !canSubmit && <p role="status" className="text-sm text-muted">当前设备没有提交模型配置的权限，请在已有配置权限的设备上处理。</p>}
      {operation?.state === "unknown" && <p role="alert" className="text-sm text-muted">保存结果不确定，请核查机器配置；本请求不会重复执行。</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={busy || !canSubmit || !operation || operation.state !== "pending" || (operation.keyRequired && !key)}
          className="min-h-11 rounded-lg bg-accent px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? "正在保存并验证…" : "保存并验证"}</button>
        <button type="button" disabled={busy || !canSubmit || !operation} onClick={() => void answer(false)}
          className="min-h-11 rounded-lg border border-line-strong px-4 py-2 text-sm">取消配置</button>
      </div>
    </form>
  </section>;
}
