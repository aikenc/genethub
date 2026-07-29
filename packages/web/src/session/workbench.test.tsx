import type { AgentInfo, TimelineItem } from "@genehub/proto";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";
import { ComposerControls } from "./ComposerControls";
import { PermissionCard } from "./Permission";
import { Timeline } from "./Timeline";
import { ToolCallView } from "./ToolCall";
import { apply, emptyTimeline } from "./timeline";

const agent = (overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "genet",
  label: "GeneHub Agent",
  probe: { state: "ready" },
  builtin: true,
  capabilities: {
    interrupt: true,
    setModel: true,
    setMode: true,
    permissions: false,
    resume: true,
    attachments: false,
  },
  catalog: {
    models: [{ id: "deepseek/v4", label: "DeepSeek V4", contextWindow: 128000, reasoning: true }],
    modes: [{ id: "high", label: "Thinking: high" }],
    defaultModel: "deepseek/v4",
    defaultMode: "high",
  },
  ...overrides,
});

describe("what the user sees in a session", () => {
  it("shows the reply as it streams rather than only when it finishes", () => {
    let state = emptyTimeline();
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "assistantMessage", id: "a1", text: "" },
    });
    state = apply(state, {
      type: "itemDelta",
      turnId: "t1",
      itemId: "a1",
      delta: { kind: "text", delta: "正在读取" },
    });

    render(<Timeline state={state} />);
    expect(screen.getByTestId("assistant-message")).toHaveTextContent("正在读取");
  });

  it("keeps thinking out of the way until it is asked for", async () => {
    const state = apply(emptyTimeline(), {
      type: "item",
      turnId: "t1",
      item: { type: "reasoning", id: "r1", text: "先看看目录结构" },
    });

    render(<Timeline state={state} />);
    expect(screen.queryByText("先看看目录结构")).not.toBeInTheDocument();

    await userEvent.click(screen.getByText("思考过程"));
    expect(screen.getByText("先看看目录结构")).toBeInTheDocument();
  });

  it("renders a shell call as its command and output", () => {
    render(
      <ToolCallView
        name="bash"
        status="ok"
        detail={{ kind: "shell", command: "ls -a", output: "a\nb", exitCode: 0 }}
      />,
    );
    expect(screen.getByText("ls -a")).toBeInTheDocument();
    expect(screen.getByTestId("tool-call")).toHaveTextContent("a b");
  });

  it("colours an edit so the change is readable at a glance", () => {
    render(
      <ToolCallView
        name="edit"
        status="ok"
        detail={{ kind: "edit", path: "src/main.rs", diff: "@@ -1 +1 @@\n-old\n+new" }}
      />,
    );
    const diff = screen.getByTestId("diff");
    expect(diff).toHaveTextContent("-old");
    expect(diff).toHaveTextContent("+new");
  });

  it("shows a tool it has never heard of instead of dropping it", async () => {
    render(
      <ToolCallView
        name="teleport"
        status="error"
        detail={{ kind: "unknown", raw: { arguments: { destination: "mars" } } }}
      />,
    );

    expect(screen.getByText("teleport")).toBeInTheDocument();
    await userEvent.click(screen.getByText("展开原始数据"));
    expect(screen.getByTestId("tool-call")).toHaveTextContent("mars");
  });

  it("says a turn failed, in the words the daemon used", () => {
    const state = apply(emptyTimeline(), {
      type: "turnFailed",
      turnId: "t1",
      error: { code: "missingCredentials", message: "还没有配置模型密钥" },
    });

    render(<Timeline state={state} />);
    expect(screen.getByRole("alert")).toHaveTextContent("还没有配置模型密钥");
  });
});


function composerProps(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  return {
    running: false,
    agents: [agent()],
    agentId: "genet",
    modelId: null,
    modeId: null,
    onSend: () => {},
    onInterrupt: () => {},
    onPickAgent: () => {},
    onPickModel: () => {},
    onPickMode: () => {},
    ...overrides,
  };
}

