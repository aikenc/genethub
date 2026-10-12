// Which Agent and model an expert's background session starts on is decided by `tools/expert.py`, and a
// script that has to choose must be able to explain the choice. These cases run the real script's `choose`
// against a stand-in `genet` that answers `session get` and `agent list --routes` from a fixture, so every
// branch of the order "asked for explicitly > this machine's override > what the requester runs on" and the
// media rule ("same tier, nearest cost, never a silent downgrade") is observed, not read.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

const TOOL = "apps/daemon/builtin-skills/genehub/references/expert-template/tools/expert.py";

// The stand-in CLI: the answer is the last stdout line, as the real one's is.
const FAKE_GENET = `#!/usr/bin/env python3
import json, os, sys
fixture = json.load(open(os.environ["FAKE_GENET_FIXTURE"]))
args = sys.argv[1:]
if args[:2] == ["session", "get"]:
    print(json.dumps({"data": {"session": {"summary": fixture["requester"]}}}))
elif args[:3] == ["agent", "list", "--routes"]:
    tags, media, rest = [], [], args[3:]
    while rest:
        flag, value, rest = rest[0], rest[1], rest[2:]
        (tags if flag == "--tag" else media).append(value)
    need = tags + [{"image": "图片理解", "video": "视频理解"}[m] for m in media]
    print(json.dumps({"data": {"routes": [r for r in fixture["routes"] if all(n in r["tags"] for n in need)]}}))
else:
    print(json.dumps({"error": {"message": "unexpected " + " ".join(args)}}))
    sys.exit(4)
`;

const DRIVER = `
import json, os, sys
sys.path.insert(0, os.path.dirname(os.environ["EXPERT_TOOL"]))
import expert
cases = json.loads(os.environ["CASES"])
out = []
for case in cases:
    try:
        args, why = expert.choose(os.environ["ROOT"], "EXPERT_MODEL_WORK", **case["kwargs"])
        out.append({"args": args, "why": why})
    except expert.ExpertError as error:
        out.append({"error": error.what, "state": error.state})
print(json.dumps(out))
`;

type Outcome = { args?: string[]; why?: string; error?: string; state?: string };

defineSpecialty(
  {
    id: "specialty.daemon.expert-model-choice",
    title: "An expert's background session inherits the requester's model, honours overrides and never silently drops a medium",
    oracle:
      "`expert.choose` returns, for a requester on codex/gpt-6-luna (Flash, veryLow, no image): the requester's agent, model and effort when nothing is asked; the machine override when EXPERT_MODEL_WORK is set; an explicit --model on the same Agent; --tier as a platform-routed `--tag`; for an image task the same-tier route that understands images with the nearest cost; and an error that creates nothing when no such route exists, when --tier and --model are both given, or when the tier has no route",
    catches: [
      "a background session on a model nobody chose",
      "an image task handed to a model that cannot see it",
      "a medium the model lacks silently ignored",
      "a machine override losing to inheritance",
      "an equivalent that is a different tier or the far end of the cost scale",
    ],
    tags: ["core", "expert", "session-model", "genet-cli"],
    expectedDurationMs: 4_000,
    timeoutMs: 60_000,
    requiredArtifacts: [],
    resources: { environments: 1, cpu: 1 },
    surfaces: ["tools/expert.py", "genet-cli"],
  },
  async (t) => {
    const dir = join(t.env.root, "expert-model-choice");
    mkdirSync(join(dir, "root", ".genethub"), { recursive: true });
    const cli = join(dir, "genet");
    writeFileSync(cli, FAKE_GENET, { mode: 0o755 });
    const fixturePath = join(dir, "fixture.json");
    const route = (agentId: string, modelId: string, tags: string[], cost: string) => ({ agentId, modelId, tags, cost, default: false });
    writeFileSync(
      fixturePath,
      JSON.stringify({
        requester: { agentId: "codex", modelId: "gpt-6-luna", effortId: "high" },
        routes: [
          route("codex", "gpt-6-luna", ["Flash"], "veryLow"),
          route("codex", "gpt-6-sol", ["Flash", "图片理解"], "low"),
          route("codex", "gpt-6-terra", ["Flash", "图片理解"], "veryHigh"),
          route("codex", "gpt-6-max", ["Max", "图片理解", "视频理解"], "high"),
        ],
      }),
    );

    const run = (cases: Array<{ kwargs: Record<string, unknown> }>, envFile = ""): Outcome[] => {
      writeFileSync(join(dir, "root", ".genethub", "open.env"), envFile);
      const out = execFileSync("python3", ["-c", DRIVER], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          GENEHUB_CLI: cli,
          GENEHUB_SESSION_ID: "s_requester",
          FAKE_GENET_FIXTURE: fixturePath,
          EXPERT_TOOL: join(t.openRoot, TOOL),
          ROOT: join(dir, "root"),
          CASES: JSON.stringify(cases),
        },
      });
      return JSON.parse(out.trim().split("\n").at(-1)!) as Outcome[];
    };
    const same = (got: unknown, want: unknown, what: string) =>
      t.assertions.assert(JSON.stringify(got) === JSON.stringify(want), `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    const refused = (got: Outcome | undefined, what: string) =>
      t.assertions.assert(
        typeof got?.error === "string" && got.state === "没有创建任何会话",
        `${what}: expected a refusal that creates nothing, got ${JSON.stringify(got)}`,
      );

    const [inherit, explicit, tier, tierModel, badTier, noTier, imageTier, video, none] = run([
      { kwargs: {} },
      { kwargs: { model: "gpt-6-terra" } },
      { kwargs: { tier: "Max" } },
      { kwargs: { tier: "Max", model: "gpt-6-terra" } },
      { kwargs: { tier: "Ultra" } },
      { kwargs: { tier: "Pro" } },
      { kwargs: { media: "image" } },
      { kwargs: { media: "video" } },
      { kwargs: { tier: "Flash", media: "video" } },
    ]);

    same(inherit?.args, ["--agent", "codex", "--model", "gpt-6-luna", "--effort", "high"], "nothing asked: the requester's agent, model and effort");
    same(explicit?.args, ["--agent", "codex", "--model", "gpt-6-terra"], "an explicit model on the requester's Agent");
    same(tier?.args, ["--tag", "Max"], "a tier is left to platform routing");
    refused(tierModel, "--tier together with --model");
    refused(badTier, "a tier that is not Max, Pro or Flash");
    refused(noTier, "a tier no route carries");
    // luna is Flash/veryLow without images. The Flash image routes are low (sol) and veryHigh (terra); sol is nearer.
    same(imageTier?.args, ["--agent", "codex", "--model", "gpt-6-sol"], "an image task moves to the same-tier route nearest in cost");
    t.assertions.assert(
      imageTier?.args?.includes("--effort") === false,
      "an effort chosen for another model was carried to the replacement",
    );
    refused(video, "a video task when no Flash route understands video");
    refused(none, "a tier + medium no route carries");

    const [override] = run([{ kwargs: {} }], "EXPERT_MODEL_WORK=gpt-6-terra\n");
    same(override?.args, ["--agent", "codex", "--model", "gpt-6-terra"], "the machine's override beats inheritance");
    const [pinnedAgent] = run([{ kwargs: {} }], "EXPERT_AGENT=codex\n");
    same(pinnedAgent?.args, ["--agent", "codex", "--model", "gpt-6-luna", "--effort", "high"], "a configured Agent equal to the requester's still inherits its model");
  },
);
