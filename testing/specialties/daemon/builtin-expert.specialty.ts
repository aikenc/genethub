// The machine's administrator ships with the product: a Space made from the team template under
// `<data>/spaces/admin/`, named after the machine, built by the shipped SpaceBuilder, and registered by the
// ordinary scan. These cases start the shipped daemon on an empty data directory and look at what is there.
// No model is involved.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, localGenetCli, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type Info = { id: string; name: string; root?: string; agentSpace?: { parentWorkspaceId?: string } };

const MACHINE = "办公室-Mac";
const NAME = `${MACHINE}管理员`;

async function list(opened: Opened): Promise<Info[]> {
  const reply = await opened.client.call({ type: "workspace.list" });
  if (reply?.type !== "workspaces") throw new Error(`workspace.list returned ${reply?.type}`);
  return reply.data as unknown as Info[];
}

const stop = async (opened: Opened): Promise<void> => {
  opened.client.close();
  opened.daemon.stop();
  await opened.mock.stop();
};

function adminCase(
  name: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext, open: () => Promise<Opened>, admin: string) => Promise<void>,
): void {
  defineSpecialty(
    {
      id: `specialty.daemon.builtin-expert.${name}`,
      title,
      oracle,
      catches,
      tags: ["core", "daemon", "builtin-expert"],
      llm: { default: "none" },
      expectedDurationMs: 30_000,
      timeoutMs: 180_000,
      resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
      surfaces: ["daemon", "spacebuilder", "genet-cli"],
      productInterfaces: ["workspace.list", "genet hook list"],
    },
    async (t) => {
      (t.env.env as Record<string, string>).GENEHUB_LOCAL_MACHINE_NAME = MACHINE;
      const admin = path.join(t.env.data, "spaces", "admin");
      await run(t, () => t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env }), admin);
    },
  );
}

adminCase(
  "is-built-and-registered-on-first-start",
  "a fresh machine has an administrator named after it, built, registered as one Space, with the timer hook in place",
  "after the first start workspace.list holds <机器名>管理员 with no child Spaces under it (the administrator is one Space plus team-admin), the root has no rules while front/ does, the hook list shows team-front.timer valid and owned by SpaceBuilder, and every Skill is under 40 lines",
  [
    "no administrator on a new machine",
    "the administrator carrying child Spaces it never uses",
    "the timer hook missing, so nothing is ever reconciled",
    "the machine name not reaching the Space name",
  ],
  async (t, open, admin) => {
    const opened = await open();
    try {
      const spaces = await list(opened);
      const root = spaces.find((space) => space.name === NAME);
      t.assertions.assert(root, `no ${NAME} in ${JSON.stringify(spaces.map((s) => s.name))}`);
      const children = spaces.filter((space) => space.agentSpace?.parentWorkspaceId === root!.id);
      t.assertions.assert(children.length === 0, `the administrator has child Spaces: ${JSON.stringify(children.map((s) => s.name))}`);
      t.assertions.assert(existsSync(path.join(admin, "front", "AGENTS.md")), "front/AGENTS.md was not built");
      t.assertions.assert(existsSync(path.join(admin, "front/.agents/skills/team-admin/SKILL.md")), "the administrator's own Skill is not in front/");
      t.assertions.assert(!existsSync(path.join(admin, "AGENTS.md")) && !existsSync(path.join(admin, ".agents")), "rules were written at the root");
      t.assertions.assert(!existsSync(path.join(admin, "spaces")), "the administrator was given the team's child Spaces");
      const frontRules = readFileSync(path.join(admin, "front", "AGENTS.md"), "utf8");
      t.assertions.assert(frontRules.includes("我做的一切只有一个目的：让用户满意"), "the administrator's rules do not carry the soul");
      for (const skill of ["team-core", "team-front", "team-research", "team-reflect", "team-work", "team-admin"]) {
        const file = path.join(admin, "skills", skill, "SKILL.md");
        const lines = readFileSync(file, "utf8").trimEnd().split("\n").length;
        t.assertions.assert(lines <= 40, `${skill}/SKILL.md has ${lines} lines`);
      }
      const hooks = localGenetCli(t.openRoot, t.env)(["hook", "list", "--workspace", root!.id]);
      const rows = (hooks.envelope?.data as { hooks: Array<{ id: string; valid: boolean; owner?: string; everySeconds?: number }> }).hooks;
      const timer = rows.find((row) => row.id === "team-front.timer");
      t.assertions.assert(
        timer?.valid === true && timer.owner === "spacebuilder:team-front/timer" && timer.everySeconds === 5,
        `hook rows ${JSON.stringify(rows)}`,
      );
    } finally {
      await stop(opened);
    }
  },
);

