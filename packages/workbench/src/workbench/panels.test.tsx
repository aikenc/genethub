import type { Reply, Request } from "@genehub/proto";
import type { ProviderInfo } from "@genehub/proto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChangesPanel } from "../changes/ChangesPanel";
import { FilesPanel } from "../files/FilesPanel";
import { LogsPanel } from "../logs/LogsPanel";
import type { Client } from "../protocol/client";
import { SettingsPanel } from "../settings/SettingsPanel";
import { CHANNEL } from "../channel";
import { useWorkbench } from "../session/store";
import { UI_SCALE_KEY, useUiScale } from "../theme/scale";
import { browserHost } from "../host";

/**
 * A daemon that answers from a fixture.
 *
 * The panels are thin; what is worth testing is that they ask for the right
 * thing and put the answer somewhere a person can see it. A stub at the
 * protocol boundary tests exactly that and nothing about React.
 */
function stubDaemon(answers: Partial<Record<Request["type"], (payload: never) => Reply>>) {
  const calls: Request[] = [];
  const client = {
    call: async (request: Request) => {
      calls.push(request);
      const answer = answers[request.type];
      return answer?.((request as { payload?: never }).payload as never);
    },
    onPty: () => () => {},
    onNotice: () => () => {},
    onUpdateDownload: () => () => {},
    onBackgroundProcesses: () => () => {},
    onStateChange: () => () => {},
    identity: {
      daemonVersion: "test",
      webProtocol: 3,
      machineId: "m_device",
      machineName: "test",
      fingerprint: "AA-BB",
      transport: "forwarded",
      rtcSupported: false,
    },
  } as unknown as Client;
  return { client, calls };
}

function install(client: Client) {
  useWorkbench.setState({
    client,
    workspaces: [{
      id: "w1",
      name: "demo",
      root: "/tmp/demo",
      isGitRepo: true,
      folders: [{ name: "demo", root: "/tmp/demo", rootHandle: "r_demo" }],
    }],
    sessions: [],
    activeWorkspaceId: "w1",
    activeSessionId: null,
    tree: null,
    git: null,
    diff: null,
    settings: null,
    agents: [],
  });
}

beforeEach(() => {
  useWorkbench.setState({
    tree: null,
    git: null,
    diff: null,
    settings: null,
    log: null,
    update: null,
    updating: false,
    download: { state: "idle" },
    previewFloat: null,
  });
});

describe("the log panel", () => {
  /// The point of reading logs over the connection: the machine's path is no use
  /// to the phone that is holding the error.
  it("shows what the machine has been saying, from wherever it is being read", async () => {
    const { client, calls } = stubDaemon({
      "log.tail": () => ({
        type: "log",
        data: {
          name: "daemon.log",
          path: "C:\\Users\\me\\AppData\\Roaming\\GeneHub\\logs\\daemon.log",
          text: "WARN claude: Invalid API key · Please run /login",
          files: [
            { name: "daemon.log", bytes: 2048 },
            { name: "startup.log", bytes: 120 },
          ],
        },
      }),
    });
    install(client);

    render(<LogsPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("log-text").textContent).toContain("Invalid API key"),
    );
    expect(calls.some((call) => call.type === "log.tail")).toBe(true);
    // Both files are offered: the daemon's own log, and what it said before it
    // could log anything.
    expect(screen.getByText(/startup\.log/)).toBeTruthy();
  });

  it("asks again for the file it is already showing when refreshed", async () => {
    const { client, calls } = stubDaemon({
      "log.tail": () => ({
        type: "log",
        data: { name: "startup.log", path: "/tmp/logs/startup.log", text: "one", files: [] },
      }),
    });
    install(client);
    render(<LogsPanel />);
    await waitFor(() => expect(screen.getByTestId("log-text").textContent).toContain("one"));

    await userEvent.click(screen.getByTestId("refresh-log"));

    const asked = calls.filter((call) => call.type === "log.tail");
    expect(asked.length).toBe(2);
    expect((asked[1] as { payload: { name: string | null } }).payload.name).toBe("startup.log");
  });

  /// Desktop only. In a browser the button would do nothing, and a control that
  /// does nothing is worse than no control.
  it("offers to open the directory only where there is one to open", async () => {
    const { client } = stubDaemon({
      "log.tail": () => ({
        type: "log",
        data: { name: "daemon.log", path: "/tmp/logs/daemon.log", text: "", files: [] },
      }),
    });
    install(client);

    const { unmount } = render(<LogsPanel />);
    expect(screen.queryByText("打开日志目录")).toBeNull();
    unmount();

    render(<LogsPanel onOpenDirectory={() => {}} />);
    expect(screen.getByText("打开日志目录")).toBeTruthy();
  });
});

