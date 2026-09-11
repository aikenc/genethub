import { useCallback, useMemo } from "react";

import type { MarkdownArtifactProps } from "./Markdown";
import { inlineImagesFromTrunks } from "./roundGallery";
import { useWorkbench } from "./store";

/** Stable empty snapshot so zustand selectors do not infinite-loop on miss. */
const NO_FOLDERS: MarkdownArtifactProps["folders"] = [];

/** Workspace binding for chat Markdown path rewrite and authenticated images. */
export function useSessionArtifact(): MarkdownArtifactProps | null {
  const client = useWorkbench((state) => state.client);
  const deviceHandle = client?.identity?.machineId ?? null;
  const sessionId = useWorkbench((state) => state.activeSessionId);
  const workspaceHandle = useWorkbench((state) => {
    const session = state.sessions.find((entry) => entry.id === state.activeSessionId);
    return (
      session?.workspaceId ?? state.activeWorkspaceId ?? state.draft?.workspaceId ?? null
    );
  });
  const folders = useWorkbench((state) => {
    const workspace = state.workspaces.find((entry) => entry.id === workspaceHandle);
    return workspace?.folders ?? NO_FOLDERS;
  });
  const roundTrunks = useWorkbench((state) => state.timeline.roundTrunks);
  const inlineImages = useMemo(
    () => inlineImagesFromTrunks(Object.values(roundTrunks)),
    [roundTrunks],
  );

  const loadPreview = useCallback(
    async (path: string) => {
      if (!client || !workspaceHandle) return null;
      try {
        const result = await client.preview(workspaceHandle, path);
        return { bytes: result.bytes, mediaType: result.metadata.mediaType };
      } catch {
        return null;
      }
    },
    [client, workspaceHandle],
  );

  return useMemo(() => {
    if (!deviceHandle || !workspaceHandle || folders.length === 0) return null;
    return {
      deviceHandle,
      workspaceHandle,
      folders: folders.map((folder) => ({
        root: folder.root,
        rootHandle: folder.rootHandle,
      })),
      ...(sessionId ? { sessionId } : {}),
      ...(inlineImages.length > 0 ? { inlineImages } : {}),
      loadPreview,
    };
  }, [deviceHandle, folders, inlineImages, loadPreview, sessionId, workspaceHandle]);
}
