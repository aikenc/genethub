import type { ChildProcess } from "node:child_process";

const OUTPUT_LIMIT = 8 * 1024 * 1024;

interface BoundedOutput {
  text(): string;
  bytes(): number;
  truncated(): boolean;
}

function boundedOutput(): { append(chunk: Buffer): void; output: BoundedOutput } {
  const headLimit = Math.floor(OUTPUT_LIMIT / 2);
  const tailLimit = OUTPUT_LIMIT - headLimit;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let total = 0;
  return {
    append(chunk) {
      total += chunk.length;
      if (head.length < headLimit) {
        const needed = headLimit - head.length;
        head = Buffer.concat([head, chunk.subarray(0, needed)]);
        chunk = chunk.subarray(Math.min(needed, chunk.length));
      }
      if (chunk.length > 0) {
        tail = Buffer.concat([tail, chunk]);
        if (tail.length > tailLimit) tail = tail.subarray(tail.length - tailLimit);
      }
    },
    output: {
      text() {
        if (total <= OUTPUT_LIMIT) return Buffer.concat([head, tail]).toString("utf8");
        return `${head.toString("utf8")}\n\n[... testctl omitted ${total - OUTPUT_LIMIT} worker output bytes ...]\n\n${tail.toString("utf8")}`;
      },
      bytes: () => total,
      truncated: () => total > OUTPUT_LIMIT,
    },
  };
}

export async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process ${child.pid ?? "?"} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export function collectOutput(child: ChildProcess): {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
} {
  const stdout = boundedOutput();
  const stderr = boundedOutput();
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout.append(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.append(chunk);
  });
  return {
    get stdout() {
      return stdout.output.text();
    },
    get stderr() {
      return stderr.output.text();
    },
    get stdoutBytes() {
      return stdout.output.bytes();
    },
    get stderrBytes() {
      return stderr.output.bytes();
    },
    get stdoutTruncated() {
      return stdout.output.truncated();
    },
    get stderrTruncated() {
      return stderr.output.truncated();
    },
  };
}
