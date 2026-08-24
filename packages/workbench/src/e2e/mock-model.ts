/**
 * A stand-in for an OpenAI-compatible model API, for tests that need a real
 * daemon to hold a real conversation without a real key.
 *
 * The Rust harness has a much richer one (`testing/src/mock_llm.rs`); this is
 * deliberately the smallest thing that streams a reply the built-in agent will
 * accept, because the tests here are about the transport underneath the
 * conversation rather than about parsing model output.
 */
import { createServer, type Server } from "node:http";

/** The single model this stand-in reports having. */
export const MODEL = "deepseek-v4-flash";

export interface MockModel {
  baseUrl: string;
  /** How many completions have been asked for, in order. */
  prompts: string[];
  close(): Promise<void>;
}

/** Serves `reply`, split into several frames so streaming is exercised. */
export async function startMockModel(reply: string): Promise<MockModel> {
  const prompts: string[] = [];

  const server = createServer((request, response) => {
    // Which models this "provider" has. The daemon asks before it offers a
    // picker, and a mock that answers every path with an event stream leaves it
    // parsing SSE as JSON — an empty picker, and a conversation that never
    // starts, which is exactly what a real endpoint behaving this way would do.
    if (request.url?.endsWith("/models")) {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: MODEL }] }));
      return;
    }

    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      // The agent must authenticate even here: skipping it would let a
      // missing-credentials bug through.
      const authorization = request.headers.authorization ?? "";
      if (!authorization.startsWith("Bearer ")) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "no api key" } }));
        return;
      }
      prompts.push(body);

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      for (const frame of frames(reply))
        response.write(`data: ${JSON.stringify(frame)}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    prompts,
    close: () => close(server),
  };
}

function frames(reply: string): unknown[] {
  const pieces = split(reply);
  const chunks = pieces.map((piece) => ({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
  }));
  return [
    ...chunks,
    {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
    },
  ];
}

/** Splits mid-word on purpose: a one-frame reply tests nothing. */
function split(text: string): string[] {
  const size = Math.max(1, Math.ceil(text.length / 4));
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += size)
    pieces.push(text.slice(at, at + size));
  return pieces.length > 0 ? pieces : [""];
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
