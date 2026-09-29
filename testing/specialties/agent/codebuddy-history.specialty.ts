import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { BlockedError, defineSpecialty } from "../../framework/public.ts";

// The installed CLI writes the fixture, so its real path encoding is the
// independent oracle; the test never calculates the expected directory name.
for (const scenario of ["unicode", "long", "config-override"] as const) defineSpecialty({
  id: `specialty.agent.codebuddy-history.${scenario}`,
  title: `CodeBuddy history imports from ${scenario} workspace paths`,
  oracle: "A session written by the installed CBC against a local mock LLM is discovered and imported through the public guest client",
  catches: ["Claude path encoding hides CodeBuddy history", "long UTF-8 paths use the wrong truncation or hash", "CODEBUDDY_CONFIG_DIR is ignored"],
  tags: ["codebuddy", "history-import", "agent-adapter"],
  llm: { default: "mock" }, expectedDurationMs: 15_000, timeoutMs: 100_000,
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent-adapter", "filesystem", "workbench-client"],
  productInterfaces: ["cbc --print", "session.importList", "session.import"],
}, async t => {
  t.env.workspace = path.join(t.env.workspace,
    ...(scenario === "long" ? ["长目录".repeat(25)] : []), "中文 space.project_name--");
  mkdirSync(t.env.workspace, { recursive: true });
  if (scenario === "config-override") {
    t.env.env.CODEBUDDY_CONFIG_DIR = path.join(t.env.home, "custom-codebuddy");
  }
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const prompt = `CodeBuddy history fixture ${scenario}`;
  try {
    opened.mock.script({ text: "CBC_HISTORY_RESPONSE" });
    await promisify(execFile)("cbc", ["--print", "--output-format", "stream-json", "--verbose",
      "--model", "claude-sonnet-5", "--dangerously-skip-permissions", "--max-turns", "1", prompt], {
      cwd: t.env.workspace, timeout: 60_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, ...t.env.env, CODEBUDDY_BASE_URL: opened.mock.origin,
        CODEBUDDY_AUTH_TOKEN: "sk-test", CODEBUDDY_IS_SANDBOX: "1" },
    });
    t.assertions.assert(opened.mock.requests.length > 0, "CBC did not execute against the isolated mock LLM");
    const listing = await opened.client.call({ type: "session.importList", payload: { workspaceId: opened.workspaceId, limit: 20 } });
    t.assertions.assert(listing?.type === "sessionImports", "History discovery did not return a listing");
    const candidate = listing?.type === "sessionImports"
      ? listing.data.sources.find(source => source.agentId === "codebuddy")?.candidates.find(item => item.title === prompt)
      : undefined;
    if (!candidate) {
      const projects = path.join(t.env.env.CODEBUDDY_CONFIG_DIR ?? path.join(t.env.home, ".codebuddy"), "projects");
      const disk = existsSync(projects) ? readdirSync(projects).slice(0, 4).map(directory => ({
        directory,
        files: readdirSync(path.join(projects, directory)).filter(file => file.endsWith(".jsonl")).slice(0, 2).map(file => ({
          file,
          entries: readFileSync(path.join(projects, directory, file), "utf8").split("\n").filter(Boolean).slice(0, 8).map(line => {
            const entry = JSON.parse(line);
            return { type: entry.type, role: entry.role, keys: Object.keys(entry), content: entry.role === "user" ? entry.content : undefined };
          }),
        })),
      })) : [];
      const source = listing?.type === "sessionImports" ? listing.data.sources.find(source => source.agentId === "codebuddy") : undefined;
      throw new Error(`CBC history missing: ${JSON.stringify({ source, disk }).slice(0, 5000)}`);
    }
    const imported = await opened.client.call({ type: "session.import", payload: { workspaceId: opened.workspaceId, candidateId: candidate!.candidateId } });
    t.assertions.assert(imported?.type === "session" && imported.data.agentId === "codebuddy", "History was not imported with its original CodeBuddy identity");
    if (imported?.type === "session") {
      const history = await opened.client.call({ type: "session.narrative", payload: { sessionId: imported.data.id, itemId: null, cursor: null, limit: 100, throughRoundId: null } });
      const items = history?.type === "sessionNarrative" ? history.data.items : [];
      t.assertions.assert(items.some(item => item.type === "userMessage" && item.text === prompt), "Imported CBC user message was lost");
      t.assertions.assert(items.some(item => item.type === "assistantMessage" && item.text === "CBC_HISTORY_RESPONSE"), "Imported CBC assistant response was lost");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BlockedError("CBC CLI is not installed");
    throw error;
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
