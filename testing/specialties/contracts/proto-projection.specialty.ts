import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

// Native intrinsic: the Rust schema is the generator, not a business oracle.
defineSpecialty({
  id: "specialty.contracts.proto-projection",
  title: "Public TypeScript protocol is the exact Rust projection",
  oracle: "Every generated TypeScript file equals the shipped projection",
  catches: ["new RPC usable in Rust but absent from the public client", "handwritten protocol shape drift"],
  tags: ["contract", "protocol"], llm: {default: "none"},
  expectedDurationMs: 15000, timeoutMs: 180000,
  resources: {environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "exclusive"},
  surfaces: ["protocol-codec", "rust-schema"],
  productInterfaces: ["@genehub/proto"],
}, async t => {
  const generated = join(t.env.data, "proto-projection");
  await mkdir(generated, {recursive: true});
  const {stdout} = await promisify(execFile)("cargo", ["test", "-p", "genehub-proto", "--lib", "export_bindings"], {
    cwd: t.openRoot, env: {...process.env, TS_RS_EXPORT_DIR: generated}, timeout: 150000, maxBuffer: 2 * 1024 * 1024,
  });
  t.assertions.assert(/test result: ok\. [1-9]\d* passed/.test(stdout), "Protocol generation executed no schema exports");
  const files = (await readdir(generated)).filter(file => file.endsWith(".ts"));
  t.assertions.assert(files.includes("index.ts"), "Missing generated protocol index");
  for (const file of files) t.assertions.assert(await readFile(join(generated, file), "utf8") === await readFile(join(t.openRoot, "packages/proto/bindings", file), "utf8"), `Protocol projection drift: ${file}; generated=${generated}`);
  t.note(`Exact protocol projections=${files.length}`);
});
