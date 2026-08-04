/** Control owns the lease duration; local config may only refresh sooner. */
export function presenceRefreshDelaySeconds(
  leaseSeconds: number,
  localHardMaximumSeconds: number,
): number {
  return Math.min(localHardMaximumSeconds, Math.max(5, Math.floor(leaseSeconds / 2)));
}
