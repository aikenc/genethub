import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

async function withWorkspace(t: CaseContext, run: (opened: Opened) => Promise<void>): Promise<void> {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await run(opened);
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
}

function ask(workspaceId: string, argv: string[]) {
  return { workspaceId, argv };
}

function cli(id: string, title: string, oracle: string, catches: string[], run: (t: CaseContext) => Promise<void>) {
  defineSpecialty(
    {
      id,
      title,
      oracle,
      catches,
      tags: ["core", "cli", "parity"],
      expectedDurationMs: 20_000,
      timeoutMs: 120_000,
      surfaces: ["daemon", "workbench-client"],
      productInterfaces: ["@genehub/workbench/client"],
    },
    run,
  );
}

cli(
  "specialty.cli.streams-apart",
  "The two output streams arrive apart and the status is the command's own",
  "stdout and stderr stay separate and exit 3 is reported as the command status",
  ["streams merged", "run succeeded treated as command succeeded"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const result = await t.flows.main.runShell(
        opened.client,
        ask(opened.workspaceId, ["/bin/sh", "-c", "echo to-stdout; echo to-stderr 1>&2; exit 3"]),
      );
      const stdout = t.flows.main.shellText(result.frames, "stdout");
      const stderr = t.flows.main.shellText(result.frames, "stderr");
      t.assertions.assert(stdout.includes("to-stdout"), `stdout missing: ${stdout}`);
      t.assertions.assert(stderr.includes("to-stderr"), `stderr missing: ${stderr}`);
      t.assertions.assert(!stdout.includes("to-stderr"), `streams merged: ${JSON.stringify(result.frames)}`);
      t.assertions.assert(t.flows.main.shellExit(result.frames)?.code === 3, `exit was ${JSON.stringify(t.flows.main.shellExit(result.frames))}`);
    });
  },
);

cli(
  "specialty.cli.argv-is-a-list",
  "A command is a list so nothing in it becomes a second command",
  "echo prints the semicolon as an argument and does not run a second command",
  ["argv handed to a shell"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const result = await t.flows.main.runShell(opened.client, ask(opened.workspaceId, ["/bin/echo", "safe; echo INJECTED"]));
      const output = t.flows.main.shellText(result.frames, "stdout");
      t.assertions.assert(output.includes("safe; echo INJECTED"), `got ${output}`);
      t.assertions.assert((output.match(/INJECTED/g) ?? []).length === 1, `got ${output}`);
      t.assertions.assert(t.flows.main.shellExit(result.frames)?.code === 0, "echo did not exit 0");
    });
  },
);

cli(
  "specialty.cli.no-pty-grant-forbidden",
  "A device without the terminal grant cannot run a command either",
  "read+files device gets status 403 and no frames",
  ["shell.run and pty.open have different grants"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const device = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read", "files"]);
      try {
        const result = await t.flows.main.runShell(device.client, ask(opened.workspaceId, ["/bin/echo", "hello"]));
        t.assertions.assert(result.status === 403, `status ${result.status}`);
        t.assertions.assert(result.frames.length === 0, `refused command still ran: ${JSON.stringify(result.frames)}`);
      } finally {
        device.client.close();
      }
    });
  },
);

cli(
  "specialty.cli.confined-or-refused",
  "A command run for someone else is confined or refused but never neither",
  "read+pty device cannot cat a sibling file as success, or the stream is 501",
  ["remote command is an unconstrained login"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const outside = path.join(path.dirname(opened.workspaceRoot), "outside.txt");
      writeFileSync(outside, "OUT-OF-BOUNDS");
      const device = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read", "pty"]);
      try {
        const result = await t.flows.main.runShell(device.client, ask(opened.workspaceId, ["/bin/cat", outside]));
        if (result.status === 200) {
          const read = t.flows.main.shellText(result.frames, "stdout");
          t.assertions.assert(!read.includes("OUT-OF-BOUNDS"), `confined command read next door: ${read}`);
          t.assertions.assert(t.flows.main.shellExit(result.frames)?.code !== 0, `outside read succeeded: ${JSON.stringify(result.frames)}`);
        } else {
          t.assertions.assert(result.status === 501, `status ${result.status}`);
          t.assertions.assert(result.frames.length === 0, "refused command still ran");
        }
      } finally {
        device.client.close();
      }
    });
  },
);

