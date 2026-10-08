import * as zlib from "node:zlib";
import { defineSpecialty, startMockLlm, BlockedError } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.mock-llm-compression",
  title: "Mock LLM reads real compressed HTTP requests and rejects malformed input",
  oracle: "gzip, deflate, brotli and zstd HTTP bodies reach the scripted responder as JSON, native Responses function calls are emitted, and malformed JSON is refused without consuming a queued response",
  catches: ["compressed model inputs silently become empty JSON", "invalid inputs receive success", "missing native function-call stream"],
  tags: ["core", "contract", "durable-interaction"], llm: { default: "none" },
  expectedDurationMs: 1000, timeoutMs: 15_000, surfaces: ["http", "mock-llm"],
}, async t => {
  if (typeof zlib.zstdCompressSync !== "function") throw new BlockedError("zstd protocol coverage requires Node 22.15+");
  const mock = await startMockLlm();
  try {
    for (const [encoding, encode] of Object.entries({ gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync, zstd: zlib.zstdCompressSync })) {
      let seen = false;
      mock.script({ respond: body => {
        seen = (body as { input?: string }).input === encoding;
        return { tool: { name: "request_user_input", arguments: { questions: [] } } };
      } });
      const reply = await fetch(mock.origin + "/v1/responses", { method: "POST", headers: { "content-encoding": encoding },
        body: encode(Buffer.from(JSON.stringify({ input: encoding }))) });
      const stream = await reply.text();
      t.assertions.assert(reply.ok && seen && stream.includes("response.function_call_arguments.done"), "compressed request or function stream failed: " + encoding);
    }
    mock.script({ text: "retained-after-invalid-json" });
    const bad = await fetch(mock.origin + "/v1/responses", { method: "POST", body: "invalid-json" });
    await bad.text();
    t.assertions.assert(bad.status === 400, "invalid JSON accepted");
    const valid = await fetch(mock.origin + "/v1/responses", { method: "POST", body: "{}" });
    t.assertions.assert((await valid.text()).includes("retained-after-invalid-json"), "invalid request consumed scripted response");
  } finally { await mock.stop(); }
});