describe("the controls offered to the user", () => {
  it("does not offer a model picker for an agent that cannot switch models", () => {
    const fixed = agent({
      id: "fixed",
      capabilities: { ...agent().capabilities, setModel: false, setMode: false },
    });

    render(
      <ComposerControls
        agents={[fixed]}
        agentId="fixed"
        modelId={null}
        modeId={null}
        onPickAgent={() => {}}
        onPickModel={() => {}}
        onPickMode={() => {}}
      />,
    );

    expect(screen.getByLabelText("agent")).toBeInTheDocument();
    expect(screen.queryByLabelText("模型")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("模式")).not.toBeInTheDocument();
  });

  it("leaves an agent that is not installed out of the picker entirely", () => {
    render(
      <ComposerControls
        agents={[agent(), agent({ id: "opencode", label: "OpenCode", probe: { state: "notInstalled" } })]}
        agentId="genet"
        modelId={null}
        modeId={null}
        onPickAgent={() => {}}
        onPickModel={() => {}}
        onPickMode={() => {}}
      />,
    );

    const picker = screen.getByLabelText("agent") as HTMLSelectElement;
    expect([...picker.options].map((option) => option.textContent)).toEqual(["GeneHub Agent"]);
  });

  it("sends on enter and keeps shift+enter for a new line", async () => {
    const onSend = vi.fn();
    render(<Composer {...composerProps({ onSend })} />);

    const box = screen.getByLabelText("任务描述");
    await userEvent.type(box, "改一下 README{Shift>}{Enter}{/Shift}再加一段");
    expect(onSend).not.toHaveBeenCalled();

    await userEvent.type(box, "{Enter}");
    expect(onSend).toHaveBeenCalledWith("改一下 README\n再加一段");
  });

  it("refuses to send an empty prompt", async () => {
    const onSend = vi.fn();
    render(<Composer {...composerProps({ onSend })} />);
    await userEvent.type(screen.getByLabelText("任务描述"), "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("turns send into stop while a turn is running", async () => {
    const onInterrupt = vi.fn();
    render(<Composer {...composerProps({ running: true, onInterrupt })} />);

    expect(screen.queryByLabelText("发送")).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("停止"));
    expect(onInterrupt).toHaveBeenCalled();
  });

  it("asks for approval in the timeline and reports which option was chosen", async () => {
    const onAnswer = vi.fn();
    render(
      <PermissionCard
        request={{
          id: "p1",
          title: "允许运行 rm -rf build？",
          detail: "rm -rf build",
          options: [
            { id: "allow", label: "允许一次", kind: "allowOnce" },
            { id: "deny", label: "拒绝", kind: "reject" },
          ],
        }}
        onAnswer={onAnswer}
      />,
    );

    await userEvent.click(screen.getByText("允许一次"));
    expect(onAnswer).toHaveBeenCalledWith({ outcome: "selected", optionId: "allow" });
  });
});

describe("a whole turn as the timeline sees it", () => {
  it("goes from prompt to tool call to answer without losing anything", () => {
    const call: TimelineItem = {
      type: "toolCall",
      id: "c1",
      name: "write",
      status: "pending",
      detail: { kind: "write", path: "hello.txt", content: "hi" },
    };

    let state = emptyTimeline();
    for (const event of [
      {
        type: "item" as const,
        turnId: "t1",
        item: { type: "userMessage" as const, id: "u1", text: "写个文件", attachments: [] },
      },
      { type: "turnStarted" as const, turnId: "t1" },
      { type: "item" as const, turnId: "t1", item: call },
      {
        type: "itemDelta" as const,
        turnId: "t1",
        itemId: "c1",
        delta: { kind: "toolStatus" as const, status: "ok" as const },
      },
      {
        type: "item" as const,
        turnId: "t1",
        item: { type: "assistantMessage" as const, id: "a1", text: "写好了。" },
      },
      {
        type: "turnCompleted" as const,
        turnId: "t1",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: undefined,
        },
      },
    ]) {
      state = apply(state, event);
    }

    render(<Timeline state={state} />);
    expect(screen.getByText("写个文件")).toBeInTheDocument();
    expect(screen.getByTestId("tool-call")).toHaveTextContent("hello.txt");
    expect(screen.getByTestId("assistant-message")).toHaveTextContent("写好了。");
    expect(state.status).toBe("idle");
  });
});
