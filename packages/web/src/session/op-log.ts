/**
 * Surfaces an operation failure where feedback diagnostics already listen.
 * The browser console gets only the fixed operation name; the user-facing
 * message is returned to the UI and is never copied into automatic feedback.
 */
export function warnOp(op: string, failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure);
  console.warn(`[genehub] ${op} failed`);
  return message;
}
