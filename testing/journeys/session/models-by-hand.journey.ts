import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.models-by-hand",
    title: "Models written by hand need no list call",
    oracle: "settings.setProvider with explicit models stores them and has no problem",
    catches: ["empty picker when /models is down"],
    tags: ["core", "session", "parity"],
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const saved = await opened.client.call({
        type: "settings.setProvider",
        payload: {
          providerId: "local",
          apiKey: "none",
          baseUrl: "http://127.0.0.1:9/v1",
          label: "本地",
          dialect: null,
          models: ["qwen3-32b"],
        },
      });
      t.assertions.assert(saved?.type === "settings", `setProvider returned ${saved?.type}`);
      const local = saved?.type === "settings" ? saved.data.providers.find((item) => item.id === "local") : undefined;
      t.assertions.assert(JSON.stringify(local?.models) === JSON.stringify(["qwen3-32b"]), `models ${local?.models?.join(",")}`);
      t.assertions.assert(local?.problem == null, "nothing was asked, so there is nothing to complain about");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
