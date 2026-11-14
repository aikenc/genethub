export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 10_000, options: { intervalMs?: number } = {}): Promise<void> {
  const intervalMs = options.intervalMs ?? 50;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("wait interval must be positive");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}
