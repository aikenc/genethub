import type { AgentInfo } from "@genehub/proto";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ComposerControls } from "./ComposerControls";

const AGENTS: AgentInfo[] = [
  {
    id: "genet",
    label: "GeneHub Agent",
    builtin: true,
    probe: { state: "ready" },
    capabilities: {
      interrupt: true,
      setModel: true,
      // Thinking, which for our own agent is the only such dial it has.
      setMode: false,
      setEffort: true,
      permissions: false,
      resume: true,
      fork: false,
      attachments: false,
    },
    catalog: {
      models: [
        { id: "deepseek/v4", label: "DeepSeek V4", reasoning: true, efforts: ["low", "high"] },
      ],
      modes: [],
      commands: [],
      defaultModel: "deepseek/v4",
      defaultMode: undefined,
      defaultEffort: "low",
    },
  },
  {
    id: "claude",
    label: "Claude Code",
    builtin: false,
    probe: { state: "ready" },
    capabilities: {
      interrupt: true,
      setModel: false,
      setMode: true,
      setEffort: false,
      permissions: true,
      resume: true,
      fork: false,
      attachments: false,
    },
    catalog: {
      models: [],
      modes: [{ id: "default", label: "Default", description: undefined }],
      commands: [],
      defaultModel: undefined,
      defaultMode: "default",
    },
  },
];

/**
 * Switching agents mid-conversation does not hand the conversation over —
 * each CLI keeps its own incompatible session state — it silently opens a
 * second, empty session instead. Once a conversation exists, the picker
 * locks rather than doing that surprise.
 */
describe("the agent picker once a conversation has started", () => {
  it("is enabled with nothing said yet", () => {
    render(
      <ComposerControls
        agents={AGENTS}
        agentId="genet"
        modelId={null}
        modeId={null}
      effortId={null}
        agentLocked={false}
        onPickAgent={vi.fn()}
        onPickModel={vi.fn()}
        onPickMode={vi.fn()}
        onPickEffort={() => {}}
      />,
    );
    expect(screen.getByLabelText("agent")).toBeEnabled();
  });

  it("locks once the session has history", () => {
    render(
      <ComposerControls
        agents={AGENTS}
        agentId="genet"
        modelId={null}
        modeId={null}
      effortId={null}
        agentLocked={true}
        onPickAgent={vi.fn()}
        onPickModel={vi.fn()}
        onPickMode={vi.fn()}
        onPickEffort={() => {}}
      />,
    );
    expect(screen.getByLabelText("agent")).toBeDisabled();
  });

  it("does not show Codex while the session is still bound to an unavailable built-in", () => {
    const onPickAgent = vi.fn();
    const agents: AgentInfo[] = [
      { ...AGENTS[0]!, probe: { state: "notInstalled" } },
      { ...AGENTS[1]!, id: "codex", label: "Codex", catalog: { ...AGENTS[0]!.catalog } },
    ];
    render(
      <ComposerControls
        agents={agents}
        agentId="genet"
        modelId={null}
        modeId={null}
        effortId={null}
        agentLocked={false}
        onPickAgent={onPickAgent}
        onPickModel={vi.fn()}
        onPickMode={vi.fn()}
        onPickEffort={vi.fn()}
      />,
    );

    const picker = screen.getByLabelText("agent") as HTMLSelectElement;
    expect(picker.value).toBe("genet");
    expect(picker.selectedOptions[0]?.textContent).toBe("GeneHub Agent（不可用）");

    fireEvent.change(picker, { target: { value: "codex" } });
    expect(onPickAgent).toHaveBeenCalledWith("codex");
  });

  it("shows the same usable default agent that a new draft will send through", () => {
    const agents: AgentInfo[] = [
      { ...AGENTS[0]!, catalog: { ...AGENTS[0]!.catalog, models: [] } },
      { ...AGENTS[1]!, id: "codex", label: "Codex", catalog: { ...AGENTS[0]!.catalog } },
    ];
    render(
      <ComposerControls
        agents={agents}
        agentId={null}
        modelId={null}
        modeId={null}
        effortId={null}
        onPickAgent={vi.fn()}
        onPickModel={vi.fn()}
        onPickMode={vi.fn()}
        onPickEffort={vi.fn()}
      />,
    );

    expect((screen.getByLabelText("agent") as HTMLSelectElement).value).toBe("codex");
  });
});

/**
 * Thinking used to ride on the `mode` axis for our own agent while claude used
 * that same axis for tool-approval policy — one chip that meant two unrelated
 * things depending on who you were talking to, and the only way to tell was a
 * capability flag. Thinking now has its own axis, so each chip means one thing.
 */
describe("the thinking and permission chips", () => {
  const controls = (agentId: string) =>
    render(
      <ComposerControls
        agents={AGENTS}
        agentId={agentId}
        modelId={null}
        modeId={null}
        effortId={null}
        onPickAgent={vi.fn()}
        onPickModel={vi.fn()}
        onPickMode={vi.fn()}
        onPickEffort={vi.fn()}
      />,
    );

  it("offers thinking from the levels the model named", () => {
    controls("genet");

    const thinking = screen.getByLabelText("思考强度");
    expect([...thinking.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "low",
      "high",
    ]);
    // No permission chip: our own agent has no approval flow to have a policy about.
    expect(screen.queryByLabelText("模式")).not.toBeInTheDocument();
  });

  it("offers permissions where they exist, and no thinking where the model has none", () => {
    controls("claude");

    expect(screen.getByText("权限")).toBeInTheDocument();
    // This fixture's claude lists no levels, so the control that would pretend to
    // set one is absent rather than empty.
    expect(screen.queryByLabelText("思考强度")).not.toBeInTheDocument();
  });

  it("says '默认' rather than naming a level nobody chose", () => {
    // Claude Code never reports which level it is on. Showing the weakest one as
    // if it were in force would be a wrong answer dressed as a known one.
    const agents = AGENTS.map((agent) =>
      agent.id === "claude"
        ? {
            ...agent,
            capabilities: { ...agent.capabilities, setEffort: true },
            catalog: {
              ...agent.catalog,
              models: [{ id: "default", label: "Default", reasoning: true, efforts: ["low", "max"] }],
              defaultModel: "default",
              defaultEffort: undefined,
            },
          }
        : agent,
    );
    render(
      <ComposerControls
        agents={agents}
        agentId="claude"
        modelId={null}
        modeId={null}
        effortId={null}
        onPickAgent={vi.fn()}
        onPickModel={vi.fn()}
        onPickMode={vi.fn()}
        onPickEffort={vi.fn()}
      />,
    );

    const thinking = screen.getByLabelText("思考强度");
    expect([...thinking.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "默认",
      "low",
      "max",
    ]);
    expect((thinking as HTMLSelectElement).value).toBe("");
  });
});
