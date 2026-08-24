import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

function readOpen(openRoot: string, relative: string): string {
  return readFileSync(path.join(openRoot, relative), "utf8");
}

function between(body: string, start: string, end: string): string {
  const from = body.indexOf(start);
  if (from < 0) throw new Error(`missing ${start}`);
  const rest = body.slice(from);
  const until = rest.indexOf(end);
  if (until < 0) throw new Error(`missing ${end}`);
  return rest.slice(0, until);
}

function rustFiles(openRoot: string, relative: string): string[] {
  const root = path.join(openRoot, relative);
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith(".rs")) files.push(path.relative(openRoot, full).replaceAll("\\", "/"));
    }
  };
  visit(root);
  return files;
}

defineSpecialty(
  {
    id: "specialty.contracts.release-actions-pinned",
    title: "Release actions are immutable and contents write stays in the publish job",
    oracle: "release.yml pins SHAs, contents:write stays in the publish job",
    catches: ["floating action tag", "write permission leak"],
    tags: ["core", "contract", "parity"],
    expectedDurationMs: 400,
    timeoutMs: 10_000,
    surfaces: ["release"],
  },
  async (t) => {
    const workflow = readOpen(t.openRoot, ".github/workflows/release.yml");
    const uses = workflow
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- uses: "))
      .map((line) => line.slice("- uses: ".length));
    t.assertions.assert(uses.length > 0, "release workflow has no actions");
    for (const action of uses) {
      const reference = (action.split("#")[0] ?? "").trim().split("@").at(-1) ?? "";
      t.assertions.assert(
        reference.length === 40 && [...reference].every((ch) => /[0-9a-f]/.test(ch)),
        `action is not pinned: ${action}`,
      );
    }
    t.assertions.assert(workflow.includes("permissions:\n  contents: read\n"), "default contents is not read");
    t.assertions.assert(
      workflow.split("contents: write").length - 1 === 1,
      "contents: write escaped the publish job",
    );
    const publish = workflow.indexOf("\n  publish:\n");
    const write = workflow.indexOf("contents: write");
    t.assertions.assert(publish >= 0 && write > publish, "write permission escaped the publish job");
    const checkoutCount = uses.filter((action) => action.startsWith("actions/checkout@")).length;
    t.assertions.assert(
      workflow.split("persist-credentials: false").length - 1 === checkoutCount,
      "a checkout retained the workflow credential",
    );
    t.assertions.assert(!workflow.includes("echo \"hub_url=${{ vars."), "hub url interpolated into bash");
    t.assertions.assert(workflow.includes("BETA_HUB_URL: ${{ vars.GENEHUB_BETA_HUB_URL"), "beta hub env missing");
    if (workflow.includes("\n  publish_fast_website:\n")) {
      const fast = between(workflow, "\n  publish_fast_website:\n", "\n  publish_component_website:\n");
      t.assertions.assert(!fast.includes("contents: write"), "fast website writes contents");
      t.assertions.assert(!fast.includes("softprops/action-gh-release"), "fast website publishes GitHub releases");
    }
  },
);

defineSpecialty(
  {
    id: "specialty.contracts.release-signed-component",
    title: "App release embeds one signed component with channel-specific keys",
    oracle: "release.yml packs genehub_guest.wasm signed per channel",
    catches: ["unsigned component", "channel signing key missing"],
    tags: ["core", "contract", "parity"],
    expectedDurationMs: 400,
    timeoutMs: 10_000,
    surfaces: ["release"],
  },
  async (t) => {
    const workflow = readOpen(t.openRoot, ".github/workflows/release.yml");
    t.assertions.assert(workflow.includes("GENEHUB_BETA_COMPONENT_SIGNING_KEY"), "beta key missing");
    t.assertions.assert(workflow.includes("GENEHUB_STABLE_COMPONENT_SIGNING_KEY"), "stable key missing");
    t.assertions.assert(workflow.includes("dist/genehub_guest.wasm"), "signed component not packed");
  },
);

defineSpecialty(
  {
    id: "specialty.contracts.release-from-main",
    title: "Tag releases must come from the observed public main history",
    oracle: "release.yml ancestor-checks the tag against public main",
    catches: ["tag from a private fork history"],
    tags: ["core", "contract", "parity"],
    expectedDurationMs: 300,
    timeoutMs: 10_000,
    surfaces: ["release"],
  },
  async (t) => {
    const workflow = readOpen(t.openRoot, ".github/workflows/release.yml");
    t.assertions.assert(workflow.includes("git merge-base --is-ancestor"), "ancestor check missing");
    t.assertions.assert(workflow.includes("refs/heads/main"), "main ref missing");
  },
);

defineSpecialty(
  {
    id: "specialty.contracts.native-wire-boundary",
    title: "Native runtime cannot take back business wire ownership",
    oracle: "native crates do not import Request/Reply/ServerFrame",
    catches: ["daemon owning the business codec"],
    tags: ["core", "contract", "parity", "v1-wasm"],
    expectedDurationMs: 800,
    timeoutMs: 15_000,
    surfaces: ["release"],
  },
  async (t) => {
    const forbidden = [
      "genehub_app_proto::Request",
      "genehub_app_proto::Reply",
      "genehub_app_proto::ServerFrame",
      "use genehub_app_proto::{Request",
      "use genehub_app_proto::{Reply",
      "use genehub_app_proto::{ServerFrame",
    ];
    const roots = [
      "apps/cli/src",
      "apps/daemon/src",
      "packages/platform-abi/src",
      "packages/platform-native/src",
      "packages/platform-system/src",
      "apps/desktop/src-tauri/src",
    ];
    for (const root of roots) {
      for (const relative of rustFiles(t.openRoot, root)) {
        const body = readOpen(t.openRoot, relative);
        for (const symbol of forbidden) {
          t.assertions.assert(!body.includes(symbol), `${relative} regained ${symbol}`);
        }
      }
    }
    const dataPlane = readOpen(t.openRoot, "packages/app-core/src/dataplane.rs");
    t.assertions.assert(dataPlane.includes("PeerHello") && dataPlane.includes("ServerFrame"), "app-core lost the wire");
  },
);
