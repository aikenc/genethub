import { useEffect, useState } from "react";
import type { RtcState } from "../protocol/client";
import { useWorkbench } from "../session/store";

/** Reflect the current machine's live connection, never its directory status. */
export function useRtcAccelerated(): boolean {
  const client = useWorkbench(state => state.client);
  const connection = useWorkbench(state => state.connection);
  const [rtc, setRtc] = useState<RtcState>(client?.rtcState ?? "standby");
  useEffect(() => {
    setRtc(client?.rtcState ?? "standby");
    return client?.onRtcStateChange?.(setRtc);
  }, [client]);
  return connection === "ready" && rtc === "connected";
}

export function RtcAcceleration({ active }: { active: boolean }) {
  return active ? <span title="RTC 加速已连接" aria-label="RTC 加速已连接">⚡</span> : null;
}
