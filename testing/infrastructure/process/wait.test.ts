import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";

import { collectOutput } from "./wait.ts";

test("worker output is always drained and retained with an explicit bound", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output = collectOutput({ stdout, stderr } as unknown as ChildProcess);
  stdout.write(Buffer.alloc(9 * 1024 * 1024, "a"));
  stdout.write("tail-marker");
  stderr.write("bounded warning");
  stdout.end();
  stderr.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(output.stdoutTruncated, true);
  assert(output.stdoutBytes > 9 * 1024 * 1024);
  assert(output.stdout.includes("testctl omitted"));
  assert(output.stdout.endsWith("tail-marker"));
  assert.equal(output.stderr, "bounded warning");
  assert.equal(output.stderrTruncated, false);
});
