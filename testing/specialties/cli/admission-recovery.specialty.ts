import { createServer, request } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineSpecialty, parseJson, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.cli.admission-recovery",
  title: "An expired CLI admission recovers without replaying identity failures or unknown mutations",
  oracle: "A real delayed POST is refused before workspace registration then succeeds once with a fresh admission; invalid Session identity is not retried, and dropping a successful mutation reply leaves one attempt and an honest error",
  catches: ["scheduling delay strands a valid local user", "invalid Session identity falls back to local user", "a lost successful reply causes mutation replay", "expired admission is accepted"],
  tags: ["core", "cli", "daemon-control", "authorization-depth"], llm: { default: "none" },
  expectedDurationMs: 25_000, timeoutMs: 90_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["genet-cli", "daemon", "loopback-http"],
  productInterfaces: ["genet-cli", "@genehub/workbench/client"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const endpoint = path.join(t.env.data, "endpoint.json");
  const original = await readFile(endpoint);
  const facts = JSON.parse(original.toString("utf8"));
  const target = path.join(t.env.workspace, "delayed-open");
  const lost = path.join(t.env.workspace, "lost-reply-open");
  const denied = path.join(t.env.workspace, "identity-denied-open");
  await mkdir(target); await mkdir(lost); await mkdir(denied);
  let calls = 0, delayFirst = true, dropReply = false;
  let actualAdmissionRefusal = false, absentBeforeRetry = false;
  const errors: string[] = [];
  const workspaces = async () => {
    const reply = await opened.client.call({ type: "workspace.list" });
    if (reply?.type !== "workspaces") throw new Error("workspace list absent");
    return reply.data;
  };
  // This external transport fault does not mint proofs or fabricate replies.
  // The original private endpoint and all request credentials stay in memory.
  const proxy = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    // Native error reporting may make separate context/health queries. Count
    // the requested business command, not those read-only diagnostics.
    const argv = incoming.method === "POST" && incoming.url?.startsWith("/cli?")
      ? JSON.parse(body.toString("utf8")).argv : [];
    const business = argv?.length === 3 && argv[0] === "workspace" && argv[1] === "open"
      && [target, denied, lost].includes(argv[2]);
    if (business) calls++;
    const delayed = business && delayFirst;
    if (delayed) delayFirst = false;
    const dropping = business && dropReply;
    if (dropping) dropReply = false;
    if (delayed) await new Promise(resolve => setTimeout(resolve, 18_000));
    const upstream = request({ hostname: "127.0.0.1", port: facts.port,
      method: incoming.method, path: incoming.url, headers: incoming.headers }, response => {
      if (dropping) {
        response.resume();
        response.once("end", () => outgoing.destroy());
        return;
      }
      if (delayed) {
        let text = "";
        response.on("data", chunk => { text = (text + chunk.toString()).slice(0, 128); });
        response.once("end", () => { void (async () => {
          actualAdmissionRefusal = response.statusCode === 401 && text === "invalid cli proof";
          absentBeforeRetry = !(await workspaces()).some(w => w.root === target);
          outgoing.writeHead(response.statusCode!, response.headers); outgoing.end(text);
        })().catch(error => { errors.push(String(error)); outgoing.destroy(); }); });
      } else {
        outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing);
      }
    });
    upstream.on("error", error => { errors.push(error.message); outgoing.destroy(); });
    upstream.end(body);
  });
  try {
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("proxy port absent");
    await writeFile(endpoint, JSON.stringify({ ...facts, port: address.port }));
    const command = (args: string[], env = opened.daemon.env) => runGenetAsync(opened.daemon.genet, args, env);
    const recovered = await command(["workspace", "open", target]);
    t.assertions.assert(actualAdmissionRefusal && absentBeforeRetry, "expired proof reached the workspace handler or was not genuinely refused");
    t.assertions.assert(recovered.code === 0 && calls === 2, `expired admission did not recover once: code=${recovered.code} calls=${calls}; ${recovered.stderr.slice(-400)}`);
    t.assertions.assert((parseJson(recovered.stdout).data as any)?.workspace?.root === target, "CLI registered a different workspace");
    const beforeIdentity = calls;
    const refused = await command(["workspace", "open", denied], { ...opened.daemon.env,
      GENEHUB_SESSION_ID: "s_missing", GENEHUB_CONTROLLER_TOKEN: "invalid" });
    t.assertions.assert(refused.code !== 0 && calls === beforeIdentity + 1,
      "invalid Session identity was retried or dropped to impersonate LocalUser");
    t.assertions.assert(!(await workspaces()).some(w => w.root === denied), "invalid Session identity registered a workspace");
    dropReply = true;
    const beforeLost = calls;
    const unknown = await command(["workspace", "open", lost]);
    t.assertions.assert(unknown.code !== 0 && calls === beforeLost + 1, "an unacknowledged mutation was automatically replayed");
    t.assertions.assert((await workspaces()).some(w => w.root === lost), "lost reply fault did not follow a real successful mutation");
    t.assertions.assert(errors.length === 0, `transport fixture failed: ${errors.join("; ")}`);
    t.note("Real expired admission refused before mutation; one fresh proof recovered. Invalid Session identity and a lost successful mutation reply each remained one attempt.");
  } finally {
    await writeFile(endpoint, original);
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});
