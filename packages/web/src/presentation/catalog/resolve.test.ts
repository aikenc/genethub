import { describe, expect, it } from "vitest";

import { agentAssets } from "../../assets/agents";
import agentConfig from "./agents.json";
import modelConfig from "./model-aliases.json";
import {
  resolveAgentPresentation,
  resolveAgentProfile,
  resolveEffortBadge,
  resolveModeBadge,
  resolveModelPresentation,
  resolveModelTraits,
  truncateGraphemes,
} from "./resolve";
import badgeConfig from "./runtime-badges.json";

describe("Agent presentation catalog", () => {
  it("covers every built-in registry Agent with an icon, glyph, or name", () => {
    expect(resolveAgentPresentation({ id: "genet", label: "GeneHub Agent" }).kind).toBe("icon");
    expect(resolveAgentPresentation({ id: "opencode", label: "OpenCode" }).kind).toBe("icon");
    expect(resolveAgentPresentation({ id: "acp:goose", label: "goose" }).kind).toBe("icon");
    expect(resolveAgentPresentation({ id: "claude", label: "Claude Code" })).toMatchObject({
      kind: "glyph",
      glyph: "✱",
    });
    expect(resolveAgentPresentation({ id: "codex", label: "Codex" })).toEqual({
      kind: "text",
      label: "Codex",
    });
    expect(resolveAgentPresentation({ id: "cursor", label: "Cursor" }).kind).toBe("icon");
    expect(resolveAgentPresentation({ id: "acp", label: "ACP agent" }).kind).toBe("icon");
    expect(
      resolveAgentPresentation({ id: "acp:github-copilot", label: "GitHub Copilot" }),
    ).toEqual({ kind: "text", label: "GitHub Copilot" });
  });

  it("does not guess a vendor icon from an arbitrary custom Agent label", () => {
    expect(resolveAgentPresentation({ id: "acp:private", label: "My Codex wrapper" })).toEqual({
      kind: "text",
      label: "My Codex wrapper",
    });
    expect(resolveAgentPresentation({ id: "acp:private", label: "" })).toEqual({
      kind: "text",
      label: "acp:private",
    });
  });
});

describe("presentation catalog integrity", () => {
  it("keeps supported schema versions and unique exact keys", () => {
    expect(agentConfig.version).toBe(1);
    expect(modelConfig.version).toBe(1);
    expect(badgeConfig.version).toBe(1);

    const agentIds = agentConfig.agents.flatMap((rule) => rule.ids);
    expect(new Set(agentIds).size).toBe(agentIds.length);
    const modelKeys = modelConfig.exact.map(
      (rule) => `${rule.agentId ?? "*"}\u0000${rule.modelId}`,
    );
    expect(new Set(modelKeys).size).toBe(modelKeys.length);
    const permissionKeys = badgeConfig.permissions.flatMap((rule) =>
      rule.agentIds.flatMap((agentId) => rule.ids.map((modeId) => `${agentId}\u0000${modeId}`)),
    );
    expect(new Set(permissionKeys).size).toBe(permissionKeys.length);
  });

  it("references only bundled assets and keeps labels non-empty", () => {
    for (const rule of agentConfig.agents) {
      expect(rule.ids.every(Boolean)).toBe(true);
      expect(rule.label.trim()).not.toBe("");
      expect(["permission", "workflow", "unknown"]).toContain(rule.modeKind);
      expect(typeof rule.startWithoutModelCatalog).toBe("boolean");
      if ("assetId" in rule && rule.assetId) expect(agentAssets).toHaveProperty(rule.assetId);
    }
    for (const rule of modelConfig.exact) {
      expect(rule.modelId.trim()).not.toBe("");
      expect(rule.shortLabel.trim()).not.toBe("");
    }
    expect(modelConfig.fallback.maxGraphemes).toBe(8);
  });
});

