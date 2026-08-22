import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ScriptedTurn {
  text?: string;
  tool?: { name: string; arguments: Record<string, unknown> };
  tools?: Array<{ name: string; arguments: Record<string, unknown> }>;
  status?: number;
  delayMs?: number;
  hang?: boolean;
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

function openaiChat(turn: ScriptedTurn): string[] {
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
        id: `call_${index + 1}`,
        type: "function",
        function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
      })),
    });
    send({}, "tool_calls");
  } else {
    const text = turn.text ?? "ok";
    const split = Math.max(1, Math.ceil(text.length / 2));
    send({ content: text.slice(0, split) });
    send({ content: text.slice(split) });
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

function responses(turn: ScriptedTurn): string[] {
  const text = turn.text ?? "ok";
  return [
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 8, output_tokens: 4 } } })}`,
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
    const turn = queue.shift() ?? { text: "ok" };
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
      sse(response, openaiChat(turn));
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
