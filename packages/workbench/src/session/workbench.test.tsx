import type {
  AgentInfo,
  RoundLayer,
  RoundTrunk,
  SessionSummary,
  TimelineItem,
  WorkspaceInfo,
} from "@genehub/proto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWorkbench } from "./store";
import type { Client } from "../protocol/client";
import {
  COMPOSER_TEXTAREA_DESKTOP_MAX_HEIGHT,
  COMPOSER_TEXTAREA_DESKTOP_MIN_HEIGHT,
  COMPOSER_TEXTAREA_PHONE_MAX_HEIGHT,
  COMPOSER_TEXTAREA_PHONE_MIN_HEIGHT,
  Composer,
  quietFor,
  resolveComposerPhase,
  resizeComposerTextarea,
} from "./Composer";
import { ComposerControls } from "./ComposerControls";
import { NewSessionPanel } from "./NewSessionPanel";
import { PermissionCard } from "./Permission";
import { TimelineView } from "./TimelineView";
import { ToolCallView } from "./ToolCall";
import { apply, emptyTimeline, type TimelineState } from "./timeline";

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

/** Real actions, so a test that stubs one hands it back. */
const { retryPending, editPending } = useWorkbench.getState();

afterEach(() => {
  // Before the store is reset, so a mounted subscriber cannot re-render into it.
  cleanup();
  useWorkbench.setState({
    timeline: emptyTimeline(),
    sessions: [],
    activeSessionId: null,
    agents: [],
    workspaces: [],
    draft: null,
    retryPending,
    editPending,
    previewFloat: null,
  });
  localStorage.clear();
});

/** Puts one session's round layer on screen, the way a snapshot would. */
function showRounds(state: TimelineState, layer: Partial<TimelineState>): TimelineState {
  const timeline = { ...state, ...layer };
  useWorkbench.setState({ timeline });
  return timeline;
}

/** jsdom lays nothing out, so the scrollport has to be described by hand. */
function stubScrollport(
  element: HTMLElement,
  box: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  for (const [name, value] of Object.entries(box)) {
    Object.defineProperty(element, name, { value, configurable: true, writable: true });
  }
}

