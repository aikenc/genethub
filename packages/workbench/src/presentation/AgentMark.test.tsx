import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentMark } from "./AgentMark";

describe("Agent marks across themes", () => {
  it("keeps a single-variant mark visible in the light theme", () => {
    const { container } = render(
      <div className="light">
        <AgentMark agent={{ id: "genet", label: "GeneHub Agent" }} />
      </div>,
    );
    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    expect(image).not.toHaveClass("agent-brand-dark");
    expect(image).not.toHaveClass("agent-brand-light");
  });

  it("marks both official variants when an Agent supplies them", () => {
    const { container } = render(<AgentMark agent={{ id: "cursor", label: "Cursor" }} />);
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveClass("agent-brand-dark");
    expect(images[1]).toHaveClass("agent-brand-light");
  });

  it("uses the Agent name when there is no configured icon", () => {
    render(<AgentMark agent={{ id: "codex", label: "Codex" }} />);
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("falls back to the Agent name if a bundled image cannot load", () => {
    const { container } = render(
      <AgentMark agent={{ id: "genet", label: "GeneHub Agent" }} />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByText("GeneHub Agent")).toBeInTheDocument();
  });
});
