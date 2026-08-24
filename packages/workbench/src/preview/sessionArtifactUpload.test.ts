import { describe, expect, it } from "vitest";

import type { Request, SessionArtifactBundle } from "@genehub/proto";

import { ConnectionOutcomeUnknownError, type Client } from "../protocol/client";
import type { RuntimeArtifactSubmission } from "./PreviewRuntimeControls";
import { runtimeArtifactDraftLine, uploadSessionArtifact } from "./sessionArtifactUpload";

const bundle: SessionArtifactBundle = {
  relativePath: "artifacts/260813-221500-a3f1",
  workspacePath: ".genethub/sessions/s_demo/artifacts/260813-221500-a3f1",
  manifestPath: ".genethub/sessions/s_demo/artifacts/260813-221500-a3f1/manifest.json",
  createdAtMs: 1_700_000_000_000,
  totalBytes: 1_100_000,
  files: [
    {
      name: "recording.webm",
      mime: "video/webm",
      bytes: 1_100_000,
      sha256: "a".repeat(64),
    },
    { name: "events.jsonl", mime: "application/x-ndjson", bytes: 0, sha256: "b".repeat(64) },
  ],
};

function artifact(): RuntimeArtifactSubmission {
  return {
    files: [
      {
        name: "recording.webm",
        mime: "video/webm",
        blob: new Blob([new Uint8Array(1_100_000).fill(7)], { type: "video/webm" }),
      },
      { name: "events.jsonl", mime: "application/x-ndjson", blob: new Blob([]) },
    ],
    metadata: { schema: "genehub.preview-runtime.v2" },
    summary: {
      eventCount: 0,
      frameCount: 0,
      recording: { durationMs: 4_000, bytes: 1_100_000 },
    },
  };
}

describe("session artifact upload", () => {
  it("streams bounded chunks and finalizes a daemon-selected bundle", async () => {
    const calls: Request[] = [];
    const client = {
      async call(request: Request) {
        calls.push(request);
        if (request.type === "session.artifact.begin") {
          return {
            type: "sessionArtifactUpload" as const,
            data: {
              uploadId: `u_${"1".repeat(32)}`,
              relativePath: bundle.relativePath,
              workspacePath: bundle.workspacePath,
              maxChunkBytes: 512 * 1024,
            },
          };
        }
        if (request.type === "session.artifact.finish") {
          return { type: "sessionArtifact" as const, data: bundle };
        }
        return { type: "ack" as const };
      },
    } as unknown as Client;
    const progress: number[] = [];

    const saved = await uploadSessionArtifact(client, "s_demo", artifact(), ({ uploadedBytes }) =>
      progress.push(uploadedBytes),
    );

    expect(saved).toEqual(bundle);
    const chunks = calls.filter(
      (request): request is Extract<Request, { type: "session.artifact.chunk" }> =>
        request.type === "session.artifact.chunk",
    );
    expect(chunks).toHaveLength(3);
    expect(chunks.map((request) => request.payload.offset)).toEqual([0, 512 * 1024, 1024 * 1024]);
    expect(chunks.every((request) => request.payload.dataBase64.length < 710_000)).toBe(true);
    expect(progress.at(-1)).toBe(1_100_000);
    expect(calls.at(-1)?.type).toBe("session.artifact.finish");
  });

  it("best-effort aborts staging when a chunk fails", async () => {
    const calls: Request[] = [];
    const client = {
      async call(request: Request) {
        calls.push(request);
        if (request.type === "session.artifact.begin") {
          return {
            type: "sessionArtifactUpload" as const,
            data: {
              uploadId: `u_${"2".repeat(32)}`,
              relativePath: bundle.relativePath,
              workspacePath: bundle.workspacePath,
              maxChunkBytes: 512 * 1024,
            },
          };
        }
        if (request.type === "session.artifact.chunk") throw new Error("disk full");
        return { type: "ack" as const };
      },
    } as unknown as Client;

    await expect(uploadSessionArtifact(client, "s_demo", artifact())).rejects.toThrow("disk full");
    expect(calls.at(-1)?.type).toBe("session.artifact.abort");
  });

  it("retries an idempotent finish whose acknowledgement was lost", async () => {
    let finishCalls = 0;
    const client = {
      async call(request: Request) {
        if (request.type === "session.artifact.begin") {
          return {
            type: "sessionArtifactUpload" as const,
            data: {
              uploadId: `u_${"3".repeat(32)}`,
              relativePath: bundle.relativePath,
              workspacePath: bundle.workspacePath,
              maxChunkBytes: 512 * 1024,
            },
          };
        }
        if (request.type === "session.artifact.finish") {
          finishCalls += 1;
          if (finishCalls === 1) throw new ConnectionOutcomeUnknownError();
          return { type: "sessionArtifact" as const, data: bundle };
        }
        return { type: "ack" as const };
      },
    } as unknown as Client;

    await expect(uploadSessionArtifact(client, "s_demo", artifact())).resolves.toEqual(bundle);
    expect(finishCalls).toBe(2);
  });

  it("builds exactly one concise composer draft line", () => {
    expect(runtimeArtifactDraftLine(bundle.workspacePath)).toBe(
      "运行产物Bundle：`.genethub/sessions/s_demo/artifacts/260813-221500-a3f1`",
    );
  });
});
