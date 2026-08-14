import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { HighlightedCode, languageForPath, Markdown } from "./Markdown";
import { useWorkbench } from "./store";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><script>alert(1)</script><a href="https://tracker.example"><text>流程</text></a><text>完成</text></svg>',
    })),
  },
}));

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

  it("does not let model-authored images make automatic network requests", () => {
    const { container } = render(
      <Markdown text="![tracking pixel](http://127.0.0.1:8787/private-action)" />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("图片已阻止：tracking pixel")).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("127.0.0.1");
  });

  it("rewrites workspace-relative links using the current Preview binding", () => {
    render(
      <Markdown
        text="见 [报告](reports/a.md)"
        artifact={{
          deviceHandle: "m_device",
          workspaceHandle: "w_docs",
          folders: [{ root: "/srv/product", rootHandle: "r_product" }],
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "报告" })).toHaveAttribute(
      "href",
      "http://localhost:3000/assets/preview/v2/m_device/w_docs/r_product/reports/a.md",
    );
  });

  it("rewrites cwd-relative ../ links that land in another workspace root", () => {
    render(
      <Markdown
        text="[《我的产品》闭环控制台原型 V1](../../worktrees/dev-0/genethub/prototypes/produce-manager/genet-ds/v1/index.html)"
        artifact={{
          deviceHandle: "m_device",
          workspaceHandle: "w_docs",
          folders: [
            {
              root: "/data/workspace/genethub-work/genethub-spaces/spaces/dev-ui",
              rootHandle: "r_ui",
            },
            {
              root: "/data/workspace/genethub-work/genethub-spaces",
              rootHandle: "r_spaces",
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByRole("link", { name: "《我的产品》闭环控制台原型 V1" }),
    ).toHaveAttribute(
      "href",
      "http://localhost:3000/assets/preview/v2/m_device/w_docs/r_spaces/worktrees/dev-0/genethub/prototypes/produce-manager/genet-ds/v1/index.html",
    );
  });

  it("does not turn workspace-escaping paths into clickable links", () => {
    render(
      <Markdown
        text="见 [秘密](../../etc/passwd)"
        artifact={{
          deviceHandle: "m_device",
          workspaceHandle: "w_docs",
          folders: [{ root: "/srv/product", rootHandle: "r_product" }],
        }}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("秘密")).toHaveAttribute("title", "此链接不在当前工作区内");
  });

  it("keeps the owning session when a Preview link is opened", async () => {
    useWorkbench.setState({ previewFloat: null });
    render(
      <Markdown
        text="[打开 H5](demos/index.html)"
        artifact={{
          deviceHandle: "m_device",
          workspaceHandle: "w_docs",
          folders: [{ root: "/srv/product", rootHandle: "r_product" }],
          sessionId: "s_origin",
        }}
      />,
    );

    await userEvent.click(screen.getByRole("link", { name: "打开 H5" }));
    expect(useWorkbench.getState().previewFloat).toEqual({
      deviceHandle: "m_device",
      workspaceHandle: "w_docs",
      path: "r_product/demos/index.html",
      sessionId: "s_origin",
    });
    useWorkbench.setState({ previewFloat: null });
  });

  it("puts a code block behind a copy button rather than in the prose", async () => {
    const write = vi.fn(async () => {});
    // Only the clipboard: replacing the whole of `navigator` would drop every
    // property that lives on its prototype, which is most of them.
    vi.stubGlobal("navigator", Object.create(navigator, {
      clipboard: { value: { writeText: write } },
    }));

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

  it("syntax-highlights fenced source code", () => {
    const { container } = render(
      <Markdown text={"```typescript\nconst answer: number = 42;\n```"} variant="document" />,
    );

    expect(container.querySelector(".hljs-keyword")).toHaveTextContent("const");
    expect(screen.getByText("typescript")).toBeInTheDocument();
  });

  it("infers common source and config languages for standalone text Preview", () => {
    expect(languageForPath("src/main.cpp")).toBe("cpp");
    expect(languageForPath("infra/Dockerfile")).toBe("dockerfile");
    expect(languageForPath("suite.code-workspace")).toBe("json");
    expect(languageForPath("data/new-language")).toBeUndefined();

    const { container } = render(
      <HighlightedCode text={"class Preview { public: int value = 4; };"} language="cpp" document />,
    );
    expect(container.querySelector(".gh-code-document")).toBeInTheDocument();
    expect(container.querySelector(".hljs-keyword")).toBeInTheDocument();
  });

  it("renders Mermaid lazily as an inert SVG image", async () => {
    const create = vi.fn((_blob: Blob) => "blob:flowchart");
    const revoke = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    const { unmount } = render(
      <Markdown text={"```mermaid\nflowchart LR\n  A --> B\n```"} variant="document" />,
    );

    const diagram = await screen.findByRole("img", { name: "Markdown 流程图" });
    expect(diagram).toHaveAttribute("src", "blob:flowchart");
    const svg = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(create.mock.calls[0]?.[0] as Blob);
    });
    expect(svg).not.toContain("tracker.example");
    expect(svg).not.toContain("<script");
    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:flowchart");
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });
});
