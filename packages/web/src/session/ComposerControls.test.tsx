import type { AgentInfo } from "@genehub/proto";
import { render, screen } from "@testing-library/react";
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
      setMode: true,
      permissions: false,
      resume: true,
      attachments: false,
    },
    catalog: {
      models: [],
      modes: [{ id: "medium", label: "Medium", description: undefined }],
      commands: [],
      defaultModel: undefined,
      defaultMode: "medium",
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
      permissions: true,
      resume: true,
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
        agentLocked={false}
        onPickAgent={vi.fn()}
        onPickModel={vi.fn()}
        onPickMode={vi.fn()}
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
        agentLocked={true}
        onPickAgent={vi.fn()}
        onPickModel={vi.fn()}
        onPickMode={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("agent")).toBeDisabled();
  });
});

/**
 * genet's `mode` axis is thinking effort; claude/acp reuse the same axis for
 * tool-approval policy. Nothing else in the payload says which is which, so
 * the chip must read `capabilities.permissions` to caption itself correctly.
 */
describe("the mode chip's caption", () => {
  it("reads '思考' for an agent without permissions (genet)", () => {
    render(
      <ComposerControls
        agents={AGENTS}
        agentId="genet"
        modelId={null}
        modeId={null}
        onPickAgent={vi.fn()}
        onPickModel={vi.fn()}
        onPickMode={vi.fn()}
      />,
    );
    expect(screen.getByText("思考")).toBeInTheDocument();
  });

  it("reads '权限' for an agent with permissions (claude)", () => {
    render(
      <ComposerControls
        agents={AGENTS}
        agentId="claude"
        modelId={null}
        modeId={null}
        onPickAgent={vi.fn()}
        onPickModel={vi.fn()}
        onPickMode={vi.fn()}
      />,
    );
    expect(screen.getByText("权限")).toBeInTheDocument();
  });
});
