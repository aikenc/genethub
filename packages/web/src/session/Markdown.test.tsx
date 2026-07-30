import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Markdown } from "./Markdown";

/**
 * An agent's reply is markdown, and used to be shown as if it were not: lists
 * arrived as hyphens, tables as pipes, code as prose.
 *
 * The cases here are the ones that were actually wrong on screen, plus the one
 * that matters even when nothing looks wrong — this text comes from a model, so
 * it is not trusted input.
 */
describe("an agent's reply", () => {
  it("renders the structure it was written with", () => {
    render(
      <Markdown
        text={[
          "## 步骤",
          "",
          "1. 先装桌面端",
          "2. 再登录",
          "",
          "| 平台 | 状态 |",
          "| --- | --- |",
          "| Windows | 可用 |",
          "",
          "参考 [文档](https://example.com/docs)。",
        ].join("\n")}
      />,
    );

    expect(screen.getByRole("heading", { name: "步骤" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    // Tables come from GFM, which is not on by default — a plugin has to be
    // asked for, and this is what says it still is.
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "平台" })).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "文档" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    // A link a model wrote must not be able to replace the workbench with
    // whatever it points at.
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("never renders HTML a model asked for", () => {
    // The reply is not trusted input: a model can be steered by anything it read
    // on the way here, including a file in the repository it was summarising.
    const { container } = render(
      <Markdown text={'正常文字 <img src=x onerror="alert(1)"> <b>加粗</b>'} />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText(/正常文字/)).toBeInTheDocument();
  });

  it("puts a code block behind a copy button rather than in the prose", async () => {
    const write = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: write } });

    render(<Markdown text={"跑这个：\n\n```bash\nnpm install -g @anthropic-ai/claude-code\n```"} />);

    expect(screen.getByText("bash")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(write).toHaveBeenCalledWith("npm install -g @anthropic-ai/claude-code");
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it("keeps inline code inline instead of breaking the sentence into a block", () => {
    render(<Markdown text="改 `apps/daemon/src/main.rs` 就好。" />);

    // One `code`, no block furniture around it: an inline span that turned into a
    // fenced block used to cut a sentence in half.
    expect(screen.queryByRole("button", { name: "复制" })).not.toBeInTheDocument();
    expect(screen.getByText("apps/daemon/src/main.rs")).toBeInTheDocument();
  });
});
