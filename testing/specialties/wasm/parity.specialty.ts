import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  BlockedError,
  defineSpecialty,
  registerScriptedCodex,
  tryLocateDaemonComponent,
  tryLocateHost,
  type CaseContext,
} from "../../framework/public.ts";

/** The component delegates OS facts to the native host. Installed CLIs are
 * discovered through that host, and a full paired connection has the same
 * OS-account command capability on native and guest paths. */

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

function requireWasmArtifacts(openRoot: string): void {
  const host = tryLocateHost(openRoot);
  const component = tryLocateDaemonComponent(openRoot);
  if (!host || !component) {
    throw new BlockedError(
      `wasm artifacts missing: host=${host ?? "no"} component=${component ?? "no"}`,
    );
  }
}

function parityMeta(id: string, title: string, oracle: string, catches: string[]) {
  return {
    id,
    title,
    oracle,
    catches,
    tags: ["core", "wasm-guest", "v2-shell"],
    llm: { default: "none" as const },
    expectedDurationMs: 25_000,
    timeoutMs: 150_000,
    resources: {
      environments: 1,
      cpu: 2,
      memoryMb: 768,
      io: 1,
      browser: 0,
      pool: "standard" as const,
    },
    surfaces: ["genehub-host", "daemon"],
    productInterfaces: ["@genehub/workbench/client"],
    requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
  };
}

async function withOpened(t: CaseContext, run: (opened: Opened) => Promise<void>): Promise<void> {
  requireWasmArtifacts(t.openRoot);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await run(opened);
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
}

defineSpecialty(
  {
    ...parityMeta(
      "specialty.wasm.agents.path-install-is-discovered",
      "An agent CLI that is only on PATH is offered by the component daemon",
      "with a directory holding a codex executable (the declared app-server double) prepended to the daemon's PATH, the built-in codex script Agent started by the component daemon reports codex ready",
      [
        "the guest cannot start script Agents (no sh / Python runtime found from inside the component)",
        "every third-party agent silently disappears in the wasm build",
        "the daemon's PATH does not reach the script Agent and the CLI it looks for",
      ],
    ),
  },
  async (t) => {
    // Prepended, so this is the copy that is found even on a machine that has
    // a real one. The daemon inherits this through the shell that loads it.
    registerScriptedCodex(t.env, []);
    await withOpened(t, async (opened) => {
      const codex = await t.flows.branches.waitForAgent(opened.client, "codex", t.flows.branches.agentReady,
        { timeoutMs: 60_000, what: "ready from a PATH-only CLI" });
      t.assertions.assert(codex.source === "builtin", `codex source ${codex.source}`);
    });
  },
);

defineSpecialty(
  parityMeta(
    "specialty.wasm.isolation.narrowed-device-gets-a-real-sandbox",
    "A full paired device has the same OS command capability in the wasm guest",
    "paired shell reads the known sibling file with exit 0; guest architecture does not change full connection authority",
    [
      "the guest refuses full paired commands based on obsolete device tiers",
      "the wrapper argv names the component instead of a native binary",
      "full paired commands lose OS-account access",
      "a successful shell receipt hides a failed command",
    ],
  ),
  async (t) => {
    requireWasmArtifacts(t.openRoot);
    const outside = path.join(t.env.root, "not-the-workspace.txt");
    writeFileSync(outside, "outside-the-workspace\n");

    await withOpened(t, async (opened) => {
      const device = await t.flows.main.pairDevice(opened.client, opened.daemon);
      try {
        const result = await t.flows.main.runShell(device.client, {
          workspaceId: opened.workspaceId,
          argv: ["/bin/sh", "-c", `printf %s "$GENEHUB_CONFINEMENT"; cat ${outside} 2>/dev/null`],
        });

        t.assertions.assert(result.status === 200, "complete paired shell refused");
        t.assertions.assert(t.flows.main.shellText(result.frames,"stdout").includes("outside-the-workspace"),"paired shell lost OS account file access");
        t.assertions.assert(t.flows.main.shellExit(result.frames)?.code===0,"paired sibling read failed");
      } finally {
        device.client.close();
      }
    });
  },
);
