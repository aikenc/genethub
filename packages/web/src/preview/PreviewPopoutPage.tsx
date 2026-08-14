import { useCallback, useEffect, useMemo, useRef } from "react";

import type { SessionArtifactBundle } from "@genehub/proto";

import { AssetPreviewPage } from "./AssetPreviewPage";
import {
  createPreviewPopoutChannel,
  previewPopoutArtifact,
  previewPopoutReady,
  takePreviewPopoutClient,
  type PreviewPopoutContext,
} from "./popout";
import type { AssetPreviewLocation } from "./url";

export function PreviewPopoutPage({
  source,
  context,
}: {
  source: AssetPreviewLocation;
  context: PreviewPopoutContext | null;
}) {
  const channelRef = useRef<ReturnType<typeof createPreviewPopoutChannel> | null>(null);
  const sharedClient = useMemo(
    () => (context ? takePreviewPopoutClient(context, source) : null),
    [context, source.deviceHandle, source.path, source.workspaceHandle],
  );

  useEffect(() => {
    if (!context) return;
    const channel = createPreviewPopoutChannel(() => {});
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      channel.close();
    };
  }, [context]);

  const reportReady = useCallback(() => {
    if (!context) return;
    channelRef.current?.post(previewPopoutReady(context));
  }, [context]);

  const reportSaved = useCallback(
    (bundle: SessionArtifactBundle) => {
      if (!context?.sessionId) return;
      channelRef.current?.post(
        previewPopoutArtifact(
          { id: context.id, sessionId: context.sessionId },
          bundle.workspacePath,
        ),
      );
    },
    [context],
  );

  return (
    <AssetPreviewPage
      source={source}
      client={sharedClient}
      runtimeSessionId={context?.sessionId ?? null}
      onRuntimeArtifactSaved={context?.sessionId ? reportSaved : undefined}
      onRuntimeReady={context ? reportReady : undefined}
    />
  );
}