describe("the files panel", () => {
  it("opens a file in the workbench Preview float", async () => {
    const { client, calls } = stubDaemon({
      "file.tree": () => ({
        type: "fileTree",
        data: {
          name: "demo",
          path: "r_demo",
          isDir: true,
          children: [{ name: "notes.md", path: "r_demo/notes.md", isDir: false }],
        },
      }),
    });
    install(client);

    render(<FilesPanel />);
    const entry = await screen.findByText("notes.md");
    await userEvent.click(entry);
    expect(useWorkbench.getState().previewFloat).toEqual({
      deviceHandle: "m_device",
      workspaceHandle: "w1",
      path: "r_demo/notes.md",
      sessionId: null,
    });
    expect(calls.some((call) => call.type === "file.tree")).toBe(true);
    expect(calls.some((call) => call.type === "file.write")).toBe(false);
  });

  it("creates copies and deletes paths through the light file manager", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { client, calls } = stubDaemon({
      "file.tree": () => ({
        type: "fileTree",
        data: {
          name: "demo",
          path: "r_demo",
          isDir: true,
          children: [
            { name: "docs", path: "r_demo/docs", isDir: true, children: [] },
            { name: "notes.md", path: "r_demo/notes.md", isDir: false },
          ],
        },
      }),
      "file.mkdir": () => ({ type: "ack" }),
      "file.copy": () => ({ type: "ack" }),
      "file.delete": () => ({ type: "ack" }),
    });
    install(client);

    render(<FilesPanel />);
    await screen.findByText("notes.md");

    await userEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
    const input = await screen.findByLabelText("新文件夹名称");
    await userEvent.clear(input);
    await userEvent.type(input, "assets");
    await userEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => {
      expect(calls.find((call) => call.type === "file.mkdir")?.payload).toEqual({
        workspaceId: "w1",
        path: "r_demo/assets",
      });
    });

    await userEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(screen.getByRole("button", { name: "确认复制" })).toBeDisabled();
    await userEvent.click(screen.getByText("notes.md"));
    // Selecting for copy must not open Preview.
    expect(useWorkbench.getState().previewFloat).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "确认复制" }));
    await userEvent.click(screen.getByText("docs"));
    await userEvent.click(screen.getByRole("button", { name: "粘贴" }));
    await waitFor(() => {
      expect(calls.find((call) => call.type === "file.copy")?.payload).toEqual({
        workspaceId: "w1",
        from: "r_demo/notes.md",
        to: "r_demo/docs/notes.md",
      });
    });

    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    await userEvent.click(screen.getByText("notes.md"));
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => {
      expect(calls.find((call) => call.type === "file.delete")?.payload).toEqual({
        workspaceId: "w1",
        paths: ["r_demo/notes.md"],
      });
    });
    expect(confirm).toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("does not load file bytes into the workbench store", async () => {
    const { client } = stubDaemon({
      "file.tree": () => ({
        type: "fileTree",
        data: {
          name: "demo",
          path: "r_demo",
          isDir: true,
          children: [{ name: "notes.md", path: "r_demo/notes.md", isDir: false }],
        },
      }),
    });
    install(client);

    render(<FilesPanel />);
    await userEvent.click(await screen.findByText("notes.md"));
    expect(useWorkbench.getState().previewFloat?.path).toBe("r_demo/notes.md");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("expands a directory in place instead of navigating the whole UI", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const { client, calls } = stubDaemon({
      "file.tree": (payload: { path?: string | null }) =>
        payload.path === "r_demo/docs"
          ? {
              type: "fileTree",
              data: {
                name: "docs",
                path: "r_demo/docs",
                isDir: true,
                children: [{ name: "guide.md", path: "r_demo/docs/guide.md", isDir: false }],
              },
            }
          : {
              type: "fileTree",
              data: {
                name: "demo",
                path: "r_demo",
                isDir: true,
                // This is the exact shape older Rust daemons emitted for None.
                // Clicking it must not call null.map() and unmount the page.
                children: [{
                  name: "docs",
                  path: "r_demo/docs",
                  isDir: true,
                  children: null as never,
                }],
              },
            },
    });
    install(client);

    render(<FilesPanel />);
    await userEvent.click(await screen.findByRole("treeitem", { name: /docs/ }));

    expect(await screen.findByText("guide.md")).toBeInTheDocument();
    expect(opened).not.toHaveBeenCalled();
    expect(calls).toContainEqual({
      type: "file.tree",
      payload: { workspaceId: "w1", path: "r_demo/docs", depth: 1 },
    });
    expect(screen.getByText(/单个预览上限 64 MiB/)).toBeInTheDocument();
  });

  it("refreshes the root without requiring a page reload", async () => {
    let roots = 0;
    const { client } = stubDaemon({
      "file.tree": () => {
        roots += 1;
        return {
          type: "fileTree",
          data: {
            name: "demo",
            path: "r_demo",
            isDir: true,
            children: [
              { name: roots === 1 ? "before.md" : "after.md", path: roots === 1 ? "r_demo/before.md" : "r_demo/after.md", isDir: false },
            ],
          },
        };
      },
    });
    install(client);

    render(<FilesPanel />);
    expect(await screen.findByText("before.md")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    expect(await screen.findByText("after.md")).toBeInTheDocument();
    expect(screen.queryByText("before.md")).toBeNull();
    expect(roots).toBe(2);
  });
});

