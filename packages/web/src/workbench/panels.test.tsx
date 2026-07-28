import type { Reply, Request } from "@genehub/proto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ChangesPanel } from "../changes/ChangesPanel";
import { FilesPanel } from "../files/FilesPanel";
import type { Client } from "../protocol/client";
import { SettingsPanel } from "../settings/SettingsPanel";
import { useWorkbench } from "../session/store";
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
    onStateChange: () => () => {},
  } as unknown as Client;
  return { client, calls };
}

function install(client: Client) {
  useWorkbench.setState({
    client,
    workspaces: [{ id: "w1", name: "demo", root: "/tmp/demo", isGitRepo: true }],
    sessions: [],
    activeSessionId: null,
    tree: null,
    file: null,
    git: null,
    diff: null,
    settings: null,
    agents: [],
  });
}

beforeEach(() => {
  useWorkbench.setState({ tree: null, file: null, git: null, diff: null, settings: null });
});

describe("the files panel", () => {
  it("opens a file and saves an edit back to the machine", async () => {
    const { client, calls } = stubDaemon({
      "file.tree": () => ({
        type: "fileTree",
        data: {
          name: "demo",
          path: "",
          isDir: true,
          children: [{ name: "notes.md", path: "notes.md", isDir: false }],
        },
      }),
      "file.read": () => ({
        type: "fileContent",
        data: { path: "notes.md", content: "before", truncated: false, isText: true },
      }),
      "file.write": () => ({ type: "ack" }),
      "git.status": () => ({ type: "gitStatus", data: { changes: [], clean: true } }),
    });
    install(client);

    render(<FilesPanel />);
    const entry = await screen.findByText("notes.md");
    await userEvent.click(entry);

    const editor = await screen.findByLabelText("notes.md 的内容");
    expect(editor).toHaveValue("before");

    await userEvent.clear(editor);
    await userEvent.type(editor, "after");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const written = calls.find((call) => call.type === "file.write");
      expect(written?.payload).toMatchObject({ path: "notes.md", content: "after" });
    });
  });

  it("will not offer to save a file that has not been touched", async () => {
    const { client } = stubDaemon({
      "file.tree": () => ({
        type: "fileTree",
        data: {
          name: "demo",
          path: "",
          isDir: true,
          children: [{ name: "notes.md", path: "notes.md", isDir: false }],
        },
      }),
      "file.read": () => ({
        type: "fileContent",
        data: { path: "notes.md", content: "before", truncated: false, isText: true },
      }),
    });
    install(client);

    render(<FilesPanel />);
    await userEvent.click(await screen.findByText("notes.md"));
    await screen.findByLabelText("notes.md 的内容");
    expect(screen.getByRole("button", { name: "已保存" })).toBeDisabled();
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

describe("the settings panel", () => {
  it("sends a key without ever showing one back", async () => {
    let stored = false;
    const { client, calls } = stubDaemon({
      "settings.get": () => ({
        type: "settings",
        data: { lanEnabled: false, providers: [{ id: "deepseek", hasApiKey: stored }] },
      }),
      "settings.setProvider": () => {
        stored = true;
        return {
          type: "settings",
          data: { lanEnabled: false, providers: [{ id: "deepseek", hasApiKey: true }] },
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

  it("re-probes the agents after a key lands, so the list stops lying", async () => {
    const { client, calls } = stubDaemon({
      "settings.get": () => ({
        type: "settings",
        data: { lanEnabled: false, providers: [] },
      }),
      "settings.setProvider": () => ({
        type: "settings",
        data: { lanEnabled: false, providers: [{ id: "openai", hasApiKey: true }] },
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
