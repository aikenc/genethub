import { useEffect, useRef, useState } from "react";

import type { StaticPreviewGrant } from "@genehub/proto";
import { browserHost, type Host } from "../host";
import type { Client } from "../protocol/client";
import { connectPreview, endpointForDevice } from "./AssetPreviewPage";
import { assetPreviewUrl, isAbsoluteFilePath, type AssetPreviewLocation } from "./url";
import { INDEPENDENT_REVIEW_FEATURE, INDEPENDENT_SERVICE_FEATURE } from "./IndependentPreviewMenu";
import { IndependentPreviewReview } from "./IndependentPreviewReview";
import { htmlServiceMedia, ServicePreviewClient } from "./serviceClient";

const feature = "asset.preview.independent.v1";

export function validateStaticPreviewGrant(grant: StaticPreviewGrant): StaticPreviewGrant {
  const action = new URL(grant.action);
  if (action.protocol !== "https:" || action.username || action.password || action.search || action.hash
    || !/^[a-f0-9]{32}\.[a-z0-9.-]+$/.test(action.hostname)
    || action.pathname !== "/.well-known/genehub/preview-bootstrap"
    || !/^[a-f0-9]{64}$/.test(grant.code)) {
    throw new Error("设备返回了无效的独立预览凭证");
  }
  const storageScope = typeof grant.storageScope === "string" && /^[a-f0-9]{64}$/.test(grant.storageScope) ? grant.storageScope : undefined;
  return { action: action.href, code: grant.code, ...(storageScope ? { storageScope } : {}) };
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

export function IndependentPreviewLaunch({ source, client, host, withService = false, review = false, feedbackScope = "owner" }: {
  source: AssetPreviewLocation;
  client: Client | null;
  host?: Host;
  withService?: boolean;
  review?: boolean;
  feedbackScope?: string;
}) {
  const [grant, setGrant] = useState<StaticPreviewGrant>();
  const [reviewClient, setReviewClient] = useState<Client>();
  const [reviewService, setReviewService] = useState<ServicePreviewClient>();
  const [problem, setProblem] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [allowTurn, setAllowTurn] = useState(false);
  const { deviceHandle, path, workspaceHandle } = source;
  useEffect(() => {
    if (withService && !confirmed) return;
    const cancellation = new AbortController();
    const signal = cancellation.signal;
    const deadline = setTimeout(() => cancellation.abort(new Error("开启独立预览超时")), 40_000);
    let owned: Client | undefined;
    let active = true;
    let retainClient = false;
    let enabledService: ServicePreviewClient | null = null;
    void (async () => {
      if (review && !globalThis.crossOriginIsolated) {
        throw new Error("当前浏览器或入口未启用独立评审所需的跨源隔离");
      }
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
      if (review && !connection.identity.features?.includes(INDEPENDENT_REVIEW_FEATURE)) {
        throw new Error("目标设备未启用独立评审");
      }

      if (withService) {
        if (!connection.identity.features?.includes(INDEPENDENT_SERVICE_FEATURE)) {
          throw new Error("目标设备未启用独立服务预览");
        }
        enabledService = await ServicePreviewClient.discover(connection, workspaceHandle, path);
        signal.throwIfAborted();
        if (!enabledService) throw new Error("这个入口没有已登记的服务");
      }
      const serviceRunId = enabledService?.descriptor.runId;
      const player = enabledService && htmlServiceMedia(enabledService.descriptor)?.protocol === "pixel-streaming/1";
      const reply = await connection.call({
        type: "preview.feedback",
        payload: {
          workspaceId: isAbsoluteFilePath(path) ? "" : workspaceHandle,
          operation: {
            kind: "openStatic", path,
            ...(serviceRunId ? { serviceRunId } : {}),
            ...(player ? { playerAllowTurn: allowTurn } : {}),
            ...(review ? { review } : {}),
          },
        },
      }, { timeoutMs: 30_000 });
      signal.throwIfAborted();
      if (reply?.type !== "previewFeedback" || reply.data.kind !== "staticPreview") {
        throw new Error("设备未签发独立预览凭证");
      }
      if (active) {
        const validated = validateStaticPreviewGrant(reply.data.data);
        if (review) {
          retainClient = true;
          setReviewClient(connection);
          setReviewService(enabledService ?? undefined);
        }
        setGrant(validated);
      }
    })().catch(error => {
      if (active) setProblem(error instanceof Error ? error.message : "无法打开独立预览");
    }).finally(() => {
      clearTimeout(deadline);
      if (!retainClient) {
        enabledService?.close();
        owned?.close();
      }
    });
    return () => {
      active = false;
      clearTimeout(deadline);
      cancellation.abort();
      enabledService?.close();
      owned?.close();
    };
  }, [allowTurn, client, confirmed, deviceHandle, host, path, review, withService, workspaceHandle]);

  useEffect(() => { if (grant && !review) form.current?.submit(); }, [grant, review]);
  if (grant && review && reviewClient) {
    const mayEnableService = feedbackScope === "owner" && !withService
      && reviewClient.identity?.features?.includes(INDEPENDENT_SERVICE_FEATURE);
    const serviceUrl = mayEnableService ? new URL(window.location.href) : undefined;
    serviceUrl?.searchParams.set("service", "1");
    const player = reviewService && htmlServiceMedia(reviewService.descriptor)?.protocol === "pixel-streaming/1";
    const stopUrl = player ? new URL(window.location.href) : undefined;
    stopUrl?.searchParams.delete("service");
    return <IndependentPreviewReview key={grant.action} client={reviewClient} source={source} grant={grant}
      feedbackScope={feedbackScope} serviceUrl={serviceUrl?.href} stopPlayerUrl={stopUrl?.href}
      media={reviewService?.descriptor.media && !player ? reviewService : undefined} />;
  }
  const compatibility = new URL(assetPreviewUrl(source.deviceHandle, source.workspaceHandle, source.path, undefined, undefined, source));
  if (feedbackScope !== "owner") compatibility.hash = location.hash;
  return (
    <main className="m-auto max-w-sm p-6 text-center text-sm">
      <meta name="referrer" content="strict-origin" />
      {withService && !confirmed ? (
        <>
          <p>允许这个页面访问源机器上为它登记的本地服务？</p>
          <label className="mt-3 flex items-center justify-center gap-2">
            <input type="checkbox" checked={allowTurn} onChange={event => setAllowTurn(event.target.checked)} />
            允许引擎串流使用媒体中继
          </label>
          <button type="button" className="mt-3 rounded border border-line px-3 py-2" onClick={() => setConfirmed(true)}>
            启用服务并打开预览
          </button>
        </>
      ) : <p role={problem ? "alert" : "status"}>{problem || "正在打开独立预览…"}</p>}
      {problem ? <a className="mt-3 inline-block text-accent underline"
        href={compatibility.href}>使用兼容预览打开</a> : null}
      {grant ? (
        <form ref={form} method="post" action={grant.action}>
          <input type="hidden" name="code" value={grant.code} />
        </form>
      ) : null}
    </main>
  );
}
