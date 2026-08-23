import { useEffect, useState } from "react";

/**
 * Compact age for tab titles: `3m` / `2h` / `3d`.
 *
 * The strip is too narrow for “3 分钟前”, and a sub-minute mark still costs
 * pixels without telling anyone anything they cannot already see.
 */
export function compactAge(atMs: number | undefined, nowMs: number): string | null {
  if (atMs == null || !Number.isFinite(atMs) || atMs <= 0) return null;
  const minutes = Math.max(0, Math.floor((nowMs - atMs) / 60_000));
  if (minutes < 1) return null;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
