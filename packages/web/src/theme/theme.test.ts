import { beforeEach, describe, expect, it } from "vitest";

import { applyTheme, readPreference, resolveTheme, THEME_KEY, useTheme } from "./store";

/**
 * The palette is one class on `<html>` and two sets of variables behind it, so
 * these are the only two things that can go wrong: the wrong class, or a choice
 * that does not survive a reload. Both did, in the version that had no light
 * mode at all — the window chrome was light and the page was dark, and nothing
 * anywhere let anyone say which they wanted.
 */

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
  document.documentElement.className = "dark";
  useTheme.setState({ preference: "system", resolved: "dark" });
});

describe("choosing a palette", () => {
  it("puts exactly one of the two classes on the document", () => {
    applyTheme("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(false);
  });

  it("remembers the choice, and defaults to following the system", () => {
    expect(readPreference(storage())).toBe("system");
    expect(readPreference(storage({ [THEME_KEY]: "light" }))).toBe("light");
    // Anything else is a value we did not write — a stale key, a hand-edited
    // one — and following the system is the safe reading of it.
    expect(readPreference(storage({ [THEME_KEY]: "solarized" }))).toBe("system");
  });

  it("writes the choice down and repaints in one go", () => {
    useTheme.getState().setPreference("light");

    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(useTheme.getState().resolved).toBe("light");
  });

  it("takes an explicit choice at face value", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });
});

describe("the system changing its mind", () => {
  it("moves the screen while nobody has chosen", () => {
    useTheme.getState().setPreference("system");
    useTheme.getState().systemChanged("light");

    expect(useTheme.getState().resolved).toBe("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });

  it("is ignored once someone has", () => {
    useTheme.getState().setPreference("dark");
    useTheme.getState().systemChanged("light");

    expect(useTheme.getState().resolved).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
