import { Buffer } from "node:buffer";

import { defineJourney, hideHostAgentClis, seedScriptAgentRuntime } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.chat-file-upload",
    title: "A chat file stays in the workspace and the Agent reads it on demand",
    oracle:
      "an uploaded text file is stored under the session artifacts, the Agent receives its name/size/path in the turn, and a scripted read returns the exact bytes without any provider media input",
    catches: [
      "arbitrary files are rejected by the composer/daemon",
      "a non-media attachment crashes the model turn",
      "the Agent learns a staged name but not the stored path",
      "the file is not readable after the turn",
    ],
    tags: ["core", "session", "attachment"],
    llm: { default: "mock" },
    expectedDurationMs: 35_000,
    timeoutMs: 100_000,
    surfaces: ["daemon", "agent", "workbench-client", "protocol-codec"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    seedScriptAgentRuntime(t.env);
    hideHostAgentClis(t.env);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);

      const contents = Buffer.from("hello from the uploaded file");
      const begin = await opened.client.call({
        type: "session.artifact.begin",
        payload: {
          sessionId,
          files: [{ name: "file-001.txt", mime: "text/plain", bytes: contents.length }],
          metadata: { kind: "chat-file-input" },
        },
      });
      t.assertions.assert(begin?.type === "sessionArtifactUpload", "file upload did not start");
      if (begin?.type !== "sessionArtifactUpload") return;
      await opened.client.call({
        type: "session.artifact.chunk",
        payload: {
          sessionId,
          uploadId: begin.data.uploadId,
          fileIndex: 0,
          offset: 0,
          dataBase64: contents.toString("base64"),
        },
      });
      const finished = await opened.client.call({
        type: "session.artifact.finish",
        payload: { sessionId, uploadId: begin.data.uploadId },
      });
      t.assertions.assert(finished?.type === "sessionArtifact", "file upload was not published");
      if (finished?.type !== "sessionArtifact") return;
      const storedPath = `${finished.data.workspacePath}/file-001.txt`;

      opened.mock.script(
        { tool: { name: "read", arguments: { path: storedPath } } },
        { text: "The file says hello." },
        { text: "It still says hello." },
      );
      await opened.client.call({
        type: "session.send",
        payload: {
          sessionId,
          text: "Read the attached notes and tell me what they say",
          attachments: [{
            name: "notes.txt",
            mime: "text/plain",
            path: storedPath,
            bytes: contents.length,
          }],
          artifactPreviewBaseUrl: null,
          continuesRound: null,
        },
      });
      await t.tools.waitUntil(() => events.filter((item) => item.type === "turnCompleted").length >= 1, 45_000);

      const requestText = (index: number) => {
        const request = opened.mock.requests[index] as { messages?: unknown } | undefined;
        return JSON.stringify(request?.messages ?? []);
      };
      const first = requestText(0);
      t.assertions.assert(first.includes("notes.txt"), "the original file name did not reach the Agent");
      t.assertions.assert(first.includes(storedPath), "the stored path did not reach the Agent");
      t.assertions.assert(first.includes(String(contents.length)), "the file size did not reach the Agent");

      const second = requestText(1);
      t.assertions.assert(
        second.includes(contents.toString()),
        "the Agent's read tool did not return the uploaded bytes",
      );

      await t.flows.main.sendPrompt(opened.client, sessionId, "And now?");
      await t.tools.waitUntil(() => events.filter((item) => item.type === "turnCompleted").length >= 2, 45_000);
      const third = requestText(2);
      t.assertions.assert(
        third.includes(storedPath),
        "the uploaded file disappeared from follow-up history",
      );

      const narrative = await opened.client.call({
        type: "session.narrative",
        payload: { sessionId, itemId: null, throughRoundId: null, cursor: null, limit: null },
      });
      t.assertions.assert(narrative?.type === "sessionNarrative", "narrative lookup failed");
      if (narrative?.type === "sessionNarrative") {
        const user = narrative.data.items.find((item) => item.type === "userMessage");
        t.assertions.assert(
          user?.type === "userMessage" && user.attachments[0]?.path === storedPath,
          "the timeline did not retain the stored file path",
        );
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