describe("the changes panel", () => {
  it("shows a file's diff when it is picked", async () => {
    const { client } = stubDaemon({
      "git.status": () => ({
        type: "gitStatus",
        data: {
          branch: "main",
          clean: false,
          changes: [{ path: "src/main.rs", kind: "modified", staged: false }],
        },
      }),
      "git.diff": () => ({ type: "gitDiff", data: { diff: "@@ -1 +1 @@\n-old\n+new" } }),
    });
    install(client);

    render(<ChangesPanel />);
    await userEvent.click(await screen.findByText("src/main.rs"));

    const diff = await screen.findByTestId("diff");
    expect(diff).toHaveTextContent("-old");
    expect(diff).toHaveTextContent("+new");
  });

  it("refuses to commit without a message", async () => {
    const { client } = stubDaemon({
      "git.status": () => ({
        type: "gitStatus",
        data: {
          branch: "main",
          clean: false,
          changes: [{ path: "src/main.rs", kind: "modified", staged: false }],
        },
      }),
    });
    install(client);

    render(<ChangesPanel />);
    await screen.findByText("src/main.rs");
    expect(screen.getByRole("button", { name: "提交全部改动" })).toBeDisabled();

    await userEvent.type(screen.getByLabelText("提交说明"), "修好了那个 bug");
    expect(screen.getByRole("button", { name: "提交全部改动" })).toBeEnabled();
  });

  it("commits, then reloads the status rather than trusting its own copy", async () => {
    let clean = false;
    const { client, calls } = stubDaemon({
      "git.status": () => ({
        type: "gitStatus",
        data: {
          branch: "main",
          clean,
          changes: clean ? [] : [{ path: "src/main.rs", kind: "modified", staged: false }],
        },
      }),
      "git.commit": () => {
        clean = true;
        return { type: "gitCommit", data: { commit: "abc1234" } };
      },
    });
    install(client);

    render(<ChangesPanel />);
    await screen.findByText("src/main.rs");
    await userEvent.type(screen.getByLabelText("提交说明"), "修好了那个 bug");
    await userEvent.click(screen.getByRole("button", { name: "提交全部改动" }));

    await screen.findByText("工作区干净");
    expect(calls.filter((call) => call.type === "git.status")).toHaveLength(2);
  });
});

