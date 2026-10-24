import path from "node:path";
import { defineSpecialty, parseJson, runGenetAsync, startHub, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type Row = { machineId: string; local: boolean; sources: string[]; online: boolean | null };
type Answer = { data: { machines: Row[]; complete: boolean; [key: string]: any }; error?: { code: string; details: any } };
const command = (opened: Opened, args: string[]) => runGenetAsync(opened.daemon.genet, args, opened.daemon.env);
async function json(opened: Opened, args: string[]): Promise<Answer> {
  const result = await command(opened, args);
  if (result.code !== 0) throw new Error(`CLI ${args.slice(0, 2).join(" ")} failed: ${result.stderr}`);
  return parseJson(result.stdout) as unknown as Answer;
}

for (const hubEnabled of [false, true]) {
  defineSpecialty({
    id: `specialty.cli.machine-directory.${hubEnabled ? "hub" : "local"}`,
    title: `Default machine discovery and show agree with ${hubEnabled ? "a real Hub" : "no Hub enrollment"}`,
    oracle: "Default and reachable lists agree, every listed ID resolves through show, paired records remain separate, and a failed Hub query reports an incomplete directory rather than empty success",
    catches: ["default list hides Hub machines", "show requires pairing for a listed ID", "Hub outage masquerades as no machines", "ticket failure masquerades as missing pairing"],
    tags: ["core", "cli", "machine-directory"], llm: { default: "none" },
    requiredRepos: hubEnabled ? ["cloud"] : [],
    requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
    productInterfaces: ["genet-cli", "@genehub/workbench/client", ...(hubEnabled ? ["hub-http"] : [])],
    surfaces: ["genet-cli", "daemon", ...(hubEnabled ? ["cloud-server"] : [])],
    expectedDurationMs: hubEnabled ? 15000 : 5000, timeoutMs: 90000,
    resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" },
  }, async t => {
    const hub = hubEnabled ? await startHub({ databasePath: path.join(t.env.root, "directory-hub.sqlite") }) : null;
    if (hub) t.env.env.GENEHUB_LOCAL_HUB_URL = hub.origin;
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let stopped = false;
    try {
      if (hub) {
        const owner = hub.browser();
        await hub.signInOwner(owner);
        const pairing = await opened.client.call({ type: "hub.pair", payload: { hubUrl: hub.origin, displayName: "directory-machine" } });
        if (pairing?.type !== "hubStatus" || pairing.data.state !== "pairing") throw new Error("Hub pairing did not start");
        await hub.approvePairing(owner, pairing.data.userCode);
        await t.tools.waitUntil(async () => {
          const state = await opened.client.call({ type: "hub.status" });
          return state?.type === "hubStatus" && state.data.state === "paired";
        }, 30000);
      }
      const listed = (await json(opened, ["machine", "list"])).data;
      const legacy = (await json(opened, ["machine", "list", "--reachable"])).data;
      const paired = (await json(opened, ["machine", "list", "--paired"])).data;
      t.assertions.assert(listed.complete && JSON.stringify(listed) === JSON.stringify(legacy), "default did not discover the same directory as reachable");
      t.assertions.assert(listed.machines.length === 1 && listed.machines[0]!.local, "an installation hid its local target or duplicated its Hub identity");
      t.assertions.assert(paired.scope === "paired" && paired.machines.length === 0, "Hub enrollment was confused with direct pairing");
      const row = listed.machines[0]!;
      t.assertions.assert(row.sources.includes("local") && (!hub || row.sources.includes("hub")), "discovery lost a machine source");
      const shown = (await json(opened, ["machine", "show", row.machineId])).data;
      t.assertions.assert(JSON.stringify(shown) === JSON.stringify(row), "show did not use the listing directory");
      const absent = await command(opened, ["machine", "show", "m_no_such_machine"]);
      t.assertions.assert(absent.code !== 0 && (parseJson(absent.stdout).error as any)?.code === "targetNotFound", "unknown ID was reported as an unpaired machine");
      for (const args of [["machine", "list", "--paired", "--reachable"], ["machine", "show", row.machineId, "extra"], ["machine", "list", "--unknown"]]) {
        t.assertions.assert((await command(opened, args)).code === 2, "ambiguous discovery arguments were accepted");
      }
      if (hub) {
        const ticket = await command(opened, ["context", "--machine", "m_no_such_machine"]);
        const failure = parseJson(ticket.stdout).error as any;
        t.assertions.assert(ticket.code !== 0 && failure?.code !== "machineNotPaired" && failure?.details?.stage === "hubTicket", "ticket failure discarded the real reason");
        await hub.stop(); stopped = true;
        const failed = await command(opened, ["machine", "list"]);
        const error = parseJson(failed.stdout).error as any;
        t.assertions.assert(failed.code !== 0 && error?.details?.complete === false && error.details.source === "hub", "Hub outage became a successful empty directory");
        t.assertions.assert(error.details.machines.some((item: Row) => item.local), "Hub failure discarded the known local machine");
        t.assertions.assert((await json(opened, ["machine", "list", "--paired"])).data.complete, "direct records unnecessarily depend on the Hub");
      }
      t.note(`directory sources=${row.sources.join(",")}; paired=0; default, alias and show agree${hub ? "; real Hub failure preserves incomplete directory" : ""}`);
    } finally {
      opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
      if (hub && !stopped) await hub.stop();
    }
  });
}
