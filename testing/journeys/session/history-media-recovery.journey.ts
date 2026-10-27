import { Buffer } from "node:buffer";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineJourney, hideHostAgentClis, seedScriptAgentRuntime } from "../../framework/public.ts";

defineJourney({
  id: "journey.session.history-media-recovery",
  title: "A session continues when media files disappear",
  oracle: "The model receives the original read_media image after deletion and an explanation for an unavailable attachment",
  catches: ["read_media history depends on the original file", "an unavailable attachment blocks a session"],
  tags: ["core", "session", "media"], llm: { default: "mock" },
  expectedDurationMs: 35_000, timeoutMs: 120_000,
  surfaces: ["daemon", "agent", "workbench-client", "protocol-codec"], productInterfaces: ["@genehub/workbench/client"],
}, async (t) => {
  seedScriptAgentRuntime(t.env); hideHostAgentClis(t.env);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await opened.client.call({ type: "settings.setProvider", payload: { providerId: "deepseek", apiKey: null, baseUrl: null, label: null, dialect: null, models: ["deepseek-v4-flash"], modelInputs: { "deepseek-v4-flash": ["image", "video"] } } });
    await opened.client.call({ type: "settings.setAgentPreferences", payload: { preferences: { runtimes: {}, selectedTags: ["Flash"], modelProfiles: [{ agentId: "genet", modelId: "deepseek/deepseek-v4-flash", tags: ["Flash", "图片理解", "视频理解"], cost: "low" }] } } });
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7XcAAAAASUVORK5CYII=", "base64");
    const file = join(t.env.workspace, "recon_front.png");
    writeFileSync(file, image);
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const events = await t.flows.main.attachEventLog(opened.client, sessionId);
    opened.mock.script({ tool: { name: "read_media", arguments: { path: "recon_front.png" } } }, { tool: { name: "read_media", arguments: { path: "recon_front.png" } } }, { text: "seen" }, { text: "continued" });
    await t.flows.main.sendPrompt(opened.client, sessionId, "Inspect the image");
    await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
    rmSync(file);
    await t.flows.main.sendPrompt(opened.client, sessionId, "Continue");
    await t.tools.waitUntil(() => events.filter((item) => item.type === "turnCompleted").length >= 2 || events.some((item) => item.type === "turnFailed"), 45_000);
    t.assertions.assert(events.filter((item) => item.type === "turnCompleted").length >= 2, "deleted image blocked the next turn");
    const imageUrl = `data:image/png;base64,${image.toString("base64")}`;
    const followup = JSON.stringify(opened.mock.requests.at(-1));
    t.assertions.assert(followup.split(imageUrl).length === 2, "original image bytes were missing or duplicated in model history");
    const missingId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const missingEvents = await t.flows.main.attachEventLog(opened.client, missingId);
    opened.mock.script({ text: "continued" });
    await opened.client.call({ type: "session.send", payload: { sessionId: missingId, messageId: "u_missing_media", text: "Inspect", attachments: [{ name: "gone.png", mime: "image/png", path: "gone.png" }], artifactPreviewBaseUrl: null, continuesRound: null } });
    await t.tools.waitUntil(() => missingEvents.some((item) => item.type === "turnCompleted" || item.type === "turnFailed"), 45_000);
    t.assertions.assert(missingEvents.some((item) => item.type === "turnCompleted"), "missing attachment blocked the turn");
    const body = JSON.stringify(opened.mock.requests.at(-1));
    t.assertions.assert(body.includes("gone.png") && body.includes("无法读取") && !body.includes("image_url"), "model did not receive an unavailable attachment explanation");
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