/** A provider row as the daemon reports it, with only the parts a test cares about. */
function provider(over: Partial<ProviderInfo> & { id: string }): ProviderInfo {
  return {
    hasApiKey: false,
    label: over.id === "deepseek" ? "DeepSeek" : over.id === "openai" ? "OpenAI" : over.id,
    dialect: "openai",
    custom: false,
    models: [],
    ...over,
  };
}

describe("the settings panel", () => {
  it("sends a key without ever showing one back", async () => {
    let stored = false;
    const { client, calls } = stubDaemon({
      "settings.get": () => ({
        type: "settings",
        data: { lanEnabled: false, providers: [provider({ id: "deepseek", hasApiKey: stored })] },
      }),
      "settings.setProvider": () => {
        stored = true;
        return {
          type: "settings",
          data: {
            lanEnabled: false,
            providers: [
              provider({
                id: "deepseek",
                hasApiKey: true,
                baseUrl: "https://api.deepseek.com/v1",
                models: ["deepseek-chat", "deepseek-v4-flash"],
              }),
            ],
          },
        };
      },
      "agent.refresh": () => ({ type: "agents", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
    });
    install(client);

    render(<SettingsPanel host={browserHost()} />);
    const field = await screen.findByLabelText("DeepSeek API Key");
    expect(field).toHaveAttribute("type", "password");

    await userEvent.type(field, "sk-secret");
    await userEvent.click(screen.getByTestId("save-deepseek"));

    await waitFor(() => {
      const sent = calls.find((call) => call.type === "settings.setProvider");
      expect(sent?.payload).toMatchObject({ providerId: "deepseek", apiKey: "sk-secret" });
    });
    // The field empties and the placeholder becomes the only trace of the key.
    await waitFor(() => expect(field).toHaveValue(""));
    expect(field).toHaveAttribute("placeholder", "已配置，输入新值可替换");
  });

  /**
   * The answer to "配好 key 之后模型列表应该自动刷出来". The list comes from the
   * provider, so the page has to show what came back — otherwise saving a key
   * looks like it did nothing until you go hunting in the composer.
   */
  it("shows the models the provider reported, right where the key was typed", async () => {
    const { client } = stubDaemon({
      "settings.get": () => ({
        type: "settings",
        data: {
          lanEnabled: false,
          providers: [
            provider({
              id: "deepseek",
              hasApiKey: true,
              baseUrl: "https://api.deepseek.com/v1",
              models: ["deepseek-chat", "deepseek-v4-flash"],
            }),
          ],
        },
      }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
    });
    install(client);

    render(<SettingsPanel host={browserHost()} />);
    expect(await screen.findByText(/2 个模型可选/)).toHaveTextContent("deepseek-v4-flash");
    // And where the key is going, which is the part that was wrong: a DeepSeek
    // key with an empty address used to be sent to OpenAI.
    expect(screen.getByLabelText("DeepSeek 接口地址")).toHaveAttribute(
      "placeholder",
      "https://api.deepseek.com/v1",
    );
  });

  /**
   * A rejected key is the most ordinary way for this to stop working, and from
   * the outside it looks identical to a broken app: an empty picker and nothing
   * said. The provider's own words go on screen.
   */
  it("repeats the provider's complaint instead of leaving the list mysteriously empty", async () => {
    const { client } = stubDaemon({
      "settings.get": () => ({
        type: "settings",
        data: {
          lanEnabled: false,
          providers: [
            provider({
              id: "deepseek",
              hasApiKey: true,
              baseUrl: "https://api.deepseek.com/v1",
              problem: "deepseek 返回 401 Unauthorized：Authentication Fails",
            }),
          ],
        },
      }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
    });
    install(client);

    render(<SettingsPanel host={browserHost()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("401");
  });

  /** Somewhere else to send requests, with an address that is not optional. */
  it("takes a provider of the user's own, address and all", async () => {
    const { client, calls } = stubDaemon({
      "settings.get": () => ({ type: "settings", data: { lanEnabled: false, providers: [] } }),
      "settings.setProvider": () => ({
        type: "settings",
        data: {
          lanEnabled: false,
          providers: [provider({ id: "kimi", label: "Kimi", hasApiKey: true, custom: true })],
        },
      }),
      "agent.refresh": () => ({ type: "agents", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
    });
    install(client);

    render(<SettingsPanel host={browserHost()} />);
    await userEvent.click(await screen.findByRole("button", { name: "添加自定义 provider" }));

    const add = screen.getByTestId("add-provider");
    await userEvent.type(screen.getByLabelText("provider id"), "kimi");
    // Nowhere to send it yet, so there is nothing to save.
    expect(add).toBeDisabled();

    await userEvent.type(screen.getByLabelText("provider 接口地址"), "https://api.moonshot.cn/v1");
    await userEvent.type(screen.getByLabelText("provider API Key"), "sk-kimi");
    await userEvent.click(add);

    await waitFor(() => {
      const sent = calls.find((call) => call.type === "settings.setProvider");
      expect(sent?.payload).toMatchObject({
        providerId: "kimi",
        baseUrl: "https://api.moonshot.cn/v1",
        apiKey: "sk-kimi",
        dialect: "openai",
      });
    });
  });

  it("shows the fingerprint of the machine that answered", async () => {
    const { client } = stubDaemon({
      "settings.get": () => ({ type: "settings", data: { lanEnabled: false, providers: [] } }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
    });
    (client as { identity?: unknown }).identity = {
      machineId: "m_1",
      fingerprint: "AAAA-BBBB-CCCC-DDDD",
      daemonVersion: "0.1.0",
      webProtocol: 1,
      transport: "loopback",
    };
    install(client);

    render(<SettingsPanel host={browserHost()} />);
    expect(await screen.findByTestId("fingerprint")).toHaveTextContent("AAAA-BBBB-CCCC-DDDD");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /**
   * The whole point of the fingerprint: where the shell knows what it should
   * be, a different answer means the connection is not going where it claims.
   */
  it("warns when the connection's fingerprint is not the one this machine has", async () => {
    const { client } = stubDaemon({
      "settings.get": () => ({ type: "settings", data: { lanEnabled: false, providers: [] } }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
    });
    (client as { identity?: unknown }).identity = {
      machineId: "m_1",
      fingerprint: "AAAA-BBBB-CCCC-DDDD",
      daemonVersion: "0.1.0",
      webProtocol: 1,
      transport: "loopback",
    };
    install(client);

    render(
      <SettingsPanel
        host={browserHost()}
        endpoint={{ url: "ws://127.0.0.1:1/ws", via: "loopback", label: "本机", fingerprint: "EEEE-FFFF" }}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("EEEE-FFFF");
  });

  it("re-probes the agents after a key lands, so the list stops lying", async () => {
    const { client, calls } = stubDaemon({
      "settings.get": () => ({
        type: "settings",
        data: { lanEnabled: false, providers: [] },
      }),
      "settings.setProvider": () => ({
        type: "settings",
        data: { lanEnabled: false, providers: [provider({ id: "openai", hasApiKey: true })] },
      }),
      "agent.refresh": () => ({ type: "agents", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
    });
    install(client);

    render(<SettingsPanel host={browserHost()} />);
    await userEvent.type(await screen.findByLabelText("OpenAI API Key"), "sk-1");
    await userEvent.click(screen.getByTestId("save-openai"));

    await waitFor(() => {
      expect(calls.some((call) => call.type === "agent.refresh")).toBe(true);
    });
  });
});

describe("speech settings", () => {
  it("configures project context, labels an explicit mock, and probes the runtime", async () => {
    let correctionWorkspaces: string[] = [];
    const speech = () => ({
      runtime: {
        id: "qwen3-asr",
        model: "Qwen3-ASR-1.7B",
        label: "Qwen3-ASR 1.7B",
        implementation: "mock",
      },
      stubEnabled: false,
      contextEnabled: true,
      pinnedTerms: [] as string[],
      languageHints: ["zh"],
      collectCorrections: false,
      correctionWorkspaces,
    });
    const { client, calls } = stubDaemon({
      "settings.get": () => ({
        type: "settings",
        data: { lanEnabled: false, providers: [], speech: speech() },
      }),
      "speech.settings.setQwen3": () => {
        correctionWorkspaces = ["w1"];
        return {
          type: "settings",
          data: { lanEnabled: false, providers: [], speech: speech() },
        };
      },
      "speech.runtime.probe": () => ({ type: "speechRuntimeStatus", data: { state: "ready" } }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
    });
    (client.identity as { features?: string[] }).features = ["speech.transcribe.v2"];
    install(client);

    render(<SettingsPanel host={browserHost()} />);
    expect(await screen.findByText("Qwen3-ASR-1.7B")).toBeInTheDocument();
    expect(screen.getByText(/开发 Mock 已启用/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "语音协议 Stub" })).not.toBeChecked();
    expect(screen.queryByRole("combobox", { name: /模型/ })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("固定专业术语"), "GeneHub\nPipeSpace");
    await userEvent.clear(screen.getByLabelText("语音语言提示"));
    await userEvent.type(screen.getByLabelText("语音语言提示"), "zh, en");
    await userEvent.click(screen.getByRole("switch", { name: "语音协议 Stub" }));
    await userEvent.click(screen.getByText("为当前工作区沉淀我主动选择的候选"));
    await userEvent.click(screen.getByTestId("save-speech-qwen3"));

    await waitFor(() => {
      const sent = calls.find((call) => call.type === "speech.settings.setQwen3");
      expect(sent?.payload).toMatchObject({
        stubEnabled: true,
        pinnedTerms: ["GeneHub", "PipeSpace"],
        languageHints: ["zh", "en"],
        collectCorrections: true,
        workspaceId: "w1",
      });
    });

    await userEvent.click(screen.getByTestId("probe-speech-qwen3"));
    expect(await screen.findByText("语音 runtime 就绪")).toBeInTheDocument();
  });
});

describe("the version section", () => {
  // The prefix is the tree's channel, not a pinned one: the tree stamps
  // `dev`, a release build stamps its own, and either is correct.
  const prefix = { official: "正式版", beta: "Beta版", alpha: "Alpha版", dev: "开发版" }[CHANNEL];

  /** A shell that knows its own build, the way the desktop one does. */
  function desktopish(version: string, opened: string[] = []) {
    return {
      ...browserHost(),
      appVersion: async () => version,
      openExternal: (url: string) => opened.push(url),
    };
  }

  function connected(answers: Parameters<typeof stubDaemon>[0]) {
    const stub = stubDaemon({
      "settings.get": () => ({ type: "settings", data: { lanEnabled: false, providers: [] } }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      ...answers,
    });
    (stub.client as { identity?: unknown }).identity = {
      machineId: "m_1",
      fingerprint: "AAAA-BBBB-CCCC-DDDD",
      daemonVersion: "0.1.17",
      webProtocol: 1,
      transport: "loopback",
    };
    install(stub.client);
    return stub;
  }

  /**
   * The version has to be readable without pressing anything: "which build is
   * this" is the first question of every bug report, and for seventeen releases
   * the answer on screen was 0.1.0 on every machine.
   */
  it("says which build this is before anyone asks it anything", async () => {
    const { client, calls } = connected({});
    void client;

    render(<SettingsPanel host={desktopish("0.1.17")} />);

    expect(await screen.findByTestId("app-version")).toHaveTextContent(`${prefix} 0.1.17`);
    expect(screen.getByTestId("daemon-version")).toHaveTextContent(`daemon ${prefix} 0.1.17`);
    // The page is a third artefact, deployed on its own schedule, and the two
    // numbers above say nothing about it. An hour went once on a phone that was
    // three releases behind while the screen said "daemon 0.1.21" and looked
    // right. Only that a build is named — the name itself is a bundle-time
    // stamp, which is not this file's to predict.
    expect(screen.getByTestId("page-build")).toHaveTextContent(/页面 \S/);
    // Nothing is asked until the button is pressed. An outbound call on mount is
    // the thing this design is avoiding.
    expect(calls.some((call) => call.type === "update.check")).toBe(false);
  });

  it("ignores executable URLs and only applies a signed guest update after confirm", async () => {
    const opened: string[] = [];
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { calls } = connected({
      "update.check": () => ({
        type: "update",
        data: {
          current: "0.1.17",
          latest: "0.1.18",
          newer: true,
          url: "https://example.test/releases/tag/v0.1.18",
          downloadUrl: "https://example.test/GeneHub-setup.exe",
        },
      }),
      "update.download": () => ({ type: "updateDownload", data: { state: "idle" } }),
    });

    render(<SettingsPanel host={desktopish("0.1.17", opened)} />);
    await userEvent.click(await screen.findByTestId("check-update"));

    expect(await screen.findByText(/有签名更新 0\.1\.18/)).toBeTruthy();
    expect(screen.getByTestId("manual-update-note")).toHaveTextContent("自动下载和安装暂未启用");
    expect(screen.queryByTestId("download-update")).toBeNull();
    expect(calls.some((call) => call.type === "update.download")).toBe(false);
    expect(opened).toEqual([]);

    await userEvent.click(screen.getByTestId("apply-guest-update"));
    expect(confirm).toHaveBeenCalledWith("将断开会话并结束后台进程，确认更新？");
    expect(calls.some((call) => call.type === "update.download")).toBe(true);

    await userEvent.click(screen.getByTestId("manual-update-link"));
    expect(opened).toEqual(["https://github.com/aikenc/genethub/releases"]);
    confirm.mockRestore();
  });

  it("does not apply a signed guest update when the confirm is cancelled", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { calls } = connected({
      "update.check": () => ({
        type: "update",
        data: { current: "0.1.17", latest: "0.1.18", newer: true },
      }),
    });

    render(<SettingsPanel host={desktopish("0.1.17")} />);
    await userEvent.click(await screen.findByTestId("check-update"));
    await userEvent.click(await screen.findByTestId("apply-guest-update"));

    expect(confirm).toHaveBeenCalled();
    expect(calls.some((call) => call.type === "update.download")).toBe(false);
    confirm.mockRestore();
  });

  /// The one answer worth refusing to give: reaching nothing is not the same
  /// sentence as being up to date, and only one of the two is true.
  it("does not report being up to date when it reached nothing", async () => {
    connected({
      "update.check": () => ({
        type: "update",
        data: {
          current: "0.1.17",
          newer: false,
          problem: "asking where the newest version is: dns error",
        },
      }),
    });

    render(<SettingsPanel host={desktopish("0.1.17")} />);
    await userEvent.click(await screen.findByTestId("check-update"));

    expect(await screen.findByRole("alert")).toHaveTextContent("dns error");
    expect(screen.queryByText("已经是最新的了。")).toBeNull();
  });

  it("says so when there is nothing to do", async () => {
    connected({
      "update.check": () => ({
        type: "update",
        data: { current: "0.1.17", latest: "0.1.17", newer: false },
      }),
    });

    render(<SettingsPanel host={desktopish("0.1.17")} />);
    await userEvent.click(await screen.findByTestId("check-update"));

    expect(await screen.findByText("daemon 已经是最新的了。")).toBeTruthy();
  });

  /**
   * What every build from source looks like: the tree carries 0.0.0 and only the
   * release workflow stamps a real number in (`scripts/version.mjs`). Printing
   * "0.0.0" would read as a release, and telling that person to go and install an
   * installer would be telling them to replace their own tree with an older one.
   */
  it("calls an unreleased build what it is, and does not tell it to upgrade", async () => {
    const stub = stubDaemon({
      "settings.get": () => ({ type: "settings", data: { lanEnabled: false, providers: [] } }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "update.check": () => ({
        type: "update",
        data: { current: "0.0.0", latest: "0.1.18", newer: false },
      }),
    });
    (stub.client as { identity?: unknown }).identity = {
      machineId: "m_1",
      fingerprint: "AAAA-BBBB-CCCC-DDDD",
      daemonVersion: "0.0.0",
      webProtocol: 1,
      transport: "loopback",
    };
    install(stub.client);

    render(<SettingsPanel host={desktopish("0.0.0")} />);

    expect(await screen.findByTestId("app-version")).toHaveTextContent("应用 开发版");
    expect(screen.getByTestId("daemon-version")).toHaveTextContent("daemon 开发版");

    await userEvent.click(screen.getByTestId("check-update"));
    expect(await screen.findByText(/开发版，不跟发布版本比较/)).toBeTruthy();
    expect(screen.queryByText(/有新版本/)).toBeNull();
    expect(screen.queryByText("已经是最新的了。")).toBeNull();
  });

  it("adds the isolated dev branch name to both source-built versions", async () => {
    vi.stubEnv("VITE_GENEHUB_DEV_NAME", "dev-ui");
    const stub = stubDaemon({
      "settings.get": () => ({ type: "settings", data: { lanEnabled: false, providers: [] } }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
    });
    (stub.client as { identity?: unknown }).identity = {
      machineId: "m_1",
      fingerprint: "AAAA-BBBB-CCCC-DDDD",
      daemonVersion: "0.0.0",
      webProtocol: 1,
      transport: "loopback",
    };
    install(stub.client);

    render(<SettingsPanel host={desktopish("0.0.0")} />);

    expect(await screen.findByTestId("app-version")).toHaveTextContent("应用 开发版 dev-ui");
    expect(screen.getByTestId("daemon-version")).toHaveTextContent("daemon 开发版 dev-ui");
    vi.unstubAllEnvs();
  });

  /**
   * The failure `installer.nsh` was written for, seen from the other end: an
   * installer that could not replace the daemon leaves the two halves on
   * different versions, and the app looks fine while being wrong.
   */
  it("points out that the two halves are on different versions", async () => {
    connected({});

    render(
      <SettingsPanel
        host={desktopish("0.1.18")}
        endpoint={{ url: "ws://127.0.0.1:1/ws", via: "loopback", label: "本机" }}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("只装了一半");
  });

  it("checks the client App separately when controlling a remote daemon", async () => {
    const opened: string[] = [];
    connected({
      "update.check": () => ({
        type: "update",
        data: { current: "0.1.18", latest: "0.1.18", newer: false },
      }),
    });
    const host = {
      ...desktopish("0.1.16", opened),
      checkAppUpdate: async () => ({
        current: "0.1.16",
        latest: "0.1.18",
        newer: true,
        url: "https://example.test/releases/tag/v0.1.18",
        downloadUrl: "https://example.test/GeneHub-setup.exe",
      }),
    };

    render(
      <SettingsPanel
        host={host}
        endpoint={{ url: "wss://example.test/fabric/v2?ticket=test", via: "relay", label: "服务器" }}
      />,
    );
    await userEvent.click(await screen.findByTestId("check-update"));

    expect(await screen.findByText(/客户端 App 有新版本 0\.1\.18/)).toBeTruthy();
    expect(screen.getByText("daemon 已经是最新的了。")).toBeTruthy();
    expect(screen.getByTestId("remote-version-note")).toHaveTextContent("分别更新");
    expect(screen.queryByText(/只装了一半/)).toBeNull();

    expect(screen.queryByTestId("download-app-update")).toBeNull();
    await userEvent.click(screen.getByTestId("manual-update-link"));
    expect(opened).toEqual(["https://github.com/aikenc/genethub/releases"]);
  });

  /// A browser is not a build of anything, so there is no second number to print.
  it("prints one version in a browser, not an empty label", async () => {
    connected({});

    render(<SettingsPanel host={browserHost()} />);

    expect(await screen.findByTestId("daemon-version")).toHaveTextContent(`daemon ${prefix} 0.1.17`);
    expect(screen.queryByTestId("app-version")).toBeNull();
  });
});

describe("appearance on this client", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.uiScale;
    useUiScale.setState({ scale: "medium" });
  });

  it("offers three UI sizes and keeps medium as the current size", async () => {
    render(<SettingsPanel host={browserHost()} />);

    expect(screen.getByRole("radiogroup", { name: "界面大小" })).toBeInTheDocument();
    expect(screen.getByTestId("ui-scale-medium")).toHaveAttribute("aria-checked", "true");

    await userEvent.click(screen.getByTestId("ui-scale-large"));

    expect(localStorage.getItem(UI_SCALE_KEY)).toBe("large");
    expect(document.documentElement.dataset.uiScale).toBe("large");
    expect(useUiScale.getState().scale).toBe("large");
  });
});
