import type { BackgroundProcess, Reply, Request } from "@genehub/proto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { Client } from "../protocol/client";
import { useWorkbench } from "../session/store";
import { BackgroundBadge } from "./BackgroundBadge";
import { ProcessesPanel } from "./ProcessesPanel";

function stubDaemon(answers: Partial<Record<Request["type"], (payload: never) => Reply>>) {
  const calls: Request[] = [];
  const client = {
    call: async (request: Request) => {
      calls.push(request);
      const answer = answers[request.type];
      return answer?.((request as { payload?: never }).payload as never);
    },
    onPty: () => () => {},
    onNotice: () => () => {},
    onBackgroundProcesses: () => () => {},
    onStateChange: () => () => {},
  } as unknown as Client;
  return { client, calls };
}

const server: BackgroundProcess = {
  sessionId: "s_one",
  pid: 4242,
  parentPid: 4200,
  command: "node server.js --port 3000",
  runningForSeconds: 3720,
};

beforeEach(() => {
  useWorkbench.setState({
    client: null,
    backgroundProcesses: [],
    sessions: [],
    tabs: [],
    activeTabId: null,
  });
});

describe("the background process panel", () => {
  it("says which conversation left a process running, not just that one is", async () => {
    // A command line on its own is not enough to judge by. "Is this still
    // needed" is a question about what somebody was doing.
    const { client } = stubDaemon({ "process.list": () => ({ type: "processes", data: [server] }) });
    useWorkbench.setState({
      client,
      sessions: [
        {
          id: "s_one",
          workspaceId: "w1",
          title: "把首页跑起来",
          agentId: "codex",
          status: "idle",
          createdAtMs: 0,
          updatedAtMs: 0,
        },
      ] as never,
    });

    render(<ProcessesPanel />);
    await screen.findByText("node server.js --port 3000");
    expect(screen.getByText(/把首页跑起来/)).toBeInTheDocument();
  });

  it("shows the whole of what is known once a process is picked, and ends that one", async () => {
    const { client, calls } = stubDaemon({
      "process.list": () => ({ type: "processes", data: [server] }),
      "process.kill": () => ({ type: "ack" }),
    });
    useWorkbench.setState({ client });

    render(<ProcessesPanel />);
    await userEvent.click(await screen.findByText("node server.js --port 3000"));
    expect(screen.getByText("4242")).toBeInTheDocument();
    expect(screen.getByText("4200")).toBeInTheDocument();
    expect(screen.getByText("1 小时")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "结束进程" }));
    await waitFor(() => {
      const kill = calls.find((call) => call.type === "process.kill");
      expect(kill).toBeDefined();
      // The session travels with the pid: the daemon refuses a pid that is not
      // that session's, and it can only check that if it is told both.
      expect((kill as { payload: unknown }).payload).toEqual({ sessionId: "s_one", pid: 4242 });
    });
  });

  it("offers to end everything one conversation left, which is the usual wish", async () => {
    const { client, calls } = stubDaemon({
      "process.list": () => ({ type: "processes", data: [server] }),
      "process.killAll": () => ({ type: "ack" }),
    });
    useWorkbench.setState({ client });

    render(<ProcessesPanel />);
    await userEvent.click(await screen.findByText("node server.js --port 3000"));
    await userEvent.click(screen.getByRole("button", { name: "结束该会话的全部" }));
    await waitFor(() => {
      expect(calls.find((call) => call.type === "process.killAll")).toBeDefined();
    });
  });

  it("says nothing is left rather than showing an empty box", async () => {
    const { client } = stubDaemon({ "process.list": () => ({ type: "processes", data: [] }) });
    useWorkbench.setState({ client });

    render(<ProcessesPanel />);
    expect(await screen.findByText("没有留下运行中的进程")).toBeInTheDocument();
  });
});

describe("the badge on the chat panel", () => {
  it("is absent when there is nothing to report", () => {
    render(<BackgroundBadge />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("counts what is running and opens the panel when pressed", async () => {
    useWorkbench.setState({ backgroundProcesses: [server, { ...server, pid: 4243 }] });

    render(<BackgroundBadge />);
    const badge = screen.getByRole("button", { name: "2 个后台进程" });
    expect(badge).toHaveTextContent("2");

    await userEvent.click(badge);
    expect(useWorkbench.getState().tabs.some((tab) => tab.kind === "processes")).toBe(true);
  });
});
