import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ScriptedTurn {
  text?: string;
  usage?: { inputTokens: number; outputTokens?: number };
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

export interface MockLlmHandle {
  origin: string;
  requests: unknown[];
  inboundHeaders: Array<Record<string, string>>;
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
      usage: { prompt_tokens: turn.usage?.inputTokens ?? 8, completion_tokens: turn.usage?.outputTokens ?? 4, reasoning_tokens: 0 },
    })}`,
  );
  frames.push("data: [DONE]");
  return frames;
}

function anthropicEvent(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}`;
}

function anthropic(turn: ScriptedTurn): string[] {
  const tools = turn.tools ?? (turn.tool ? [turn.tool] : []);
  const frames: string[] = [
    anthropicEvent("message_start", {
      message: {
        id: "msg_1",
        role: "assistant",
        usage: {
          input_tokens: turn.usage?.inputTokens ?? 11,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      },
    }),
  ];
  let index = 0;
  if (turn.reasoning) {
    frames.push(
      anthropicEvent("content_block_start", {
        index,
        content_block: { type: "thinking", thinking: "" },
      }),
      anthropicEvent("content_block_delta", {
        index,
        delta: { type: "thinking_delta", thinking: turn.reasoning },
      }),
      anthropicEvent("content_block_delta", {
        index,
        delta: { type: "signature_delta", signature: "sig_test" },
      }),
      anthropicEvent("content_block_stop", { index }),
    );
    index += 1;
  }
  if (tools.length > 0) {
    for (const [toolIndex, tool] of tools.entries()) {
      const block = index + toolIndex;
      frames.push(
        anthropicEvent("content_block_start", {
          index: block,
          content_block: { type: "tool_use", id: `toolu_${toolIndex + 1}`, name: tool.name, input: {} },
        }),
        anthropicEvent("content_block_delta", {
          index: block,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.arguments) },
        }),
        anthropicEvent("content_block_stop", { index: block }),
      );
    }
    frames.push(
      anthropicEvent("message_delta", {
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: turn.usage?.outputTokens ?? 6 },
      }),
    );
  } else {
    const text = turn.text ?? (turn.reasoning ? "" : "ok");
    if (text) {
      frames.push(
        anthropicEvent("content_block_start", {
          index,
          content_block: { type: "text", text: "" },
        }),
        anthropicEvent("content_block_delta", {
          index,
          delta: { type: "text_delta", text },
        }),
        anthropicEvent("content_block_stop", { index }),
      );
    }
    frames.push(
      anthropicEvent("message_delta", {
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: turn.usage?.outputTokens ?? 4 },
      }),
    );
  }
  frames.push(anthropicEvent("message_stop", {}));
  return frames;
}

function responses(turn: ScriptedTurn): string[] {
  const text = turn.text ?? "ok";
  return [
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: turn.usage?.inputTokens ?? 8, output_tokens: turn.usage?.outputTokens ?? 4 } } })}`,
    "data: [DONE]",
  ];
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
      body = {};
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
      sse(response, anthropic(turn));
      return;
    }
    if (url.includes("/responses")) {
      sse(response, responses(turn));
      return;
    }
    if (url.includes("/chat/completions") || url.endsWith("/completions")) {
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
