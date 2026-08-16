import { beforeEach, describe, expect, it } from "vitest";

import { applyUiScale, readUiScale, UI_SCALE_KEY, useUiScale } from "./scale";

function storage(entries: Record<string, string> = {}) {
  return {
    getItem: (key: string) => entries[key] ?? null,
    setItem: (key: string, value: string) => {
      entries[key] = value;
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.uiScale;
  useUiScale.setState({ scale: "medium" });
});

describe("choosing a UI scale", () => {
  it("defaults to the size the workbench already was", () => {
    expect(readUiScale(storage())).toBe("medium");
    expect(readUiScale(storage({ [UI_SCALE_KEY]: "large" }))).toBe("large");
    expect(readUiScale(storage({ [UI_SCALE_KEY]: "tiny" }))).toBe("medium");
    expect(readUiScale(storage({ [UI_SCALE_KEY]: "xsmall" }))).toBe("xsmall");
    expect(readUiScale(storage({ [UI_SCALE_KEY]: "xlarge" }))).toBe("xlarge");
  });

  it("marks the four non-medium sizes on the document, and leaves medium unmarked", () => {
    applyUiScale("xsmall");
    expect(document.documentElement.dataset.uiScale).toBe("xsmall");

    applyUiScale("small");
    expect(document.documentElement.dataset.uiScale).toBe("small");

    applyUiScale("medium");
    expect(document.documentElement.dataset.uiScale).toBeUndefined();

    applyUiScale("large");
    expect(document.documentElement.dataset.uiScale).toBe("large");

    applyUiScale("xlarge");
    expect(document.documentElement.dataset.uiScale).toBe("xlarge");
  });

  it("writes the choice down and repaints in one go", () => {
    useUiScale.getState().setScale("large");

    expect(localStorage.getItem(UI_SCALE_KEY)).toBe("large");
    expect(document.documentElement.dataset.uiScale).toBe("large");
    expect(useUiScale.getState().scale).toBe("large");
  });
});
