/** Poll a public fact and return the first truthy observation. */
export async function waitUntil<T>(check: () => T | Promise<T>, timeoutMs = 10_000, intervalMs = 50): Promise<NonNullable<T>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError("poll timeout must be positive and interval nonnegative");
  }
  const deadline = Date.now() + timeoutMs;
  do {
    const observation = await check();
    if (observation) return observation as NonNullable<T>;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  } while (Date.now() < deadline);
  throw new Error(`timed out after ${timeoutMs}ms`);
}
