import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { SessionSnapshot, TimelineItem } from "@genehub/proto";
import { allocatePort, defineSpecialty, startHub, startRelay } from "../../framework/public.ts";

const read = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8") : "");
const scrub = (text: string): string => text.replace(/https?:\/\/\S+|wss?:\/\/\S+/g, "[endpoint]").slice(-600);
const TRIGGER = "RUN_SESSION_CONTROL_PARITY";

defineSpecialty({
  id: "specialty.authorization.agent-session-control-parity",
  title: "An Agent Session controls ordinary Sessions the same way locally and through --machine, and its writes are attributed",
  oracle: "One real Agent Session uses the product CLI to send into another ordinary Session both locally and through a Hub-introduced --machine route, and to start a new ordinary Session; every command succeeds, both target messages carry the sender Session as origin, and the receiving Agent's delivered input marks them as Agent-written",
  catches: [
    "a local Agent Session refused control of an ordinary Session the --machine route allows",
    "an Agent Session refused creating an ordinary Session",
    "an Agent's message recorded and delivered as Human input",
    "the remote route dropping the sender's identity",
  ],
  tags: ["authorization-depth", "cloud-server", "genet-cli"],
  llm: { default: "mock" },
  requiredRepos: ["cloud"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["cloud-server", "daemon", "relay", "genet-cli", "agent"],
  productInterfaces: ["hub-http", "genet-cli", "session.send", "session.create", "@genehub/workbench/client"],
  stages: ["pair-with-hub", "agent-runs-cli", "assert-effects"],
  expectedDurationMs: 40_000,
  timeoutMs: 150_000,
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
      const pairing = await opened.client.call({ type: "hub.pair", payload: { hubUrl: hub.origin, displayName: "session-parity" } });
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

    const root = opened.workspaceRoot;
    const snapshot = async (sessionId: string): Promise<SessionSnapshot> => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
      if (reply?.type !== "snapshot") throw new Error(`missing Session ${sessionId}`);
      return reply.data;
    };
    const target = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const sender = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const listIds = async (): Promise<string[]> => {
      const listed = await opened.client.call({ type: "session.list", payload: { workspaceId: opened.workspaceId, includeArchived: false } });
      if (listed?.type !== "sessions") throw new Error(`session.list returned ${listed?.type}`);
      return listed.data.map(session => session.id);
    };
    const before = new Set(await listIds());

    await t.stage("agent-runs-cli", async () => {
      const command = [
        `cd "${root}"`,
        `"$GENEHUB_CLI" session send ${target} "parity local note" --message-id m_parity_local --no-wait < /dev/null > local.out 2> local.err`,
        "echo $? > local.exit",
        `"$GENEHUB_CLI" --machine ${machineId} session send ${target} "parity remote note" --message-id m_parity_remote --no-wait < /dev/null > remote.out 2> remote.err`,
        "echo $? > remote.exit",
        `"$GENEHUB_CLI" agent run --agent genet --model deepseek/deepseek-v4-flash --workspace ${opened.workspaceId} "parity created session" --no-wait < /dev/null > create.out 2> create.err`,
        "echo $? > create.exit",
        "touch done",
      ].join("; ");
      let issued = false;
      opened.mock.script(...Array.from({ length: 40 }, () => ({
        respond: (request: unknown) => {
          const body = JSON.stringify(request);
          if (!issued && body.includes(TRIGGER)) {
            issued = true;
            return { tool: { name: "bash", arguments: { command } } };
          }
          return { text: "Noted." };
        },
      })));
      await t.flows.main.sendPrompt(opened.client, sender, `${TRIGGER}: control the other Session.`);
      try {
        await t.tools.waitUntil(() => existsSync(join(root, "done")), 60_000);
      } catch (error) {
        throw new Error(`the Agent never finished its command: files=${readdirSync(root).join(",")} ${String(error)}`);
      }
    });

    await t.stage("assert-effects", async () => {
      for (const step of ["local", "remote", "create"]) {
        const exit = read(join(root, `${step}.exit`)).trim();
        t.assertions.assert(
          exit === "0",
          `the Agent's ${step} Session command failed: exit=${exit} stdout=${scrub(read(join(root, `${step}.out`)))} stderr=${scrub(read(join(root, `${step}.err`)))}`,
        );
      }

      let messages: Array<Extract<TimelineItem, { type: "userMessage" }>> = [];
      await t.tools.waitUntil(async () => {
        messages = (await snapshot(target)).items.filter(
          (item): item is Extract<TimelineItem, { type: "userMessage" }> => item.type === "userMessage",
        );
        return ["m_parity_local", "m_parity_remote"].every(id => messages.some(message => message.id === id));
      }, 20_000);
      for (const id of ["m_parity_local", "m_parity_remote"]) {
        const message = messages.find(item => item.id === id);
        t.assertions.assert(
          message?.origin?.sessionId === sender && (message.origin.machineId ?? "") !== "",
          `${id} was not attributed to the sending Agent Session: origin=${JSON.stringify(message?.origin ?? null)}`,
        );
      }

      // The receiving Agent must be told these inputs are Agent-written.
      await t.tools.waitUntil(() => opened.mock.requests.some(request => {
        const body = JSON.stringify(request);
        return body.includes("parity local note") && /source\\*":\\*"agent/.test(body) && body.includes(sender);
      }), 20_000);

      let created: string | undefined;
      await t.tools.waitUntil(async () => {
        created = (await listIds()).find(id => !before.has(id));
        return created !== undefined;
      }, 20_000);
      const first = (await snapshot(created!)).items.find(item => item.type === "userMessage") as Extract<TimelineItem, { type: "userMessage" }> | undefined;
      t.assertions.assert(
        first?.text === "parity created session" && first.origin?.sessionId === sender,
        `the Agent-created Session's first message was not attributed: ${JSON.stringify(first ?? null).slice(0, 300)}`,
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
