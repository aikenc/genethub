import type { AgentInfo, AgentSelectionPreferences } from "@genehub/proto";
import { describe, expect, it } from "vitest";

import {
  capabilityForRoute,
  normalizeAgentPreferences,
  resolveCapabilityRoute,
  withCapabilityRoutes,
  withRuntimePreference,
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
        },
        {
          id: "vision",
          label: "Vision",
          reasoning: true,
          efforts: ["low", "medium", "high"],
          inputModalities: ["image"],
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

describe("machine capability preferences", () => {
  it("derives a first-run proposal but keeps a saved empty list empty", () => {
    const derived = normalizeAgentPreferences(undefined, [agent()]);
    expect(derived.capabilities.planning).toEqual([{ agentId: "codex", modelId: "text" }]);
    expect(derived.capabilities.multimodal).toEqual([
      { agentId: "codex", modelId: "vision" },
    ]);

    const saved = { ...derived, capabilities: { ...derived.capabilities, planning: [] } };
    expect(normalizeAgentPreferences(saved, [agent()]).capabilities.planning).toEqual([]);
  });

  it("defaults to high thinking and unrestricted permission", () => {
    const preferences = normalizeAgentPreferences(undefined, [agent()]);
    const route = resolveCapabilityRoute(preferences, "planning", [agent()]);
    expect(route).toMatchObject({
      modelId: "text",
      effortId: "high",
      modeId: "full-access",
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
    const preferences = normalizeAgentPreferences(undefined, [custom]);
    expect(resolveCapabilityRoute(preferences, "planning", [custom])?.effortId).toBe(
      "xhigh",
    );
  });

  it("remembers the last valid runtime choices at machine scope", () => {
    const initial = normalizeAgentPreferences(undefined, [agent()]);
    const remembered = withRuntimePreference(initial, "codex", {
      effortId: "xhigh",
      modeId: "read-only",
    });
    expect(resolveCapabilityRoute(remembered, "planning", [agent()])).toMatchObject({
      effortId: "xhigh",
      modeId: "read-only",
    });
  });

  it("tries the next exact route when a preferred Agent or model is unavailable", () => {
    const fallback = agent({ id: "claude", label: "Claude", builtin: false });
    const preferences: AgentSelectionPreferences = {
      capabilities: {
        planning: [
          { agentId: "missing", modelId: "text" },
          { agentId: "codex", modelId: "withdrawn" },
          { agentId: "claude", modelId: "text" },
        ],
        coding: [],
        multimodal: [],
      },
      selectedCapability: "planning",
      runtimes: {},
    };
    expect(resolveCapabilityRoute(preferences, "planning", [agent(), fallback])?.agent.id).toBe(
      "claude",
    );
  });

  it("keeps each exact route unique and prefers the remembered capability for ambiguous history", () => {
    const initial = normalizeAgentPreferences(undefined, [agent()]);
    const duplicated = withCapabilityRoutes(initial, "coding", [
      { agentId: "codex", modelId: "text" },
      { agentId: "codex", modelId: "text" },
      { agentId: "codex", modelId: "vision" },
    ]);
    expect(duplicated.capabilities.coding).toEqual([
      { agentId: "codex", modelId: "text" },
      { agentId: "codex", modelId: "vision" },
    ]);

    const selectedCoding = { ...duplicated, selectedCapability: "coding" as const };
    expect(capabilityForRoute(selectedCoding, "codex", "text")).toBe("coding");
  });
});
