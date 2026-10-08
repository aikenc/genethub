import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as zlib from "node:zlib";

export interface ScriptedTurn {
  text?: string;
  /** OpenAI-compatible reasoning stream; omit text to end without a visible answer. */
  reasoning?: string;
  tool?: { name: string; arguments: Record<string, unknown> };
  tools?: Array<{ name: string; arguments: Record<string, unknown> }>;
  status?: number;
  delayMs?: number;
  hang?: boolean;
  /** OpenAI-compatible streams may repeat an empty id on argument deltas. */
  emptyToolIdDeltas?: boolean;
  /**
   * Resolve a response from the exact model request that triggered it.
   *
   * This is for protocols whose next tool arguments contain daemon-issued
   * values from an earlier tool result (plan digests, revisions, opaque
   * challenges). Baking those values into a fixture would bypass the product
   * contract the journey is meant to exercise.
   */
  respond?: (request: unknown) => Omit<ScriptedTurn, "respond">;
}

/** One inbound HTTP request, as far as it can be recorded without a secret. */
export interface MockLlmCall {
  method: string;
  path: string;
  /** sha256 hex of the exact `Authorization` header value; the value itself is never kept. */
  authorizationSha256: string | null;
}

export interface MockLlmHandle {
  origin: string;
  requests: unknown[];
  inboundHeaders: Array<Record<string, string>>;
  /** Every request in arrival order, including model listings. */
  calls: MockLlmCall[];
  script(...turns: ScriptedTurn[]): void;
  stop(): Promise<void>;
}

function sse(response: ServerResponse, lines: string[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const line of lines) response.write(`${line}\n\n`);
  response.end();
}

function openaiChat(turn: ScriptedTurn, responseIndex: number): string[] {
  const frames: string[] = [];
  const send = (delta: unknown, finish: string | null = null) => {
    frames.push(
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        model: "mock-llm",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}`,
    );
  };
  const tools = turn.tools ?? (turn.tool ? [turn.tool] : []);
  if (tools.length > 0) {
    send({
      tool_calls: tools.map((tool, index) => ({
        index,
        id: `call_${responseIndex}_${index + 1}`,
        type: "function",
        function: { name: tool.name, arguments: turn.emptyToolIdDeltas ? "" : JSON.stringify(tool.arguments) },
      })),
    });
    if (turn.emptyToolIdDeltas) {
      const argumentsByTool = tools.map(tool => JSON.stringify(tool.arguments));
      for (let offset = 0; offset < Math.max(...argumentsByTool.map(args => args.length)); offset += 7) {
        send({ tool_calls: argumentsByTool.flatMap((args, index) => offset < args.length
          ? [{ index, id: "", function: { arguments: args.slice(offset, offset + 7) } }] : []) });
      }
    }
    send({}, "tool_calls");
  } else {
    if (turn.reasoning) send({ reasoning_content: turn.reasoning });
    const text = turn.text ?? (turn.reasoning ? "" : "ok");
    if (text) {
      const split = Math.max(1, Math.ceil(text.length / 2));
      send({ content: text.slice(0, split) });
      send({ content: text.slice(split) });
    }
    send({}, "stop");
  }
  frames.push(
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 8, completion_tokens: 4, reasoning_tokens: 0 },
    })}`,
  );
  frames.push("data: [DONE]");
  return frames;
}

function anthropic(turn: ScriptedTurn): string[] {
  const text = turn.text ?? "ok";
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", role: "assistant" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
  ];
}

/** OpenAI Responses streaming: the item and content-part envelope around the
 * text and a full usage object, as a strict client (codex) requires. */
