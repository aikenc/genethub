import { useEffect, useRef, useState } from "react";

import type { StaticPreviewGrant } from "@genehub/proto";
import { browserHost, type Host } from "../host";
import type { Client } from "../protocol/client";
import { connectPreview, endpointForDevice } from "./AssetPreviewPage";
import { isAbsoluteFilePath, type AssetPreviewLocation } from "./url";
import { INDEPENDENT_SERVICE_FEATURE } from "./IndependentPreviewMenu";
import { ServicePreviewClient } from "./serviceClient";

const feature = "asset.preview.independent.v1";

export function validateStaticPreviewGrant(grant: StaticPreviewGrant): StaticPreviewGrant {
  const action = new URL(grant.action);
  if (action.protocol !== "https:" || action.username || action.password || action.search || action.hash
    || !/^[a-f0-9]{32}\.[a-z0-9.-]+$/.test(action.hostname)
    || action.pathname !== "/.well-known/genehub/preview-bootstrap"
    || !/^[a-f0-9]{64}$/.test(grant.code)) {
    throw new Error("设备返回了无效的独立预览凭证");
  }
  return { action: action.href, code: grant.code };
}

function waitForIdentity(client: Client, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (client.connectionState === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    function stop() {
      unsubscribe();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    function abort() {
      stop();
      reject(signal.reason);
    }
    const unsubscribe = client.onStateChange(state => {
      if (state === "ready" || state === "closed") {
        stop();
        if (state === "ready") resolve();
        else reject(new Error(client.failure?.message ?? "目标设备拒绝连接"));
      }
    });
    const timer = setTimeout(() => {
      stop();
      reject(new Error("连接目标设备超时"));
    }, 15_000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function IndependentPreviewLaunch({ source, client, host, withService = false }: {
  source: AssetPreviewLocation;
  client: Client | null;
  host?: Host;
  withService?: boolean;
}) {
  const [grant, setGrant] = useState<StaticPreviewGrant>();
  const [problem, setProblem] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  const { deviceHandle, path, workspaceHandle } = source;
  useEffect(() => {
    if (withService && !confirmed) return;
    const cancellation = new AbortController();
    const signal = cancellation.signal;
    const deadline = setTimeout(() => cancellation.abort(new Error("开启独立预览超时")), 40_000);
    let owned: Client | undefined;
    let active = true;
    void (async () => {
      const currentHost = host ?? browserHost();
      if (!client) {
        const endpoint = await endpointForDevice(currentHost, deviceHandle);
        signal.throwIfAborted();
        if (!endpoint) throw new Error("请使用已经获准连接目标设备的浏览器打开");
        owned = connectPreview(endpoint, currentHost, deviceHandle);
      }
      const connection = client ?? owned!;
      await waitForIdentity(connection, signal);
      if (connection.identity?.machineId !== deviceHandle) {
        throw new Error("链接指向的设备与当前连接不一致");
      }
      if (!connection.identity.features?.includes(feature)) {
        throw new Error("目标设备未启用独立预览");
      }
      let serviceRunId: string | undefined;
      if (withService) {
        if (!connection.identity.features?.includes(INDEPENDENT_SERVICE_FEATURE)) {
          throw new Error("目标设备未启用独立服务预览");
        }
        const service = await ServicePreviewClient.discover(connection, workspaceHandle, path);
        signal.throwIfAborted();
        if (!service) throw new Error("这个入口没有已登记的服务");
        serviceRunId = service.descriptor.runId;
      }
      const reply = await connection.call({
        type: "preview.feedback",
        payload: {
          workspaceId: isAbsoluteFilePath(path) ? "" : workspaceHandle,
          operation: { kind: "openStatic", path, ...(serviceRunId ? { serviceRunId } : {}) },
        },
      }, { timeoutMs: 30_000 });
      signal.throwIfAborted();
      if (reply?.type !== "previewFeedback" || reply.data.kind !== "staticPreview") {
        throw new Error("设备未签发独立预览凭证");
      }
      if (active) setGrant(validateStaticPreviewGrant(reply.data.data));
    })().catch(error => {
      if (active) setProblem(error instanceof Error ? error.message : "无法打开独立预览");
    }).finally(() => {
      clearTimeout(deadline);
      owned?.close();
    });
    return () => {
      active = false;
      clearTimeout(deadline);
      cancellation.abort();
      owned?.close();
    };
  }, [client, confirmed, deviceHandle, host, path, withService, workspaceHandle]);

  useEffect(() => { if (grant) form.current?.submit(); }, [grant]);
  return (
    <main className="m-auto max-w-sm p-6 text-center text-sm">
      <meta name="referrer" content="strict-origin" />
      {withService && !confirmed ? (
        <>
          <p>允许这个页面访问源机器上为它登记的本地服务？</p>
          <button type="button" className="mt-3 rounded border border-line px-3 py-2" onClick={() => setConfirmed(true)}>
            启用服务并打开预览
          </button>
        </>
      ) : <p role={problem ? "alert" : "status"}>{problem || "正在打开独立预览…"}</p>}
      {grant ? (
        <form ref={form} method="post" action={grant.action}>
          <input type="hidden" name="code" value={grant.code} />
        </form>
      ) : null}
    </main>
  );
}
