import type { SessionArtifactBundle } from "@genehub/proto";

import { ConnectionOutcomeUnknownError, type Client } from "../protocol/client";
import type { RuntimeArtifactSubmission } from "./PreviewRuntimeControls";

export type ArtifactUploadProgress = {
  uploadedBytes: number;
  totalBytes: number;
  fileName: string;
};

/**
 * Streams browser-owned Blobs to the daemon without ever materializing the
 * whole recording as base64. The daemon chooses the path and publishes it only
 * after `finish`; errors best-effort abort the hidden staging directory.
 */
export async function uploadSessionArtifact(
  client: Client,
  sessionId: string,
  artifact: RuntimeArtifactSubmission,
  onProgress?: (progress: ArtifactUploadProgress) => void,
): Promise<SessionArtifactBundle> {
  const declared = artifact.files.map((file) => ({
    name: file.name,
    mime: file.mime,
    bytes: file.blob.size,
  }));
  const totalBytes = declared.reduce((total, file) => total + file.bytes, 0);
  const begin = await client.call({
    type: "session.artifact.begin",
    payload: {
      sessionId,
      files: declared,
      metadata: artifact.metadata,
    },
  });
  if (begin?.type !== "sessionArtifactUpload") {
    throw new Error("daemon 未返回运行产物上传凭据");
  }
  const upload = begin.data;
  const chunkBytes = Math.max(1, Math.min(upload.maxChunkBytes, 512 * 1024));
  let uploadedBytes = 0;
  try {
    for (let fileIndex = 0; fileIndex < artifact.files.length; fileIndex += 1) {
      const file = artifact.files[fileIndex]!;
      for (let offset = 0; offset < file.blob.size; offset += chunkBytes) {
        const chunk = file.blob.slice(offset, Math.min(file.blob.size, offset + chunkBytes));
        const request = {
          type: "session.artifact.chunk" as const,
          payload: {
            sessionId,
            uploadId: upload.uploadId,
            fileIndex,
            offset,
            dataBase64: await blobToBase64(chunk),
          },
        };
        await retryUnknownOutcome(() => client.call(request));
        uploadedBytes += chunk.size;
        onProgress?.({ uploadedBytes, totalBytes, fileName: file.name });
      }
    }
    const finished = await retryUnknownOutcome(() =>
      client.call({
        type: "session.artifact.finish",
        payload: { sessionId, uploadId: upload.uploadId },
      }),
    );
    if (finished?.type !== "sessionArtifact") {
      throw new Error("daemon 未确认运行产物已落盘");
    }
    return finished.data;
  } catch (error) {
    await client
      .call({
        type: "session.artifact.abort",
        payload: { sessionId, uploadId: upload.uploadId },
      })
      .catch(() => {});
    throw error;
  }
}

async function retryUnknownOutcome<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof ConnectionOutcomeUnknownError)) throw error;
    return operation();
  }
}

/** One concise draft line. It is appended to the composer and never auto-sent. */
export function runtimeArtifactDraftLine(workspacePath: string): string {
  return `运行产物Bundle：\`${workspacePath}\``;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取运行产物分块失败"));
    reader.readAsDataURL(blob);
  });
}
