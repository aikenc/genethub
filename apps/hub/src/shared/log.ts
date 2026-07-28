type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", msg: string, fields?: Fields): void {
  const line = JSON.stringify({ level, msg, at: new Date().toISOString(), ...fields });
  if (level === "info") console.log(line);
  else console.error(line);
}

export const log = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
