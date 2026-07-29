import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { useWorkbench } from "./session/store";

/**
 * The app with nothing injected, which is the only configuration a user ever
 * runs.
 *
 * Every other case here hands `App` a host and a connect function, and those
 * props hid a whole class of failure: the defaults were built inline, so they
 * were new values on every render, and the effects that depend on them ran
 * again each time. The result was a blank page — React gives up and unmounts
 * the tree rather than looping forever — and the entire suite stayed green,
 * because no test ever used the defaults.
 */

const ENDPOINT = "ws://127.0.0.1:59999/ws?token=t";

let sockets = 0;

class CountingSocket {
  static readonly OPEN = 1;
  readonly readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor() {
    sockets += 1;
  }
  send() {}
  close() {}
}

beforeEach(() => {
  sockets = 0;
  window.location.hash = `#endpoint=${ENDPOINT}`;
  vi.stubGlobal("WebSocket", CountingSocket);
  useWorkbench.setState({
    client: null,
    agents: [],
    workspaces: [],
    sessions: [],
    tabs: [],
    activeTabId: null,
    rightPanel: null,
    notice: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("the app as the browser loads it", () => {
  it("renders, instead of looping until React gives up", async () => {
    render(<App />);

    // Anything at all from the workbench shell proves the tree survived; the
    // failure mode is an empty root, not a wrong pixel.
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Changes" })).toBeInTheDocument();
  });

  it("opens one connection and keeps it across re-renders", async () => {
    render(<App />);
    await screen.findByRole("status");

    // Something unrelated changes, the way an incoming event would change it.
    useWorkbench.setState({ notice: "anything" });
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());

    expect(sockets).toBe(1);
  });
});
