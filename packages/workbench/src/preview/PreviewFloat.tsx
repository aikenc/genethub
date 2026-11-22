import { feedbackReceiptText } from "./fileFeedback";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { previewIconButton } from "./PreviewToolbar";
import { CornerUpLeft } from "lucide-react";
import { PreviewShareButton } from "./PreviewShareButton";
import type { Host } from "../host";
import { MachineConnectionsContext } from "../protocol/machine-connection-context";
import type { MachineLease } from "../protocol/machine-connections";
import type { Client } from "../protocol/client";
import { useWorkbench, type PreviewFloatTarget } from "../session/store";
import { isIosStandalonePwa } from "../shell/platform";
import {
  AssetPreviewPage,
  type PreviewMeta,
} from "./AssetPreviewPage";
import {
  createPortablePreviewUrl,
  createPreviewPopoutChannel,
  createPreviewPopoutUrl,
  registerPreviewPopoutClient,
} from "./popout";
import type { RuntimeArtifactSubmit } from "./PreviewRuntimeControls";
import { runtimeArtifactDraftLine, uploadSessionArtifact } from "./sessionArtifactUpload";
import { assetPreviewUrl, independentPreviewUrl } from "./url";
import { ServicePreviewClient } from "./serviceClient";

export function PreviewFloat({
  source,
  host,
  onClose,
}: {
  source: PreviewFloatTarget;
  host: Host;
  onClose(): void;
}) {
  const primaryClient = useWorkbench((state) => state.client);
  const connections = useContext(MachineConnectionsContext);
  const [borrowedClient, setBorrowedClient] = useState<Client | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const sameSource = primaryClient?.identity?.machineId === source.deviceHandle;
  const client = sameSource ? primaryClient : borrowedClient;
  useEffect(() => {
    setBorrowedClient(null); setConnectionError("");
    if (sameSource || !connections) return;
    const controller = new AbortController();
    let lease: MachineLease | undefined;
    void connections.targets().then(targets => {
      const target = targets.find(target => target.deviceHandle === source.deviceHandle || target.id === source.deviceHandle);
      if (!target) throw new Error("资源所在机器未授权或已移除");
      return connections.acquire(target, { signal: controller.signal, foreground: true });
    }).then(opened => {
      if (controller.signal.aborted) { opened.release(); return; }
      lease = opened; setBorrowedClient(opened.client);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setConnectionError(error instanceof Error ? error.message : String(error));
    });
    return () => { controller.abort(); lease?.release(); };
  }, [connections, sameSource, source.deviceHandle]);
  // An isolated document must be the top-level main-domain page for
  // threaded WASM. Enable this navigation in the configured Dev pilot.
  const prefersIndependent = import.meta.env.VITE_GENEHUB_DEV_NAME === "dev-preview"
    && location.protocol === "https:"
    && /\.html?$/i.test(source.path)
    && !new URLSearchParams(location.search).has("previewCompatibility")
    && !source.docQuery && !source.docFragment
    && (!source.siteEntryPath || source.siteEntryPath === source.path)
    && !!client?.identity?.features?.includes("asset.preview.independent.storage.v1");
  const [stayEmbedded, setStayEmbedded] = useState(false);
  useEffect(() => {
    setStayEmbedded(false);
    if (!prefersIndependent || !client) return;
    let active = true;
    const probe = async () => {
      // Keep the established service/stream discovery UI when this file
      // has an active registration.
      const service = await ServicePreviewClient.discover(client, source.workspaceHandle, source.path);
      if (service) {
        service.close();
        if (active) setStayEmbedded(true);
        return;
      }
      if (!active) return;
      const url = new URL(independentPreviewUrl(source));
      url.searchParams.set("review", "1");
      const conversation = new URL(location.href);
      conversation.searchParams.delete("preview");
      url.searchParams.set("workbenchReturn", conversation.pathname + conversation.search);
      // Workbench URL sync may already have pushed the file locator. Remove
      // it from the back entry so browser Back returns to the conversation.
      history.replaceState(history.state, "", conversation.href);
      location.assign(url.href);
    };
    void probe().catch(() => { if (active) setStayEmbedded(true); });
    return () => { active = false; };
  }, [client, prefersIndependent, source]);
  const appendComposerDraftLine = useWorkbench((state) => state.appendComposerDraftLine);
  const [meta, setMeta] = useState<PreviewMeta | null>(null);
  const [popupBlocked, setPopupBlocked] = useState<string>();
  const popouts = useRef(new Map<string, string | null>());
  const popoutBridges = useRef(new Map<string, () => void>());
  const linkedBundles = useRef(new Set<string>());
  // iOS home-screen web apps cannot open a real browser window; there the
  // external-open button mints a one-time ticket link and copies it instead.
  const copyLinkMode = useMemo(() => isIosStandalonePwa(), []);
  const [copyState, setCopyState] = useState<"idle" | "minting" | "copied" | "failed">(
    "idle",
  );
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const externalSource = meta?.location ? {...source, ...meta.location} : source;
  const externalUrl = assetPreviewUrl(externalSource.deviceHandle, externalSource.workspaceHandle, externalSource.path, undefined, undefined, externalSource);
  useEffect(() => {
    return () => {
      for (const release of popoutBridges.current.values()) release();
      popoutBridges.current.clear();
    };
  }, []);

  useEffect(() => {
    const channel = createPreviewPopoutChannel((message) => {
      const expectedSessionId = popouts.current.get(message.id);
      if (expectedSessionId === undefined || expectedSessionId !== message.sessionId) return;
      if (message.type === "ready") {
        popoutBridges.current.get(message.id)?.();
        popoutBridges.current.delete(message.id);
        return;
      }
      const bundleKey = `${message.sessionId}:${message.workspacePath}`;
      if (linkedBundles.current.has(bundleKey)) return;
      linkedBundles.current.add(bundleKey);
      appendComposerDraftLine(
        message.sessionId,
        runtimeArtifactDraftLine(message.workspacePath),
      );
    });
    return () => channel.close();
  }, [appendComposerDraftLine]);

  const submitRuntimeArtifact = useCallback<RuntimeArtifactSubmit>(
    async (artifact, onProgress) => {
      if (!client || !sameSource || !source.sessionId) {
        throw new Error("尚未连接到可保存运行产物的会话");
      }
      const sessionId = source.sessionId;
      const bundle = await uploadSessionArtifact(
        client,
        sessionId,
        artifact,
        ({ uploadedBytes, totalBytes }) => onProgress(uploadedBytes, totalBytes),
      );

      // This action closes over its source store, even if the visible machine
      // changes while the upload is finishing.
      appendComposerDraftLine(
        sessionId,
        runtimeArtifactDraftLine(bundle.workspacePath),
      );
      return {
        relativePath: bundle.relativePath,
        addedToDraft: true,
      };
    },
    [client, sameSource, appendComposerDraftLine, source.sessionId],
  );

  const copyPortableLink = useCallback(async () => {
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    if (!client) {
      setCopyState("failed");
      return;
    }
    setCopyState("minting");
    try {
      const url = await mintPortablePreviewUrl(client, externalUrl, source.sessionId);
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    copyResetTimer.current = setTimeout(() => {
      copyResetTimer.current = null;
      setCopyState("idle");
    }, 4_000);
  }, [client, externalUrl, source.sessionId]);

  const externalOpen = copyLinkMode && client?.identity?.features?.includes("preview.feedback.v1") ? <PreviewShareButton client={client} source={externalSource} resources={meta?.resourcePaths} quick label="在浏览器打开预览" /> : <button
                type="button"
                aria-label={copyLinkMode ? "复制预览链接" : "新窗口打开"}
                title={
                  copyLinkMode
                    ? "复制预览链接，粘贴到浏览器打开"
                    : "新窗口打开"
                }
                className={`${previewIconButton} text-accent`}
                disabled={copyLinkMode && copyState === "minting"}
                onClick={() => {
                  if (copyLinkMode) {
                    void copyPortableLink();
                    return;
                  }
                  const popout = createPreviewPopoutUrl(externalUrl, source.sessionId);
                  popouts.current.set(popout.id, source.sessionId);
                  if (client) {
                    const release = registerPreviewPopoutClient(
                      { id: popout.id, sessionId: source.sessionId },
                      externalSource,
                      client,
                    );
                    const timer = window.setTimeout(release, 60_000);
                    popoutBridges.current.set(popout.id, () => {
                      window.clearTimeout(timer);
                      release();
                    });
                  }
                  window.dispatchEvent(
                    new CustomEvent("genehub:preview-open", {
                      detail: { path: source.path, url: popout.url },
                    }),
                  );
                  // Keep window.open in the user gesture so popup blockers allow it.
                  // Opening externally leaves this preview expanded.
                  try {
                    // A named same-origin window keeps `opener` just long enough
                    // for the trusted shell to take the shared Client. `_blank`
                    // is implicitly noopener in some mobile browsers.
                    const opened = window.open(popout.url, `genehub-preview-${popout.id}`);
                    if (!opened) throw new Error("浏览器阻止了新窗口");
                  } catch {
                    popouts.current.delete(popout.id);
                    popoutBridges.current.get(popout.id)?.();
                    popoutBridges.current.delete(popout.id);
                    setPopupBlocked(externalUrl);
                  }
                }}
              >
                {copyLinkMode ? <LinkIcon /> : <ExternalLinkIcon />}
              </button>;

  if (prefersIndependent && !stayEmbedded) return <div role="status" className="safe-area-page fixed inset-0 z-40 flex items-center justify-center bg-bg p-6 text-fg">
    <div className="space-y-2 text-center text-sm">
      <p>正在打开独立预览…</p>
      <button type="button" className="underline" onClick={onClose}>返回对话</button>
    </div>
  </div>;

  return <div role="dialog" aria-modal="true" aria-label="文件预览"
    className="safe-area-page fixed inset-0 z-40 flex flex-col bg-bg text-fg"
    onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) onClose(); }}>
    {popupBlocked ? <p role="status" className="px-2 py-1 text-xs">
      浏览器阻止了新窗口。 <a className="underline" href={popupBlocked} target="_blank" rel="noopener">打开预览链接</a>
    </p> : null}
    {connectionError ? <p role="alert" className="px-2 py-1 text-xs text-danger">{connectionError}</p> : null}
    <AssetPreviewPage
      source={source}
      host={host}
      client={client}
      onMetaChange={setMeta}
      onRuntimeArtifact={submitRuntimeArtifact}
      runtimeSessionId={source.sessionId}
      onAddFeedbackToChat={sameSource && source.sessionId
        ? receipt => appendComposerDraftLine(source.sessionId!, feedbackReceiptText(receipt))
        : undefined}
      annotationWrite
      navigation={<>
        <button type="button" aria-label="返回对话" title="返回对话" className={previewIconButton} onClick={onClose}><CornerUpLeft size={16} /></button>
        {externalOpen}
      </>}
    />
  </div>;
}

