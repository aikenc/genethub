import { existsSync } from "node:fs";
import path from "node:path";

import { ProtocolError_ } from "@genehub/web/client";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

function protocolCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext, opened: Opened) => Promise<void>,
  timeoutMs = 90_000,
): void {
  defineSpecialty(
    {
      id,
      title,
      oracle,
      catches,
      tags: ["core", "daemon", "protocol-depth"],
      llm: { default: "none" },
      expectedDurationMs: 20_000,
      timeoutMs,
      resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0, pool: "standard" },
      surfaces: ["daemon", "workbench-client"],
      productInterfaces: ["@genehub/web/client", "daemon-protocol"],
    },
    async (t) => {
      const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      try {
        await run(t, opened);
      } finally {
        opened.client.close();
        opened.daemon.stop();
        await opened.mock.stop();
      }
    },
  );
}

async function expectProtocolClose(opened: Opened, request: unknown): Promise<void> {
  try {
    await opened.client.call(request as never);
  } catch (error) {
    if (error instanceof ProtocolError_ && String(error.detail.code).toLowerCase() === "badrequest") {
      return;
    }
    throw new Error(`malformed request returned the wrong error: ${String(error)}`);
  }
  throw new Error(`malformed request was accepted: ${JSON.stringify(request).slice(0, 500)}`);
}

async function assertLive(t: CaseContext, opened: Opened): Promise<void> {
  const listed = await opened.client.call({ type: "workspace.list" });
  t.assertions.assert(
    listed?.type === "workspaces" && listed.data.some((workspace) => workspace.id === opened.workspaceId),
    `daemon did not remain live after rejection: ${JSON.stringify(listed)}`,
  );
}

protocolCase(
  "specialty.daemon.protocol.unknown-operation-rejected",
  "An unknown RPC operation is isolated without harming the daemon",
  "the offending call is refused as badRequest and the same client can still list the workspace",
  ["unknown variant reaches a fallback action", "decode failure terminates daemon", "pending request poisons redial"],
  async (t, opened) => {
    await expectProtocolClose(opened, { type: "workspace.teleport", payload: { workspaceId: opened.workspaceId } });
    await assertLive(t, opened);
  },
);

protocolCase(
  "specialty.daemon.protocol.required-payload-omitted",
  "A request missing its required payload is rejected",
  "workspace.open without payload is refused as badRequest and the registered workspace stays listed",
  ["missing payload receives defaults", "decoder panic", "workspace registry reset on parse error"],
  async (t, opened) => {
    await expectProtocolClose(opened, { type: "workspace.open" });
    await assertLive(t, opened);
  },
);

protocolCase(
  "specialty.daemon.protocol.null-payload-rejected",
  "A null payload cannot masquerade as an empty object",
  "workspace.open with null payload is refused as badRequest and the same client remains usable",
  ["null coerced to default payload", "null dereference kills guest", "production redial fails after protocol close"],
  async (t, opened) => {
    await expectProtocolClose(opened, { type: "workspace.open", payload: null });
    await assertLive(t, opened);
  },
);

protocolCase(
  "specialty.daemon.protocol.required-field-omitted",
  "A payload missing a required field is rejected",
  "workspace.open with an empty object is refused as badRequest without creating a phantom workspace",
  ["missing root becomes empty path", "decoder accepts partial struct", "phantom workspace created"],
  async (t, opened) => {
    const before = await opened.client.call({ type: "workspace.list" });
    await expectProtocolClose(opened, { type: "workspace.open", payload: {} });
    const after = await opened.client.call({ type: "workspace.list" });
    t.assertions.assert(
      before?.type === "workspaces" && after?.type === "workspaces" && after.data.length === before.data.length,
      `invalid open changed workspace count: ${JSON.stringify({ before, after })}`,
    );
  },
);

protocolCase(
  "specialty.daemon.protocol.field-type-rejected",
  "A scalar field with the wrong JSON type is rejected",
  "numeric workspace root is refused as badRequest and cannot mutate workspace registration",
  ["number stringified as a host path", "type confusion reaches filesystem", "parse error changes state"],
  async (t, opened) => {
    await expectProtocolClose(opened, { type: "workspace.open", payload: { root: 42 } });
    await assertLive(t, opened);
  },
);

protocolCase(
  "specialty.daemon.protocol.unsigned-boundary-rejected",
  "A negative value cannot cross an unsigned protocol boundary",
  "file.tree depth -1 is refused as badRequest while an ordinary tree request still succeeds",
  ["negative depth wraps to a huge traversal", "signed value silently clamps", "tree service remains poisoned"],
  async (t, opened) => {
    await expectProtocolClose(opened, {
      type: "file.tree",
      payload: { workspaceId: opened.workspaceId, path: null, depth: -1 },
    });
    const tree = await opened.client.call({
      type: "file.tree",
      payload: { workspaceId: opened.workspaceId, path: null, depth: 1 },
    });
    t.assertions.assert(tree?.type === "fileTree", `valid tree failed after negative depth: ${JSON.stringify(tree)}`);
  },
);

protocolCase(
  "specialty.daemon.protocol.null-write-is-side-effect-free",
  "A null file body is rejected without touching disk",
  "file.write with null content is refused as badRequest, creates no file, and a later valid write succeeds",
  ["null becomes empty file", "failed decode partially writes", "file service breaks after rejection"],
  async (t, opened) => {
    const relative = "must-not-exist.txt";
    await expectProtocolClose(opened, {
      type: "file.write",
      payload: { workspaceId: opened.workspaceId, path: `${opened.rootHandle}/${relative}`, content: null },
    });
    t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, relative)), "rejected null write created a file");
    const written = await opened.client.call({
      type: "file.write",
      payload: { workspaceId: opened.workspaceId, path: `${opened.rootHandle}/valid-after-error.txt`, content: "ok" },
    });
    t.assertions.assert(written?.type === "ack", "valid write failed after null write rejection");
    t.assertions.fileEquals(opened.workspaceRoot, "valid-after-error.txt", "ok");
  },
);

protocolCase(
  "specialty.daemon.protocol.rejection-storm-isolated",
  "A malformed-request storm stays isolated to its issuing client",
  "eight badRequest refusals do not interrupt a second production client repeatedly listing the workspace",
  ["parse errors exhaust dispatcher", "one client blocks peers", "bad request closes shared daemon transport"],
  async (t, opened) => {
    const observer = await t.flows.main.openSecondClient(opened, "protocol-storm-observer");
    try {
      for (let index = 0; index < 8; index += 1) {
        const invalid = expectProtocolClose(opened, {
          type: index % 2 === 0 ? "workspace.open" : "workspace.create",
          payload: index % 2 === 0 ? { root: { invalid: index } } : { root: [], name: index },
        });
        const observed = observer.call({ type: "workspace.list" });
        const [, listed] = await Promise.all([invalid, observed]);
        t.assertions.assert(
          listed?.type === "workspaces" && listed.data.some((workspace) => workspace.id === opened.workspaceId),
          `observer failed during rejection ${index}: ${JSON.stringify(listed)}`,
        );
      }
      await assertLive(t, opened);
    } finally {
      observer.close();
    }
  },
  300_000,
);
