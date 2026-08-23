import { mkdirSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

async function withWorkspace(t: CaseContext, run: (opened: Opened) => Promise<void>): Promise<void> {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await run(opened);
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
}

function processCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext, opened: Opened) => Promise<void>,
): void {
  defineSpecialty(
    {
      id: `specialty.cli.process.${id}`,
      title,
      oracle,
      catches,
      tags: ["core", "cli", "process-depth"],
      expectedDurationMs: 20_000,
      timeoutMs: 120_000,
      resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
      surfaces: ["daemon", "workbench-client"],
      productInterfaces: ["@genehub/workbench/client"],
    },
    async (t) => withWorkspace(t, (opened) => run(t, opened)),
  );
}

async function shell(opened: Opened, t: CaseContext, argv: string[], options: { cwd?: string; env?: Record<string, string>; stdin?: Uint8Array } = {}) {
  return t.flows.main.runShell(opened.client, {
    workspaceId: opened.workspaceId,
    argv,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  }, options.stdin);
}

function stdout(t: CaseContext, frames: Parameters<CaseContext["flows"]["main"]["shellText"]>[0]): string {
  return t.flows.main.shellText(frames, "stdout");
}

processCase(
  "empty-argument-preserved",
  "An empty argv element reaches the child unchanged",
  "the child observes three arguments and the middle argument has length zero",
  ["empty argument dropped", "argv compacted"],
  async (t, opened) => {
    const result = await shell(opened, t, ["/bin/sh", "-c", "printf '%s|%s|%s|%s' \"$#\" \"$1\" \"${#2}\" \"$3\"", "argv0", "left", "", "right"]);
    t.assertions.assert(stdout(t, result.frames) === "3|left|0|right", `argv changed: ${stdout(t, result.frames)}`);
    t.assertions.assert(t.flows.main.shellExit(result.frames)?.code === 0, "argv probe failed");
  },
);

processCase(
  "unicode-argument-preserved",
  "Unicode argv survives the command boundary",
  "CJK, emoji, and combining characters return byte-for-byte as one argument",
  ["locale corruption", "UTF-8 argument split", "normalization changes payload"],
  async (t, opened) => {
    const value = "基因🧬e\u0301";
    const result = await shell(opened, t, ["/bin/sh", "-c", "printf '%s' \"$1\"", "argv0", value]);
    t.assertions.assert(stdout(t, result.frames) === value, `Unicode changed: ${JSON.stringify(stdout(t, result.frames))}`);
  },
);

processCase(
  "newline-argument-preserved",
  "A newline inside one argv element remains data",
  "the child reports one argument with the exact multiline value",
  ["newline treated as command separator", "argument split on lines"],
  async (t, opened) => {
    const value = "first\nsecond";
    const result = await shell(opened, t, ["/bin/sh", "-c", "printf '%s|%s' \"$#\" \"$1\"", "argv0", value]);
    t.assertions.assert(stdout(t, result.frames) === `1|${value}`, `newline argv changed: ${JSON.stringify(stdout(t, result.frames))}`);
  },
);

processCase(
  "wildcard-is-literal",
  "Wildcard characters in argv are not expanded by the daemon",
  "an asterisk reaches the child literally even when matching files exist",
  ["implicit shell glob expansion", "workspace contents alter argv"],
  async (t, opened) => {
    const result = await shell(opened, t, ["/bin/echo", "*.specialty.ts"]);
    t.assertions.assert(stdout(t, result.frames).trim() === "*.specialty.ts", `wildcard expanded: ${stdout(t, result.frames)}`);
  },
);

processCase(
  "dollar-is-literal",
  "Dollar expressions in argv are not environment-expanded",
  "the literal $HOME token reaches echo",
  ["daemon invokes through a shell", "host environment leaks through argument interpolation"],
  async (t, opened) => {
    const result = await shell(opened, t, ["/bin/echo", "$HOME"]);
    t.assertions.assert(stdout(t, result.frames).trim() === "$HOME", `dollar expanded: ${stdout(t, result.frames)}`);
  },
);

processCase(
  "nested-cwd-exact",
  "A nested workspace cwd is honored exactly",
  "pwd reports the requested nested directory rather than the workspace root",
  ["cwd ignored", "cwd silently clamped"],
  async (t, opened) => {
    const nested = path.join(opened.workspaceRoot, "one", "two");
    mkdirSync(nested, { recursive: true });
    const result = await shell(opened, t, ["/bin/pwd"], { cwd: nested });
    t.assertions.assert(path.resolve(stdout(t, result.frames).trim()) === path.resolve(nested), `cwd changed: ${stdout(t, result.frames)}`);
  },
);

processCase(
  "missing-cwd-does-not-run",
  "A missing cwd fails without running the requested command",
  "no marker text appears on stdout and the request is non-successful",
  ["missing cwd falls back to root", "command runs before cwd validation"],
  async (t, opened) => {
    const result = await shell(opened, t, ["/bin/echo", "MUST-NOT-RUN"], { cwd: path.join(opened.workspaceRoot, "absent") });
    t.assertions.assert(!stdout(t, result.frames).includes("MUST-NOT-RUN"), `command ran: ${JSON.stringify(result.frames)}`);
    t.assertions.assert(result.status !== 200 || t.flows.main.shellExit(result.frames)?.code !== 0, "missing cwd succeeded");
  },
);