async function mintPortablePreviewUrl(
  client: Client,
  externalUrl: string,
  sessionId: string | null,
): Promise<string> {
  const status = await client.call({ type: "hub.status" });
  if (status?.type !== "hubStatus" || status.data.state !== "paired") {
    throw new Error("设备尚未加入账号，生成不了预览链接");
  }
  const ticket = await client.call({
    type: "hub.connect",
    payload: { machineId: status.data.machineId },
  });
  if (ticket?.type !== "hubTicket") throw new Error("设备暂时无法生成预览链接");
  return createPortablePreviewUrl(
    externalUrl,
    {
      url: ticket.data.url,
      fabricRouteTicket: ticket.data.fabricRouteTicket,
      channelCapability: ticket.data.channelCapability,
      channelSecret: ticket.data.channelSecret,
    },
    sessionId,
  );
}

function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M6 8 8 6M5 9.5 3.75 10.75a1.77 1.77 0 0 1-2.5-2.5l2-2A1.77 1.77 0 0 1 5.75 5.5M9 4.5l1.25-1.25a1.77 1.77 0 0 1 2.5 2.5l-2 2A1.77 1.77 0 0 1 8.25 8.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExternalLinkIcon() {  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M5.5 3.5H3.75A1.25 1.25 0 0 0 2.5 4.75v5.5A1.25 1.25 0 0 0 3.75 11.5h5.5A1.25 1.25 0 0 0 10.5 10.25V8.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <path
        d="M7.5 2.5H11.5V6.5M11.2 2.8 6.5 7.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
