// An ACP-speaking agent whose misbehaviour is chosen on the launch line.
//
// The daemon reaches this exactly the way it reaches Cursor or Goose: an
// `agents.custom` entry with `extends: "acp"`, so nothing inside the product
// is stubbed or patched to run these cases. What varies is only what a real
// external CLI is free to do — answer, go quiet, exit without a terminal
// frame, leave a grandchild holding the pipe, ignore a cancel, ignore
// SIGTERM, stop draining stdin, or shout.
//
// Startup profiles deliberately stall initialize or session/new. Other
// profiles complete the handshake and exercise an execution already in flight.
//
// Usage:
//   node controlled-agent.mjs --profile <name> --journal <path> [--chunks N]
//                             [--delay-ms N] [--floods N]

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const PROTOCOL_VERSION = 1;

function parseArgs(argv) {
  const args = { profile: "normal", journal: "", chunks: 2, delayMs: 0, floods: 4000 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--profile") args.profile = String(value);
    else if (key === "--journal") args.journal = String(value);
    else if (key === "--chunks") args.chunks = Number(value);
    else if (key === "--delay-ms") args.delayMs = Number(value);
    else if (key === "--floods") args.floods = Number(value);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

/** The case reads this file; it is the only thing the script asserts about
 * itself. Appends are synchronous so a profile that exits abruptly still
 * leaves the line that explains why. */
function journal(event, extra = {}) {
  if (!args.journal) return;
  const line = JSON.stringify({
    ts: Date.now(),
    pid: process.pid,
    ppid: process.ppid,
    profile: args.profile,
    event,
    ...extra,
  });
  try {
    appendFileSync(args.journal, `${line}\n`);
  } catch {
    // A journal that cannot be written must not change how the agent behaves.
  }
}

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function update(sessionId, body) {
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });
}

