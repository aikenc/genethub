/**
 * Surfaces an operation failure where feedback diagnostics already listen:
 * `console.warn` is mirrored into the feedback bundle as an `error` event.
 */
export function warnOp(op: string, failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure);
  console.warn(`[genehub] ${op}: ${message}`);
  return message;
}