describe("model display names", () => {
  it("uses a scoped exact mapping before the runtime label", () => {
    expect(
      resolveModelPresentation({
        agentId: "codex",
        modelId: "codex-auto-review",
        modelLabel: "GPT-5.6-Luna",
      }),
    ).toMatchObject({ shortLabel: "5.6 Luna·审查", source: "scoped-map" });
  });

  it("uses the first eight graphemes of an unmapped runtime label", () => {
    expect(
      resolveModelPresentation({
        agentId: "genet",
        modelId: "provider/anything",
        modelLabel: "一二三四五六七八九十",
      }).shortLabel,
    ).toBe("一二三四五六七八…");
  });

  it("falls back to the last provider/id segment when no label exists", () => {
    expect(
      resolveModelPresentation({
        agentId: "genet",
        modelId: "private-provider/long-model-name",
      }).shortLabel,
    ).toBe("long-mod…");
  });

  it("applies the same eight-grapheme fallback to every dynamic Agent catalog", () => {
    for (const agentId of ["genet", "opencode", "claude", "codex", "cursor", "acp"]) {
      expect(
        resolveModelPresentation({
          agentId,
          modelId: "provider/runtime-model-123",
          modelLabel: "Runtime Model 123",
        }).shortLabel,
      ).toBe("Runtime …");
    }
  });

  it("does not split a joined emoji grapheme", () => {
    expect(truncateGraphemes("👨‍👩‍👧‍👦abcdefghi", 8)).toBe("👨‍👩‍👧‍👦abcdefg…");
  });
});

describe("runtime badges", () => {
  it("does not invent a thinking level when the Agent supplied no default", () => {
    expect(resolveEffortBadge(null)).toEqual({
      level: "auto",
      shortLabel: "默认",
      fullLabel: "默认",
    });
  });

  it.each([
    ["off", "off", "关", "关闭"],
    ["minimal", 1, "微", "极低"],
    ["low", 2, "低", "低"],
    ["medium", 3, "中", "中"],
    ["high", 4, "高", "高"],
    ["xhigh", 5, "极", "极高"],
    ["max", 5, "满", "最大"],
    ["ultra", 5, "超", "超高"],
  ])(
    "places the %s thinking level on the dial",
    (id, level, shortLabel, fullLabel) => {
      expect(resolveEffortBadge(id)).toEqual({ level, shortLabel, fullLabel });
    },
  );

  it("keeps an unknown Agent-supplied thinking level instead of placing it on the dial", () => {
    expect(resolveEffortBadge("extreme")).toEqual({
      level: "auto",
      shortLabel: "ex",
      fullLabel: "extreme",
    });
  });

  it("reads vision off well-known model families and never guesses it away", () => {
    expect(
      resolveModelTraits({ id: "anthropic/claude-sonnet-4", label: "Sonnet 4", reasoning: true }),
    ).toEqual({ reasoning: true, multimodal: true });
    expect(
      resolveModelTraits({ id: "qwen/qwen3-vl-plus", label: "Qwen3 VL", reasoning: false }),
    ).toEqual({ reasoning: false, multimodal: true });
    // Unlisted is unknown, and unknown shows nothing rather than a claim.
    expect(
      resolveModelTraits({ id: "private/in-house-1", label: "In house", reasoning: false }),
    ).toEqual({ reasoning: false, multimodal: false });
  });

  it("separates a permission policy from an ACP workflow selector", () => {
    expect(resolveAgentProfile("codex").modeKind).toBe("permission");
    expect(resolveAgentProfile("claude").modeKind).toBe("permission");
    expect(resolveAgentProfile("cursor").modeKind).toBe("workflow");
    expect(resolveAgentProfile("acp:private")).toEqual({
      modeKind: "unknown",
      startWithoutModelCatalog: true,
    });
  });

  it("only shows the unlock emoji for known unrestricted modes", () => {
    expect(
      resolveModeBadge({
        agentId: "codex",
        permissions: true,
        modeId: "full-access",
        modeLabel: "Full access",
      }),
    ).toMatchObject({ emoji: "🔓", risk: "unrestricted" });
    expect(
      resolveModeBadge({
        agentId: "codex",
        permissions: true,
        modeId: "vendor-new-mode",
        modeLabel: "Vendor mode",
      }),
    ).toMatchObject({ emoji: "🛡️", risk: "unknown" });
    expect(
      resolveModeBadge({
        agentId: "acp:codex",
        permissions: true,
        modeId: "full-access",
        modeLabel: "Vendor full access",
      }),
    ).toMatchObject({ emoji: "🛡️", fullLabel: "Vendor full access", risk: "unknown" });
  });

  it("uses a neutral settings badge for a non-permission mode axis", () => {
    expect(
      resolveModeBadge({
        agentId: "acp:goose",
        permissions: false,
        modeId: "agent",
        modeLabel: "Agent",
      }),
    ).toMatchObject({ emoji: "⚙️", fullLabel: "Agent" });
  });
});
