#!/usr/bin/env node
// Reference implementation of the `pack.script` host contract.
//
// It publishes a build output by copying a directory to a destination and
// reporting what it produced. There is deliberately no Git here and no
// version control of any kind: the point of this file is to demonstrate
// that the contract a package uses to teach the platform a new action does
// not depend on any repository tooling, so a project that is a plain folder
// — an asset depot, a render output tree, a mounted share — can declare
// actions exactly like a project that happens to be a checkout.
//
// The contract, in full:
//
//   in   one JSON object on stdin, whatever the node declared in `with.input`
//   out  one JSON object on stdout: {ok, evidence?, revision?, message?}
//   cwd  the Run's own task directory
//
// `evidence` is judged afterwards by the platform's registered pure
// predicates. This script does not decide whether its own work was
// acceptable — it reports facts and a verifier rules on them. That split is
// what lets anyone holding a Run record re-run the judgment without
// re-running the copy.

import { createHash } from "node:crypto";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

/// Every regular file under `root`, relative and in a stable order, so that
/// the digest below is a property of the content rather than of the order
/// the filesystem happened to hand things back in.
async function walk(root, prefix = "") {
  const found = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(root, relative)));
    else if (entry.isFile()) found.push(relative);
  }
  return found.sort();
}

async function main() {
  const { source = ".", destination, expectedFiles } = await readInput();
  if (!destination) throw new Error("publish-directory needs a destination");

  // Relative to the task directory, which is the cwd the platform set. The
  // platform already confined this process; resolving here only keeps the
  // reported paths meaningful.
  const from = path.resolve(source);
  const to = path.resolve(destination);
  if (!(await stat(from)).isDirectory()) {
    throw new Error(`source is not a directory: ${from}`);
  }

  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });

  const files = await walk(to);
  // An opaque receipt: the platform stores and compares it byte for byte
  // and never parses it, so its shape is this package's business.
  const digest = createHash("sha256");
  for (const file of files) digest.update(`${file}\0`);

  process.stdout.write(
    JSON.stringify({
      ok: true,
      revision: `dir:${digest.digest("hex").slice(0, 16)}`,
      evidence: {
        published: String(files.length),
        destination: to,
        // Reported as a fact, not enforced here. If the Workflow cares, it
        // declares `verify: value.equals` with its own expectation and the
        // platform's predicate decides — the script does not get to rule on
        // its own output.
        matchedExpectation:
          expectedFiles === undefined ? "unchecked" : String(files.length === expectedFiles),
      },
      message: `published ${files.length} files to ${to}`,
    }),
  );
}

main().catch((error) => {
  // A crash is a transport-shaped failure and the platform may retry it. A
  // business failure is reported as `ok: true` with evidence saying so.
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
