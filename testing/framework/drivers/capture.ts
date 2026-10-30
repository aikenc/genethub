import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ServicePreviewClient } from "@genehub/workbench/client";
import type { CaseContext } from "../context.ts";
import { BlockedError } from "../../infrastructure/public.ts";

/** Real independent app and public Preview consumer, with lease-owned OS data. */
export async function openCapturePreview(t: CaseContext) {
  const binary = process.env.GENEHUB_CAPTURE_BINARY;
  if (!binary) throw new BlockedError("packaged Capture binary required");
  const opened = await t.flows.main.openWorkspace({openRoot: t.openRoot, lease: t.env});
  const entry = join(t.env.workspace, "remote/index.html");
  const children = new Map<ChildProcess, Promise<unknown>>();
  const services: ServicePreviewClient[] = [];
  const launch = (otherEntry = entry) => {
    const child = spawn(binary, ["--headless", "--entry", otherEntry, "--daemon-root", t.env.data], {
      // Capture's per-account locks must never use the test runner's real home.
      env: {...process.env, ...t.env.env, LOCALAPPDATA: join(t.env.home, "AppData/Local")},
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit"); children.set(child, exited);
    let output = "";
    child.stdout!.on("data", b => {output = (output + b).slice(-4096);});
    child.stderr!.on("data", b => {output = (output + b).slice(-4096);});
    return {child, exited, output: () => output};
  };
  const close = async () => {
    for (const service of services) service.close();
    try {
      for (const [child, exited] of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([exited, new Promise<never>((_, reject) => {
            timer = setTimeout(() => {child.kill("SIGKILL"); reject(new Error("Capture shutdown exceeded 8 seconds"));}, 8000);
          })]);
        } finally {clearTimeout(timer);}
      }
    } finally {opened.client.close(); opened.daemon.stop(); await opened.mock.stop();}
  };
  try {
    await cp(join(t.env.data, "builtin-skills/genehub-preview/assets/remote-desktop"), join(t.env.workspace, "remote"), {recursive: true});
    // Windows known-folder resolution validates the expanded profile path.
    // An isolated LOCALAPPDATA must exist before the real app asks for it.
    await mkdir(join(t.env.home, "AppData/Local"), {recursive: true});
    const source = launch();
    let service: ServicePreviewClient | null = null;
    const discover = () => ServicePreviewClient.discover(opened.client, opened.workspaceId, `${opened.rootHandle}/remote/index.html`);
    await t.tools.waitUntil(async () => {
      if (source.child.exitCode !== null) throw new Error(`Capture exited before ready: ${source.output()}`);
      service = await discover(); return service !== null;
    }, 15000);
    services.push(service!);
    return {opened, entry, source, service: service!, discover, launch, close};
  } catch (error) {await close(); throw error;}
}

/** Application protocol over the exact public HTTP/WS bridge used by H5. */
export async function captureSocket(service: ServicePreviewClient, path = "/api/remote/session") {
  const messages: Record<string, any>[] = [];
  let closed = false;
  const socket = await service.websocket(path, async packet => {
    if (packet[0] !== 0) return;
    const outer = JSON.parse(new TextDecoder().decode(packet.subarray(1)));
    if (outer.kind === "close") closed = true;
    if (outer.kind === "text") {
      messages.push(JSON.parse(outer.text));
      if (messages.length > 256) throw new Error("unexpected Capture response flood");
    }
  });
  return {messages, closed: () => closed, send: (value: unknown) => socket.send({kind: "text", text: JSON.stringify(value)}), close: () => socket.close()};
}