function messageChunk(sessionId, text) {
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exits only once stdout has actually drained. `process.exit` on a piped
 * stdout discards buffered bytes, which would make "exited after one chunk"
 * indistinguishable from "exited saying nothing". */
function exitAfterFlush(code) {
  journal("exit", { code });
  process.stdout.write("", () => process.exit(code));
  setTimeout(() => process.exit(code), 250).unref();
}

/** A grandchild that inherits stdout and outlives us: the daemon's read pipe
 * never reaches EOF even though the process it spawned is gone. This is the
 * shape any CLI shipped as a shell/npm shim already has.
 *
 * It stays in our process group on purpose. A shim's child does, and that is
 * what makes reaping it the product's job rather than an impossible ask.
 */
function leaveGrandchildHoldingStdout() {
  const child = spawn(
    process.execPath,
    ["-e", `setInterval(() => {}, 1000); process.title = "controlled-agent-orphan";`],
    { stdio: ["ignore", "inherit", "ignore"] },
  );
  child.unref();
  // `spawn` only asks for a process; the fork happens on the event loop. Exiting
  // before it lands is how this profile silently degrades into the plain
  // exit-without-terminal one, which is a different case.
  return new Promise((resolve) => {
    child.once("spawn", () => {
      journal("orphan-spawned", { orphanPid: child.pid });
      resolve(child.pid);
    });
    child.once("error", (error) => {
      journal("orphan-failed", { error: String(error) });
      resolve(undefined);
    });
  });
}

let sessionCounter = 0;
let currentSessionId = null;
/** The `session/prompt` we accepted and have not answered. */
let pendingPrompt = null;
let draining = true;

async function onPrompt(id, params) {
  const sessionId = params?.sessionId ?? currentSessionId;
  pendingPrompt = { id, sessionId };
  journal("prompt", { id });

  if (args.delayMs > 0) await sleep(args.delayMs);

  switch (args.profile) {
    case "normal": {
      for (let i = 0; i < args.chunks; i += 1) messageChunk(sessionId, `chunk-${i} `);
      pendingPrompt = null;
      respond(id, { stopReason: "end_turn" });
      journal("answered", { id, stopReason: "end_turn" });
      return;
    }
    // The turn is accepted, one chunk arrives, and then the process is gone
    // without any terminal frame. Reproduces an agent that crashes mid-turn.
    case "exit-without-terminal": {
      messageChunk(sessionId, "partial ");
      exitAfterFlush(0);
      return;
    }
    // The same crash, except a grandchild keeps the stdout pipe open, so the
    // daemon's reader sees neither a terminal frame nor EOF.
    case "grandchild-holds-stdout": {
      messageChunk(sessionId, "partial ");
      await leaveGrandchildHoldingStdout();
      exitAfterFlush(0);
      return;
    }
    // Alive, healthy, and never answering. A cancel is still honoured.
    case "accept-then-silent": {
      messageChunk(sessionId, "thinking ");
      journal("went-silent", { id });
      return;
    }
    case "reasoning-ignore-interrupt": {
      update(sessionId, { sessionUpdate: "agent_thought_chunk", content: {
        type: "text", text: "Reasoning overview. " + "source detail ".repeat(512) + "final-reasoning-marker",
      } });
      journal("went-silent", { id });
      return;
    }
    case "burst-then-silent": {
      messageChunk(sessionId, "checkpoint-prefix ");
      await sleep(150);
      messageChunk(sessionId, "checkpoint-tail ");
      journal("went-silent", { id });
      return;
    }
    // Alive and deaf: neither the turn nor the cancel will ever be answered.
    case "ignore-interrupt":
    // Also refuses to die politely, so only the escalation to SIGKILL ends it.
    case "ignore-sigterm": {
      journal("went-silent", { id });
      return;
    }
    // Stops draining its own stdin. A prompt larger than the pipe buffer
    // leaves the daemon's write blocked mid-turn.
    case "stdin-never-drains": {
      journal("went-silent", { id });
      return;
    }
    // A turn that produces far more events than the client can consume.
    case "flood-events": {
      for (let i = 0; i < args.floods; i += 1) messageChunk(sessionId, `f${i} `);
      pendingPrompt = null;
      respond(id, { stopReason: "end_turn" });
      journal("answered", { id, stopReason: "end_turn", floods: args.floods });
      return;
    }
    default: {
      pendingPrompt = null;
      respond(id, { stopReason: "end_turn" });
    }
  }
}

function onCancel() {
  journal("cancel", { pending: pendingPrompt?.id ?? null });
  if (args.profile === "ignore-interrupt" || args.profile === "ignore-sigterm" || args.profile === "reasoning-ignore-interrupt") {
    journal("cancel-ignored");
    return;
  }
  if (!pendingPrompt) return;
  const { id } = pendingPrompt;
  pendingPrompt = null;
  respond(id, { stopReason: "cancelled" });
  journal("answered", { id, stopReason: "cancelled" });
}

async function onFrame(frame) {
  const { id, method, params } = frame;
  if (typeof method !== "string") return;
  if (method !== "session/update") journal("rpc", { method, id: id ?? null });

  switch (method) {
    case "initialize": {
      // A CLI that comes up, takes the connection, and then never finishes
      // introducing itself. This is the shape of a first run that goes wrong —
      // fetching something that never arrives, waiting on a lock nobody
      // releases — and it is the one phase where the daemon has already told
      // every client a turn is running before it has anything to run.
      if (args.profile === "never-finishes-starting") {
        journal("withholding-initialize", { id: id ?? null });
        return;
      }
      // No `authMethods`: the daemon would otherwise spend a round trip on an
      // `authenticate` that has nothing to do with what these cases measure.
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: true, embeddedContext: true },
        },
      });
      return;
    }
    case "session/new": {
      if (args.profile === "hang-session-new") {
        journal("withholding-session-new", { id });
        return;
      }
      sessionCounter += 1;
      currentSessionId = `controlled-${process.pid}-${sessionCounter}`;
      respond(id, { sessionId: currentSessionId });
      // The handshake is over, so a profile that must go deaf can go deaf now
      // without breaking session setup.
      if (args.profile === "stdin-never-drains") stopReadingStdin();
      return;
    }
    case "session/prompt": {
      await onPrompt(id, params);
      return;
    }
    case "session/cancel": {
      onCancel();
      return;
    }
    default: {
      // A request we do not implement still needs an answer, or the daemon
      // waits on it forever — which would be our bug, not the product's.
      if (id !== undefined && id !== null) {
        write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported: ${method}` } });
      }
    }
  }
}

if (args.profile === "ignore-sigterm") {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => journal("signal-ignored", { signal }));
  }
}

journal("start", { argv: process.argv.slice(2) });

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

/** Stops taking bytes off the pipe, without closing it.
 *
 * Pausing the stream is the whole mechanism, and it has to be *only* that:
 * closing the line reader first hands the descriptor back to a state where
 * bytes keep being consumed, and then the daemon's write never blocks, which
 * is the one thing these cases need it to do. The process stays alive on its
 * own timer because nothing is listening on stdin any more.
 */
function stopReadingStdin() {
  draining = false;
  process.stdin.pause();
  journal("stdin-paused", { bytesRead: process.stdin.bytesRead });
  // Nothing is listening on stdin any more, so the process needs its own
  // reason to stay alive. The sample doubles as the case's evidence that the
  // pipe really did stop moving.
  setInterval(() => journal("stdin-idle", { bytesRead: process.stdin.bytesRead }), 1_000).unref();
  setInterval(() => {}, 60_000);
}
/** Frames are handled one at a time: a profile that awaits inside a turn must
 * not have the next frame overtake it. */
let queue = Promise.resolve();
lines.on("line", (line) => {
  if (!draining || line.trim() === "") return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  queue = queue.then(() => onFrame(frame)).catch((error) => journal("error", { error: String(error) }));
});
lines.on("close", () => {
  journal("stdin-closed");
  process.exit(0);
});