describe("what the user sees in a session", () => {
  it("offers a way back to the newest message once the end is out of sight", async () => {
    const onReturnToBottom = vi.fn();
    let state = emptyTimeline();
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "assistantMessage", id: "a1", text: "很久以前" },
    });
    render(
      <TimelineView state={state} bottomInset={128} onReturnToBottom={onReturnToBottom} />,
    );

    const scroller = screen.getByTestId("timeline");
    const back = screen.getByRole("button", { name: "回到最新消息" });
    expect(scroller).toHaveStyle({ paddingBottom: "calc(1.5rem + 128px)" });
    expect(back.parentElement?.parentElement).toHaveStyle({
      bottom: "calc(0.75rem + 128px)",
    });
    expect(back).toHaveClass("opacity-0");

    stubScrollport(scroller, { scrollHeight: 4000, clientHeight: 800, scrollTop: 1200 });
    fireEvent.scroll(scroller);
    expect(back).toHaveClass("opacity-100");

    scroller.scrollTo = vi.fn();
    await userEvent.click(back);
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 4000, behavior: "smooth" });
    expect(onReturnToBottom).toHaveBeenCalled();
    expect(back).toHaveClass("opacity-0");
  });

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

  it("keeps a new turn's streaming reply visible until that turn has a process layer", () => {
    const previous = {
      roundId: "r0",
      userItemId: "u0",
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "completed" as const,
      trunkCount: 0,
    };
    let state = emptyTimeline();
    state = apply(state, {
      type: "item",
      turnId: "t0",
      item: { type: "userMessage", id: "u0", text: "上一问", attachments: [] },
    });
    state = apply(state, {
      type: "item",
      turnId: "t0",
      item: { type: "assistantMessage", id: "a0", text: "上一答" },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "userMessage", id: "u1", text: "下一问", attachments: [] },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "assistantMessage", id: "a1", text: "正在写下一答" },
    });
    state = showRounds(state, { rounds: [previous], roundLayers: {} });

    render(<TimelineView state={state} />);
    expect(screen.getByText("正在写下一答")).toBeInTheDocument();
  });

  it("occupies a process card as soon as a live request exists, before any tool arrives", () => {
    let state = emptyTimeline();
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "userMessage", id: "u1", text: "核对权限", attachments: [] },
    });
    state = { ...state, activeTurn: "t1", activeTurnStartedAtMs: 1 };

    render(<TimelineView state={state} />);
    expect(screen.getByTestId("round-trunk")).toHaveTextContent("🧭");
    expect(screen.getByTestId("round-trunk")).toHaveTextContent("进行中");
    expect(screen.getByTestId("live-tail")).toHaveTextContent("进行中");
    expect(screen.queryByText("思考过程")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tool-call")).not.toBeInTheDocument();
  });

  it("keeps streaming tools inside that process card until the round layer arrives", () => {
    let state = emptyTimeline();
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "userMessage", id: "u1", text: "核对权限", attachments: [] },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "reasoning", id: "think1", text: "先核对权限链路" },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: {
        type: "toolCall",
        id: "c1",
        name: "Read",
        status: "running",
        detail: { kind: "read", path: "role.json", content: "", truncated: false },
        images: [],
      },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "assistantMessage", id: "a1", text: "正在写" },
    });
    state = { ...state, activeTurn: "t1", activeTurnStartedAtMs: 1 };

    render(<TimelineView state={state} />);
    expect(screen.getByText("核对权限")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-message")).toHaveTextContent("正在写");
    expect(screen.queryByText("思考过程")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tool-call")).not.toBeInTheDocument();
    expect(screen.getByTestId("round-trunk")).toHaveTextContent("先核对权限链路");
    expect(screen.getByTestId("live-tail")).toHaveTextContent("先核对权限链路");
    expect(screen.getByTestId("live-tail")).toHaveTextContent("role.json");
  });

  it("keeps the same process chrome when a named round still has no layer", () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 0,
      outcome: "running" as const,
      trunkCount: 0,
    };
    let state = emptyTimeline();
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "userMessage", id: "u1", text: "核对权限", attachments: [] },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: {
        type: "toolCall",
        id: "c1",
        name: "Read",
        status: "running",
        detail: { kind: "read", path: "role.json", content: "", truncated: false },
        images: [],
      },
    });
    state = showRounds(state, { rounds: [round], roundLayers: {} });

    render(<TimelineView state={state} />);
    expect(screen.queryByTestId("tool-call")).not.toBeInTheDocument();
    expect(screen.getByTestId("round-progress")).toBeInTheDocument();
    expect(screen.getByTestId("round-trunk")).toHaveTextContent("role.json");
  });

  /**
   * The bubble is the answer to "did it send?", and it has to be there before
   * the daemon can answer that. The named wait behind it is the answer to the
   * next question, which only a slow agent start ever raises.
   */
  it("shows an unconfirmed message straight away and names a slow agent start", async () => {
    useWorkbench.setState({
      sessions: [
        {
          id: "s1",
          workspaceId: "w1",
          agentId: "cursor",
          title: undefined,
          createdAtMs: 0,
          updatedAtMs: 0,
          archived: false,
          status: "idle",
        },
      ],
      activeSessionId: "s1",
      agents: [agent({ id: "cursor", label: "Cursor", builtin: false })],
    });
    const state: TimelineState = {
      ...emptyTimeline(),
      pending: { text: "重构存储层", attachments: [], sentAtMs: Date.now(), error: null },
    };

    render(<TimelineView state={state} />);
    expect(screen.getByTestId("pending-message")).toHaveTextContent("重构存储层");
    expect(screen.queryByText("正在启动 Cursor…")).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("正在启动 Cursor…")).toBeInTheDocument());
  });

  it("leaves a failed message on screen with a way to send or edit it again", async () => {
    const retryPending = vi.fn(async () => {});
    const editPending = vi.fn();
    useWorkbench.setState({ retryPending, editPending });
    const state: TimelineState = {
      ...emptyTimeline(),
      pending: {
        text: "启动 Cursor 试试",
        attachments: [],
        sentAtMs: Date.now(),
        error: "cursor-agent is not installed",
      },
    };

    render(<TimelineView state={state} />);
    const bubble = screen.getByTestId("pending-message");
    expect(bubble).toHaveTextContent("启动 Cursor 试试");
    expect(bubble).toHaveTextContent("发送失败：cursor-agent is not installed");
    // A failed send is not a wait, so it never claims to be starting anything.
    expect(screen.queryByText(/正在启动/)).not.toBeInTheDocument();

    await userEvent.click(within(bubble).getByRole("button", { name: "重试" }));
    expect(retryPending).toHaveBeenCalled();
    await userEvent.click(within(bubble).getByRole("button", { name: "编辑" }));
    expect(editPending).toHaveBeenCalled();
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

  it("renders the daemon's visible round, trunk, batch and blob hierarchy", async () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 0,
      outcome: "running" as const,
      trunkCount: 1,
    };
    const batch = {
      index: 0,
      firstItemId: "a1",
      blobCount: 2,
      text: "先检查配置",
    };
    const trunkSummary = {
      index: 0,
      firstItemId: "a1",
      blobCount: 2,
      title: "先检查配置。",
      batches: [batch],
    };
    const layer: RoundLayer = {
      round,
      trunks: [trunkSummary],
      expandedTrunk: {
        summary: trunkSummary,
        batches: [
          {
            summary: batch,
            monologue: "先检查配置。再逐项核对。",
            blobs: [
              {
                itemId: "think1",
                kind: "reasoning",
                overview: "确认结构",
                blob: { id: "ab".repeat(12), bytes: 48, at: "ab:0:48" },
              },
              {
                itemId: "tool1",
                kind: "toolCall",
                overview: "读取配置",
                blob: { id: "cd".repeat(12), bytes: 96, at: "cd:0:96" },
              },
            ],
          },
        ],
      },
    };
    const expanded = layer.expandedTrunk as RoundTrunk;
    const state = showRounds(
      apply(emptyTimeline(), {
        type: "item",
        turnId: "t1",
        item: { type: "userMessage", id: "u1", text: "检查项目", attachments: [] },
      }),
      { rounds: [round], roundLayers: { r1: layer }, roundTrunks: { "r1:0": expanded } },
    );

    render(<TimelineView state={state} />);
    expect(screen.queryByText("查看进展")).not.toBeInTheDocument();
    expect(screen.getByTestId("round-progress")).not.toHaveTextContent("工作过程");
    expect(screen.getByTestId("round-progress")).not.toHaveTextContent("阶段");
    expect(screen.getByTestId("round-trunk")).toHaveTextContent("🧭");
    expect(screen.getByTestId("round-trunk")).toHaveTextContent("先检查配置。");
    expect(screen.getByTestId("round-trunk")).toHaveTextContent("2 项");
    expect(screen.queryByTestId("batch-monologue")).not.toBeInTheDocument();
    expect(screen.getByTestId("live-tail")).toBeInTheDocument();
    expect(within(screen.getByTestId("live-tail")).getByText("确认结构")).toBeInTheDocument();
    expect(within(screen.getByTestId("live-tail")).getByText("读取配置")).toBeInTheDocument();
    expect(within(screen.getByTestId("live-tail")).queryByRole("button")).not.toBeInTheDocument();

    await userEvent.click(within(screen.getByTestId("round-batch")).getByRole("button"));
    await userEvent.click(screen.getByRole("button", { name: /确认结构/ }));
    expect(screen.getByText("正在加载…")).toBeInTheDocument();
  });

  it("shows a batch's images as a strip: reads and produced ones open Preview", async () => {
    const thumb = {
      mime: "image/jpeg",
      dataBase64: "dGh1bWI=",
      width: 128,
      height: 64,
    };
    const batch = { index: 0, firstItemId: "a1", blobCount: 2, text: "看图" };
    const trunkSummary = { index: 0, firstItemId: "a1", blobCount: 2, title: "看图。", batches: [batch] };
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 0,
      outcome: "running" as const,
      trunkCount: 1,
    };
    const layer: RoundLayer = {
      round,
      trunks: [trunkSummary],
      expandedTrunk: {
        summary: trunkSummary,
        batches: [
          {
            summary: batch,
            monologue: "",
            blobs: [
              {
                itemId: "tool1:img:0",
                kind: "image",
                overview: "Read: assets/logo.png",
                thumb,
                path: "assets/logo.png",
              },
              {
                itemId: "tool2:img:0",
                kind: "image",
                overview: "generate_image",
                thumb,
                path: ".genethub/sessions/s1/images/abc.png",
                blob: { id: "ef".repeat(12), bytes: 96, at: "ef:0:96" },
              },
            ],
          },
        ],
      },
    };
    const expanded = layer.expandedTrunk as RoundTrunk;
    const state = showRounds(
      apply(emptyTimeline(), {
        type: "item",
        turnId: "t1",
        item: { type: "userMessage", id: "u1", text: "看看", attachments: [] },
      }),
      { rounds: [round], roundLayers: { r1: layer }, roundTrunks: { "r1:0": expanded } },
    );
    useWorkbench.setState({
      activeWorkspaceId: "ws1",
      workspaces: [
        {
          id: "ws1",
          machineId: "dev1",
          name: "repo",
          root: "/repo",
          folders: [{ path: "/repo", name: "repo", root: "/repo", rootHandle: "r_repo" }],
        } as never,
      ],
      client: { identity: { machineId: "dev1" } } as never,
    });

    render(<TimelineView state={state} />);
    expect(screen.getByTestId("round-image-batch")).toBeInTheDocument();
    expect(screen.queryByTestId("turn-body-gallery")).not.toBeInTheDocument();

    const strip = screen.getByTestId("image-thumb-strip");
    const tiles = within(strip).getAllByTestId("image-thumb");
    expect(tiles).toHaveLength(2);
    // Every thumbnail renders through <img> — never inline markup — so an SVG
    // payload stays inert.
    expect(within(strip).getAllByRole("img")[0]).toHaveAttribute(
      "src",
      "data:image/jpeg;base64,dGh1bWI=",
    );

    // A workspace read opens the same Preview float Markdown file links use:
    // root-qualified path, then asset.preview loads the original.
    await userEvent.click(tiles[0]!);
    expect(useWorkbench.getState().previewFloat).toMatchObject({
      deviceHandle: "dev1",
      workspaceHandle: "ws1",
      path: "r_repo/assets/logo.png",
    });
    expect(screen.queryByTestId("image-expanded")).not.toBeInTheDocument();

    // A produced image is a session file; click is the same Preview open.
    await userEvent.click(tiles[1]!);
    expect(useWorkbench.getState().previewFloat).toMatchObject({
      deviceHandle: "dev1",
      workspaceHandle: "ws1",
      path: "r_repo/.genethub/sessions/s1/images/abc.png",
    });
    expect(screen.queryByTestId("image-expanded")).not.toBeInTheDocument();
  });

  it("keeps a mid-turn produced-image batch after the tool batch, not in the turn body", async () => {
    const thumb = { mime: "image/jpeg", dataBase64: "dGh1bWI=", width: 128, height: 64 };
    const tools = { index: 0, firstItemId: "t1", blobCount: 1, text: "生成图片" };
    const images = { index: 1, firstItemId: "t1:img:0", blobCount: 1, text: "1 张图片" };
    const more = { index: 2, firstItemId: "t2", blobCount: 1, text: "再读文件" };
    const trunkSummary = {
      index: 0,
      firstItemId: "t1",
      blobCount: 3,
      title: "生成图片。",
      batches: [tools, images, more],
    };
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "completed" as const,
      trunkCount: 1,
    };
    const expanded: RoundTrunk = {
      summary: trunkSummary,
      batches: [
        {
          summary: tools,
          monologue: "",
          blobs: [{ itemId: "t1", kind: "toolCall", overview: "imageGeneration" }],
        },
        {
          summary: images,
          monologue: "",
          blobs: [
            {
              itemId: "t1:img:0",
              kind: "image",
              overview: "风景",
              thumb,
              path: ".genethub/sessions/s1/images/aa.png",
            },
          ],
        },
        {
          summary: more,
          monologue: "",
          blobs: [{ itemId: "t2", kind: "toolCall", overview: "Read" }],
        },
      ],
    };
    const state = showRounds(
      apply(
        apply(emptyTimeline(), {
          type: "item",
          turnId: "t1",
          item: { type: "userMessage", id: "u1", text: "画一张再读一下", attachments: [] },
        }),
        {
          type: "item",
          turnId: "t1",
          item: { type: "assistantMessage", id: "a9", text: "画完了，也读过了。" },
        },
      ),
      {
        rounds: [round],
        roundLayers: { r1: { round, trunks: [trunkSummary], expandedTrunk: expanded } },
        roundTrunks: { "r1:0": expanded },
      },
    );

    render(<TimelineView state={state} />);
    await userEvent.click(within(screen.getByTestId("round-trunk")).getByRole("button"));
    expect(screen.getByTestId("round-image-batch")).toBeInTheDocument();
    expect(screen.queryByTestId("turn-body-gallery")).not.toBeInTheDocument();
    expect(screen.getByText("画完了，也读过了。")).toBeInTheDocument();
  });

  it("hoists the last produced-image group into the turn body when the round has settled", async () => {
    const thumb = { mime: "image/jpeg", dataBase64: "dGh1bWI=", width: 128, height: 64 };
    const tools = { index: 0, firstItemId: "t1", blobCount: 1, text: "生成图片" };
    const images = { index: 1, firstItemId: "t1:img:0", blobCount: 2, text: "2 张图片" };
    const summary = { index: 2, firstItemId: "a2", blobCount: 0, text: "三张风景都画好了。" };
    const trunkSummary = {
      index: 0,
      firstItemId: "t1",
      blobCount: 3,
      title: "生成图片。",
      batches: [tools, images, summary],
    };
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "completed" as const,
      trunkCount: 1,
    };
    const expanded: RoundTrunk = {
      summary: trunkSummary,
      batches: [
        {
          summary: tools,
          monologue: "",
          blobs: [{ itemId: "t1", kind: "toolCall", overview: "imageGeneration" }],
        },
        {
          summary: images,
          monologue: "",
          blobs: [
            {
              itemId: "t1:img:0",
              kind: "image",
              overview: "山",
              thumb,
              path: ".genethub/sessions/s1/images/aa.png",
            },
            {
              itemId: "t1:img:1",
              kind: "image",
              overview: "海",
              thumb,
              path: ".genethub/sessions/s1/images/bb.png",
            },
          ],
        },
        {
          summary,
          monologue: "三张风景都画好了。",
          blobs: [],
        },
      ],
    };
    const state = showRounds(
      apply(
        apply(emptyTimeline(), {
          type: "item",
          turnId: "t1",
          item: { type: "userMessage", id: "u1", text: "画两张风景", attachments: [] },
        }),
        {
          type: "item",
          turnId: "t1",
          item: { type: "assistantMessage", id: "a9", text: "三张风景都画好了。" },
        },
      ),
      {
        rounds: [round],
        roundLayers: { r1: { round, trunks: [trunkSummary], expandedTrunk: expanded } },
        roundTrunks: { "r1:0": expanded },
      },
    );
    useWorkbench.setState({
      activeWorkspaceId: "ws1",
      workspaces: [
        {
          id: "ws1",
          machineId: "dev1",
          name: "repo",
          root: "/repo",
          folders: [{ path: "/repo", name: "repo", root: "/repo", rootHandle: "r_repo" }],
        } as never,
      ],
      client: { identity: { machineId: "dev1" } } as never,
    });

    render(<TimelineView state={state} />);
    expect(screen.queryByTestId("round-image-batch")).not.toBeInTheDocument();
    const gallery = screen.getByTestId("turn-body-gallery");
    const tiles = within(gallery).getAllByTestId("image-thumb");
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toHaveClass("gh-markdown-image-ref");
    expect(tiles[0]).toHaveAttribute("data-size", "document");
    expect(screen.getByText("三张风景都画好了。")).toBeInTheDocument();

    await userEvent.click(tiles[0]!);
    expect(useWorkbench.getState().previewFloat).toMatchObject({
      deviceHandle: "dev1",
      workspaceHandle: "ws1",
      path: "r_repo/.genethub/sessions/s1/images/aa.png",
    });
  });

  it("does not hoist a second strip when the assistant already linked the pictures", async () => {
    const thumb = { mime: "image/jpeg", dataBase64: "dGh1bWI=", width: 128, height: 64 };
    const tools = { index: 0, firstItemId: "t1", blobCount: 1, text: "生成图片" };
    const images = { index: 1, firstItemId: "t1:img:0", blobCount: 1, text: "1 张图片" };
    const trunkSummary = {
      index: 0,
      firstItemId: "t1",
      blobCount: 2,
      title: "生成图片。",
      batches: [tools, images],
    };
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "completed" as const,
      trunkCount: 1,
    };
    const expanded: RoundTrunk = {
      summary: trunkSummary,
      batches: [
        {
          summary: tools,
          monologue: "",
          blobs: [{ itemId: "t1", kind: "toolCall", overview: "imageGeneration" }],
        },
        {
          summary: images,
          monologue: "",
          blobs: [
            {
              itemId: "t1:img:0",
              kind: "image",
              overview: "山间",
              thumb,
              path: ".genethub/sessions/s1/images/aa.png",
            },
          ],
        },
      ],
    };
    const state = showRounds(
      apply(
        apply(emptyTimeline(), {
          type: "item",
          turnId: "t1",
          item: { type: "userMessage", id: "u1", text: "画一张", attachments: [] },
        }),
        {
          type: "item",
          turnId: "t1",
          item: {
            type: "assistantMessage",
            id: "a9",
            text: "好了 [山间](demos/landscapes/landscape-mountains.png)",
          },
        },
      ),
      {
        rounds: [round],
        roundLayers: { r1: { round, trunks: [trunkSummary], expandedTrunk: expanded } },
        roundTrunks: { "r1:0": expanded },
      },
    );

    render(<TimelineView state={state} />);
    expect(screen.queryByTestId("turn-body-gallery")).not.toBeInTheDocument();
    expect(screen.getByText("山间")).toBeInTheDocument();
  });

  it("renders reasoning as text, tools as YAML, and edits as a diff", async () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 0,
      outcome: "running" as const,
      trunkCount: 1,
    };
    const batch = {
      index: 0,
      firstItemId: "think1",
      blobCount: 3,
      text: "检查网络边界",
    };
    const summary = {
      index: 0,
      firstItemId: "think1",
      blobCount: 3,
      title: "检查网络边界。",
      batches: [batch],
    };
    const reasoningBlob = { id: "aa".repeat(12), bytes: 64, at: "aa:0:64" };
    const toolBlob = { id: "bb".repeat(12), bytes: 128, at: "bb:0:128" };
    const editBlob = { id: "cc".repeat(12), bytes: 128, at: "cc:0:128" };
    const expandedTrunk: RoundTrunk = {
      summary,
      batches: [
        {
          summary: batch,
          monologue: "检查网络边界。",
          blobs: [
            {
              itemId: "think1",
              kind: "reasoning",
              overview: "分析入口",
              blob: reasoningBlob,
            },
            {
              itemId: "tool1",
              kind: "toolCall",
              overview: "执行测试",
              blob: toolBlob,
            },
            {
              itemId: "edit1",
              kind: "toolCall",
              overview: "修改入口",
              blob: editBlob,
            },
          ],
        },
      ],
    };
    const state = showRounds(
      apply(emptyTimeline(), {
        type: "item",
        turnId: "t1",
        item: { type: "userMessage", id: "u1", text: "检查项目", attachments: [] },
      }),
      {
        rounds: [round],
        roundLayers: {
          r1: { round, trunks: [summary], expandedTrunk },
        },
        roundTrunks: { "r1:0": expandedTrunk },
        blobs: {
          [reasoningBlob.id]: {
            id: reasoningBlob.id,
            value: { type: "reasoning", id: "think1", text: "逐项确认入口与信任边界。" },
          },
          [toolBlob.id]: {
            id: toolBlob.id,
            value: {
              type: "toolCall",
              id: "tool1",
              name: "shell",
              status: "ok",
              detail: { kind: "shell", command: "npm test", output: "all passed", exitCode: 0 },
            },
          },
          [editBlob.id]: {
            id: editBlob.id,
            value: {
              type: "toolCall",
              id: "edit1",
              name: "edit",
              status: "ok",
              detail: {
                kind: "edit",
                path: "src/main.ts",
                diff: "@@ -1 +1 @@\n-old\n+new",
              },
            },
          },
        },
      },
    );

    render(<TimelineView state={state} />);
    await userEvent.click(within(screen.getByTestId("round-batch")).getByRole("button"));
    const rows = screen.getAllByTestId("blob-row");

    await userEvent.click(within(rows[0]!).getByRole("button"));
    expect(within(rows[0]!).getByTestId("reasoning-text")).toHaveTextContent(
      "逐项确认入口与信任边界。",
    );
    expect(rows[0]!).not.toHaveTextContent('"type"');

    await userEvent.click(within(rows[1]!).getByRole("button"));
    expect(rows[1]!).toHaveTextContent("yaml");
    expect(rows[1]!).toHaveTextContent("type: toolCall");
    expect(rows[1]!).toHaveTextContent("command: npm test");
    expect(rows[1]!).not.toHaveTextContent('"command"');

    await userEvent.click(within(rows[2]!).getByRole("button"));
    expect(within(rows[2]!).getByTestId("blob-diff")).toContainElement(
      within(rows[2]!).getByText("-old"),
    );
    expect(within(rows[2]!).getByTestId("blob-diff")).toContainElement(
      within(rows[2]!).getByText("+new"),
    );
    expect(rows[2]!).toHaveTextContent("src/main.ts");
    expect(rows[2]!).not.toHaveTextContent("kind: edit");
  });

  it("shows a tool row's kind, relative time and duration without inventing them", async () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "completed" as const,
      trunkCount: 1,
    };
    const batch = {
      index: 0,
      firstItemId: "tool1",
      blobCount: 2,
      text: "读取配置",
    };
    const summary = {
      index: 0,
      firstItemId: "tool1",
      blobCount: 2,
      title: "读取配置。",
      batches: [batch],
    };
    const expandedTrunk: RoundTrunk = {
      summary,
      batches: [
        {
          summary: batch,
          monologue: "读取配置。",
          blobs: [
            {
              itemId: "tool1",
              kind: "toolCall",
              overview: "packages/proto/src/domain.rs",
              toolKind: "read",
              status: "ok",
              startedAtMs: Date.now() - 3 * 60_000,
              durationMs: 400,
            },
            {
              itemId: "tool2",
              kind: "toolCall",
              overview: "旧行没有时间",
            },
          ],
        },
      ],
    };
    const state = showRounds(
      apply(emptyTimeline(), {
        type: "item",
        turnId: "t1",
        item: { type: "userMessage", id: "u1", text: "看配置", attachments: [] },
      }),
      {
        rounds: [round],
        roundLayers: { r1: { round, trunks: [summary], expandedTrunk } },
        roundTrunks: { "r1:0": expandedTrunk },
      },
    );

    render(<TimelineView state={state} />);
    await userEvent.click(within(screen.getByTestId("round-trunk")).getByRole("button"));
    const rows = screen.getAllByTestId("blob-row");
    expect(within(rows[0]!).getByRole("img", { name: "读取文件" })).toBeInTheDocument();
    expect(within(rows[0]!).getByTestId("blob-timing")).toHaveTextContent("3 分钟前 · 0.4s");
    expect(within(rows[1]!).queryByTestId("blob-timing")).not.toBeInTheDocument();
    expect(rows[1]!).not.toHaveTextContent("刚刚");
  });

  it("shows trunk and batch metrics as rounds, duration and relative time", async () => {
    const now = Date.now();
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "completed" as const,
      trunkCount: 1,
    };
    const firstBatch = {
      index: 0,
      firstItemId: "tool1",
      blobCount: 3,
      text: "读取配置",
      llmRounds: 5,
      startedAtMs: now - 3 * 60_000,
      durationMs: 61_000,
      toolDurationMs: 30_000,
    };
    const secondBatch = {
      index: 1,
      firstItemId: "tool4",
      blobCount: 2,
      text: "写入修改",
      llmRounds: 7,
      startedAtMs: now - 2 * 60_000,
      durationMs: 119_000,
      toolDurationMs: 80_000,
    };
    const summary = {
      index: 0,
      firstItemId: "tool1",
      blobCount: 5,
      title: "先检查配置。",
      batches: [firstBatch, secondBatch],
      llmRounds: 12,
      startedAtMs: now - 3 * 60_000,
      durationMs: 200_000,
      toolDurationMs: 110_000,
    };
    const expandedTrunk: RoundTrunk = {
      summary,
      batches: [
        { summary: firstBatch, monologue: "读取配置。", blobs: [] },
        { summary: secondBatch, monologue: "写入修改。", blobs: [] },
      ],
    };
    const state = showRounds(
      apply(emptyTimeline(), {
        type: "item",
        turnId: "t1",
        item: { type: "userMessage", id: "u1", text: "看配置", attachments: [] },
      }),
      {
        rounds: [round],
        roundLayers: { r1: { round, trunks: [summary], expandedTrunk } },
        roundTrunks: { "r1:0": expandedTrunk },
      },
    );

    render(<TimelineView state={state} />);
    const trunk = screen.getByTestId("round-trunk");
    const trunkMetrics = within(trunk).getByTestId("summary-metrics");
    expect(trunkMetrics).toHaveTextContent("12 轮 · 3m 20s");
    expect(trunkMetrics).toHaveTextContent("3 分钟前 · 工具 1m 50s");
    expect(trunkMetrics).not.toHaveTextContent("5 项");

    await userEvent.click(within(trunk).getByRole("button"));
    const batches = screen.getAllByTestId("round-batch");
    const firstMetrics = within(batches[0]!).getByTestId("summary-metrics");
    expect(firstMetrics).toHaveTextContent("5 轮 · 1m 1s");
    expect(firstMetrics).toHaveTextContent("3 分钟前 · 工具 30s");
    expect(within(batches[1]!).getByTestId("summary-metrics")).toHaveTextContent(
      "7 轮 · 1m 59s",
    );
  });

  it("keeps the blob count for trunk rows written before metrics existed", () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "completed" as const,
      trunkCount: 1,
    };
    const summary = {
      index: 0,
      firstItemId: "a1",
      blobCount: 4,
      title: "盘点入口。",
      batches: [],
    };
    const state = showRounds(
      apply(emptyTimeline(), {
        type: "item",
        turnId: "t1",
        item: { type: "userMessage", id: "u1", text: "审计", attachments: [] },
      }),
      {
        rounds: [round],
        roundLayers: { r1: { round, trunks: [summary] } },
        roundTrunks: {},
      },
    );

    render(<TimelineView state={state} />);
    const trunk = screen.getByTestId("round-trunk");
    expect(trunk).toHaveTextContent("4 项");
    expect(within(trunk).queryByTestId("summary-metrics")).not.toBeInTheDocument();
  });

  it("shows live rounds and elapsed time on the in-progress card", () => {
    const now = Date.now();
    let state = emptyTimeline();
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "userMessage", id: "u1", text: "核对配置", attachments: [] },
    });
    state = apply(state, { type: "turnStarted", turnId: "t1", startedAtMs: now - 65_000 });
    state = apply(state, {
      type: "turnProgress",
      turnId: "t1",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        llmRounds: 3,
        toolOutputTokens: 0,
        compactionCount: 0,
        outputRateEstimated: false,
        costUsd: undefined,
      },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: {
        type: "toolCall",
        id: "c1",
        name: "Read",
        status: "ok",
        detail: { kind: "read", path: "role.json", content: "x", truncated: false },
        images: [],
        startedAtMs: now - 90_000,
        finishedAtMs: now - 80_000,
      },
    });

    render(<TimelineView state={state} />);
    const card = screen.getByTestId("round-trunk");
    const metrics = within(card).getByTestId("summary-metrics");
    expect(metrics).toHaveTextContent("3 轮");
    expect(metrics).toHaveTextContent("1 分钟前");
    expect(metrics).toHaveTextContent("工具 10s");
    expect(card).not.toHaveTextContent("1 项");
  });

  it("calls only the live tail progress and completed trunks process", () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 0,
      outcome: "running" as const,
      trunkCount: 2,
    };
    const first = {
      index: 0,
      firstItemId: "a1",
      blobCount: 64,
      title: "我会先盘点入口。",
      batches: [],
    };
    const second = {
      index: 1,
      firstItemId: "a2",
      blobCount: 3,
      title: "我会继续核对权限。",
      batches: [],
    };
    const state = showRounds(
      apply(emptyTimeline(), {
        type: "item",
        turnId: "t1",
        item: { type: "userMessage", id: "u1", text: "审计", attachments: [] },
      }),
      {
        rounds: [round],
        roundLayers: { r1: { round, trunks: [first, second] } },
        roundTrunks: {},
      },
    );

    render(<TimelineView state={state} />);

    const trunks = screen.getAllByTestId("round-trunk");
    expect(trunks[0]!).toHaveTextContent("🧭");
    expect(trunks[0]!).toHaveTextContent("盘点入口。64 项");
    expect(trunks[1]!).toHaveTextContent("🧭");
    expect(trunks[1]!).toHaveTextContent("核对权限。3 项");
    // Watching an agent work is the point of a running round: its tail is open,
    // and only the settled work behind it is folded away.
    expect(within(trunks[0]!).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(within(trunks[1]!).getByRole("button")).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps streaming progress headers to two lines as their text grows", () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 0,
      outcome: "running" as const,
      trunkCount: 1,
    };
    const batch = {
      index: 0,
      firstItemId: "a1",
      blobCount: 1,
      text: "正在核对信息面板",
    };
    const progress = (title: string, monologue: string) => {
      const summary = {
        index: 0,
        firstItemId: "a1",
        blobCount: 1,
        title,
        batches: [batch],
      };
      return showRounds(
        apply(emptyTimeline(), {
          type: "item",
          turnId: "t1",
          item: { type: "userMessage", id: "u1", text: "继续", attachments: [] },
        }),
        {
          rounds: [round],
          roundLayers: { r1: { round, trunks: [summary] } },
          roundTrunks: {
            "r1:0": {
              summary,
              batches: [{ summary: batch, monologue, blobs: [] }],
            },
          },
        },
      );
    };

    const view = render(<TimelineView state={progress("正在核对", "正在核对")} />);
    view.rerender(
      <TimelineView
        state={progress(
          "正在核对对话中持续刷新的信息面板与布局边界。",
          "正在核对对话中持续刷新的信息面板与布局边界。",
        )}
      />,
    );

    const header = within(screen.getByTestId("round-trunk")).getAllByRole("button")[0]!;
    expect(header.querySelector(".line-clamp-2")).toHaveAttribute(
      "title",
      "正在核对对话中持续刷新的信息面板与布局边界。",
    );
  });

  it("keeps a long first sentence in the expanded body so a phone can read it without hover", async () => {
    const longFirst =
      "Cursor 会把整段规划写成没有短句号的一行所以折叠标题会被裁掉而展开后再藏掉首句手机就读不到了。";
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "completed" as const,
      trunkCount: 1,
    };
    const batch = {
      index: 0,
      firstItemId: "a1",
      blobCount: 0,
      text: longFirst,
    };
    const summary = {
      index: 0,
      firstItemId: "a1",
      blobCount: 0,
      title: longFirst,
      batches: [batch],
    };
    const state = showRounds(
      apply(emptyTimeline(), {
        type: "item",
        turnId: "t1",
        item: { type: "userMessage", id: "u1", text: "继续", attachments: [] },
      }),
      {
        rounds: [round],
        roundLayers: { r1: { round, trunks: [summary] } },
        roundTrunks: {
          "r1:0": {
            summary,
            batches: [{ summary: batch, monologue: `${longFirst} 然后再改代码。`, blobs: [] }],
          },
        },
      },
    );

    render(<TimelineView state={state} />);
    await userEvent.click(within(screen.getByTestId("round-trunk")).getByRole("button"));
    expect(screen.getByTestId("batch-monologue")).toHaveTextContent(longFirst);
    expect(screen.getByTestId("batch-monologue")).toHaveTextContent("然后再改代码。");
  });

  it("renders a compaction marker batch inside the batch flow, not above it", async () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "completed" as const,
      trunkCount: 1,
    };
    const read = { index: 0, firstItemId: "a1", blobCount: 1, text: "读取配置" };
    const marker = {
      index: 1,
      firstItemId: "c1",
      blobCount: 0,
      text: "上下文压缩",
      marker: "auto",
    };
    const write = { index: 2, firstItemId: "a5", blobCount: 1, text: "写入修改" };
    const summary = {
      index: 0,
      firstItemId: "a1",
      blobCount: 2,
      title: "读取配置。",
      batches: [read, marker, write],
    };
    let state = apply(emptyTimeline(), {
      type: "item",
      turnId: "t1",
      item: { type: "userMessage", id: "u1", text: "改一下配置", attachments: [] },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "compaction", id: "c1", reason: "auto" },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "assistantMessage", id: "a9", text: "已完成。" },
    });
    state = showRounds(state, {
      rounds: [round],
      roundLayers: { r1: { round, trunks: [summary] } },
      roundTrunks: {
        "r1:0": {
          summary,
          batches: [
            { summary: read, monologue: "读取配置。", blobs: [] },
            { summary: marker, blobs: [] },
            { summary: write, monologue: "写入修改。", blobs: [] },
          ],
        },
      },
    });

    render(<TimelineView state={state} />);
    const trunk = screen.getByTestId("round-trunk");
    await userEvent.click(within(trunk).getByRole("button"));

    const markers = screen.getAllByTestId("compaction-marker");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toHaveTextContent("上下文压缩 · 自动");
    const batches = within(trunk).getAllByTestId("round-batch");
    expect(batches).toHaveLength(2);
    expect(
      batches[0]!.compareDocumentPosition(markers[0]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      markers[0]!.compareDocumentPosition(batches[1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps a legacy session's compaction marker in the flat narrative", async () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "completed" as const,
      trunkCount: 1,
    };
    // Trunk rows written before the marker field existed carry no `marker`.
    const read = { index: 0, firstItemId: "a1", blobCount: 1, text: "读取配置" };
    const write = { index: 1, firstItemId: "a5", blobCount: 1, text: "写入修改" };
    const summary = {
      index: 0,
      firstItemId: "a1",
      blobCount: 2,
      title: "读取配置。",
      batches: [read, write],
    };
    let state = apply(emptyTimeline(), {
      type: "item",
      turnId: "t1",
      item: { type: "userMessage", id: "u1", text: "改一下配置", attachments: [] },
    });
    // The built-in agent reports manual compactions as "manual:cited".
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "compaction", id: "c1", reason: "manual:cited" },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "assistantMessage", id: "a9", text: "已完成。" },
    });
    state = showRounds(state, {
      rounds: [round],
      roundLayers: { r1: { round, trunks: [summary] } },
      roundTrunks: {
        "r1:0": {
          summary,
          batches: [
            { summary: read, monologue: "读取配置。", blobs: [] },
            { summary: write, monologue: "写入修改。", blobs: [] },
          ],
        },
      },
    });

    render(<TimelineView state={state} />);
    const markers = screen.getAllByTestId("compaction-marker");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toHaveTextContent("上下文压缩 · 手动");
    expect(
      within(screen.getByTestId("round-trunk")).queryByTestId("compaction-marker"),
    ).not.toBeInTheDocument();
    expect(
      markers[0]!.compareDocumentPosition(screen.getByTestId("round-progress")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("moves the open tail along with the round and lets a reader hold one open", async () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 0,
      outcome: "running" as const,
      trunkCount: 1,
    };
    const first = { index: 0, firstItemId: "a1", blobCount: 2, title: "先盘点入口。", batches: [] };
    const second = { index: 1, firstItemId: "a2", blobCount: 1, title: "再核对权限。", batches: [] };
    const running = (trunks: typeof first[]) =>
      showRounds(
        apply(emptyTimeline(), {
          type: "item",
          turnId: "t1",
          item: { type: "userMessage", id: "u1", text: "审计", attachments: [] },
        }),
        { rounds: [round], roundLayers: { r1: { round, trunks } } },
      );

    const view = render(<TimelineView state={running([first])} />);
    expect(within(screen.getByTestId("round-trunk")).getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    // The tail advances by appending. Settled trunks fold to a header so the
    // transcript does not keep every blob that has ever been on screen.
    view.rerender(<TimelineView state={running([first, second])} />);
    let trunks = screen.getAllByTestId("round-trunk");
    expect(within(trunks[0]!).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(within(trunks[1]!).getByRole("button")).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(within(trunks[0]!).getByRole("button"));
    view.rerender(<TimelineView state={running([first, second])} />);
    trunks = screen.getAllByTestId("round-trunk");
    expect(within(trunks[0]!).getByRole("button")).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps running batches collapsed and only the last five blobs in the live window", () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 0,
      outcome: "running" as const,
      trunkCount: 1,
    };
    const blobs = Array.from({ length: 12 }, (_, index) => ({
      itemId: `tool${index + 1}`,
      kind: "toolCall" as const,
      overview: `调用 ${index + 1}`,
    }));
    const first = {
      index: 0,
      firstItemId: "a1",
      blobCount: 8,
      text: "先盘点入口",
    };
    const second = {
      index: 1,
      firstItemId: "a2",
      blobCount: 4,
      text: "再改权限",
    };
    const summary = {
      index: 0,
      firstItemId: "a1",
      blobCount: 12,
      title: "先盘点入口。",
      batches: [first, second],
    };
    const state = showRounds(
      apply(emptyTimeline(), {
        type: "item",
        turnId: "t1",
        item: { type: "userMessage", id: "u1", text: "审计", attachments: [] },
      }),
      {
        rounds: [round],
        roundLayers: { r1: { round, trunks: [summary] } },
        roundTrunks: {
          "r1:0": {
            summary,
            batches: [
              { summary: first, monologue: "先盘点入口。随后核对角色。", blobs: blobs.slice(0, 8) },
              { summary: second, monologue: "再改权限。", blobs: blobs.slice(8) },
            ],
          },
        },
      },
    );

    render(<TimelineView state={state} />);
    const batches = screen.getAllByTestId("round-batch");
    expect(batches).toHaveLength(2);
    expect(within(batches[0]!).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(within(batches[1]!).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("batch-monologue")).not.toBeInTheDocument();

    const tail = screen.getByTestId("live-tail");
    expect(within(tail).queryByText("调用 7")).not.toBeInTheDocument();
    expect(within(tail).getByText("调用 8")).toBeInTheDocument();
    expect(within(tail).getByText("调用 12")).toBeInTheDocument();
    expect(within(tail).queryByRole("button")).not.toBeInTheDocument();
    expect(tail).not.toHaveClass("overflow-y-auto");
    expect(screen.getAllByTestId("live-blob-row")).toHaveLength(5);
    expect(screen.queryByTestId("blob-row")).not.toBeInTheDocument();
  });

  it("closes the live window when the round settles", () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "completed" as const,
      trunkCount: 1,
    };
    const summary = {
      index: 0,
      firstItemId: "a1",
      blobCount: 1,
      title: "调用了 1 次工具",
      batches: [{ index: 0, firstItemId: "a1", blobCount: 1, text: "调用了 1 次工具" }],
    };
    const state = showRounds(
      apply(emptyTimeline(), {
        type: "item",
        turnId: "t1",
        item: { type: "userMessage", id: "u1", text: "运行", attachments: [] },
      }),
      {
        rounds: [round],
        roundLayers: { r1: { round, trunks: [summary] } },
        roundTrunks: {
          "r1:0": {
            summary,
            batches: [
              {
                summary: summary.batches[0]!,
                monologue: "做完了。",
                blobs: [{ itemId: "tool1", kind: "toolCall", overview: "读取配置" }],
              },
            ],
          },
        },
      },
    );

    render(<TimelineView state={state} />);
    expect(screen.queryByTestId("live-tail")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("round-trunk")).getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("uses compact batch text only while collapsed and full narration after expansion", async () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "completed" as const,
      trunkCount: 1,
    };
    const first = {
      index: 0,
      firstItemId: "a1",
      blobCount: 2,
      text: "核对入口与权限",
    };
    const second = {
      index: 1,
      firstItemId: "a2",
      blobCount: 1,
      text: "核对部署边界",
    };
    const summary = {
      index: 0,
      firstItemId: "a1",
      blobCount: 3,
      title: "我会先核对入口与权限。",
      batches: [first, second],
    };
    const state = showRounds(
      apply(emptyTimeline(), {
        type: "item",
        turnId: "t1",
        item: { type: "userMessage", id: "u1", text: "审计", attachments: [] },
      }),
      {
        rounds: [round],
        roundLayers: { r1: { round, trunks: [summary] } },
        roundTrunks: {
          "r1:0": {
            summary,
            batches: [
              {
                summary: first,
                monologue: "核对入口与权限。随后检查角色边界。最后记录结论。",
                blobs: [],
              },
              { summary: second, monologue: "核对部署边界。", blobs: [] },
            ],
          },
        },
      },
    );

    render(<TimelineView state={state} />);
    await userEvent.click(within(screen.getByTestId("round-trunk")).getByRole("button"));

    const batches = screen.getAllByTestId("round-batch");
    expect(batches).toHaveLength(2);
    expect(batches[0]!).toHaveTextContent("💭");
    expect(batches[0]!).toHaveTextContent("核对入口与权限");
    expect(batches[0]!).toHaveTextContent("2 项");
    expect(within(batches[0]!).getByRole("button").querySelector(".line-clamp-2")).toHaveAttribute(
      "title",
      "核对入口与权限。随后检查角色边界。",
    );

    const batchHeader = within(batches[0]!).getByRole("button");
    await userEvent.click(batchHeader);
    expect(batchHeader).toHaveTextContent("核对入口与权限");
    expect(batches[0]!).toHaveTextContent("最后记录结论。");
    expect(screen.getByTestId("batch-monologue")).not.toHaveTextContent("核对入口与权限。");
  });

  it("keeps historical trunks collapsed and preserves a manual expansion", async () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "completed" as const,
      trunkCount: 1,
    };
    const summary = {
      index: 0,
      firstItemId: "t1",
      blobCount: 1,
      title: "调用了 1 次工具",
      batches: [
        { index: 0, firstItemId: "t1", blobCount: 1, text: "调用了 1 次工具" },
      ],
    };
    const state = showRounds(
      apply(emptyTimeline(), {
        type: "item",
        turnId: "t1",
        item: { type: "userMessage", id: "u1", text: "运行", attachments: [] },
      }),
      { rounds: [round], roundLayers: { r1: { round, trunks: [summary] } } },
    );
    const view = render(<TimelineView state={state} />);
    const trunk = screen.getByTestId("round-trunk");
    expect(within(trunk).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(within(trunk).getByRole("button"));
    expect(within(trunk).getByRole("button")).toHaveAttribute("aria-expanded", "true");
    view.rerender(<TimelineView state={{ ...state }} />);
    expect(within(screen.getByTestId("round-trunk")).getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("keeps process monologues inside progress and places the final summary last", async () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "completed" as const,
      trunkCount: 1,
    };
    const processBatch = {
      index: 0,
      firstItemId: "a1",
      blobCount: 8,
      text: "先彻底核对权限链路，再给结论。",
    };
    const finalBatch = {
      index: 1,
      firstItemId: "a2",
      blobCount: 0,
      text: "最终结论：需要修复授权边界。",
    };
    const summary = {
      index: 0,
      firstItemId: "a1",
      blobCount: 8,
      title: "我会先彻底核对权限链路。",
      batches: [processBatch, finalBatch],
    };
    let state = emptyTimeline();
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "userMessage", id: "u1", text: "检查风险", attachments: [] },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "assistantMessage", id: "a1", text: "先彻底核对权限链路，再给结论。" },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "assistantMessage", id: "a2", text: "最终结论：需要修复授权边界。" },
    });
    state = showRounds(state, {
      rounds: [round],
      roundLayers: { r1: { round, trunks: [summary] } },
      roundTrunks: {
        "r1:0": {
          summary,
          batches: [
            {
              summary: processBatch,
              monologue: "先彻底核对权限链路，再给结论。",
              blobs: [],
            },
            {
              summary: finalBatch,
              monologue: "最终结论：需要修复授权边界。",
              blobs: [],
            },
          ],
        },
      },
    });

    render(<TimelineView state={state} />);

    const timeline = screen.getByTestId("timeline");
    expect(screen.getAllByTestId("assistant-message")).toHaveLength(1);
    expect(screen.getByTestId("round-trunk")).toHaveTextContent(
      "先彻底核对权限链路，再给结论。8 项",
    );
    expect(timeline.textContent?.indexOf("先彻底核对权限链路，再给结论。")).toBeLessThan(
      timeline.textContent?.indexOf("最终结论：需要修复授权边界。") ?? -1,
    );
    expect(timeline).not.toHaveTextContent("阶段 1");

    await userEvent.click(within(screen.getByTestId("round-trunk")).getByRole("button"));
    expect(screen.queryByTestId("round-batch")).not.toBeInTheDocument();
    expect(screen.getByTestId("round-trunk")).toHaveTextContent("先彻底核对权限链路，再给结论。");
    expect(screen.queryByTestId("batch-monologue")).not.toBeInTheDocument();
    expect(screen.getAllByText("最终结论：需要修复授权边界。")).toHaveLength(1);
  });

  it("keeps a completed answer visible while its round projection still says running", () => {
    const staleRound = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 0,
      outcome: "running" as const,
      trunkCount: 1,
    };
    let state = emptyTimeline();
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "userMessage", id: "u1", text: "给出结论", attachments: [] },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: { type: "assistantMessage", id: "a1", text: "这是已经持久化的最终结论。" },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: {
        type: "turnSummary",
        id: "turn-summary-t1",
        stats: {
          turnId: "t1",
          outcome: "completed",
          startedAtMs: 1,
          finishedAtMs: 2,
          durationMs: 1,
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            llmRounds: 1,
            toolOutputTokens: 0,
            compactionCount: 0,
            outputRateEstimated: false,
          },
          toolCalls: 0,
        },
      },
    });
    state = showRounds(state, {
      rounds: [staleRound],
      roundLayers: {
        r1: {
          round: staleRound,
          trunks: [
            {
              index: 0,
              firstItemId: "a1",
              blobCount: 0,
              title: "仍在刷新",
              batches: [],
            },
          ],
        },
      },
    });

    render(<TimelineView state={state} />);

    expect(screen.getByTestId("assistant-message")).toHaveTextContent(
      "这是已经持久化的最终结论。",
    );
    expect(screen.getByText(/20 输出 tokens/)).toBeInTheDocument();
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

  it("keeps an unfamiliar failed tool quiet until its output is requested", async () => {
    render(
      <ToolCallView
        name="teleport"
        status="error"
        detail={{ kind: "unknown", raw: { arguments: { destination: "mars" } } }}
      />,
    );

    expect(screen.getByText("teleport")).toBeInTheDocument();
    expect(screen.queryByLabelText("失败")).not.toBeInTheDocument();
    expect(screen.getByTestId("tool-call")).not.toHaveClass("border-danger/50");
    expect(screen.getByRole("button", { name: "查看输出" })).toBeInTheDocument();
    expect(screen.getByTestId("tool-call")).not.toHaveTextContent("已省略");

    await userEvent.click(screen.getByRole("button", { name: "查看输出" }));
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
    phase: "idle" as const,
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
  it("routes an unavailable Qwen3 runtime to settings", async () => {
    const onOpenSettings = vi.fn();
    const onSend = vi.fn();
    const client = {
      call: vi.fn(async () => ({
        type: "speechCapabilities",
        data: {
          webProtocol: 2,
          runtimeStatus: { state: "unavailable", message: "Qwen3 runtime 尚未就绪" },
          runtime: {
            id: "qwen3-asr",
            model: "Qwen3-ASR-1.7B",
            label: "Qwen3-ASR 1.7B",
            implementation: "mock",
          },
          audio: [{ encoding: "pcmS16Le", sampleRateHz: 16_000, channels: 1 }],
          languages: ["zh"],
          maxLanguageHints: 4,
          maxDurationMs: 300_000,
          context: {
            maxBytes: 16_384,
            maxPromptChars: 4_000,
            maxPinnedTerms: 50,
            maxAutomaticTerms: 150,
          },
          nBest: { maxCandidates: 5, scoreKind: "mockRelative", calibrated: false },
          segmentation: {
            maxSegments: 32,
            partialResults: false,
            localNBest: true,
            uncertainSpans: true,
          },
        },
      })),
    } as unknown as Client;
    render(
      <Composer
        {...composerProps({ onSend })}
        speech={{ client, workspaceId: "w1", onOpenSettings }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "语音输入" }));
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalledOnce());
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText("Qwen3 runtime 尚未就绪")).toBeInTheDocument();
  });

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
    expect(within(dialog).getByRole("tablist", { name: "Agent" })).toBeInTheDocument();
    expect(within(dialog).queryByText("模型")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("模式")).not.toBeInTheDocument();
  });

  it("keeps every Agent visible and labels one that is not installed", async () => {
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
    expect(within(dialog).getByRole("tab", { name: "GeneHub Agent" })).toBeEnabled();
    expect(within(dialog).getByRole("tab", { name: "OpenCode 未安装" })).toBeDisabled();
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

  it("uses three-to-five phone lines and four-to-seven desktop lines, with no smaller size", () => {
    const box = document.createElement("textarea");
    Object.defineProperty(box, "scrollHeight", { configurable: true, value: 40 });
    expect(resizeComposerTextarea(box, false)).toBe(COMPOSER_TEXTAREA_PHONE_MIN_HEIGHT);
    expect(box.style.overflowY).toBe("hidden");
    Object.defineProperty(box, "scrollHeight", { configurable: true, value: 156 });
    expect(resizeComposerTextarea(box, false)).toBe(156);

    Object.defineProperty(box, "scrollHeight", { configurable: true, value: 240 });
    expect(resizeComposerTextarea(box, false)).toBe(COMPOSER_TEXTAREA_PHONE_MAX_HEIGHT);
    expect(box.style.overflowY).toBe("auto");

    Object.defineProperty(box, "scrollHeight", { configurable: true, value: 40 });
    expect(resizeComposerTextarea(box, true)).toBe(COMPOSER_TEXTAREA_DESKTOP_MIN_HEIGHT);
    Object.defineProperty(box, "scrollHeight", { configurable: true, value: 220 });
    expect(resizeComposerTextarea(box, true)).toBe(COMPOSER_TEXTAREA_DESKTOP_MAX_HEIGHT);
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

    expect(
      screen.getByRole("button", { name: "添加文件（当前仅支持图片）" }),
    ).toBeInTheDocument();
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
    render(<Composer {...composerProps({ phase: "running", onInterrupt })} />);

    expect(screen.queryByLabelText("停止")).toBeInTheDocument();
    expect(screen.queryByLabelText("发送")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("发送中")).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("停止"));
    expect(onInterrupt).toHaveBeenCalled();
  });

  /**
   * "又卡住了" was filed against a turn that had been running for six minutes
   * and forty-nine seconds and finished normally. Nothing was wrong with it —
   * the person waiting simply had no way to tell that from a wedged one, and
   * the daemon cannot tell them, because it does not know either.
   */
  it("says how long a running turn has been quiet, once that is worth saying", () => {
    const now = 1_000_000;
    // An ordinary pause to think says nothing at all.
    expect(quietFor(now - 5_000, now)).toBeNull();
    expect(quietFor(now - 59_000, now)).toBeNull();
    expect(quietFor(now - 61_000, now)).toBe("已静默 1 分 1 秒");
    expect(quietFor(now - 409_000, now)).toBe("已静默 6 分 49 秒");
    expect(quietFor(now - 120_000, now)).toBe("已静默 2 分");
    // An idle session has no running turn, so there is nothing to be quiet.
    expect(quietFor(null, now)).toBeNull();
    expect(quietFor(undefined, now)).toBeNull();
  });

  it("keeps the send control busy after the echo and when switching onto a running tab", () => {
    const pending = { text: "改这里", attachments: [], sentAtMs: 1, error: null };
    expect(
      resolveComposerPhase({
        pending,
        timelineStatus: "idle",
        activeTurn: null,
      }),
    ).toBe("sending");
    expect(
      resolveComposerPhase({
        pending: null,
        timelineStatus: "idle",
        activeTurn: null,
        sessionStatus: "running",
      }),
    ).toBe("running");
    expect(
      resolveComposerPhase({
        pending: null,
        timelineStatus: "running",
        activeTurn: null,
      }),
    ).toBe("running");
    expect(
      resolveComposerPhase({
        pending: null,
        timelineStatus: "idle",
        activeTurn: null,
        sessionStatus: "waiting",
      }),
    ).toBe("running");
    expect(
      resolveComposerPhase({
        pending: { ...pending, error: "失败" },
        timelineStatus: "idle",
        activeTurn: null,
      }),
    ).toBe("idle");
  });

  /**
   * The wait between pressing send and a turn actually starting. There is no
   * turn to stop yet and sending again only earns the daemon's refusal, so the
   * control is a spinner nobody can press — and the keyboard has to be shut out
   * too, because the textarea's Enter never went through the button.
   */
  it("shows a non-interactive spinner while a sent message is unconfirmed", async () => {
    const onSend = vi.fn();
    const onInterrupt = vi.fn();
    render(
      <Composer
        {...composerProps({ phase: "sending", onSend, onInterrupt, attachmentsSupported: true })}
      />,
    );

    const spinner = screen.getByLabelText("发送中");
    expect(screen.queryByLabelText("发送")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("停止")).not.toBeInTheDocument();
    expect(spinner).toHaveAttribute("aria-disabled", "true");
    expect(spinner).toHaveAttribute("aria-busy", "true");
    expect(spinner.querySelector(".animate-spin")).not.toBeNull();

    await userEvent.click(spinner);
    expect(onSend).not.toHaveBeenCalled();
    expect(onInterrupt).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("任务描述"), "再补一句{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /添加文件/ })).toBeDisabled();
  });

  it("keeps the geometry of the row stable across all three phases", () => {
    const sizes = (["idle", "sending", "running"] as const).map((phase) => {
      const view = render(<Composer {...composerProps({ phase })} />);
      const label = phase === "idle" ? "发送" : phase === "sending" ? "发送中" : "停止";
      const control = screen.getByLabelText(label);
      const classes = ["h-9", "w-9", "md:h-6", "md:w-6"].filter((name) =>
        control.classList.contains(name),
      );
      view.unmount();
      return classes.length;
    });
    expect(sizes).toEqual([4, 4, 4]);
  });

  it("takes a failed message back into the field, attachments and all", async () => {
    const onRestoreDraft = vi.fn();
    const onSend = vi.fn();
    render(
      <Composer
        {...composerProps({
          onSend,
          onRestoreDraft,
          attachmentsSupported: true,
          restoreDraft: {
            text: "刚才没发出去的话",
            attachments: [{ name: "shot.png", mime: "image/png", dataBase64: "AAA" }],
          },
        })}
      />,
    );

    await waitFor(() => expect(onRestoreDraft).toHaveBeenCalled());
    expect(screen.getByLabelText("任务描述")).toHaveValue("刚才没发出去的话");
    expect(screen.getByAltText("shot.png")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("发送"));
    expect(onSend).toHaveBeenCalledWith(
      "刚才没发出去的话",
      expect.arrayContaining([expect.objectContaining({ name: "shot.png" })]),
    );
  });

  it("appends each runtime bundle on its own line without sending or erasing feedback", async () => {
    const onSend = vi.fn();
    const onInsertDraft = vi.fn();
    const view = render(<Composer {...composerProps({ onSend, onInsertDraft })} />);
    const box = screen.getByLabelText("任务描述");
    await userEvent.type(box, "点击提交后页面空白");

    view.rerender(
      <Composer
        {...composerProps({
          onSend,
          onInsertDraft,
          insertDraft: {
            id: "bundle-1",
            sessionId: "s1",
            text: "运行产物Bundle：`.genethub/sessions/s1/artifacts/first`",
          },
        })}
      />,
    );
    await waitFor(() => expect(onInsertDraft).toHaveBeenCalledWith("bundle-1"));

    view.rerender(
      <Composer
        {...composerProps({
          onSend,
          onInsertDraft,
          insertDraft: {
            id: "bundle-2",
            sessionId: "s1",
            text: "运行产物Bundle：`.genethub/sessions/s1/artifacts/second`",
          },
        })}
      />,
    );
    await waitFor(() => expect(onInsertDraft).toHaveBeenCalledWith("bundle-2"));

    expect(box).toHaveValue(
      [
        "点击提交后页面空白",
        "运行产物Bundle：`.genethub/sessions/s1/artifacts/first`",
        "运行产物Bundle：`.genethub/sessions/s1/artifacts/second`",
      ].join("\n"),
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps one writing-sized card whether or not the field has focus", async () => {
    render(<Composer {...composerProps({ agentLocked: true })} />);

    const box = screen.getByLabelText("任务描述");
    const summary = screen.getByRole("button", { name: /Agent：GeneHub Agent/ });
    const card = box.closest("[data-composer-card]");
    const inputSlot = box.closest('[data-composer-slot="input"]');
    const runtimeRow = card?.querySelector('[data-composer-slot="runtime"]');
    const actionsRow = card?.querySelector('[data-composer-slot="actions"]');
    const fileButton = screen.getByRole("button", { name: /添加文件/ });
    const sendButton = screen.getByRole("button", { name: "发送" });
    const geometry = () => {
      expect(box).toHaveStyle({ height: `${COMPOSER_TEXTAREA_DESKTOP_MIN_HEIGHT}px` });
      expect(box).toHaveClass("leading-9", "md:leading-6", "py-1.5", "md:py-1");
      expect(inputSlot).toHaveClass("col-span-2", "col-start-1", "row-start-1");
      expect(runtimeRow).toHaveClass("h-9", "md:h-6", "row-start-2");
      expect(actionsRow).toHaveClass("h-9", "md:h-6", "row-start-2");
      expect(summary).toHaveClass("h-9", "md:h-6", "text-[14px]", "md:text-[12px]");
      expect(fileButton).toHaveClass("h-9", "w-9", "md:h-6", "md:w-6");
      expect(sendButton).toHaveClass("h-9", "w-9", "md:h-6", "md:w-6");
    };

    expect(box).toHaveAttribute("rows", "1");
    expect(box).toHaveClass("focus-visible:outline-transparent");
    expect(card).toHaveClass("border-line-strong");
    expect(summary).toHaveClass("!min-h-0", "!min-w-0", "focus-visible:outline-muted/60");
    expect(summary).not.toHaveClass("focus-visible:outline-accent");
    expect(summary.firstElementChild).toHaveClass("opacity-75");
    expect(fileButton).toHaveClass("!min-h-0", "!min-w-0", "focus-visible:outline-muted/60");
    expect(sendButton).toHaveClass("!min-h-0", "!min-w-0", "focus-visible:outline-muted/60");
    geometry();

    await userEvent.click(box);
    expect(card).toHaveClass("border-muted/50");
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelectorAll("select")).toHaveLength(0);
    geometry();

    fireEvent.blur(box);
    expect(card).toHaveClass("border-line-strong");
    geometry();
  });

  it("overlays the transcript and reports its unzoomed layout height", () => {
    const onHeightChange = vi.fn();
    const { container, rerender } = render(
      <Composer {...composerProps({ onHeightChange })} />,
    );
    const shell = container.querySelector("[data-composer-shell]")!;

    expect(shell).toHaveClass("absolute", "bottom-0", "max-md:px-0");
    expect(shell).toHaveStyle({
      paddingBottom: "var(--keyboard, 0px)",
    });
    const card = container.querySelector("[data-composer-card]");
    expect(card).toHaveClass(
      "max-md:rounded-b-none",
      "max-md:border-x-0",
      "max-md:border-b-0",
      "max-md:pb-[env(safe-area-inset-bottom,0px)]",
    );
    Object.defineProperty(shell, "offsetHeight", { value: 73, configurable: true });
    rerender(<Composer {...composerProps({ minimized: true, onHeightChange })} />);
    expect(onHeightChange).toHaveBeenLastCalledWith(73);
  });

  it("tucks into a tap target when minimized, and comes back on tap", async () => {
    const onExpand = vi.fn();
    render(<Composer {...composerProps({ minimized: true, onExpand })} />);

    expect(screen.queryByLabelText("任务描述")).not.toBeInTheDocument();
    const compact = screen.getByRole("button", { name: "展开输入框" });
    expect(compact).toHaveClass(
      "max-md:rounded-b-none",
      "max-md:pb-[env(safe-area-inset-bottom,0px)]",
    );
    await userEvent.click(compact);
    expect(onExpand).toHaveBeenCalled();
  });

  it("fits the draft again when it comes back from being tucked away", async () => {
    const { rerender } = render(<Composer {...composerProps()} />);
    await userEvent.type(screen.getByLabelText("任务描述"), "一行{Enter}两行{Enter}三行");

    rerender(<Composer {...composerProps({ minimized: true })} />);
    rerender(<Composer {...composerProps()} />);

    // The field is remounted at its one-line default with a draft that has not
    // changed since it was last measured, so only re-measuring on the way back
    // stops three lines from coming back as one.
    expect(screen.getByLabelText("任务描述").style.height).not.toBe("");
  });

  it("does not move the file button out from under an in-flight click", async () => {
    const { container } = render(
      <Composer {...composerProps({ attachmentsSupported: true })} />,
    );
    const box = screen.getByLabelText("任务描述");
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const pickerClick = vi.spyOn(picker, "click").mockImplementation(() => {});

    await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: /添加文件/ }));

    expect(pickerClick).toHaveBeenCalledOnce();
    expect(box).toHaveFocus();
  });

  it("keeps the caret in the field after a pointer send", async () => {
    const onSend = vi.fn();
    render(<Composer {...composerProps({ onSend })} />);
    const box = screen.getByLabelText("任务描述");

    await userEvent.type(box, "继续调整");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(onSend).toHaveBeenCalledWith("继续调整", []);
    expect(box).toHaveValue("");
    expect(box).toHaveFocus();
  });

  it("keeps the rich settings viewable when Agent switching is locked", async () => {
    render(<Composer {...composerProps({ agentLocked: true })} />);
    await userEvent.click(screen.getByRole("button", { name: /Agent：GeneHub Agent/ }));
    const dialog = screen.getByRole("dialog", { name: "Agent 与运行设置" });
    expect(within(dialog).getByRole("tab", { name: "GeneHub Agent" })).toBeDisabled();
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
          questions: [],
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
          questions: [],
          options: [{ id: "beta", label: "Beta", kind: "allowOnce" }],
        }}
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Agent 提问")).toBeInTheDocument();
    expect(screen.getByText("任务已暂停；回答后会从原会话继续。")).toBeInTheDocument();
  });

  it("labels plan approval as a stopped plan decision", () => {
    render(
      <PermissionCard
        request={{
          id: "plan-1",
          kind: "planApproval",
          title: "实现计划",
          detail: "先持久化，再恢复。",
          options: [
            { id: "accept", label: "批准并继续", kind: "allowOnce" },
            { id: "reject", label: "拒绝计划", kind: "reject" },
          ],
        }}
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Agent 计划确认")).toBeInTheDocument();
    expect(screen.getByText("任务已暂停；确认计划后会从原会话继续。")).toBeInTheDocument();
  });

  it("keeps multi-question answers together in one durable interaction", async () => {
    const onAnswer = vi.fn();
    render(
      <PermissionCard
        request={{
          id: "q-many",
          kind: "question",
          title: "发布选择",
          options: [],
          questions: [
            {
              id: "environment",
              prompt: "发布到哪里？",
              allowMultiple: false,
              allowFreeform: true,
              options: [
                { id: "beta", label: "Beta" },
                { id: "official", label: "Official" },
              ],
            },
            {
              id: "checks",
              prompt: "执行哪些检查？",
              allowMultiple: true,
              allowFreeform: false,
              options: [
                { id: "smoke", label: "冒烟" },
                { id: "regression", label: "回归" },
              ],
            },
          ],
        }}
        onAnswer={onAnswer}
      />,
    );

    await userEvent.click(screen.getByLabelText("Official"));
    await userEvent.click(screen.getByLabelText("冒烟"));
    await userEvent.click(screen.getByLabelText("回归"));
    await userEvent.type(screen.getByPlaceholderText("其他答案或补充说明"), "保留回滚开关");
    await userEvent.click(screen.getByRole("button", { name: "提交答案" }));

    expect(onAnswer).toHaveBeenCalledWith({
      outcome: "answered",
      answers: [
        {
          questionId: "environment",
          selectedOptionIds: ["official"],
          freeformText: "保留回滚开关",
        },
        {
          questionId: "checks",
          selectedOptionIds: ["smoke", "regression"],
          freeformText: undefined,
        },
      ],
    });
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
      images: [],
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
        delta: { kind: "toolStatus" as const, status: "ok" as const, images: [] },
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
              llmRounds: 1,
              toolOutputTokens: 4,
                compactionCount: 0,
                outputRateEstimated: false,
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
          llmRounds: 1,
          toolOutputTokens: 4,
            compactionCount: 0,
            outputRateEstimated: false,
          costUsd: undefined,
        },
      },
    ]) {
      state = apply(state, event);
    }

    render(<TimelineView state={state} />);
    expect(screen.getByText("写个文件")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-call")).not.toBeInTheDocument();
    expect(screen.getByTestId("round-trunk")).toHaveTextContent("hello.txt");
    expect(screen.getByTestId("assistant-message")).toHaveTextContent("写好了。");
    expect(screen.getByTestId("turn-footer")).toHaveTextContent("2 分钟前");
    expect(screen.getByTestId("turn-footer")).toHaveTextContent("耗时 5s");
    expect(screen.queryByTestId("usage-summary")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /5 输出 tokens/ }));
    // turnSummary stats carry cacheReadTokens:3/input:10 (uncached 7); the
    // turnCompleted event has cacheReadTokens:0 but the footer renders the
    // turnSummary stats, so the summary line shows the richer breakdown.
    expect(screen.getByTestId("usage-summary")).toHaveTextContent(
      "本 Turn · input(cached:3, uncached:7) output 5 · 工具 1 次 · 模型 1 轮 · 工具输出约 4 tokens",
    );
    expect(screen.getByRole("button", { name: "Fork" })).toBeDisabled();
    expect(state.status).toBe("idle");
  });

  it("opens Agent selection for a completed turn without a native checkpoint", async () => {
    useWorkbench.setState({
      sessions: [
        {
          id: "s1",
          workspaceId: "w1",
          agentId: "codex",
          title: undefined,
          createdAtMs: 0,
          updatedAtMs: 0,
          archived: false,
          status: "idle",
        },
      ],
      activeSessionId: "s1",
      workspaces: [{
        id: "w1",
        name: "GeneHub",
        root: "/work/genehub",
        isGitRepo: true,
        folders: [],
      }],
      agents: [
        agent({
          id: "codex",
          label: "Codex",
          capabilities: { ...agent().capabilities, fork: true },
        }),
        agent({ id: "claude", label: "Claude Code" }),
      ],
    });
    let state = apply(emptyTimeline(), {
      type: "item",
      turnId: "t1",
      item: { type: "userMessage", id: "u1", text: "继续实现", attachments: [] },
    });
    state = apply(state, {
      type: "item",
      turnId: "t1",
      item: {
        type: "turnSummary",
        id: "summary-t1",
        stats: {
          turnId: "t1",
          outcome: "completed",
          startedAtMs: 1,
          finishedAtMs: 2,
          durationMs: 1,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            llmRounds: 1,
            toolOutputTokens: 0,
              compactionCount: 0,
              outputRateEstimated: false,
            costUsd: undefined,
          },
          toolCalls: 0,
          forkCheckpoint: undefined,
        },
      },
    });

    render(<TimelineView state={state} />);
    await userEvent.click(screen.getByRole("button", { name: "Fork" }));

    expect(screen.getByRole("dialog", { name: "Fork 会话" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Codex" })).toBeChecked();
    expect(screen.getByText("重建会话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重建到所选目标" })).toBeEnabled();
    expect(screen.getByRole("option", { name: /GeneHub/ }).querySelector("[data-workspace-icon=folder]")).toBeTruthy();
  });

  it("lets a running turn open a reconstruct-only Fork dialog", async () => {
    useWorkbench.setState({
      sessions: [
        {
          id: "s1",
          workspaceId: "w1",
          agentId: "cursor",
          title: undefined,
          createdAtMs: 0,
          updatedAtMs: 0,
          archived: false,
          status: "running",
        },
      ],
      activeSessionId: "s1",
      workspaces: [{
        id: "w1",
        name: "GeneHub",
        root: "/work/genehub",
        isGitRepo: true,
        folders: [],
      }],
      agents: [
        agent({
          id: "cursor",
          label: "Cursor",
          capabilities: { ...agent().capabilities, fork: false },
        }),
      ],
    });
    let state = apply(emptyTimeline(), {
      type: "turnStarted",
      turnId: "t-live",
      startedAtMs: 1,
    });
    state = apply(state, {
      type: "item",
      turnId: "t-live",
      item: { type: "userMessage", id: "u1", text: "你能帮忙做什么?", attachments: [] },
    });
    state = apply(state, {
      type: "item",
      turnId: "t-live",
      item: { type: "assistantMessage", id: "a1", text: "排查和稳定性" },
    });

    render(<TimelineView state={state} />);
    const fork = screen.getByRole("button", { name: "Fork" });
    expect(fork).toBeEnabled();
    expect(fork).toHaveAttribute("title", "从当前进行中的内容重建分支");
    await userEvent.click(fork);

    expect(screen.getByRole("dialog", { name: "Fork 会话" })).toBeInTheDocument();
    expect(screen.getByText("重建会话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重建到所选目标" })).toBeEnabled();
  });

  it("enters multi-select from a turn's 选择 button and range-selects across bubbles", async () => {
    useWorkbench.setState({
      sessions: [
        {
          id: "s1",
          workspaceId: "w1",
          agentId: "codex",
          title: undefined,
          createdAtMs: 0,
          updatedAtMs: 0,
          archived: false,
          status: "idle",
        },
      ],
      activeSessionId: "s1",
      workspaces: [{
        id: "w1",
        name: "GeneHub",
        root: "/work/genehub",
        isGitRepo: true,
        folders: [],
      }],
      agents: [agent({ id: "codex", label: "Codex" })],
    });
    const completedTurn = (turnId: string, userText: string, assistantText: string) => [
      {
        type: "item" as const,
        turnId,
        item: { type: "userMessage" as const, id: `u-${turnId}`, text: userText, attachments: [] },
      },
      { type: "turnStarted" as const, turnId, startedAtMs: 1 },
      {
        type: "item" as const,
        turnId,
        item: { type: "assistantMessage" as const, id: `a-${turnId}`, text: assistantText },
      },
      {
        type: "item" as const,
        turnId,
        item: {
          type: "turnSummary" as const,
          id: `summary-${turnId}`,
          stats: {
            turnId,
            outcome: "completed" as const,
            startedAtMs: 1,
            finishedAtMs: 2,
            durationMs: 1,
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              llmRounds: 1,
              toolOutputTokens: 0,
              compactionCount: 0,
              outputRateEstimated: false,
              costUsd: undefined,
            },
            toolCalls: 0,
            forkCheckpoint: undefined,
          },
        },
      },
    ];
    let state = emptyTimeline();
    for (const event of [
      ...completedTurn("t1", "第一个问题", "第一个回答"),
      ...completedTurn("t2", "第二个问题", "第二个回答"),
    ]) {
      state = apply(state, event);
    }

    render(<TimelineView state={state} />);

    // The floating entry and the footer's old single-shot copy are gone;
    // each completed turn's footer offers 选择 next to Fork instead.
    expect(screen.queryByRole("button", { name: "多选" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
    const entries = screen.getAllByRole("button", { name: "选择" });
    expect(entries).toHaveLength(2);

    // 选择 checks its own turn and anchors the bubble above the footer.
    await userEvent.click(entries[1]!);
    expect(screen.getByTestId("selection-bar")).toHaveTextContent("已选 2/30 条");
    expect(screen.getByRole("checkbox", { name: /第二个问题/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: /第二个回答/ })).toHaveAttribute("aria-checked", "true");
    // The footer entry steps aside while selecting; the turn-level add remains.
    expect(screen.queryByRole("button", { name: "选择" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /选择整个 Turn/ })).toHaveLength(2);

    // Clicking a bubble above the anchor range-selects everything between.
    await userEvent.click(screen.getByRole("checkbox", { name: /第一个问题/ }));
    expect(screen.getByTestId("selection-bar")).toHaveTextContent("已选 4/30 条");
    expect(screen.getByRole("checkbox", { name: /第一个回答/ })).toHaveAttribute("aria-checked", "true");

    // Clicking a checked bubble unchecks it (反选).
    await userEvent.click(screen.getByRole("checkbox", { name: /第一个回答/ }));
    expect(screen.getByTestId("selection-bar")).toHaveTextContent("已选 3/30 条");
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

/**
 * "新建会话的工作区好像是左侧会话列表选中的。比较隐晦。" The transcript is empty
 * because there is nothing to transcribe yet, and that is the room the two
 * decisions a new conversation still needs belong in.
 */
describe("an unstarted conversation", () => {
  const workspace = (id: string, name: string, root: string): WorkspaceInfo => ({
    id,
    name,
    root,
    isGitRepo: true,
    folders: [],
  });

  const worked = (id: string, workspaceId: string, updatedAtMs: number): SessionSummary => ({
    id,
    workspaceId,
    agentId: "genet",
    title: undefined,
    createdAtMs: 0,
    updatedAtMs,
    archived: false,
    status: "idle",
  });

  function draft() {
    useWorkbench.setState({
      workspaces: [
        workspace("w1", "genethub", "/srv/genethub"),
        workspace("w2", "console", "/srv/console"),
      ],
      agents: [agent(), agent({ id: "codex", label: "Codex", builtin: false })],
      sessions: [],
      activeSessionId: null,
      tabs: [],
      tabLimit: 16,
    });
    useWorkbench.getState().newSession("w1", "genet");
  }

  /** The buttons of one titled section, without its own header controls. */
  const listed = (section: string) =>
    within(within(screen.getByRole("region", { name: section })).getByRole("list"))
      .getAllByRole("button")
      .map((button) => button.textContent);
  const openings = () => listed("可以先问问");

  it("names every workspace and switches the draft to the one that is picked", async () => {
    draft();
    render(<NewSessionPanel />);

    expect(screen.getByRole("button", { name: /genethub/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: /console/ }));

    expect(useWorkbench.getState().draft?.workspaceId).toBe("w2");
    expect(useWorkbench.getState().activeSessionId).toBeNull();
  });

  /**
   * The Agent and model live in the composer's own footer, one line below this
   * panel. Asking for them again here made the first message look like it
   * needed four decisions when it needs one.
   */
  it("leaves the Agent and model to the composer", () => {
    draft();
    render(<NewSessionPanel />);

    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  /** An empty composer under "描述任务…" is the hardest moment in the product. */
  it("offers openings, writes one into the composer, and can draw another set", async () => {
    draft();
    render(<NewSessionPanel />);

    const first = openings();
    expect(first).toHaveLength(4);

    await userEvent.click(screen.getByText(first[0]!));
    expect(
      useWorkbench.getState().composerDraftInserts.map((insert) => insert.text),
    ).toEqual([first[0]]);

    await userEvent.click(screen.getByRole("button", { name: "换一批建议" }));
    expect(openings()).toHaveLength(4);
  });

  /**
   * "点击工作区后，选中的工作区会立刻切换到第一。来回跳变很不好。" The order is
   * decided once, when the panel opens.
   */
  it("does not reshuffle the grid under the finger that just picked a workspace", async () => {
    draft();
    render(<NewSessionPanel />);
    const names = () => listed("工作区");
    expect(names()).toEqual(["genethub", "console"]);

    await userEvent.click(screen.getByRole("button", { name: "console" }));

    expect(useWorkbench.getState().draft?.workspaceId).toBe("w2");
    expect(names()).toEqual(["genethub", "console"]);
    expect(screen.getByRole("button", { name: "console" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  /**
   * Four workspaces, and the one the sidebar has selected is always one of them.
   * Being offered a list that does not include the workspace you are looking at
   * reads as the panel having changed it.
   */
  it("leads with the selected workspace, then the most recently worked in", async () => {
    const many = Array.from({ length: 6 }, (_, index) =>
      workspace(`w${index}`, `project-${index}`, `/srv/p${index}`),
    );
    useWorkbench.setState({
      workspaces: many,
      agents: [agent()],
      sessions: [worked("a", "w4", 900), worked("b", "w2", 300)],
      activeSessionId: null,
      tabs: [],
      tabLimit: 16,
    });
    useWorkbench.getState().newSession("w5", "genet");
    render(<NewSessionPanel />);

    const names = () =>
      screen
        .getAllByRole("button", { name: /^project-/ })
        .map((button) => button.textContent);
    expect(names()).toEqual(["project-5", "project-4", "project-2", "project-0"]);

    await userEvent.click(screen.getByRole("button", { name: "更多 2" }));
    expect(names()).toHaveLength(6);
  });
});
