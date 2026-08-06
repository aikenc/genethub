type Fields = Record<string, unknown>;

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * The lowest level that reaches the log, from `RELAY_LOG`.
 *
 * Anything below `info` is off by default because a busy Relay forwards one
 * frame per streamed event and would otherwise write a line for each. A dev
 * deployment turns it on to answer the question production cannot: which side
 * closed a channel, and when.
 */
const threshold = ORDER[(process.env.RELAY_LOG as Level) in ORDER ? (process.env.RELAY_LOG as Level) : "info"];

function emit(level: Level, msg: string, fields?: Fields): void {
  if (ORDER[level] < threshold) return;
  const line = JSON.stringify({ level, msg, at: new Date().toISOString(), ...fields });
  if (level === "info" || level === "debug") console.log(line);
  else console.error(line);
}

export const log = {
  debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
