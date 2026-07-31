import type { TimelineItem, ToolCallDetail } from "@genehub/proto";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToolCallView } from "./ToolCall";

/**
 * A dispatched sub-agent runs its own tools, sometimes for minutes. Its card used
 * to show only the prompt it was sent away with, so a long task looked like a
 * stalled one — and its steps, if they showed at all, showed as the main agent's.
 */
describe("a sub-agent's card", () => {
  const detail = (items: TimelineItem[]): ToolCallDetail => ({
    kind: "subAgent",
    agent: "Explore",
    prompt: "Find hello.txt",
    items,
  });

  it("shows what it has done so far, as its own work", () => {
    render(
      <ToolCallView
        name="Agent"
        status="running"
        detail={detail([
          {
            type: "toolCall",
            id: "1-1",
            name: "Bash",
            status: "ok",
            detail: { kind: "shell", command: "ls /tmp", output: "hello.txt", exitCode: 0 },
          },
          {
            type: "toolCall",
            id: "1-2",
            name: "Read",
            status: "running",
            detail: { kind: "read", path: "/tmp/hello.txt", content: "", truncated: false },
          },
        ])}
      />,
    );

    const steps = screen.getByRole("list", { name: "子 agent 的步骤" });
    expect(within(steps).getAllByTestId("tool-call")).toHaveLength(2);
    // Twice over: a shell step puts its command in the header as the summary
    // and again in the body as the thing that was run.
    expect(within(steps).getAllByText("ls /tmp").length).toBeGreaterThanOrEqual(1);
    // Still working, and visibly so: the point of showing the steps at all.
    expect(within(steps).getByLabelText("running")).toBeInTheDocument();
    // And the instruction it was given stays on the card.
    expect(screen.getByText("Find hello.txt")).toBeInTheDocument();
  });

  it("is just the prompt before it has done anything", () => {
    render(<ToolCallView name="Agent" status="running" detail={detail([])} />);

    expect(screen.getByText("Find hello.txt")).toBeInTheDocument();
    // No empty container pretending there is a list of steps.
    expect(screen.queryByRole("list", { name: "子 agent 的步骤" })).not.toBeInTheDocument();
  });
});
