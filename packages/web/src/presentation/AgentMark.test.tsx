import { render } from "@testing-library/react";
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
});
