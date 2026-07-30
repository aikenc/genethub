import type { CommandInfo } from "@genehub/proto";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";

/**
 * A Claude Code install has dozens of commands and skills, and outside its own
 * terminal there was no way to find out that any of them existed. Running one
 * needs nothing special — it is ordinary prompt text — so all of this is about
 * discovery, and about not sending a half-typed command by accident.
 */
const COMMANDS: CommandInfo[] = [
  {
    name: "code-review",
    description: "Review the current diff for correctness bugs",
    argumentHint: "[low|medium|high]",
  },
  { name: "compact", description: "Compact the conversation", argumentHint: undefined },
  { name: "context", description: undefined, argumentHint: undefined },
];

function composer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn();
  render(
    <Composer
      running={false}
      agents={[]}
      agentId="claude"
      modelId={null}
      modeId={null}
      commands={COMMANDS}
      onSend={onSend}
      onInterrupt={vi.fn()}
      onPickAgent={vi.fn()}
      onPickModel={vi.fn()}
      onPickMode={vi.fn()}
      {...overrides}
    />,
  );
  return { onSend, input: screen.getByLabelText("任务描述") };
}

describe("the slash command menu", () => {
  it("lists what the agent said it has, narrowing as it is typed", async () => {
    const { input } = composer();

    await userEvent.type(input, "/");
    expect(screen.getByRole("listbox", { name: "命令" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    // The agent's own wording for the argument, so nobody has to guess it.
    expect(screen.getByText("[low|medium|high]")).toBeInTheDocument();

    await userEvent.type(input, "co");
    const names = screen.getAllByRole("option").map((option) => option.textContent);
    expect(names).toHaveLength(3);
    // `compact` and `context` start with what was typed; `code-review` does too,
    // so all three stay — but a prefix match must always come before a mere
    // substring one.
    await userEvent.type(input, "mp");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("/compact");
  });

  it("completes on Enter rather than sending what was half typed", async () => {
    const { onSend, input } = composer();

    await userEvent.type(input, "/co");
    await userEvent.keyboard("{Enter}");

    // The one outcome nobody wanted: `/co` going to the agent as a message
    // because the menu happened to be open.
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("/code-review ");
    // And the menu is gone, because the draft is no longer a bare slash token —
    // so the next Enter sends, as it always does.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("/code-review", []);
  });

  it("moves with the arrow keys and closes on Escape", async () => {
    const { onSend, input } = composer();

    await userEvent.type(input, "/");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // Escape dismissed the menu, it did not clear the draft — and Enter now does
    // what Enter does.
    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("/", []);
  });

  it("stays out of the way once the message is more than a command", async () => {
    const { input } = composer();

    // A command only counts at the start of a message, so a slash in the middle
    // of a sentence is just a slash.
    await userEvent.type(input, "看下 src/App.tsx");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, "/compact 然后继续");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("offers nothing for an agent that named no commands", async () => {
    const { input } = composer({ commands: [] });

    await userEvent.type(input, "/");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
