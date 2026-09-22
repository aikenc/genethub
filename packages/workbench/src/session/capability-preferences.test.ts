import type { AgentInfo, AgentSelectionPreferences } from "@genehub/proto";
import { describe, expect, it } from "vitest";

import {
  IMAGE_TAG,
  VIDEO_TAG,
  availableAgentTags,
  mediaInputSupport,
  inferredModelProfile,
  normalizeAgentPreferences,
  normalizeGroupedTags,
  resolveTagRoute,
  tagMediaInputSupport,
  toggleGroupedTag,
  withModelProfile,
  withoutModelProfile,
  withRuntimePreference,
  withSelectedTags,
  withTagGroups,
} from "./capability-preferences";

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "codex",
    label: "Codex",
    builtin: true,
    probe: { state: "ready" },
    capabilities: {
      interrupt: true,
      setModel: true,
      setEffort: true,
      setMode: true,
      permissions: true,
      resume: true,
      fork: true,
      attachments: true,
    },
    catalog: {
      models: [
        {
          id: "text",
          label: "Text",
          reasoning: true,
          efforts: ["low", "medium", "high", "xhigh"],
          inputModalities: [],
        },
        {
          id: "vision-pro",
          label: "Vision Pro",
          reasoning: true,
          efforts: ["low", "medium", "high"],
          inputModalities: ["image"],
        },
        {
          id: "video-flush",
          label: "Video Flush",
          reasoning: true,
          efforts: ["medium", "high"],
          inputModalities: ["video"],
        },
      ],
      modes: [
        { id: "read-only", label: "Read only" },
        { id: "full-access", label: "Full access" },
      ],
      commands: [],
      defaultModel: "text",
      defaultMode: "read-only",
      defaultEffort: "medium",
    },
    ...overrides,
  };
}