function responses(turn: ScriptedTurn, responseIndex: number): string[] {
  const text = turn.text ?? "ok";
  const id = `resp_${responseIndex}`;
  const itemId = `msg_${responseIndex}`;
  const part = { type: "output_text", text, annotations: [] };
  const item = { id: itemId, type: "message", role: "assistant", status: "completed", content: [part] };
  const response = (status: string, output: unknown[]) => ({
    id, object: "response", created_at: 0, model: "mock-llm", status, output,
  });
  const usage = {
    input_tokens: 8,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 4,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 12,
  };
  const tools = turn.tools ?? (turn.tool ? [turn.tool] : []);
  if (tools.length) {
    const items = tools.map((tool, index) => ({
      id: `fc_${responseIndex}_${index}`, type: "function_call", status: "completed",
      call_id: `call_${responseIndex}_${index}`, name: tool.name, arguments: JSON.stringify(tool.arguments),
    }));
    const events: Array<Record<string, unknown>> = [
      { type: "response.created", response: response("in_progress", []) },
      { type: "response.in_progress", response: response("in_progress", []) },
    ];
    items.forEach((item, index) => {
      const at = { item_id: item.id, output_index: index };
      events.push(
        { type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", arguments: "" } },
        { type: "response.function_call_arguments.delta", ...at, delta: item.arguments },
        { type: "response.function_call_arguments.done", ...at, arguments: item.arguments },
        { type: "response.output_item.done", output_index: index, item },
      );
    });
    events.push({ type: "response.completed", response: { ...response("completed", items), usage } });
    return events.map((event, sequence) => `event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence })}`);
  }
  const at = { item_id: itemId, output_index: 0, content_index: 0 };
  const events: Array<Record<string, unknown>> = [
    { type: "response.created", response: response("in_progress", []) },
    { type: "response.in_progress", response: response("in_progress", []) },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", ...at, part: { ...part, text: "" } },
    { type: "response.output_text.delta", ...at, delta: text },
    { type: "response.output_text.done", ...at, text },
    { type: "response.content_part.done", ...at, part },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...response("completed", [item]), usage } },
  ];
  return events.map((event, sequence) =>
    `event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence })}`);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const limit = 16 * 1024 * 1024;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("model request too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  let bytes = Buffer.concat(chunks);
  const encoding = request.headers["content-encoding"];
  const options = { maxOutputLength: limit };
  if (encoding === "gzip") bytes = zlib.gunzipSync(bytes, options);
  else if (encoding === "deflate") bytes = zlib.inflateSync(bytes, options);
  else if (encoding === "br") bytes = zlib.brotliDecompressSync(bytes, options);
  else if (encoding === "zstd" && typeof zlib.zstdDecompressSync === "function") bytes = zlib.zstdDecompressSync(bytes, options);
  else if (encoding && encoding !== "identity") throw new Error("unsupported model request encoding");
  return JSON.parse(bytes.toString("utf8"));
}

function redact(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(redact);
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of Object.keys(copy)) {
    const lower = key.toLowerCase();
    copy[key] =
      lower.includes("key") || lower.includes("token") || lower.includes("authorization")
        ? "[redacted]"
        : redact(copy[key]);
  }
  return copy;
}

export async function startMockLlm(): Promise<MockLlmHandle> {
  const queue: ScriptedTurn[] = [];
  const requests: unknown[] = [];
  const inboundHeaders: Array<Record<string, string>> = [];
  const calls: MockLlmCall[] = [];
  let responseIndex = 0;
  const server: Server = createServer(async (request, response) => {
    const url = request.url ?? "";
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value !== "string") continue;
      const lower = key.toLowerCase();
      if (lower.includes("authorization") || lower.includes("token") || lower.includes("key")) {
        continue;
      }
      headers[lower] = value;
    }
    inboundHeaders.push(headers);
    const authorization = request.headers.authorization;
    calls.push({
      method: request.method ?? "GET",
      path: url.split("?")[0] ?? url,
      authorizationSha256: typeof authorization === "string"
        ? createHash("sha256").update(authorization).digest("hex")
        : null,
    });
    if (url.endsWith("/models")) {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          object: "list",
          data: [{ id: "deepseek-v4-flash" }, { id: "mock-llm" }],
        }),
      );
      return;
    }
    let body: unknown = {};
    try {
      body = await readJson(request);
    } catch {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
        error: { type: "invalid_request_error", message: "invalid or unsupported compressed JSON request" },
      }));
      return;
    }
    requests.push(redact(body));
    const scripted = queue.shift() ?? { text: "ok" };
    let turn: Omit<ScriptedTurn, "respond">;
    try {
      turn = scripted.respond ? scripted.respond(body) : scripted;
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: "scripted_response_error",
          },
        }),
      );
      return;
    }
    if (turn.hang) return;
    if (turn.delayMs) await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
    if (turn.status && turn.status >= 400) {
      response.writeHead(turn.status, { "content-type": "application/json" }).end(
        JSON.stringify({ error: { message: "injected mock failure", type: "server_error" } }),
      );
      return;
    }
    if (url.includes("/messages")) {
      if ((body as {stream?: unknown}).stream === false) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          id: "msg_test", type: "message", role: "assistant", content: [{type:"text", text:turn.text ?? "ok"}], stop_reason:"end_turn", usage:{input_tokens:8,output_tokens:4},
        }));
        return;
      }
      sse(response, anthropic(turn));
      return;
    }
    if (url.includes("/responses")) {
      sse(response, responses(turn, ++responseIndex));
      return;
    }
    if (url.includes("/chat/completions") || url.endsWith("/completions")) {
      if ((body as {stream?: unknown}).stream === false) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          id: "chatcmpl-test", object:"chat.completion", choices:[{index:0,message:{role:"assistant",content:turn.text ?? "ok"},finish_reason:"stop"}], usage:{prompt_tokens:8,completion_tokens:4},
        }));
        return;
      }
      sse(response, openaiChat(turn, ++responseIndex));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    inboundHeaders,
    calls,
    script: (...turns) => {
      queue.push(...turns);
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
