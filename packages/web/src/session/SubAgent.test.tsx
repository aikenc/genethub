import type { ToolCallDetail } from "@genehub/proto";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ToolCallView } from "./ToolCall";

/**
 * A dispatched sub-agent runs its own tools, sometimes for minutes. Its card used
 * to show only the prompt it was sent away with, so a long task looked like a
 * stalled one — and its steps, if they showed at all, showed as the main agent's.
 */
describe("a sub-agent's card", () => {
  const detail = (output: string): ToolCallDetail => ({
    kind: "overview",
    toolKind: "subAgent",
    overview: "Explore · Find hello.txt",
    input: "Find hello.txt",
    output,
    paths: [],
  });

  it("shows only the bounded output excerpt", async () => {
    render(
      <ToolCallView
        name="Agent"
        status="running"
        detail={detail("Found /tmp/hello.txt")}
      />,
    );

    expect(screen.getByRole("img", { name: "子 Agent" })).toHaveTextContent("🤖");
    await userEvent.click(screen.getByRole("button", { name: "查看输出" }));
    expect(screen.getByText("Found /tmp/hello.txt")).toBeInTheDocument();
    expect(screen.queryByText("Find hello.txt", { selector: "pre" })).not.toBeInTheDocument();
  });

  it("says when there is no output yet", async () => {
    render(<ToolCallView name="Agent" status="running" detail={detail("")} />);

    await userEvent.click(screen.getByRole("button", { name: "查看输出" }));
    expect(screen.getByText("暂无输出")).toBeInTheDocument();
  });
});
