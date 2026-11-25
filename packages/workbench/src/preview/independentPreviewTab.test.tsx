import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preservePreviewReturn, PreviewReturn } from "./independentPreviewTab";

afterEach(() => {
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("returning from a workbench preview tab", () => {
  it("carries the return through compatibility mode and closes the owned tab", () => {
    const conversation = "/d/m_fixture/w/w_fixture/s/s_fixture";
    const params = new URLSearchParams({
      workbenchReturn: conversation,
      workbenchPreviewTab: "owned-tab",
    });
    history.replaceState(null, "", "/assets/independent-preview/v3/m_fixture?" + params);
    const fallback = new URL("/assets/preview/v3/m_fixture", location.origin);
    preservePreviewReturn(fallback);
    expect(fallback.search).toBe("?" + params);
    history.replaceState(null, "", fallback.href);
    sessionStorage.setItem("genehub:workbench-preview-tab", "owned-tab");
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    render(<PreviewReturn owner />);
    expect(fireEvent.click(screen.getByRole("link", {name: "返回对话"}))).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it("only offers a return to a same-site page for the owner", () => {
    history.replaceState(null, "", "/assets/independent-preview/v3/m_fixture?workbenchReturn=%2F%2Fother.example");
    const view = render(<PreviewReturn owner />);
    expect(screen.queryByRole("link")).toBeNull();
    history.replaceState(null, "", "/assets/independent-preview/v3/m_fixture?workbenchReturn=%2F");
    view.rerender(<PreviewReturn owner={false} />);
    expect(screen.queryByRole("link")).toBeNull();
    view.rerender(<PreviewReturn owner />);
    expect(screen.getByRole("link", {name: "返回对话"}).getAttribute("href")).toBe(location.origin + "/");
  });
});
