import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SanitizedHtml } from "./SanitizedHtml";

/**
 * A single HTML file an agent wrote, rendered without an iframe
 * (`docs/specs/artifact-skill.md` §6). Nothing sandboxes this from the rest
 * of the workbench, so these are the cases where that would have mattered.
 */
describe("a single HTML document, rendered without an iframe", () => {
  it("never runs a script tag", () => {
    const { container } = render(
      <SanitizedHtml html="<p>正文</p><script>window.__pwned = true;</script>" />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(screen.getByText("正文")).toBeInTheDocument();
  });

  it("never runs an inline event handler", () => {
    const { container } = render(
      <SanitizedHtml html='<button onclick="window.__pwned = true">点我</button>' />,
    );

    expect(container.querySelector("button")).not.toHaveAttribute("onclick");
  });

  it("strips <style>, so one document cannot repaint the whole workbench", () => {
    const { container } = render(
      <SanitizedHtml html="<style>body { display: none }</style><p>正文</p>" />,
    );

    expect(container.querySelector("style")).toBeNull();
    expect(screen.getByText("正文")).toBeInTheDocument();
  });

  it("strips a style= attribute the same way", () => {
    const { container } = render(
      <SanitizedHtml html='<p style="position:fixed;inset:0;background:red">正文</p>' />,
    );

    expect(container.querySelector("p")).not.toHaveAttribute("style");
  });

  it("drops a remote image source, the same reasoning as blocked markdown images", () => {
    const { container } = render(
      <SanitizedHtml html='<img src="http://127.0.0.1:8787/tracking-pixel" alt="chart">' />,
    );

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).not.toHaveAttribute("src");
  });

  it("keeps a self-contained data: image, which makes no network request", () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgo=";
    const { container } = render(<SanitizedHtml html={`<img src="${dataUri}" alt="chart">`} />);

    expect(container.querySelector("img")).toHaveAttribute("src", dataUri);
  });

  it("forces external links open in a new tab rather than replacing the workbench", () => {
    render(<SanitizedHtml html='<a href="https://example.com">外链</a>' />);

    const link = screen.getByRole("link", { name: "外链" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("keeps ordinary structure and text intact", () => {
    render(
      <SanitizedHtml html="<h1>标题</h1><ul><li>第一项</li><li>第二项</li></ul><p><b>加粗</b>文字</p>" />,
    );

    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("加粗")).toBeInTheDocument();
  });
});
