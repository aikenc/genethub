import { useCallback, useEffect, useMemo, useRef } from "react";

import type { SessionArtifactBundle } from "@genehub/proto";

import type { Host } from "../host";
import { AssetPreviewPage } from "./AssetPreviewPage";
import {
  createPreviewPopoutChannel,
  previewPopoutArtifact,
  previewPopoutReady,
  takePreviewPopoutBridge,
  type PreviewPopoutContext,
} from "./popout";
import type { AssetPreviewLocation } from "./url";

export function PreviewPopoutPage({
  source,
  context,
  host,
}: {
  source: AssetPreviewLocation;
  context: PreviewPopoutContext | null;
  host?: Host;
}) {
  const channelRef = useRef<ReturnType<typeof createPreviewPopoutChannel> | null>(null);
  const inherited = useMemo(
    () => (context ? takePreviewPopoutBridge(context, source) : null),
    [context, source.deviceHandle, source.path, source.workspaceHandle],
  );
  const effectiveContext = inherited?.context ?? context;
  const sharedClient = inherited?.client ?? null;

  useEffect(() => {
    if (!effectiveContext) return;
    const channel = createPreviewPopoutChannel(() => {});
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      channel.close();
    };
  }, [effectiveContext]);

  const reportReady = useCallback(() => {
    if (!effectiveContext) return;
    channelRef.current?.post(previewPopoutReady(effectiveContext));
  }, [effectiveContext]);

  const reportSaved = useCallback(
    (bundle: SessionArtifactBundle) => {
      if (!effectiveContext?.sessionId) return;
      channelRef.current?.post(
        previewPopoutArtifact(
          { id: effectiveContext.id, sessionId: effectiveContext.sessionId },
          bundle.workspacePath,
        ),
      );
    },
    [effectiveContext],
  );

  return (
    <AssetPreviewPage
      source={source}
      host={host}
      client={sharedClient}
      runtimeSessionId={effectiveContext?.sessionId ?? null}
      onRuntimeArtifactSaved={effectiveContext?.sessionId ? reportSaved : undefined}
      onRuntimeReady={effectiveContext ? reportReady : undefined}
    />
  );
}