describe("machine-global Agent tag routing", () => {
  it("materializes the first three exact Agent + model rows and infers deterministic defaults", () => {
    const preferences = normalizeAgentPreferences(undefined, [agent()]);
    expect(preferences.selectedTags).toEqual(["Flush"]);
    expect(preferences.modelProfiles).toEqual([
      { agentId: "codex", modelId: "text", tags: ["Flush"], cost: "medium" },
      {
        agentId: "codex",
        modelId: "vision-pro",
        tags: ["Pro", IMAGE_TAG],
        cost: "medium",
      },
      {
        agentId: "codex",
        modelId: "video-flush",
        tags: ["Flush", VIDEO_TAG],
        cost: "low",
      },
    ]);
  });

  it("filters auto and adds further models only when the Human asks", () => {
    const rich = agent({
      catalog: {
        ...agent().catalog,
        models: [
          { id: "provider/auto", label: "Auto Select", reasoning: true, efforts: [] },
          ...[1, 2, 3, 4, 5].map((index) => ({
            id: `m${index}`,
            label: `Model ${index}`,
            reasoning: true,
            efforts: [] as string[],
          })),
        ],
      },
    });
    const initial = normalizeAgentPreferences(undefined, [rich]);
    expect(initial.modelProfiles?.map((profile) => profile.modelId)).toEqual(["m1", "m2", "m3"]);

    const fourth = rich.catalog.models.find((model) => model.id === "m4")!;
    const saved = withModelProfile(initial, inferredModelProfile(rich, fourth));
    expect(normalizeAgentPreferences(saved, [rich]).modelProfiles?.map((profile) => profile.modelId))
      .toEqual(["m1", "m2", "m3", "m4"]);

    const staleOnly = { ...saved, modelProfiles: [inferredModelProfile(rich, fourth)] };
    const changedCatalog = {
      ...rich,
      catalog: { ...rich.catalog, models: rich.catalog.models.filter((model) => model.id !== "m4") },
    };
    expect(normalizeAgentPreferences(staleOnly, [changedCatalog]).modelProfiles).toEqual([]);
  });

  it("keeps an Agent disabled after its last model is removed and re-enables it on add", () => {
    const current = agent();
    let preferences = normalizeAgentPreferences(undefined, [current]);
    for (const profile of [...(preferences.modelProfiles ?? [])]) {
      preferences = withoutModelProfile(preferences, profile.agentId, profile.modelId);
    }

    expect(preferences.modelProfiles).toEqual([]);
    expect(preferences.disabledAgentIds).toEqual(["codex"]);
    expect(normalizeAgentPreferences(preferences, [current]).modelProfiles).toEqual([]);

    preferences = withModelProfile(
      preferences,
      { ...inferredModelProfile(current, current.catalog.models[0]!), displayName: "主模型" },
    );
    expect(preferences.disabledAgentIds).toEqual([]);
    expect(normalizeAgentPreferences(preferences, [current]).modelProfiles).toEqual([
      expect.objectContaining({ modelId: "text", displayName: "主模型" }),
    ]);
  });

  it("does not materialize or retain model rows for an inactive Agent", () => {
    const inactive = agent({
      id: "inactive",
      label: "Inactive",
      probe: { state: "notInstalled" },
    });
    const stored: AgentSelectionPreferences = {
      selectedTags: ["Flush"],
      modelProfiles: [
        { agentId: "inactive", modelId: "text", tags: ["Flush"], cost: "medium" },
      ],
      runtimes: {},
    };

    expect(normalizeAgentPreferences(undefined, [inactive]).modelProfiles).toEqual([]);
    expect(normalizeAgentPreferences(stored, [inactive]).modelProfiles).toEqual([]);
  });

  it("enforces one tag per built-in or custom group for ownership and filters", () => {
    let preferences = normalizeAgentPreferences(undefined, [agent()]);
    preferences = withTagGroups(preferences, [
      { id: "speed", label: "速度", tags: ["快", "稳"] },
      { id: "builtin-intelligence", label: "冲突", tags: ["坏"] },
    ]);
    expect(preferences.tagGroups?.map((group) => group.id)).toEqual(["speed"]);
    preferences = withModelProfile(preferences, {
      agentId: "codex",
      modelId: "text",
      tags: ["Max", "Pro", "快", "稳"],
      cost: "medium",
    });
    expect(preferences.modelProfiles?.find((profile) => profile.modelId === "text")?.tags)
      .toEqual(["Max", "快"]);
    expect(toggleGroupedTag(["Pro", "稳"], "Max", preferences)).toEqual(["稳", "Max"]);
    expect(normalizeGroupedTags(["Max", "Flush", "快", "稳"], preferences))
      .toEqual(["Max", "快"]);
  });

  it("matches every requested tag and picks the available route with the lowest live cost", () => {
    let preferences = normalizeAgentPreferences(undefined, [agent()]);
    preferences = withModelProfile(preferences, {
      agentId: "codex",
      modelId: "text",
      tags: ["Flush", "我的标签"],
      cost: "high",
    });
    preferences = withModelProfile(preferences, {
      agentId: "codex",
      modelId: "video-flush",
      tags: ["Flush", "我的标签", VIDEO_TAG],
      cost: "veryLow",
    });

    expect(resolveTagRoute(preferences, ["Flush", "我的标签"], [agent()])?.modelId).toBe(
      "video-flush",
    );
    expect(resolveTagRoute(preferences, ["Flush", "不存在"], [agent()])).toBeNull();

    const unavailable = agent({ probe: { state: "unavailable", reason: "offline" } });
    expect(resolveTagRoute(preferences, ["Flush"], [unavailable])).toBeNull();
  });

  it("re-evaluates changed costs instead of preserving a previous route", () => {
    let preferences = normalizeAgentPreferences(undefined, [agent()]);
    preferences = withModelProfile(preferences, {
      agentId: "codex",
      modelId: "text",
      tags: ["Flush"],
      cost: "veryLow",
    });
    expect(resolveTagRoute(preferences, ["Flush"], [agent()])?.modelId).toBe("text");

    preferences = withModelProfile(preferences, {
      agentId: "codex",
      modelId: "text",
      tags: ["Flush"],
      cost: "veryHigh",
    });
    expect(resolveTagRoute(preferences, ["Flush"], [agent()])?.modelId).toBe("video-flush");
  });

  it("defaults runtime controls high and unrestricted, then remembers the last valid choice", () => {
    const initial = withModelProfile(normalizeAgentPreferences(undefined, [agent()]), {
      agentId: "codex",
      modelId: "text",
      tags: ["Flush"],
      cost: "veryLow",
    });
    expect(resolveTagRoute(initial, ["Flush"], [agent()])).toMatchObject({
      effortId: "high",
      modeId: "full-access",
    });
    const remembered = withRuntimePreference(initial, "codex", {
      effortId: "xhigh",
      modeId: "read-only",
    });
    expect(resolveTagRoute(remembered, ["Flush"], [agent()])).toMatchObject({
      effortId: "xhigh",
      modeId: "read-only",
    });
  });

  it("uses the upper-middle effort when an Agent has no canonical high tier", () => {
    const custom = agent({
      catalog: {
        ...agent().catalog,
        models: [
          {
            id: "text",
            label: "Text",
            reasoning: true,
            efforts: ["low", "medium", "xhigh", "max"],
          },
        ],
      },
    });
    expect(
      resolveTagRoute(normalizeAgentPreferences(undefined, [custom]), ["Flush"], [custom])
        ?.effortId,
    ).toBe("xhigh");
  });

  it("derives media affordances from all matching candidates, not from the current route", () => {
    let preferences = normalizeAgentPreferences(undefined, [agent()]);
    preferences = withModelProfile(preferences, {
      agentId: "codex",
      modelId: "vision-pro",
      tags: ["Flush", IMAGE_TAG],
      cost: "high",
    });
    expect(tagMediaInputSupport(preferences, ["Flush"], [agent()])).toEqual({
      image: true,
      video: true,
    });
    expect(resolveTagRoute(preferences, ["Flush", IMAGE_TAG], [agent()])?.modelId).toBe(
      "vision-pro",
    );
  });

  it("treats unknown third-party modalities as unsupported until the user tags them", () => {
    const external = agent({
      id: "third-party",
      builtin: false,
      catalog: {
        ...agent().catalog,
        models: [{ id: "opaque", label: "Opaque", reasoning: true, efforts: [] }],
        defaultModel: "opaque",
      },
    });
    expect(mediaInputSupport(external, "opaque")).toEqual({ image: false, video: false });
    const configured = withModelProfile(normalizeAgentPreferences(undefined, [external]), {
      agentId: "third-party",
      modelId: "opaque",
      tags: ["Flush", IMAGE_TAG],
      cost: "medium",
    });
    expect(resolveTagRoute(configured, ["Flush", IMAGE_TAG], [external])?.agent.id).toBe(
      "third-party",
    );
  });

  it("keeps multiple models from the same Agent and custom tags as independent rows", () => {
    let preferences = normalizeAgentPreferences(undefined, [agent()]);
    preferences = withModelProfile(preferences, {
      agentId: "codex",
      modelId: "text",
      tags: ["Max", "私有"],
      cost: "veryHigh",
    });
    preferences = withSelectedTags(preferences, ["max", "私有", "MAX"]);
    expect(preferences.modelProfiles?.filter((row) => row.agentId === "codex")).toHaveLength(3);
    expect(preferences.selectedTags).toEqual(["Max", "私有"]);
    expect(availableAgentTags(preferences)).toContain("私有");
  });
});
