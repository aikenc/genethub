import { Buffer } from "node:buffer";

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.native-media-to-model",
    title: "The built-in Agent sends configured image and video inputs to the model",
    oracle: "a user turn with a pasted image and session-uploaded video reaches the mock Chat Completions endpoint as native image_url and video_url parts, and remains in follow-up history",
    catches: ["Genet silently drops attachments", "video is reduced to a path or sampled frames", "model media settings do not reach the Agent", "media disappears on the next turn", "switching to a text-only model traps the session on old media", "a provider-rejected video poisons later messages"],
    tags: ["core", "session", "media", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 35_000,
    timeoutMs: 100_000,
    surfaces: ["daemon", "agent", "workbench-client", "protocol-codec"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const saved = await opened.client.call({
        type: "settings.setProvider",
        payload: {
          providerId: "deepseek",
          apiKey: null,
          baseUrl: null,
          label: null,
          dialect: null,
          models: ["deepseek-v4-flash", "deepseek-text"],
          modelInputs: { "deepseek-v4-flash": ["image", "video"] },
        },
      });
      t.assertions.assert(saved?.type === "settings", "model input settings were not saved");
      const provider = saved?.type === "settings"
        ? saved.data.providers.find((item) => item.id === "deepseek")
        : undefined;
      t.assertions.assert(
        JSON.stringify(provider?.modelInputs?.["deepseek-v4-flash"]) === JSON.stringify(["image", "video"]),
        "the chosen model lost its input capabilities",
      );
      const agents = await opened.client.call({ type: "agent.list" });
      const model = agents?.type === "agents"
        ? agents.data.find((agent) => agent.id === "genet")?.catalog.models.find((item) => item.id === "deepseek/deepseek-v4-flash")
        : undefined;
      t.assertions.assert(
        JSON.stringify(model?.inputModalities) === JSON.stringify(["image", "video"]),
        "the built-in Agent catalog did not carry the model capabilities",
      );

      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7XcAAAAASUVORK5CYII=", "base64");
      const video = Buffer.from("00000018667479706d703432000000006d7034326d703431", "hex");
      const begin = await opened.client.call({
        type: "session.artifact.begin",
        payload: {
          sessionId,
          files: [{ name: "clip.mp4", mime: "video/mp4", bytes: video.length }],
          metadata: { kind: "chat-video-input" },
        },
      });
      t.assertions.assert(begin?.type === "sessionArtifactUpload", "video upload did not start");
      if (begin?.type !== "sessionArtifactUpload") return;
      await opened.client.call({
        type: "session.artifact.chunk",
        payload: {
          sessionId,
          uploadId: begin.data.uploadId,
          fileIndex: 0,
          offset: 0,
          dataBase64: video.toString("base64"),
        },
      });
      const finished = await opened.client.call({
        type: "session.artifact.finish",
        payload: { sessionId, uploadId: begin.data.uploadId },
      });
      t.assertions.assert(finished?.type === "sessionArtifact", "video upload was not published");
      if (finished?.type !== "sessionArtifact") return;
      opened.mock.script({ text: "seen both" }, { text: "still seen" }, { text: "switched" }, { text: "recovered" });
      await opened.client.call({
        type: "session.send",
        payload: {
          sessionId,
          text: "Describe both files",
          attachments: [
            { name: "pixel.png", mime: "image/png", dataBase64: image.toString("base64") },
            { name: "clip.mp4", mime: "video/mp4", path: `${finished.data.workspacePath}/clip.mp4` },
          ],
          artifactPreviewBaseUrl: null,
          continuesRound: null,
        },
      });
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
      t.assertions.assert(opened.mock.requests.length === 1, "the first turn did not reach the model exactly once");
      const first = opened.mock.requests[0] as { messages?: Array<{ role?: string; content?: unknown }> };
      const user = first.messages?.find((message) => message.role === "user");
      const parts = user?.content as Array<{ type?: string; text?: string; image_url?: { url?: string }; video_url?: { url?: string } }>;
      t.assertions.assert(Array.isArray(parts), "media turn did not use structured content");
      t.assertions.assert(parts.some((part) => part.type === "text" && part.text === "Describe both files"), "user text was lost");
      t.assertions.assert(parts.some((part) => part.type === "image_url" && part.image_url?.url === `data:image/png;base64,${image.toString("base64")}`), "the exact image bytes did not reach image_url");
      t.assertions.assert(parts.some((part) => part.type === "video_url" && part.video_url?.url === `data:video/mp4;base64,${video.toString("base64")}`), "the exact video bytes did not reach native video_url");

      await t.flows.main.sendPrompt(opened.client, sessionId, "What was in the video?");
      await t.tools.waitUntil(() => events.filter((item) => item.type === "turnCompleted").length >= 2, 45_000);
      const second = opened.mock.requests[1] as { messages?: Array<{ role?: string; content?: unknown }> };
      t.assertions.assert(
        JSON.stringify(second.messages).includes(`data:video/mp4;base64,${video.toString("base64")}`),
        "the video was not retained in follow-up model context",
      );

      const switched = await opened.client.call({
        type: "session.setModel",
        payload: { sessionId, modelId: "deepseek/deepseek-text" },
      });
      t.assertions.assert(switched?.type === "ack", "switching to a text-only model failed");
      await t.flows.main.sendPrompt(opened.client, sessionId, "Continue without the video");
      await t.tools.waitUntil(() => events.filter((item) => item.type === "turnCompleted").length >= 3, 45_000);
      const third = opened.mock.requests[2] as { messages?: Array<{ role?: string; content?: unknown }> };
      t.assertions.assert(
        !JSON.stringify(third.messages).includes(`data:video/mp4;base64,${video.toString("base64")}`),
        "the text-only model received old video bytes",
      );
      t.assertions.assert(
        JSON.stringify(third.messages).includes("历史附件"),
        "the text-only model did not receive an explanation for omitted history",
      );

      await opened.client.call({
        type: "settings.setProvider",
        payload: {
          providerId: "deepseek",
          apiKey: null,
          baseUrl: null,
          label: null,
          dialect: null,
          models: null,
          modelInputs: { "deepseek-v4-flash": ["image"] },
        },
      });
      const deniedSessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const deniedEvents = await t.flows.main.attachEventLog(opened.client, deniedSessionId);
      await opened.client.call({
        type: "session.send",
        payload: {
          sessionId: deniedSessionId,
          text: "Describe this clip",
          attachments: [{ name: "clip.mp4", mime: "video/mp4", dataBase64: video.toString("base64") }],
          artifactPreviewBaseUrl: null,
          continuesRound: null,
        },
      });
      await t.tools.waitUntil(() => deniedEvents.some((item) => item.type === "turnFailed"), 45_000);
      const failed = deniedEvents.find((item) => item.type === "turnFailed");
      const error = (failed?.raw as { event?: { error?: { message?: string } } })?.event?.error;
      t.assertions.assert(error?.message?.includes("未配置 video 输入能力") ?? false, "unsupported video was not explained to the user");
      t.assertions.assert(opened.mock.requests.length === 3, "unsupported video reached the model endpoint");
      await t.flows.main.sendPrompt(opened.client, deniedSessionId, "Continue with text only");
      await t.tools.waitUntil(() => deniedEvents.some((item) => item.type === "turnCompleted"), 45_000);
      t.assertions.assert(opened.mock.requests.length === 4, "rejected media blocked the next text turn");

      await opened.client.call({
        type: "settings.setProvider",
        payload: {
          providerId: "deepseek",
          apiKey: null,
          baseUrl: null,
          label: null,
          dialect: null,
          models: null,
          modelInputs: { "deepseek-v4-flash": ["image", "video"] },
        },
      });
      const rejectedVideo = Buffer.from("rejected-video-bytes");
      const replacementVideo = Buffer.from("replacement-video-bytes");
      opened.mock.script({ status: 413 }, { text: "replacement accepted" });
      const recoveredSessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const recoveredEvents = await t.flows.main.attachEventLog(opened.client, recoveredSessionId);
      await opened.client.call({
        type: "session.send",
        payload: {
          sessionId: recoveredSessionId,
          messageId: "u_rejected_video",
          text: "Describe the rejected video",
          attachments: [{ name: "large.mp4", mime: "video/mp4", dataBase64: rejectedVideo.toString("base64") }],
          artifactPreviewBaseUrl: null,
          continuesRound: null,
        },
      });
      await t.tools.waitUntil(() => recoveredEvents.some((item) => item.type === "turnFailed"), 45_000);
      await opened.client.call({
        type: "session.send",
        payload: {
          sessionId: recoveredSessionId,
          messageId: "u_replacement_video",
          text: "Describe only this replacement video",
          attachments: [{ name: "small.mp4", mime: "video/mp4", dataBase64: replacementVideo.toString("base64") }],
          artifactPreviewBaseUrl: null,
          continuesRound: null,
        },
      });
      await t.tools.waitUntil(() => recoveredEvents.filter((item) => item.type === "turnCompleted").length === 1, 45_000);
      const recoveredRequest = opened.mock.requests[5] as { messages?: unknown[] };
      const recoveredBody = JSON.stringify(recoveredRequest.messages);
      t.assertions.assert(
        !recoveredBody.includes(rejectedVideo.toString("base64")) && !recoveredBody.includes("u_rejected_video"),
        "the provider-rejected video remained in the next model request",
      );
      t.assertions.assert(
        recoveredBody.includes(replacementVideo.toString("base64")) && recoveredBody.includes("u_replacement_video"),
        "the replacement video did not reach the recovered request",
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
