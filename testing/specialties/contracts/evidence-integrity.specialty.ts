import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, redactText, redactValue, watchInputs, waitForExit, collectOutput } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.failure-evidence-redaction", title: "Failure summaries remove credential values while preserving diagnostic facts",
  oracle: "A concrete HTTP/JSON error transcript must not disclose its bearer, cookie, URL ticket or secret; exit code and process identity remain readable",
  catches: ["redacting a secret's name but retaining its value", "results.ndjson leaks failure credentials"],
  tags: ["core", "contract", "network-audit-fix"], llm: { default: "none" }, expectedDurationMs: 100, timeoutMs: 5000, surfaces: ["testctl-evidence"],
}, async t => {
  const secrets = ["fake-bearer-canary", "fake-cookie-canary", "fake-ticket-canary", "fake-secret-canary"];
  const raw = 'Authorization: Bearer ' + secrets[0] + '\nCookie: session=' + secrets[1] + '\nhttps://example.invalid/?ticket=' + secrets[2] + '\n{"channelSecret":"' + secrets[3] + '"}\nexit=4 pid=123 state=S';
  const redacted = redactText(raw);
  for (const secret of secrets) t.assertions.assert(!redacted.includes(secret), "failure transcript retained a credential value");
  t.assertions.assert(redacted.includes("exit=4 pid=123 state=S"), "redaction erased non-secret diagnostic facts");
  const structured = JSON.stringify(redactValue({ channelSecret: secrets[3], error: raw }));
  for (const secret of secrets) t.assertions.assert(!structured.includes(secret), "structured failure retained a credential value");
});

defineSpecialty({
  id: "specialty.contracts.input-change-restored", title: "A source edit followed by restoration invalidates the original run input",
  oracle: "Real filesystem watch observes a content edit and restoration whose final bytes match the initial bytes",
  catches: ["start/end hashes miss edits during execution"],
  tags: ["core", "contract", "network-audit-fix"], llm: { default: "none" }, expectedDurationMs: 300, timeoutMs: 5000, surfaces: ["filesystem"],
}, async t => {
  const root = join(t.env.root, "watched-source"); mkdirSync(root);
  const file = join(root, "module.ts"); writeFileSync(file, "original");
  const watcher = watchInputs([root], []);
  try {
    writeFileSync(file, "changed"); await new Promise(r => setTimeout(r, 100));
    writeFileSync(file, "original"); await new Promise(r => setTimeout(r, 100));
    const result = watcher.stop();
    t.assertions.assert(result.complete && result.changed, "restored mutation did not invalidate input evidence");
  } finally { watcher.stop(); }
});

defineSpecialty({
  id: "specialty.contracts.process-output-drained", title: "Process completion includes the final result footer",
  oracle: "A real child fills stdout and stderr before exit; awaiting completion retains both final markers with bounded diagnostic tails",
  catches: ["exit event races buffered TAP footer", "unbounded adapter output"],
  tags: ["core", "contract", "network-audit-fix"], llm: { default: "none" }, expectedDurationMs: 200, timeoutMs: 10000, surfaces: ["process", "testctl-evidence"],
}, async t => {
  const child = spawn(process.execPath, ["-e", "process.stdout.write('x'.repeat(1024*1024)+'STDOUT-END');process.stderr.write('y'.repeat(1024*1024)+'STDERR-END')"], { stdio: ["ignore", "pipe", "pipe"] });
  const output = collectOutput(child);
  try {
    const code = await waitForExit(child, 5000);
    t.assertions.assert(code === 0 && output.stdout.endsWith("STDOUT-END") && output.stderr.endsWith("STDERR-END"), "process result inspected before its pipes drained");
    t.assertions.assert(output.stdout.length <= 128 * 1024 && output.stderr.length <= 128 * 1024, "diagnostic buffers grew without bound");
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); }
});
