import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BlockedError,
  defineSpecialty,
  agentHostProcesses,
  tryLocateDaemonComponent,
  tryLocateHost,
} from "../../framework/public.ts";

function requireWasm(openRoot: string): void {
  if (!tryLocateHost(openRoot) || !tryLocateDaemonComponent(openRoot)) {
    throw new BlockedError("wasm artifacts missing");
  }
}

function meta(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  llm: "mock" | "none" = "none",
) {
  return {
    id,
    title,
    oracle,
    catches,
    tags: ["core", "wasm-guest", "v2-shell"],
    llm: { default: llm },
    expectedDurationMs: 35_000,
    timeoutMs: 150_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" as const },
    surfaces: ["genehub-host", "daemon", "agent", "workspace"],
    productInterfaces: ["@genehub/workbench/client"],
  };
}

defineSpecialty(
  meta(
    "specialty.wasm.git.identity-and-status-via-shell",
    "Git in the workspace is a real git, executed by the host process import",
    "git status --porcelain reports the untracked file the test wrote, and the git pid is not the daemon pid",
    ["guest has no exec so git is skipped", "cwd is / so git runs in the wrong tree", "status is fabricated"],
  ),
  async (t) => {
    requireWasm(t.openRoot);
    writeFileSync(path.join(t.env.workspace, "tracked-soon.txt"), "git-through-wasm\n");
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const init = await t.flows.main.runShell(opened.client, {
        workspaceId: opened.workspaceId,
        argv: ["git", "init"],
      });
      t.assertions.assert(t.flows.main.shellExit(init.frames)?.code === 0, `git init failed ${JSON.stringify(init.frames)}`);
      const status = await t.flows.main.runShell(opened.client, {
        workspaceId: opened.workspaceId,
        argv: ["git", "status", "--porcelain"],
      });
      t.assertions.assert(t.flows.main.shellExit(status.frames)?.code === 0, "git status failed");
      const out = t.flows.main.shellText(status.frames, "stdout");
      t.assertions.assert(out.includes("tracked-soon.txt"), `git did not see the file: ${out}`);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

defineSpecialty(
  meta(
    "specialty.wasm.agent.killed-host-fails-the-turn",
    "Killing the agent host process fails the in-flight turn instead of hanging the session",
    "after SIGKILL of the agent-component process, the session records turnFailed or the next prompt is refused as not running",
    ["daemon swallows agent death", "session hangs until timeout", "native agent is what was killed"],
    "mock",
  ),
  async (t) => {
    requireWasm(t.openRoot);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ hang: true }, { text: "should not run" });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      const prompt = t.flows.main.sendPrompt(opened.client, sessionId, "Hang until the process dies.");
      await t.tools.waitUntil(
        () => agentHostProcesses().some((row) => row.environ.includes(t.env.data)),
        45_000,
      );
      const agents = agentHostProcesses().filter((row) => row.environ.includes(t.env.data));
      t.assertions.assert(agents.length > 0, "agent host never appeared");
      t.assertions.assert(
        agents.some((row) => row.cmd.includes("--entry agent") && row.cmd.includes("genehub_guest.wasm")),
        `killed a host that was not the agent entry: ${JSON.stringify(agents.map((row) => row.cmd))}`,
      );
      for (const row of agents) {
        process.kill(row.pid, "SIGKILL");
      }
      await Promise.race([prompt.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 15_000))]);
      await t.tools.waitUntil(
        () => events.some((event) => event.type === "turnFailed" || event.type === "turnCanceled" || event.type === "turnCompleted"),
        20_000,
      );
      t.assertions.assert(
        !events.some((event) => event.type === "turnCompleted"),
        "hung turn completed after the agent was killed",
      );
      t.assertions.assert(
        events.some((event) => event.type === "turnFailed" || event.type === "turnCanceled"),
        `agent death was silent: ${events.map((event) => event.type).join(",")}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

defineSpecialty(
  meta(
    "specialty.wasm.workspace.file-write-visible-on-disk",
    "file.write from the guest lands on the host filesystem, not a WASI overlay",
    "the bytes appear in the lease workspace via Node fs",
    ["write succeeded in guest memory only", "path rooted at /"],
  ),
  async (t) => {
    requireWasm(t.openRoot);
    mkdirSync(path.join(t.env.workspace, "src"), { recursive: true });
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await opened.client.call({
        type: "file.write",
        payload: {
          workspaceId: opened.workspaceId,
          path: `${opened.rootHandle}/src/from-guest.txt`,
          content: "wasm-disk-marker",
        },
      });
      t.assertions.fileEquals(opened.workspaceRoot, "src/from-guest.txt", "wasm-disk-marker");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

defineSpecialty(
  meta(
    "specialty.wasm.authz.invite-read-cannot-write",
    "A read-only paired device cannot file.write on the wasm daemon",
    "file.write is forbidden for a read grant and the disk is unchanged",
    ["grants ignored in the guest", "authz short-circuited because WASI has no bits"],
  ),
  async (t) => {
    requireWasm(t.openRoot);
    writeFileSync(path.join(t.env.workspace, "owned.txt"), "owner\n");
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const device = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"]);
      try {
        await t.assertions.expectProtocolCode(
          () =>
            device.client.call({
              type: "file.write",
              payload: {
                workspaceId: opened.workspaceId,
                path: `${opened.rootHandle}/owned.txt`,
                content: "intruder\n",
              },
            }),
          "forbidden",
        );
        t.assertions.fileEquals(opened.workspaceRoot, "owned.txt", "owner\n");
      } finally {
        device.client.close();
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
