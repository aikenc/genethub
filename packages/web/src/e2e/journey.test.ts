// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { Client, type WebSocketLike } from "../protocol/client";
import { applySequenced, assistantText, emptyTimeline, fromSnapshot } from "../session/timeline";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const DAEMON = path.join(REPO, "target/debug/genet-daemon");

/**
 * The workbench's own client, against a real daemon and a real agent.
 *
 * Every other test in this package mocks the socket, which is the right call
 * for behaviour but blind to anything about the wire: an event addressed to a
 * topic nobody listens on looks identical to no event at all. This is the test
 * that has to notice.
 *
 * The model is the only thing faked, because that is the one part that costs
 * money and refuses to be deterministic.
 */
describe.skipIf(!existsSync(DAEMON))("a session, end to end", () => {
  let model: MockModel;
  let daemon: ChildProcess;
  let client: Client;
  let dataDir: string;
  let homeDir: string;
  let workspaceDir: string;
  let workspaceId: string;

  beforeAll(async () => {
    model = await startMockModel();
    dataDir = mkdtempSync(path.join(tmpdir(), "genehub-e2e-data-"));
    homeDir = mkdtempSync(path.join(tmpdir(), "genehub-e2e-home-"));
    workspaceDir = mkdtempSync(path.join(tmpdir(), "genehub-e2e-work-"));
    writeFileSync(path.join(workspaceDir, "notes.md"), "hello\n");

    const started = await startDaemon(dataDir, path.join(homeDir, "GeneHub"));
    daemon = started.process;
    client = new Client({
      url: `ws://127.0.0.1:${started.port}/ws?token=${started.token}`,
      socketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
      clientName: "e2e",
    });
    client.connect();
    await waitFor(() => client.connectionState === "ready");

    // The key the user would type in settings, pointed at the fake model.
    await client.call({
      type: "settings.setProvider",
      payload: {
        providerId: "deepseek",
        apiKey: "sk-test",
        baseUrl: model.origin,
        label: null,
        dialect: null,
        // Left out on purpose: the daemon asks the address above what it has, and
        // that answer is what fills the picker in a real install.
        models: null,
      },
    });

    const workspace = await client.call({
      type: "workspace.open",
      payload: { root: workspaceDir },
    });
    if (workspace?.type !== "workspace") throw new Error("the workspace would not open");
    workspaceId = workspace.data.id;
  }, 30_000);

  afterAll(async () => {
    client?.close();
    daemon?.kill("SIGKILL");
    await model?.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  /**
   * The install has to be able to answer "where would you run this?" on its
   * own. Otherwise the first screen is a folder picker in front of a product
   * the user has not seen working yet.
   */
  it("comes with somewhere to work before the user has picked anything", async () => {
    const reply = await client.call({ type: "workspace.list" });
    expect(reply?.type).toBe("workspaces");
    if (reply?.type !== "workspaces") return;

    const expected = realpathSync(path.join(homeDir, "GeneHub"));
    expect(reply.data.map((entry) => entry.root)).toContain(expected);
    expect(existsSync(expected), "the folder is created, not just recorded").toBe(true);
  });

  it("offers the built-in agent with the models the key unlocked", async () => {
    const reply = await client.call({ type: "agent.list" });
    expect(reply?.type).toBe("agents");
    if (reply?.type !== "agents") return;

    const builtin = reply.data.find((agent) => agent.builtin);
    expect(builtin, "the shipped agent should always be listed").toBeTruthy();
    expect(builtin!.probe.state).toBe("ready");
    // Ids are provider-qualified, which is what the session has to send back.
    expect(builtin!.catalog.models.map((entry) => entry.id)).toContain(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("streams a reply back to the browser's timeline", async () => {
    model.script({ text: "读完了，没发现问题。" });

    const session = await client.call({
      type: "session.create",
      payload: {
        workspaceId,
        agentId: "genet",
        modelId: "deepseek/deepseek-v4-flash",
        modeId: null,
        title: null,
      },
    });
    if (session?.type !== "session") throw new Error("the session would not start");

    let timeline = emptyTimeline();
    const { snapshot, replayed } = await client.subscribe(session.data.id, {
      onEvent: (event) => {
        timeline = applySequenced(timeline, event);
      },
      onResync: () => {},
    });
    timeline = replayed.reduce(applySequenced, fromSnapshot(snapshot as never));

    await client.call({
      type: "session.send",
      payload: { sessionId: session.data.id, text: "看看 notes.md", attachments: [] },
    });

    await waitFor(() => assistantText(timeline).includes("读完了"), 20_000);
    expect(timeline.status).toBe("idle");
    expect(timeline.lastError).toBeNull();
  }, 30_000);

  it("runs a tool the model asks for, and the file really changes", async () => {
    model.script(
      { tool: { name: "write", arguments: { path: "result.txt", content: "DONE\n" } } },
      { text: "写好了。" },
    );

    const session = await client.call({
      type: "session.create",
      payload: {
        workspaceId,
        agentId: "genet",
        modelId: "deepseek/deepseek-v4-flash",
        modeId: null,
        title: null,
      },
    });
    if (session?.type !== "session") throw new Error("the session would not start");

    let timeline = emptyTimeline();
    await client.subscribe(session.data.id, {
      onEvent: (event) => {
        timeline = applySequenced(timeline, event);
      },
      onResync: () => {},
    });

    await client.call({
      type: "session.send",
      payload: { sessionId: session.data.id, text: "写个 result.txt", attachments: [] },
    });

    await waitFor(() => assistantText(timeline).includes("写好了"), 20_000);
    expect(readFileSync(path.join(workspaceDir, "result.txt"), "utf8").trim()).toBe("DONE");

    const toolCall = timeline.items.find((item) => item.type === "toolCall");
    expect(toolCall, "the browser should see the tool call, not just its effect").toBeTruthy();
  }, 30_000);

  /**
   * The acceptance action behind the whole adapter layer: one piece of frontend
   * code, two agents that share no transport, timelines of the same shape.
   *
   * OpenCode brings its own credentials, so it is pointed at the same fake
   * model rather than a real one. It is otherwise the genuine article.
   */
  it.skipIf(!onPath("opencode"))(
    "renders a third-party agent's turn in the same shape as the built-in one",
    async () => {
      writeFileSync(
        path.join(workspaceDir, "opencode.json"),
        JSON.stringify({
          provider: {
            journey: {
              npm: "@ai-sdk/openai-compatible",
              name: "Journey",
              options: { baseURL: model.origin, apiKey: "sk-test" },
              models: { "deepseek-v4-flash": { name: "Journey" } },
            },
          },
        }),
      );

      const shapes = async (agentId: string, modelId: string) => {
        const session = await client.call({
          type: "session.create",
          payload: { workspaceId, agentId, modelId, modeId: null, title: null },
        });
        if (session?.type !== "session") throw new Error(`${agentId} would not start`);

        let timeline = emptyTimeline();
        await client.subscribe(session.data.id, {
          onEvent: (event) => {
            timeline = applySequenced(timeline, event);
          },
          onResync: () => {},
        });
        await client.call({
          type: "session.send",
          payload: { sessionId: session.data.id, text: "说点什么", attachments: [] },
        });
        // The mock answers every unscripted turn the same way, including the
        // extra call OpenCode makes to name the thread.
        await waitFor(() => assistantText(timeline).includes("好的"), 60_000).catch(() => {
          throw new Error(
            `${agentId} never answered: status=${timeline.status} items=${JSON.stringify(timeline.items)}`,
          );
        });
        return timeline;
      };

      const builtin = await shapes("genet", "deepseek/deepseek-v4-flash");
      const thirdParty = await shapes("opencode", "journey/deepseek-v4-flash");

      const kinds = (timeline: typeof builtin) =>
        [...new Set(timeline.items.map((item) => item.type))].sort();
      expect(kinds(thirdParty)).toEqual(kinds(builtin));
      expect(thirdParty.status).toBe("idle");
      expect(thirdParty.lastError).toBeNull();
    },
    120_000,
  );

  it("serves the panels from the same connection", async () => {
    const tree = await client.call({ type: "file.tree", payload: { workspaceId, path: null, depth: 1 } });
    expect(tree?.type).toBe("fileTree");
    if (tree?.type === "fileTree") {
      expect(tree.data.children?.map((child) => child.name)).toContain("notes.md");
    }

    const read = await client.call({
      type: "file.read",
      payload: { workspaceId, path: "notes.md" },
    });
    expect(read?.type === "fileContent" && read.data.content).toContain("hello");

    const terminal = await client.call({ type: "pty.open", payload: { workspaceId, cols: 80, rows: 24 } });
    expect(terminal?.type).toBe("pty");
    if (terminal?.type === "pty") {
      const output = new Promise<string>((resolve) => {
        const stop = client.onPty((id, data) => {
          if (id !== terminal.data.ptyId || data === null) return;
          stop();
          resolve(data);
        });
      });
      await client.call({
        type: "pty.write",
        payload: { ptyId: terminal.data.ptyId, data: "echo hi\n" },
      });
      expect(await output).toBeTruthy();
      await client.call({ type: "pty.close", payload: { ptyId: terminal.data.ptyId } });
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------

interface Scripted {
  text?: string;
  tool?: { name: string; arguments: Record<string, unknown> };
}

interface MockModel {
  origin: string;
  script(...turns: Scripted[]): void;
  stop(): Promise<void>;
}

/**
 * An OpenAI-compatible endpoint that says what it is told to.
 *
 * Only the streaming shape matters here: the agent's parsing of it is covered
 * in Rust. What this exists for is to let a whole turn happen without a network
 * or a bill.
 */
async function startMockModel(): Promise<MockModel> {
  const queue: Scripted[] = [];

  const server: Server = createServer((request, response) => {
    // The daemon asks a provider what it has before offering a picker; an
    // endpoint that cannot answer this has no models to choose from.
    if (request.url?.endsWith("/models")) {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          object: "list",
          data: [{ id: "deepseek-v4-flash" }, { id: "text-embedding-3-small" }],
        }),
      );
      return;
    }
    if (!request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    // Drain the request body; the agent is entitled to a reader.
    request.resume();

    const turn = queue.shift() ?? { text: "好的。" };
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const send = (delta: unknown, finish: string | null = null) => {
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          model: "deepseek-v4-flash",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );
    };

    if (turn.tool) {
      send({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.arguments) },
          },
        ],
      });
      send({}, "tool_calls");
    } else {
      // In two pieces, because a reply that arrives whole would not prove the
      // deltas are being stitched together anywhere along the way.
      const text = turn.text ?? "好的。";
      const split = Math.ceil(text.length / 2);
      send({ content: text.slice(0, split) });
      send({ content: text.slice(split) });
      send({}, "stop");
    }

    response.write(
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 40, completion_tokens: 12 },
      })}\n\n`,
    );
    response.write("data: [DONE]\n\n");
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    origin: `http://127.0.0.1:${port}`,
    script: (...turns) => queue.push(...turns),
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function startDaemon(
  dataDir: string,
  defaultWorkspace: string,
): Promise<{ process: ChildProcess; port: number; token: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(DAEMON, {
      env: {
        ...process.env,
        GENEHUB_DATA_DIR: dataDir,
        // Otherwise a test run leaves a folder in whoever's home ran it.
        GENEHUB_WORKSPACE_DIR: defaultWorkspace,
        GENEHUB_LOG: "warn",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => reject(new Error("the daemon never reported a port")), 15_000);
    child.stderr?.on("data", (chunk) => process.stderr.write(`[daemon] ${chunk}`));
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const frame = JSON.parse(line) as { event: string; port: number; token: string };
        if (frame.event !== "listening") continue;
        clearTimeout(timer);
        resolve({ process: child, port: frame.port, token: frame.token });
      }
    });
  });
}

/** Whether an external agent is installed, so its case can skip rather than fail. */
function onPath(binary: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => existsSync(path.join(dir, binary)));
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for the daemon to get there");
}