cli(
  "specialty.cli.confined-works-inside",
  "A confined command still works inside the workspace",
  "read+pty device can cat a relative workspace file, or the machine refuses with 501",
  ["confinement breaks the workspace itself"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      writeFileSync(path.join(opened.workspaceRoot, "inside.txt"), "in the workspace");
      const device = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read", "pty"]);
      try {
        const result = await t.flows.main.runShell(device.client, ask(opened.workspaceId, ["/bin/cat", "inside.txt"]));
        if (result.status === 501) {
          t.assertions.assert(result.frames.length === 0, "501 still produced frames");
          return;
        }
        t.assertions.assert(result.status === 200, `status ${result.status}`);
        t.assertions.assert(
          t.flows.main.shellText(result.frames, "stdout").includes("in the workspace"),
          "confined command could not read its workspace",
        );
        t.assertions.assert(t.flows.main.shellExit(result.frames)?.code === 0, "inside cat did not exit 0");
      } finally {
        device.client.close();
      }
    });
  },
);

cli(
  "specialty.cli.confined-is-announced",
  "A confined command is told it is confined and where it may go",
  "GENEHUB_CONFINEMENT and response metadata name the workspace root, or the stream is 501",
  ["process infers ENOENT as a missing directory"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const device = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read", "pty"]);
      try {
        const result = await t.flows.main.runShell(
          device.client,
          ask(opened.workspaceId, ["/bin/sh", "-c", 'echo "$GENEHUB_CONFINEMENT|$GENEHUB_CONFINED_ROOTS"']),
        );
        if (result.status === 501) {
          t.assertions.assert(result.frames.length === 0, "501 still produced frames");
          return;
        }
        t.assertions.assert(result.status === 200, `status ${result.status}`);
        const said = t.flows.main.shellText(result.frames, "stdout").trim();
        const [backend, roots] = said.split("|");
        t.assertions.assert(Boolean(backend) && backend !== "none", `told nothing: ${said}`);
        t.assertions.assert((roots ?? "").split(":").includes(opened.workspaceRoot), `roots ${roots}`);
        t.assertions.assert(!(roots ?? "").includes("/dev/"), `plumbing leaked: ${roots}`);
        const metadata = result.metadata as { confinement?: { backend?: string; roots?: string[] } } | null;
        t.assertions.assert(metadata?.confinement?.backend === backend, `metadata ${JSON.stringify(metadata)}`);
        t.assertions.assert(
          metadata?.confinement?.roots?.includes(opened.workspaceRoot) === true,
          `metadata roots ${JSON.stringify(metadata)}`,
        );
      } finally {
        device.client.close();
      }
    });
  },
);

cli(
  "specialty.cli.unconfined-does-not-claim",
  "A command that is not confined does not claim to be",
  "pty:unconfined grant leaves confinement metadata null and empty roots",
  ["unconfined process handed a fence"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const device = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read", "pty", "pty:unconfined"]);
      try {
        const result = await t.flows.main.runShell(
          device.client,
          ask(opened.workspaceId, ["/bin/sh", "-c", 'echo "[$GENEHUB_CONFINED_ROOTS]"']),
        );
        t.assertions.assert(result.status === 200, `status ${result.status}`);
        const metadata = result.metadata as { confinement?: unknown } | null;
        t.assertions.assert(metadata?.confinement == null, `claimed confinement: ${JSON.stringify(metadata)}`);
        t.assertions.assert(t.flows.main.shellText(result.frames, "stdout").trim() === "[]", "unconfined process was fenced");
      } finally {
        device.client.close();
      }
    });
  },
);

