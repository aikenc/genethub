import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BlockedError,
  defineSpecialty,
  genetEnv,
  locateGenet,
  tryLocateDaemonComponent,
  tryLocateHost,
  type CaseContext,
} from "../../framework/public.ts";

/**
 * The guest is the daemon now, and the questions below are ones a component
 * cannot answer for itself: where a program is installed, and what this kernel
 * will hold a process to. Both were quietly lost when the daemon moved inside
 * the component — the first hid every third-party agent, the second refused
 * every narrowed device — and both are answered by the shell. These cases care
 * about the product outcome, not the import: an agent that is installed shows
 * up, and a device that may not have an unconfined terminal gets a confined
 * one rather than a refusal.
 */

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
    productInterfaces: ["@genehub/web/client"],
    requiredArtifacts: ["genehub-host-dev", "genehub_guest.wasm"],
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
  parityMeta(
    "specialty.wasm.agents.path-install-is-discovered",
    "An agent CLI that is only on PATH is offered by the component daemon",
    "with a directory holding an executable named opencode prepended to the daemon's PATH, agent.refresh reports opencode ready",
    [
      "the guest skips PATH entirely and only ever finds configured absolute paths",
      "every third-party agent silently disappears in the wasm build",
      "PATH is split with the guest's separator rather than the machine's",
    ],
  ),
  async (t) => {
    const bin = path.join(t.env.root, "path-install");
    mkdirSync(bin, { recursive: true });
    const installed = path.join(bin, process.platform === "win32" ? "opencode.bat" : "opencode");
    writeFileSync(installed, "#!/bin/sh\nexit 0\n");
    chmodSync(installed, 0o755);
    // Prepended, so this is the copy that is found even on a machine that has
    // a real one. The daemon inherits this through the shell that loads it.
    t.env.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;

    await withOpened(t, async (opened) => {
      const agents = await opened.client.call({ type: "agent.refresh" });
      if (agents?.type !== "agents") throw new Error(`agent.refresh returned ${agents?.type}`);
      const opencode = agents.data.find((agent) => agent.id === "opencode");
      t.assertions.assert(
        opencode != null,
        `opencode is not in the catalogue: ${agents.data.map((agent) => agent.id).join(",")}`,
      );
      t.assertions.assert(
        opencode?.probe.state === "ready",
        `an installed agent was not discovered: ${JSON.stringify(opencode?.probe)}`,
      );
    });
  },
);

defineSpecialty(
  parityMeta(
    "specialty.wasm.isolation.narrowed-device-gets-a-real-sandbox",
    "A device without pty:unconfined runs commands the kernel is holding to the workspace",
    "on a machine whose own wrapper can confine, the command reports GENEHUB_CONFINEMENT and cannot read a file one directory outside the workspace; on a machine that cannot, the request is refused rather than run loose",
    [
      "the guest reports no isolation backend on every machine and refuses every narrowed device",
      "the wrapper argv names the component instead of a native binary",
      "confinement is claimed but the process can still read the whole account",
      "an unconfinable machine runs the command anyway",
    ],
  ),
  async (t) => {
    requireWasmArtifacts(t.openRoot);
    const genet = locateGenet(t.openRoot);
    // The machine's own answer, taken from the same wrapper the daemon uses,
    // so this case cannot pass by agreeing with a guess. Anything the policy
    // does not name is unreachable, hence the loader directories.
    const probe = spawnSync(
      genet,
      [
        "__confine",
        "--root",
        t.env.root,
        "--rw",
        "/dev/null",
        "--ro",
        "/usr",
        "--ro",
        "/bin",
        "--ro",
        "/lib",
        "--ro",
        "/lib64",
        "--ro",
        "/etc",
        "--",
        "/bin/true",
      ],
      { env: genetEnv(t.openRoot, t.env.env), encoding: "utf8" },
    );
    const machineCanConfine = probe.status === 0;

    const outside = path.join(t.env.root, "not-the-workspace.txt");
    writeFileSync(outside, "outside-the-workspace\n");

    await withOpened(t, async (opened) => {
      // Everything but the unconfined terminal: the narrowing is the point,
      // and a device paired with the default full grant set would never reach
      // the confinement path at all.
      const device = await t.flows.main.pairDevice(opened.client, opened.daemon, [
        "read",
        "session",
        "files",
        "pty",
      ]);
      try {
        const result = await t.flows.main.runShell(device.client, {
          workspaceId: opened.workspaceId,
          argv: ["/bin/sh", "-c", `printf %s "$GENEHUB_CONFINEMENT"; cat ${outside} 2>/dev/null`],
        });

        if (!machineCanConfine) {
          t.assertions.assert(
            result.status === 403 || result.status === 503,
            `an unconfinable machine ran the command anyway: ${result.status} ${JSON.stringify(result.frames)}`,
          );
          return;
        }

        t.assertions.assert(result.status === 200, `confined run refused: ${result.status}`);
        const stdout = t.flows.main.shellText(result.frames, "stdout");
        t.assertions.assert(
          /^(landlock|namespaces)/.test(stdout),
          `the process was not told it is confined, so it was not: ${JSON.stringify(stdout)}`,
        );
        t.assertions.assert(
          !stdout.includes("outside-the-workspace"),
          `a confined process read a file outside the workspace: ${JSON.stringify(stdout)}`,
        );
      } finally {
        device.client.close();
      }
    });
  },
);
