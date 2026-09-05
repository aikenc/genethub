#!/usr/bin/env node
// External app-server v2 protocol peer. It never imports product code.
// The script supplies complete public frames; substitution only binds RPC ids.
import { readFileSync, appendFileSync } from "node:fs";
import readline from "node:readline";
if (process.argv.includes("login")) { console.log("Logged in"); process.exit(0); }
const script = JSON.parse(readFileSync(process.env.GENEHUB_TEST_CODEX_SCRIPT, "utf8"));
let turn = 0;
let thread = "scripted-thread";
const write = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const bind = (value, turnId) => JSON.parse(JSON.stringify(value).replaceAll("$TURN", turnId).replaceAll("$THREAD", thread));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  const reply = (result) => write({ jsonrpc: "2.0", id: request.id, result });
  switch (request.method) {
    case "initialize": reply({ userAgent: "scripted-codex" }); break;
    case "model/list": reply({ data: [{ id: "scripted", model: "scripted", displayName: "Scripted", isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: "medium" }], nextCursor: null }); break;
    case "thread/start": case "thread/resume": reply({ thread: { id: thread } }); break;
    case "thread/fork": reply({ thread: { id: "scripted-fork" } }); break;
    case "turn/start": {
      const frames = script.turns[turn++];
      if (!frames) { write({ jsonrpc: "2.0", id: request.id, error: { code: -1, message: "script exhausted" } }); break; }
      const turnId = `scripted-turn-${turn}`;
      appendFileSync(process.env.GENEHUB_TEST_CODEX_JOURNAL, JSON.stringify({ turn: turnId, pid: process.pid }) + "\n");
      reply({ turn: { id: turnId } });
      write({ method: "turn/started", params: { threadId: thread, turn: { id: turnId } } });
      for (const frame of frames) write(bind(frame, turnId));
      write({ method: "turn/completed", params: { threadId: thread, turn: { id: turnId, status: "completed" } } });
      break;
    }
    default: reply({});
  }
});
