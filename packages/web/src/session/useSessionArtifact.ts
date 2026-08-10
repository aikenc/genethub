import { useCallback, useMemo } from "react";

import type { MarkdownArtifactProps } from "./Markdown";
import { useWorkbench } from "./store";

/** Workspace binding for chat Markdown path rewrite and authenticated images. */
export function useSessionArtifact(): MarkdownArtifactProps | null {
  const client = useWorkbench((state) => state.client);
  const deviceHandle = client?.identity?.machineId ?? null;
  const workspaceHandle = useWorkbench((state) => {
    const session = state.sessions.find((entry) => entry.id === state.activeSessionId);
    return (
      session?.workspaceId ?? state.activeWorkspaceId ?? state.draft?.workspaceId ?? null
    );
  });
  const folders = useWorkbench((state) => {
    const workspace = state.workspaces.find((entry) => entry.id === workspaceHandle);
    return workspace?.folders ?? [];
  });

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
      loadPreview,
    };
  }, [deviceHandle, folders, loadPreview, workspaceHandle]);
}