adminCase(
  "a-restart-rewrites-admin-files-prunes-stale-ones-and-a-removal-is-final",
  "a restart rewrites what the product owns and prunes stale template files on the stateless administrator, and a removed administrator is not put back",
  "after a restart an edited tools/team.py or soul.md in the built-in admin is restored to the template, a stale file and a Skill under its pre-team name from an older template are pruned while posts/ and datas/ stay, and after the user removes the administrator and restarts, it is not registered again and its files are left exactly as they were",
  [
    "the built-in administrator left on an old template after an upgrade",
    "stale files from a retired template version remaining in admin/",
    "a damaged product script never repaired",
    "an administrator the user removed coming back on every start",
  ],
  async (t, open, admin) => {
    let opened = await open();
    const script = path.join(admin, "tools", "team.py");
    const soul = path.join(admin, "soul.md");
    const originalScript = readFileSync(script, "utf8");
    const originalSoul = readFileSync(soul, "utf8");
    writeFileSync(soul, "my own soul\n");
    writeFileSync(script, "# damaged\n");
    const stale = path.join(admin, "front", "soul.mirror.md");
    const ownedPath = path.join(admin, ".genethub/bootstrap-owned.json");
    const legacySkill = path.join(admin, "skills", "expert-core", "SKILL.md");
    mkdirSync(path.dirname(legacySkill), { recursive: true });
    writeFileSync(legacySkill, "---\nname: expert-core\ndescription: an older template\n---\n");
    writeFileSync(ownedPath, JSON.stringify([...JSON.parse(readFileSync(ownedPath, "utf8")), "front/soul.mirror.md", "skills/expert-core/SKILL.md"]));
    const unknown = path.join(admin, "owner-notes.txt");
    writeFileSync(unknown, "untracked user content");
    writeFileSync(stale, "stale mirror\n");
    mkdirSync(path.join(admin, "posts"), { recursive: true });
    const post = path.join(admin, "posts", "keep.md");
    writeFileSync(post, "keep me\n");
    await stop(opened);

    opened = await open();
    try {
      t.assertions.assert(readFileSync(script, "utf8") === originalScript, "the damaged product script was not restored");
      t.assertions.assert(readFileSync(soul, "utf8") === originalSoul, "the built-in admin's soul.md was not restored to the template");
      t.assertions.assert(readFileSync(unknown, "utf8") === "untracked user content", "unknown user file was pruned");
      t.assertions.assert(!existsSync(stale), "a stale file from an older template was not pruned");
      t.assertions.assert(!existsSync(legacySkill), "a Skill under its pre-team name was not pruned");
      const skills = (JSON.parse(readFileSync(path.join(admin, "agent-space.genet.json"), "utf8")) as { skills: string[] }).skills;
      t.assertions.assert(skills.includes("team-admin") && !skills.some((name) => name.startsWith("expert-")), `administrator skills: ${JSON.stringify(skills)}`);
      t.assertions.assert(readFileSync(post, "utf8") === "keep me\n", "posts/ was pruned");
      const root = (await list(opened)).find((space) => space.name === NAME);
      t.assertions.assert(root, "the administrator is gone after a restart");
      // Children go first: a Space with members cannot be removed.
      const spaces = await list(opened);
      for (const space of [...spaces.filter((s) => s.agentSpace?.parentWorkspaceId === root!.id), root!]) {
        await opened.client.call({ type: "workspace.remove", payload: { workspaceId: space.id } });
      }
      writeFileSync(script, "# left alone because the user removed it\n");
    } finally {
      await stop(opened);
    }

    opened = await open();
    try {
      const after = await list(opened);
      t.assertions.assert(!after.some((space) => space.name === NAME || space.name === "research" || space.name === "reflect" || space.name === "work" || space.name === "leader"), `the removed administrator came back: ${JSON.stringify(after.map((s) => s.name))}`);
      t.assertions.assert(readFileSync(script, "utf8") === "# left alone because the user removed it\n", "files of a removed administrator were rewritten");
    } finally {
      await stop(opened);
    }
  },
);
