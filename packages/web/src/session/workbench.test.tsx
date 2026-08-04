import type { AgentInfo, TimelineItem } from "@genehub/proto";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { useWorkbench } from "./store";
import {
  COMPOSER_TEXTAREA_MAX_HEIGHT,
  COMPOSER_TEXTAREA_MIN_HEIGHT,
  Composer,
  resizeComposerTextarea,
} from "./Composer";
import { ComposerControls } from "./ComposerControls";
import { PermissionCard } from "./Permission";
import { TimelineView } from "./TimelineView";
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
    setEffort: false,
    permissions: false,
    resume: true,
    fork: false,
    attachments: false,
  },
  catalog: {
    models: [
      {
        id: "deepseek/v4",
        label: "DeepSeek V4",
        contextWindow: 128000,
        reasoning: true,
        efforts: ["low", "high"],
      },
    ],
    modes: [],
    commands: [],
    defaultModel: "deepseek/v4",
    defaultMode: undefined,
    defaultEffort: "high",
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

    render(<TimelineView state={state} />);
    expect(screen.getByTestId("assistant-message")).toHaveTextContent("正在读取");
  });

  it("keeps thinking out of the way until it is asked for", async () => {
    const state = apply(emptyTimeline(), {
      type: "item",
      turnId: "t1",
      item: { type: "reasoning", id: "r1", text: "先看看目录结构" },
    });

    render(<TimelineView state={state} />);
    expect(screen.queryByText("先看看目录结构")).not.toBeInTheDocument();

    await userEvent.click(screen.getByText("思考过程"));
    expect(screen.getByText("先看看目录结构")).toBeInTheDocument();
  });

  it("keeps a successful shell call compact until its details are requested", async () => {
    render(
      <ToolCallView
        name="bash"
        status="ok"
        detail={{ kind: "shell", command: "ls -a", output: "a\nb", exitCode: 0 }}
      />,
    );
    expect(screen.getByText("ls -a")).toBeInTheDocument();
    expect(screen.getByTestId("tool-call")).not.toHaveTextContent("a b");

    expect(screen.getByRole("img", { name: "执行命令" })).toHaveTextContent("🖥️");
    await userEvent.click(screen.getByRole("button", { name: "查看输出" }));
    expect(screen.getByTestId("tool-call")).toHaveTextContent("a b");
  });

  it("renders the bounded overview but expands only the output", async () => {
    render(
      <ToolCallView
        name="bash"
        status="ok"
        detail={{
          kind: "overview",
          toolKind: "shell",
          overview: "检查构建",
          input: "npm test",
          output: "全部通过",
        }}
      />,
    );
    expect(screen.getByText("检查构建")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "查看输出" }));
    expect(screen.queryByText("npm test")).not.toBeInTheDocument();
    expect(screen.getByText("全部通过")).toBeInTheDocument();
  });

  it("keeps legacy output to the first two and last two 64-character lines", async () => {
    render(
      <ToolCallView
        name="legacy"
        status="ok"
        detail={{
          kind: "overview",
          toolKind: "other",
          overview: "旧机器输出",
          input: "ignored",
          output: [`${"a".repeat(80)}`, "second", "middle", "fourth", "last"].join("\n"),
        }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "查看输出" }));
    const output = screen.getByText(/已省略 1 行/).textContent ?? "";
    expect(output.split("\n")).toHaveLength(5);
    expect(output.split("\n")[0]).toHaveLength(64);
    expect(output).not.toContain("middle");
    expect(output).toContain("fourth\nlast");
  });

  it("shows an edit with its own emoji and expands its output", async () => {
    render(
      <ToolCallView
        name="edit"
        status="ok"
        detail={{ kind: "edit", path: "src/main.rs", diff: "@@ -1 +1 @@\n-old\n+new" }}
      />,
    );
    expect(screen.getByRole("img", { name: "编辑文件" })).toHaveTextContent("✏️");
    await userEvent.click(screen.getByRole("button", { name: "查看输出" }));
    expect(screen.getByTestId("tool-call")).toHaveTextContent("-old");
    expect(screen.getByTestId("tool-call")).toHaveTextContent("+new");
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
    expect(screen.getByLabelText("失败")).toHaveTextContent("!");
    expect(screen.getByTestId("tool-call")).toHaveTextContent("已省略");
  });

  it("says a turn failed, in the words the daemon used", () => {
    const state = apply(emptyTimeline(), {
      type: "turnFailed",
      turnId: "t1",
      error: { code: "missingCredentials", message: "还没有配置模型密钥" },
    });

    render(<TimelineView state={state} />);
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
  it("does not offer a model section for an agent that cannot switch models", async () => {
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
        effortId={null}
        onPickAgent={() => {}}
        onPickModel={() => {}}
        onPickMode={() => {}}
        onPickEffort={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Agent：GeneHub Agent/ }));
    const dialog = screen.getByRole("dialog", { name: "Agent 与运行设置" });
    expect(within(dialog).getByText("Agent")).toBeInTheDocument();
    expect(within(dialog).queryByText("模型")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("模式")).not.toBeInTheDocument();
  });

  it("leaves an agent that is not installed out of the picker entirely", async () => {
    render(
      <ComposerControls
        agents={[agent(), agent({ id: "opencode", label: "OpenCode", probe: { state: "notInstalled" } })]}
        agentId="genet"
        modelId={null}
        modeId={null}
        effortId={null}
        onPickAgent={() => {}}
        onPickModel={() => {}}
        onPickMode={() => {}}
        onPickEffort={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Agent：GeneHub Agent/ }));
    const dialog = screen.getByRole("dialog", { name: "Agent 与运行设置" });
    expect(within(dialog).getByRole("radio", { name: "GeneHub Agent" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("radio", { name: "OpenCode" })).not.toBeInTheDocument();
  });

  it("sends on enter and keeps shift+enter for a new line", async () => {
    const onSend = vi.fn();
    render(<Composer {...composerProps({ onSend })} />);

    const box = screen.getByLabelText("任务描述");
    await userEvent.type(box, "改一下 README{Shift>}{Enter}{/Shift}再加一段");
    expect(onSend).not.toHaveBeenCalled();

    await userEvent.type(box, "{Enter}");
    expect(onSend).toHaveBeenCalledWith("改一下 README\n再加一段", []);
  });

  it("refuses to send an empty prompt", async () => {
    const onSend = vi.fn();
    render(<Composer {...composerProps({ onSend })} />);
    await userEvent.type(screen.getByLabelText("任务描述"), "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("grows the textarea from two to four lines and then scrolls internally", () => {
    const box = document.createElement("textarea");
    Object.defineProperty(box, "scrollHeight", { configurable: true, value: 40 });
    expect(resizeComposerTextarea(box)).toBe(COMPOSER_TEXTAREA_MIN_HEIGHT);
    expect(box.style.overflowY).toBe("hidden");

    Object.defineProperty(box, "scrollHeight", { configurable: true, value: 96 });
    expect(resizeComposerTextarea(box)).toBe(96);

    Object.defineProperty(box, "scrollHeight", { configurable: true, value: 180 });
    expect(resizeComposerTextarea(box)).toBe(COMPOSER_TEXTAREA_MAX_HEIGHT);
    expect(box.style.overflowY).toBe("auto");
  });

  /** Pasting and the one paperclip entry both use the same attachment path. */
  function pasteImage(box: HTMLElement, name = "shot.png") {
    const file = new File(["fake-bytes"], name, { type: "image/png" });
    fireEvent.paste(box, {
      clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] },
    });
  }

  it("turns a pasted screenshot into a thumbnail and sends it as an attachment", async () => {
    const onSend = vi.fn();
    render(<Composer {...composerProps({ onSend, attachmentsSupported: true })} />);

    pasteImage(screen.getByLabelText("任务描述"));
    await waitFor(() => expect(screen.getByAltText("shot.png")).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText("发送"));
    expect(onSend).toHaveBeenCalledWith(
      "",
      expect.arrayContaining([
        expect.objectContaining({ name: "shot.png", mime: "image/png", dataBase64: expect.any(String) }),
      ]),
    );
    // The strip clears once the message goes out, same as the draft text does.
    expect(screen.queryByAltText("shot.png")).not.toBeInTheDocument();
  });

  it("uses one file button for images and resets the picker after every choice", async () => {
    const onSend = vi.fn();
    const { container } = render(
      <Composer {...composerProps({ onSend, attachmentsSupported: true })} />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["fake-bytes"], "picked.png", { type: "image/png" });

    expect(screen.getByRole("button", { name: "添加文件" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /添加图片/ })).not.toBeInTheDocument();
    await userEvent.upload(input, file);
    await waitFor(() => expect(screen.getByAltText("picked.png")).toBeInTheDocument());
    expect(input.value).toBe("");

    await userEvent.click(screen.getByLabelText("发送"));
    expect(onSend).toHaveBeenCalledWith(
      "",
      expect.arrayContaining([expect.objectContaining({ name: "picked.png" })]),
    );
  });

  it("leaves a pasted screenshot as an inert paste when the agent can't take attachments", async () => {
    const onSend = vi.fn();
    render(<Composer {...composerProps({ onSend, attachmentsSupported: false })} />);

    pasteImage(screen.getByLabelText("任务描述"));
    await waitFor(() => expect(screen.getByText("当前 Agent 还不支持附件")).toBeInTheDocument());
    expect(screen.queryByAltText("shot.png")).not.toBeInTheDocument();
  });

  it("turns send into stop while a turn is running", async () => {
    const onInterrupt = vi.fn();
    render(<Composer {...composerProps({ running: true, onInterrupt })} />);

    expect(screen.queryByLabelText("停止")).toBeInTheDocument();
    expect(screen.queryByLabelText("发送")).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("停止"));
    expect(onInterrupt).toHaveBeenCalled();
  });

  it("keeps a two-line input and the same compact footer when it is focused", async () => {
    render(<Composer {...composerProps({ agentLocked: true })} />);

    const box = screen.getByLabelText("任务描述");
    const summary = screen.getByRole("button", { name: /Agent：GeneHub Agent/ });
    expect(box).toHaveAttribute("rows", "2");
    await userEvent.click(box);
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelectorAll('select')).toHaveLength(0);
  });

  it("keeps the rich settings viewable when Agent switching is locked", async () => {
    render(<Composer {...composerProps({ agentLocked: true })} />);
    await userEvent.click(screen.getByRole("button", { name: /Agent：GeneHub Agent/ }));
    const dialog = screen.getByRole("dialog", { name: "Agent 与运行设置" });
    expect(within(dialog).getByRole("radio", { name: "GeneHub Agent" })).toBeDisabled();
    expect(within(dialog).getByText(/当前会话已有内容/)).toBeInTheDocument();
  });

  it("asks for approval in the timeline and reports which option was chosen", async () => {
    const onAnswer = vi.fn();
    render(
      <PermissionCard
        request={{
          id: "p1",
          kind: "permission",
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
    expect(screen.getByText("任务已暂停；授权后会以最高权限从原会话继续。")).toBeInTheDocument();
  });

  it("distinguishes an Agent question from a permission grant", () => {
    render(
      <PermissionCard
        request={{
          id: "q1",
          kind: "question",
          title: "选择发布环境",
          options: [{ id: "beta", label: "Beta", kind: "allowOnce" }],
        }}
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Agent 提问")).toBeInTheDocument();
    expect(screen.getByText("任务已暂停；回答后会从原会话继续。")).toBeInTheDocument();
  });
});

describe("a whole turn as the timeline sees it", () => {
  it("keeps its compact metrics and reveals token details on demand", async () => {
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
      { type: "turnStarted" as const, turnId: "t1", startedAtMs: 1 },
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
        type: "item" as const,
        turnId: "t1",
        item: {
          type: "turnSummary" as const,
          id: "summary-t1",
          stats: {
            turnId: "t1",
            outcome: "completed" as const,
            startedAtMs: Date.now() - 125_000,
            finishedAtMs: Date.now() - 120_000,
            durationMs: 5_000,
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 3,
              cacheWriteTokens: 0,
              costUsd: undefined,
            },
            toolCalls: 1,
            forkCheckpoint: undefined,
          },
        },
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

    render(<TimelineView state={state} />);
    expect(screen.getByText("写个文件")).toBeInTheDocument();
    expect(screen.getByTestId("tool-call")).toHaveTextContent("hello.txt");
    expect(screen.getByTestId("assistant-message")).toHaveTextContent("写好了。");
    expect(screen.getByTestId("turn-footer")).toHaveTextContent("2 分钟前");
    expect(screen.getByTestId("turn-footer")).toHaveTextContent("耗时 5s");
    expect(screen.queryByText("Cached 3")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /5 输出 tokens/ }));
    expect(screen.getByText("Cached 3")).toBeInTheDocument();
    expect(screen.getByText("Input 10")).toBeInTheDocument();
    expect(screen.getByText("Tools 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fork" })).toBeDisabled();
    expect(state.status).toBe("idle");
  });
});

describe("a turn that failed", () => {
  /// A failure says one line. What the agent wrote on its way out, and everything
  /// before it, is in the log — which used to be both unreachable and unmentioned,
  /// so "Claude Code stopped unexpectedly." was the end of the road.
  it("offers the log, and opens it in a tab", async () => {
    useWorkbench.setState({ tabs: [], activeTabId: null });
    const state = apply(emptyTimeline(), {
      type: "turnFailed",
      turnId: "t1",
      error: { code: "agentCrashed", message: "Claude Code 退出了（退出码 1）: Invalid API key" },
    });

    render(<TimelineView state={state} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid API key");

    await userEvent.click(screen.getByText("查看日志"));

    expect(useWorkbench.getState().tabs.map((tab) => tab.kind)).toContain("logs");
  });
});