processCase(
  "unicode-environment-preserved",
  "Unicode environment values reach the child unchanged",
  "the exact multilingual value is printed from the child environment",
  ["environment encoding loss", "emoji truncated"],
  async (t, opened) => {
    const value = "环境-δοκιμή-🧬";
    const result = await shell(opened, t, ["/bin/sh", "-c", "printf '%s' \"$GENET_CASE\""], { env: { GENET_CASE: value } });
    t.assertions.assert(stdout(t, result.frames) === value, `env changed: ${JSON.stringify(stdout(t, result.frames))}`);
  },
);

processCase(
  "newline-environment-preserved",
  "A multiline environment value remains one value",
  "the child prints the exact value including its embedded newline",
  ["environment parsed as dotenv", "newline truncated"],
  async (t, opened) => {
    const value = "alpha\nbeta";
    const result = await shell(opened, t, ["/bin/sh", "-c", "printf '%s' \"$GENET_CASE\""], { env: { GENET_CASE: value } });
    t.assertions.assert(stdout(t, result.frames) === value, `multiline env changed: ${JSON.stringify(stdout(t, result.frames))}`);
  },
);

processCase(
  "stdin-chunk-boundaries-transparent",
  "Large stdin crosses transport chunks without loss",
  "wc reports exactly 131071 bytes",
  ["last stdin chunk dropped", "length prefix corrupts body", "partial write closes stream"],
  async (t, opened) => {
    const input = new Uint8Array(131_071).fill(120);
    const result = await shell(opened, t, ["/usr/bin/wc", "-c"], { stdin: input });
    t.assertions.assert(Number(stdout(t, result.frames).trim()) === input.byteLength, `stdin length ${stdout(t, result.frames)}`);
  },
);

processCase(
  "large-stdout-complete",
  "Large stdout is collected without truncation",
  "the stream contains exactly 262144 payload characters",
  ["backpressure truncates output", "final frame overtakes data", "JSON framing loses chunks"],
  async (t, opened) => {
    const result = await shell(opened, t, ["/bin/sh", "-c", "head -c 262144 /dev/zero | tr '\\0' x"]);
    const output = stdout(t, result.frames);
    t.assertions.assert(output.length === 262_144 && /^x+$/.test(output), `stdout size/content ${output.length}`);
    t.assertions.assert(t.flows.main.shellExit(result.frames)?.code === 0, "large producer failed");
  },
);

processCase(
  "stderr-without-newline",
  "A final stderr fragment is not lost",
  "stderr contains the exact unterminated text and stdout stays empty",
  ["line buffering drops tail", "stderr tail moved to stdout"],
  async (t, opened) => {
    const result = await shell(opened, t, ["/bin/sh", "-c", "printf tail-fragment >&2"]);
    t.assertions.assert(t.flows.main.shellText(result.frames, "stderr") === "tail-fragment", "stderr tail changed");
    t.assertions.assert(stdout(t, result.frames) === "", "stderr leaked to stdout");
  },
);

processCase(
  "exit-255-preserved",
  "The maximum portable shell exit status is preserved",
  "exit 255 is reported as code 255 rather than transport failure",
  ["exit code narrowed", "nonzero status replaced with generic one"],
  async (t, opened) => {
    const result = await shell(opened, t, ["/bin/sh", "-c", "exit 255"]);
    t.assertions.assert(result.status === 200, `transport status ${result.status}`);
    t.assertions.assert(t.flows.main.shellExit(result.frames)?.code === 255, `exit ${JSON.stringify(t.flows.main.shellExit(result.frames))}`);
  },
);

processCase(
  "signal-termination-settles",
  "Signal termination settles without claiming success",
  "a self-SIGTERM produces an exit frame whose code is not zero",
  ["signal leaves stream open", "signal flattened to exit zero", "exit frame omitted"],
  async (t, opened) => {
    const result = await shell(opened, t, ["/bin/sh", "-c", "kill -TERM $$"]);
    const exit = t.flows.main.shellExit(result.frames);
    t.assertions.assert(exit !== undefined, `exit frame absent: ${JSON.stringify(result.frames)}`);
    t.assertions.assert(exit?.code == null || exit.code !== 0, `signal claimed success: ${JSON.stringify(exit)}`);
  },
);

processCase(
  "missing-executable-structured-failure",
  "A missing executable fails as a command rather than breaking the stream",
  "the request settles with an exit frame or a deliberate non-200 response and never claims success",
  ["spawn error hangs stream", "missing executable returns exit zero", "transport crashes"],
  async (t, opened) => {
    const result = await shell(opened, t, [path.join(opened.workspaceRoot, "definitely-not-an-executable")]);
    const exit = t.flows.main.shellExit(result.frames);
    t.assertions.assert(result.status !== 200 || (exit !== undefined && exit.code !== 0), `missing executable succeeded: ${JSON.stringify(result)}`);
  },
);
