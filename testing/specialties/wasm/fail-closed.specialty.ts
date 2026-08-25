import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BlockedError,
  defineSpecialty,
  genetEnv,
  locateGenet,
  parseJson,
  procCmdline,
  runGenet,
  tryLocateDaemonComponent,
  tryLocateHost,
} from "../../framework/public.ts";

function requireWasm(openRoot: string): { host: string; component: string } {
  const host = tryLocateHost(openRoot);
  const component = tryLocateDaemonComponent(openRoot);
  if (!host || !component) throw new BlockedError("wasm artifacts missing");
  return { host, component };
}

function meta(id: string, title: string, oracle: string, catches: string[], ms = 20_000) {
  return {
    id,
    title,
    oracle,
    catches,
    tags: ["core", "wasm-guest", "v2-shell"],
    llm: { default: "none" as const },
    expectedDurationMs: ms,
    timeoutMs: 120_000,
    resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0, pool: "standard" as const },
    surfaces: ["genehub-host", "daemon"],
    productInterfaces: ["genet-cli", "@genehub/workbench/client"],
  };
}

defineSpecialty(
  meta(
    "specialty.wasm.lifecycle.garbage-component-fails-closed",
    "A truncated or text file named .wasm is not started as a native daemon",
    "daemon start exits non-zero and names a component/instantiate failure",
    ["garbage wasm silently ignored", "native genet daemon run starts instead", "start hangs compiling junk"],
    15_000,
  ),
  async (t) => {
    const artifacts = requireWasm(t.openRoot);
    const junk = path.join(t.env.root, "not-a-component.wasm");
    writeFileSync(junk, "this is not a wasm component\n");
    const genet = locateGenet(t.openRoot);
    const env = genetEnv(t.openRoot, {
      ...t.env.env,
      GENEHUB_LOCAL_DAEMON_COMPONENT: junk,
      GENEHUB_HOST: artifacts.host,
    });
    const result = runGenet(genet, ["daemon", "start"], env);
    t.assertions.assert(result.code !== 0, `garbage component started: ${result.stdout}`);
    t.assertions.assert(
      /component|instantiate|wasm|compile|exited|endpoint/i.test(`${result.stderr}\n${result.stdout}`),
      `failure was not about the component: ${result.stderr || result.stdout}`,
    );
    const status = parseJson(runGenet(genet, ["daemon", "status"], env).stdout);
    t.assertions.assert(status.running === false, `garbage component left a daemon running: ${JSON.stringify(status)}`);
  },
);

defineSpecialty(
  meta(
    "specialty.wasm.lifecycle.two-data-dirs-two-hosts",
    "Two data directories get two host processes, each loading the one component",
    "pids differ, both cmdlines contain genehub_guest.wasm, and stop of one leaves the other running",
    ["second start reuses the first host", "one dir falls back to native"],
    25_000,
  ),
  async (t) => {
    requireWasm(t.openRoot);
    const genet = locateGenet(t.openRoot);
    const a = path.join(t.env.root, "data-a");
    const b = path.join(t.env.root, "data-b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const envA = genetEnv(t.openRoot, { ...t.env.env, GENEHUB_LOCAL_DATA_DIR: a });
    const envB = genetEnv(t.openRoot, { ...t.env.env, GENEHUB_LOCAL_DATA_DIR: b });
    const startedA = parseJson(runGenet(genet, ["daemon", "start"], envA).stdout);
    const startedB = parseJson(runGenet(genet, ["daemon", "start"], envB).stdout);
    try {
      t.assertions.assert(startedA.pid !== startedB.pid, `shared pid ${startedA.pid}`);
      t.assertions.assert(procCmdline(Number(startedA.pid)).includes("genehub_guest.wasm"), procCmdline(Number(startedA.pid)));
      t.assertions.assert(procCmdline(Number(startedB.pid)).includes("genehub_guest.wasm"), procCmdline(Number(startedB.pid)));
      runGenet(genet, ["daemon", "stop"], envA);
      const stillB = parseJson(runGenet(genet, ["daemon", "status"], envB).stdout);
      t.assertions.assert(stillB.running === true && stillB.pid === startedB.pid, `B died when A stopped: ${JSON.stringify(stillB)}`);
    } finally {
      runGenet(genet, ["daemon", "stop"], envA);
      runGenet(genet, ["daemon", "stop"], envB);
    }
  },
);

defineSpecialty(
  meta(
    "specialty.wasm.speech.capabilities-do-not-hang",
    "speech.capabilities on the wasm guest returns a structured reply instead of parking the fiber",
    "the reply type is speechCapabilities and arrives in under 5s",
    ["speech host call blocks the instance", "speech panics on wasm"],
    15_000,
  ),
  async (t) => {
    requireWasm(t.openRoot);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const began = Date.now();
      const reply = await opened.client.call({ type: "speech.capabilities" });
      t.assertions.assert(Date.now() - began < 5_000, "speech.capabilities blocked the guest");
      t.assertions.assert(reply?.type === "speechCapabilities", `speech.capabilities returned ${reply?.type}`);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

defineSpecialty(
  meta(
    "specialty.wasm.lifecycle.copied-host-without-component-refuses",
    "A host binary copied next to the CLI is not enough if the .wasm is absent",
    "start fails naming genehub_guest.wasm rather than running a native daemon",
    ["host without a component falls through to genet daemon run"],
    10_000,
  ),
  async (t) => {
    const artifacts = requireWasm(t.openRoot);
    const isolated = path.join(t.env.root, "cli-and-host");
    mkdirSync(isolated, { recursive: true });
    const genet = locateGenet(t.openRoot);
    const clone = path.join(isolated, path.basename(genet));
    const hostClone = path.join(isolated, path.basename(artifacts.host));
    copyFileSync(genet, clone);
    copyFileSync(artifacts.host, hostClone);
    chmodSync(clone, 0o755);
    chmodSync(hostClone, 0o755);
    const env = genetEnv(t.openRoot, {
      ...t.env.env,
      GENEHUB_LOCAL_DATA_DIR: path.join(t.env.root, "copied-host-data"),
    });
    delete env.GENEHUB_LOCAL_COMPONENT;
    delete env.GENEHUB_LOCAL_DAEMON_COMPONENT;
    delete env.GENEHUB_LOCAL_DAEMON_COMMAND;
    delete env.GENEHUB_HOST;
    const result = runGenet(clone, ["daemon", "start"], env);
    t.assertions.assert(result.code !== 0, `CLI+host without wasm started: ${result.stdout}`);
    t.assertions.assert(
      /genehub_guest\.wasm is missing/i.test(`${result.stderr}\n${result.stdout}`),
      `wrong failure: ${result.stderr || result.stdout}`,
    );
  },
);
