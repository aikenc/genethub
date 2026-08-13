import { useCallback, useEffect, useRef } from "react";

import type { SessionArtifactBundle } from "@genehub/proto";

import { AssetPreviewPage } from "./AssetPreviewPage";
import {
  createPreviewPopoutChannel,
  previewPopoutArtifact,
  previewPopoutReady,
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

  useEffect(() => {
    if (!context) return;
    const channel = createPreviewPopoutChannel(() => {});
    channelRef.current = channel;
    channel.post(previewPopoutReady(context));
    return () => {
      channelRef.current = null;
      channel.close();
    };
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
      runtimeSessionId={context?.sessionId ?? null}
      onRuntimeArtifactSaved={context?.sessionId ? reportSaved : undefined}
    />
  );
}
