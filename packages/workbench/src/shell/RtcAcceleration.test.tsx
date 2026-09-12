import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Client, RtcState } from "../protocol/client";
import { useWorkbench } from "../session/store";
import { RtcAcceleration, useRtcAccelerated } from "./RtcAcceleration";

function Machine() {
  return <div><RtcAcceleration active={useRtcAccelerated()} />工作机</div>;
}
afterEach(() => useWorkbench.setState({ client: null, connection: "closed" }));
it("shows lightning only for the current ready RTC connection and removes it on fallback", () => {
  let update: (state: RtcState) => void = () => {};
  const cleanup = vi.fn();
  const client = { rtcState: "connecting", onRtcStateChange(fn: typeof update) { update = fn; return cleanup; } } as unknown as Client;
  useWorkbench.setState({ client, connection: "ready" });
  const view = render(<Machine />);
  expect(screen.queryByLabelText("RTC 加速已连接")).toBeNull();
  act(() => update("connected"));
  expect(screen.getByLabelText("RTC 加速已连接").parentElement?.textContent).toBe("⚡工作机");
  act(() => update("standby"));
  expect(screen.queryByLabelText("RTC 加速已连接")).toBeNull();
  act(() => update("connected"));
  act(() => useWorkbench.setState({ connection: "reconnecting" }));
  expect(screen.queryByLabelText("RTC 加速已连接")).toBeNull();
  act(() => useWorkbench.setState({ client: null, connection: "ready" }));
  expect(screen.queryByLabelText("RTC 加速已连接")).toBeNull();
  expect(cleanup).toHaveBeenCalledOnce();
  view.unmount();
});