cli(
  "specialty.cli.multi-root-confinement",
  "Every folder of a multi-root workspace is inside the confinement",
  "the second folder is writable and a sibling directory stays unread, or the stream is 501",
  ["only the first folder is confined"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const home = path.dirname(opened.workspaceRoot);
      const product = path.join(home, "product");
      const docs = path.join(home, "docs");
      const elsewhere = path.join(home, "elsewhere");
      for (const directory of [product, docs, elsewhere]) mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(elsewhere, "secret.txt"), "OUT-OF-BOUNDS");
      const definition = path.join(home, "suite.code-workspace");
      writeFileSync(definition, JSON.stringify({ folders: [{ path: "product" }, { path: "docs" }] }));
      const suite = await opened.client.call({ type: "workspace.open", payload: { root: definition } });
      t.assertions.assert(suite?.type === "workspace", `workspace.open returned ${suite?.type}`);
      t.assertions.assert(suite?.type === "workspace" && suite.data.folders.length === 2, "fixture is not multi-root");
      const workspaceId = suite?.type === "workspace" ? suite.data.id : "";
      const device = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read", "pty"]);
      try {
        const write = await t.flows.main.runShell(device.client, {
          workspaceId,
          argv: ["/bin/sh", "-c", "echo written > note.txt && cat note.txt"],
          cwd: docs,
        });
        if (write.status === 501) {
          t.assertions.assert(write.frames.length === 0, "501 still produced frames");
          return;
        }
        t.assertions.assert(write.status === 200, `status ${write.status}`);
        t.assertions.assert(t.flows.main.shellText(write.frames, "stdout").includes("written"), "second folder was not writable");
        const sneak = await t.flows.main.runShell(device.client, ask(workspaceId, ["/bin/cat", path.join(elsewhere, "secret.txt")]));
        t.assertions.assert(
          !t.flows.main.shellText(sneak.frames, "stdout").includes("OUT-OF-BOUNDS"),
          "a third directory came along",
        );
      } finally {
        device.client.close();
      }
    });
  },
);

cli(
  "specialty.cli.background-child-does-not-hold",
  "A command that leaves something behind still reports when it finished",
  "sleep 60 in the background does not delay exit 7",
  ["waiter blocked on inherited stdout"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const started = Date.now();
      const result = await t.flows.main.runShell(
        opened.client,
        ask(opened.workspaceId, ["/bin/sh", "-c", "sleep 60 & echo done; exit 7"]),
      );
      t.assertions.assert(result.status === 200, `status ${result.status}`);
      t.assertions.assert(t.flows.main.shellExit(result.frames)?.code === 7, "exit was not 7");
      t.assertions.assert(t.flows.main.shellText(result.frames, "stdout").includes("done"), "pre-exit output missing");
      t.assertions.assert(Date.now() - started < 10_000, "answer waited for the descendant");
    });
  },
);

cli(
  "specialty.cli.stdin-is-piped",
  "A command is given what was piped to it",
  "cat writes the stream body to stdout",
  ["stdin dropped"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const result = await t.flows.main.runShell(opened.client, ask(opened.workspaceId, ["/bin/cat"]), new TextEncoder().encode("the-input"));
      t.assertions.assert(result.status === 200, `status ${result.status}`);
      t.assertions.assert(t.flows.main.shellText(result.frames, "stdout") === "the-input", "stdin did not reach cat");
      t.assertions.assert(t.flows.main.shellExit(result.frames)?.code === 0, "cat did not exit 0");
    });
  },
);

cli(
  "specialty.cli.empty-stdin-eof",
  "A command given nothing reads end of file rather than waiting",
  "cat with an empty body exits immediately",
  ["empty stdin waits forever"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const started = Date.now();
      const result = await t.flows.main.runShell(opened.client, ask(opened.workspaceId, ["/bin/cat"]));
      t.assertions.assert(t.flows.main.shellText(result.frames, "stdout") === "", "cat invented input");
      t.assertions.assert(t.flows.main.shellExit(result.frames)?.code === 0, "cat did not exit 0");
      t.assertions.assert(Date.now() - started < 15_000, "empty stdin waited");
    });
  },
);

cli(
  "specialty.cli.env-reaches-command",
  "A command runs with the environment it was given",
  "MARKER=set-by-caller appears in stdout",
  ["env not forwarded"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const result = await t.flows.main.runShell(opened.client, {
        workspaceId: opened.workspaceId,
        argv: ["/bin/sh", "-c", "echo $MARKER"],
        env: { MARKER: "set-by-caller" },
      });
      t.assertions.assert(
        t.flows.main.shellText(result.frames, "stdout").includes("set-by-caller"),
        `env missing: ${JSON.stringify(result.frames)}`,
      );
    });
  },
);

