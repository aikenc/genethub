import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { allocatePort, defineSpecialty, startHub, startRelay } from "../../framework/public.ts";

const read = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8") : "");
const scrub = (text: string): string => text.replace(/https?:\/\/\S+|wss?:\/\/\S+/g, "[endpoint]").slice(-600);

defineSpecialty({
  id: "specialty.authorization.agent-hosted-machine-access",
  title: "An Agent Session's CLI reaches a Hub-introduced machine without gaining other capabilities",
  oracle: "A real Agent Session runs the product CLI with --machine against a machine only the Hub can introduce and the remote command's own file effect appears, while the same session's device list is still refused",
  catches: [
    "Hub ticket request refused for an Agent Session and reported as machineNotPaired",
    "Hub-listed online machine that no Agent can reach",
    "fixing the regression by widening every Agent Session capability",
  ],
  tags: ["authorization-depth", "cloud-server", "genet-cli"],
  llm: { default: "mock" },
  requiredRepos: ["cloud"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["cloud-server", "daemon", "relay", "genet-cli", "agent"],
  productInterfaces: ["hub-http", "genet-cli", "@genehub/workbench/client"],
  stages: ["pair-with-hub", "agent-runs-cli", "assert-effects"],
  expectedDurationMs: 30_000,
  timeoutMs: 120_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" },
}, async t => {
  const token = randomBytes(32).toString("hex");
  const port = await allocatePort();
  const hub = await startHub({
    databasePath: join(t.env.root, "hub.sqlite"),
    relayOrigin: `http://127.0.0.1:${port}`,
    relayToken: token,
  });
  const relay = await startRelay({ openRoot: t.openRoot, port, control: { origin: hub.origin, token } });
  t.env.env.GENEHUB_LOCAL_HUB_URL = hub.origin;
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const owner = hub.browser();
    await hub.signInOwner(owner);
    const machineId = await t.stage("pair-with-hub", async () => {
      const pairing = await opened.client.call({ type: "hub.pair", payload: { hubUrl: hub.origin, displayName: "agent-access" } });
      if (pairing?.type !== "hubStatus" || pairing.data.state !== "pairing") throw new Error("hub.pair did not begin pairing");
      await hub.approvePairing(owner, pairing.data.userCode);
      let id = "";
      await t.tools.waitUntil(async () => {
        const me = await owner.json<{ machines: Array<{ id: string; online: boolean }> }>("/app/me");
        id = me.machines.find(machine => machine.online)?.id ?? "";
        return id !== "";
      }, 30_000);
      return id;
    });

    // No machine is paired directly with this installation, so the only way
    // for the CLI to reach `machineId` is the Hub's per-connection ticket.
    const root = opened.workspaceRoot;
    await t.stage("agent-runs-cli", async () => {
      const command = [
        `cd "${root}"`,
        `"$GENEHUB_CLI" --machine ${machineId} shell --workspace ${opened.workspaceId} --timeout 20 -- sh -c 'echo reached > hosted.marker' < /dev/null > hosted.out 2> hosted.err`,
        "echo $? > hosted.exit",
        `"$GENEHUB_CLI" device list < /dev/null > denied.out 2> denied.err`,
        "echo $? > denied.exit",
        "touch done",
      ].join("; ");
      opened.mock.script({ tool: { name: "bash", arguments: { command } } }, { text: "Finished." });
      const session = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await t.flows.main.sendPrompt(opened.client, session, "Run the remote check.");
      try {
        await t.tools.waitUntil(() => existsSync(join(root, "done")), 40_000);
      } catch (error) {
        throw new Error(`the Agent never finished its command: files=${readdirSync(root).join(",")} ${String(error)}`);
      }
    });

    await t.stage("assert-effects", async () => {
      const hostedExit = read(join(root, "hosted.exit")).trim();
      t.assertions.assert(
        hostedExit === "0" && read(join(root, "hosted.marker")) === "reached\n",
        `the Agent's CLI could not run a command on the Hub-introduced machine: exit=${hostedExit} stderr=${scrub(read(join(root, "hosted.err")))}`,
      );
      const deniedExit = read(join(root, "denied.exit")).trim();
      t.assertions.assert(
        deniedExit !== "" && deniedExit !== "0" && /unauthenticated|lacks the devices capability/.test(read(join(root, "denied.out")) + read(join(root, "denied.err"))),
        `an Agent Session gained device administration: exit=${deniedExit}`,
      );
    });
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
    relay.stop();
    await hub.stop();
  }
});
