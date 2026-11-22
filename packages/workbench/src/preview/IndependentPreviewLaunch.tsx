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

export function IndependentPreviewLaunch({ source, client, host, staticOnly = false, review = false, feedbackScope = "owner" }: {
  source: AssetPreviewLocation;
  client: Client | null;
  host?: Host;
  staticOnly?: boolean;
  review?: boolean;
  feedbackScope?: string;
}) {
  const [grant, setGrant] = useState<StaticPreviewGrant>();
  const [reviewClient, setReviewClient] = useState<Client>();
  const [reviewService, setReviewService] = useState<ServicePreviewClient>();
  const [problem, setProblem] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const { deviceHandle, path, workspaceHandle } = source;
  const serviceWorkspace = isAbsoluteFilePath(path) ? "" : workspaceHandle;
  const compatibility = assetPreviewUrl(deviceHandle, workspaceHandle, path, undefined, undefined, source);
  useEffect(() => {
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

      if (feedbackScope === "owner" && !staticOnly && connection.identity.features?.includes(INDEPENDENT_SERVICE_FEATURE)) {
        // The device independently authorizes discovery and the scoped run
        // binding. Static pages also open when the registered process is offline.
        enabledService = await ServicePreviewClient.discover(connection, serviceWorkspace, path).catch(() => null);
        signal.throwIfAborted();
      }
      const descriptor = enabledService?.descriptor;
      const htmlMedia = descriptor && htmlServiceMedia(descriptor);
      const player = htmlMedia?.protocol === "pixel-streaming/1";
      // HTML desktop control and source-only data transports use the original
      // sandbox bridge. Trusted audio/video needs the shell around the iframe.
      if (descriptor && (htmlMedia?.protocol === "remote-desktop/1"
        || (descriptor.dataPolicy === "direct-only" && (player || !descriptor.media)))) {
        window.location.replace(compatibility);
        return;
      }
      if (!review && descriptor?.media && !player
        && connection.identity.features?.includes(INDEPENDENT_REVIEW_FEATURE)) {
        const url = new URL(window.location.href);
        url.searchParams.set("review", "1");
        window.location.replace(url.href);
        return;
      }
      const serviceRunId = descriptor?.runId;
      const reply = await connection.call({
        type: "preview.feedback",
        payload: {
          workspaceId: serviceWorkspace,
          operation: {
            kind: "openStatic", path,
            ...(serviceRunId ? { serviceRunId } : {}),
            ...(player ? { playerAllowTurn: true } : {}),
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
  }, [client, compatibility, deviceHandle, feedbackScope, host, path, review, serviceWorkspace, staticOnly]);

  useEffect(() => { if (grant && !review) form.current?.submit(); }, [grant, review]);
  if (grant && review && reviewClient) {
    const player = reviewService && htmlServiceMedia(reviewService.descriptor)?.protocol === "pixel-streaming/1";
    const stopUrl = player ? new URL(window.location.href) : undefined;
    stopUrl?.searchParams.set("service", "0");
    return <IndependentPreviewReview key={grant.action} client={reviewClient} source={source} grant={grant}
      feedbackScope={feedbackScope} serviceName={reviewService?.descriptor.name} stopPlayerUrl={stopUrl?.href}
      media={reviewService?.descriptor.media && !player ? reviewService : undefined} />;
  }
  const fallbackUrl = new URL(compatibility);
  if (feedbackScope !== "owner") fallbackUrl.hash = location.hash;
  return (
    <main className="m-auto max-w-sm p-6 text-center text-sm">
      <meta name="referrer" content="strict-origin" />
      <p role={problem ? "alert" : "status"}>{problem || "正在打开独立预览…"}</p>
      {problem ? <a className="mt-3 inline-block text-accent underline"
        href={fallbackUrl.href}>使用兼容预览打开</a> : null}
      {grant ? (
        <form ref={form} method="post" action={grant.action}>
          <input type="hidden" name="code" value={grant.code} />
        </form>
      ) : null}
    </main>
  );
}