cli(
  "specialty.cli.timeout-ends-and-says-so",
  "A command that runs out of time is ended and says so",
  "sleep 60 with timeoutMs 500 ends quickly and timedOut is true",
  ["killed without saying it was the limit"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const started = Date.now();
      const result = await t.flows.main.runShell(opened.client, {
        workspaceId: opened.workspaceId,
        argv: ["/bin/sleep", "60"],
        timeoutMs: 500,
      });
      t.assertions.assert(result.status === 200, `status ${result.status}`);
      t.assertions.assert(Date.now() - started < 15_000, "limit was not enforced");
      t.assertions.assert(t.flows.main.shellTimedOut(result.frames), `ended without saying why: ${JSON.stringify(result.frames)}`);
    });
  },
);

cli(
  "specialty.cli.within-limit-left-alone",
  "A command that finishes within its limit is left alone",
  "echo with a 30s limit exits 0 and is not timedOut",
  ["limit also kills commands that met it"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const result = await t.flows.main.runShell(opened.client, {
        workspaceId: opened.workspaceId,
        argv: ["/bin/echo", "quick"],
        timeoutMs: 30_000,
      });
      t.assertions.assert(t.flows.main.shellText(result.frames, "stdout").includes("quick"), "output missing");
      t.assertions.assert(t.flows.main.shellExit(result.frames)?.code === 0, "echo did not exit 0");
      t.assertions.assert(!t.flows.main.shellTimedOut(result.frames), "in-time command reported timedOut");
    });
  },
);

cli(
  "specialty.cli.timeout-asks-before-kill",
  "A command ended for running long is asked before it is made to",
  "a TERM trap writes tidied-up.txt",
  ["timeout uses SIGKILL only"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const marker = path.join(opened.workspaceRoot, "tidied-up.txt");
      await t.flows.main.runShell(opened.client, {
        workspaceId: opened.workspaceId,
        argv: ["/bin/sh", "-c", `trap 'echo tidy > ${marker}; exit 0' TERM; while true; do sleep 0.05; done`],
        timeoutMs: 500,
      });
      t.assertions.assert(readFileSync(marker, "utf8").trim() === "tidy", "command was killed outright");
    });
  },
);

cli(
  "specialty.cli.cwd-outside-refused",
  "A directory outside the workspace is refused rather than clamped",
  "cwd /tmp returns 403 and no frames",
  ["cwd silently rewritten to workspace root"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const result = await t.flows.main.runShell(opened.client, {
        workspaceId: opened.workspaceId,
        argv: ["/bin/pwd"],
        cwd: "/tmp",
      });
      t.assertions.assert(result.status === 403, `status ${result.status}`);
      t.assertions.assert(result.frames.length === 0, "outside cwd still ran");
    });
  },
);

cli(
  "specialty.cli.does-not-outlive-caller",
  "A command does not outlive the caller that asked for it",
  "a grandchild loop stops writing after the device client is closed",
  ["disconnect leaves npm run dev holding a port"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const marker = path.join(opened.workspaceRoot, "still-running.txt");
      const device = await t.flows.main.pairDevice(opened.client, opened.daemon, []);
      const started = t.flows.main.startShell(device.client, {
        workspaceId: opened.workspaceId,
        argv: ["/bin/sh", "-c", `(while true; do echo alive >> ${marker}; sleep 0.05; done) & sleep 20`],
      });
      await t.tools.waitUntil(() => {
        try {
          return readFileSync(marker, "utf8").length > 0;
        } catch {
          return false;
        }
      }, 15_000);
      started.stream.reset();
      device.client.close();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = readFileSync(marker, "utf8");
      t.assertions.assert(after.length > 0, "command never got going");
      await new Promise((resolve) => setTimeout(resolve, 800));
      const later = readFileSync(marker, "utf8");
      t.assertions.assert(after.length === later.length, "command kept running after disconnect");
      await started.result.catch(() => undefined);
    });
  },
);
