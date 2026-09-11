import { execFileSync } from "node:child_process";
import { BlockedError, defineSpecialty } from "../../framework/public.ts";

// No model call: compare this installed CLI's published choices with the
// catalog exposed by the actual guest through the normal workbench client.
defineSpecialty({
  id: "specialty.agent.claude-catalog-installed-cli",
  title: "Claude permission picker matches the installed CLI's launch options",
  oracle: "The public guest catalog contains exactly the supported user-facing permission modes from real CLI help",
  catches: ["truncated CLI help removes modes", "unrelated default text invents an asking mode", "native fixture hides guest process capture differences"],
  tags: ["network-audit-fix", "claude-catalog"], llm: { default: "none" },
  expectedDurationMs: 15000, timeoutMs: 90000,
  surfaces: ["daemon", "agent-adapter", "workbench-client"],
}, async (t) => {
  let help: string;
  try { help = execFileSync("claude", ["--help"], { encoding: "utf8", timeout: 15000 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BlockedError("Claude CLI is not installed");
    throw error;
  }
  const choices = help.split("--permission-mode")[1]?.split(/\n\s+--/)[0] ?? "";
  t.assertions.assert(choices.includes("choices:"), "Installed CLI did not provide a complete permission-mode listing");
  const expected = ["manual", "default", "acceptEdits", "plan", "bypassPermissions"]
    .filter((mode) => choices.includes(`"${mode}"`) || choices.includes(`'${mode}'`)).sort();
  t.assertions.assert(expected.includes("bypassPermissions") && expected.length > 1, "Empty CLI permission oracle");
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const reply = await opened.client.call({ type: "agent.list" });
    t.assertions.assert(reply?.type === "agents", "Agent list was not returned");
    const claude = reply?.type === "agents" ? reply.data.find((agent) => agent.id === "claude") : undefined;
    t.assertions.assert(!!claude, "Installed Claude agent is missing");
    const actual = (claude?.catalog.modes ?? []).map((mode) => mode.id).sort();
    t.assertions.assert(JSON.stringify(actual) === JSON.stringify(expected), `Permission catalog differs: actual=${actual}, CLI=${expected}`);
    t.assertions.assert(claude?.catalog.defaultMode === "bypassPermissions", "Product highest-permission default was lost");
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
