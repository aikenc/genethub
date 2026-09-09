import type { ClientDebugAction, ClientDebugRequest, ClientDebugValue } from "@genehub/proto";
import { Client } from "../protocol/client";
import { browserHost, type Host } from "../host";
import { CLIENT_DIAGNOSTIC_EVENT, activeDiagnosticClient } from "../diagnostics";

let host: Host | undefined;
let disconnect = () => {};
/** Ends this document's grant immediately, including while the network is down. */
export function disconnectClientDebug(): void { disconnect(); }
/** A host supplies only machine discovery/dialing, never native window powers. */
export function configureClientDebugHost(value: Host): void { host = value; }

interface Grant { session: string; wall: number; monotonic: number }
const durations = [["30 分钟", 1800], ["1 小时", 3600], ["5 小时", 18000], ["1 天", 86400]] as const;

/** One runtime per document: tabs, App windows and refreshed documents never
 * inherit another document's authorization through storage or a device ID. */
export function installClientDebug(): void {
  if (!globalThis.document || document.querySelector("[data-genehub-client-debug]")) return;
  const mount = document.createElement("div");
  mount.dataset.genehubClientDebug = "";
  mount.style.cssText = "position:fixed;right:12px;top:max(12px,env(safe-area-inset-top));z-index:2147483646;font:14px system-ui;color:#eef2ff";
  const shadow = mount.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `button,select{font:inherit;padding:8px;border:1px solid #64748b;border-radius:8px;background:#1e293b;color:#eef2ff;cursor:pointer}section{background:#0f172a;border:1px solid #64748b;border-radius:12px;padding:14px;max-width:min(340px,85vw);max-height:75vh;overflow:auto;box-shadow:0 8px 30px #0007}p{line-height:1.5;overflow-wrap:anywhere}nav{display:flex;gap:8px;flex-wrap:wrap}select{max-width:100%} [hidden]{display:none!important}`;
  shadow.append(style);
  const toggle = document.createElement("button"); toggle.textContent = "联调"; toggle.setAttribute("aria-label", "客户端联调");
  const panel = document.createElement("section"); panel.hidden = true; panel.setAttribute("aria-label", "客户端联调");
  shadow.append(toggle, panel); document.body.append(mount);
  let connection: Client | null = null;
  let identity: { clientId: string; owner: string } | null = null;
  let grant: Grant | null = null;
  let pending: string | null = null;
  let pendingLabel = "";
  let generation = 0;
  let busy = false;
  let dialing = false;
  let reloading = false;
  let decisionPending = false;
  let message = "选择一台联调控制机器。调试工位电脑时，可选择服务器，避免工位重启切断联调。";
  const events: unknown[] = [];
  const record = (value: unknown) => { events.push(value); if (events.length > 100) events.shift(); };
  window.addEventListener(CLIENT_DIAGNOSTIC_EVENT, (event) => record((event as CustomEvent).detail));
  window.addEventListener("error", (event) => record({ at: Date.now(), kind: "error", message: event.message.slice(0, 2000) }));
  window.addEventListener("unhandledrejection", (event) => record({ at: Date.now(), kind: "unhandledrejection", message: String(event.reason).slice(0, 2000) }));
  const valid = (session?: string) => !!grant && (!session || session === grant.session) && Date.now() < grant.wall && performance.now() < grant.monotonic;
  async function call(request: ClientDebugRequest): Promise<ClientDebugValue> {
    if (!connection) throw new Error("联调连接尚未建立");
    const reply = await connection.call({ type: "client.debug", payload: request });
    if (reply?.type !== "client.debug") throw new Error("控制机器尚不支持客户端联调，请更新控制机器");
    return reply.data.value;
  }
  async function revoke(): Promise<void> {
    grant = null; pending = null; generation++;
    message = "授权已撤销。新请求不会执行。"; render();
    const previous = identity;
    if (previous) { try { await call({ op: "revoke", clientId: previous.clientId, key: previous.owner }); } catch { /* Local revocation is immediate even offline. */ } }
    message = "授权已撤销。新请求不会执行。"; render();
  }
  function button(label: string, action: () => void | Promise<void>): HTMLButtonElement {
    const element = document.createElement("button"); element.textContent = label;
    element.onclick = () => { void Promise.resolve().then(action).catch((error) => { message = String(error); render(); }); };
    return element;
  }
  function paragraph(text: string): void { const p = document.createElement("p"); p.textContent = text; panel.append(p); }
  function render(): void {
    panel.replaceChildren(); paragraph(message);
    if (identity) {
      paragraph(`客户端：${identity.clientId}`);
      paragraph(valid() ? `已授权至 ${new Date(grant!.wall).toLocaleTimeString()}。脚本可读取和修改当前页面及同源账户数据。` : "未授权执行远程操作。授权请求将在这里显示。");
      if (pending) {
        paragraph(`操作方请求联调：${pendingLabel}（操作方自报名称）。允许后可执行脚本、操作页面和截图。`);
        const nav = document.createElement("nav"); const session = pending;
        for (const [label, seconds] of durations) nav.append(button(label, () => authorize(session, seconds)));
        nav.append(button("拒绝", () => authorize(session, 0))); panel.append(nav);
      }
      panel.append(button("撤销授权", revoke), button("断开联调", disconnectClientDebug));
    } else {
      panel.append(button("选择控制机器", async () => {
        const selectedHost = host ?? browserHost();
        const targets = await selectedHost.targets?.() ?? [];
        if (!targets.length) throw new Error("没有可用机器，请先登录或配对机器");
        const select = document.createElement("select"); select.setAttribute("aria-label", "联调控制机器");
        for (const target of targets) { const option = document.createElement("option"); option.value = target.id; option.textContent = target.label; select.append(option); }
        panel.append(select, button("连接", async () => {
          if (connection || dialing) return;
          if (!selectedHost.openTarget) throw new Error("当前客户端不能选择控制机器");
          const id = select.value;
          const dial = () => selectedHost.openTarget!(id, { remember: false });
          const connectingGeneration = generation;
          dialing = true;
          const endpoint = await dial().finally(() => { dialing = false; });
          if (connectingGeneration !== generation) return;
          const active = new Client({ ...endpoint, redial: dial, rtcEnabled: false, maxQueuedRequests: 2, maxQueueAgeMs: 5000, requestTimeoutMs: 10000 });
          connection = active;
          active.connect();
          try {
            const url = new URL(location.href); url.search = ""; url.hash = "";
            const registered = await call({ op: "register", label: document.title.slice(0, 128) || "GeneHub", url: url.href.slice(0, 2048), userAgent: navigator.userAgent.slice(0, 1024) });
            if (!("clientId" in registered)) throw new Error("控制机器返回了无效的客户端登记");
            if (connection !== active || connectingGeneration !== generation) { active.close(); return; }
            identity = registered;
            message = `已连接控制机器：${targets.find((target) => target.id === id)?.label ?? id}`; render();
          } catch (error) { active.close(); if (connection === active) connection = null; throw error; }
        }));
      }));
    }
  }
  async function authorize(session: string, seconds: number): Promise<void> {
    if (!identity || pending !== session || decisionPending) return;
    decisionPending = true;
    const at = Date.now(); const monotonic = performance.now();
    // Consent happens at this click. A Poll reply can overtake Decide's ack.
    grant = seconds ? { session, wall: at + seconds * 1000, monotonic: monotonic + seconds * 1000 } : null;
    try { await call({ op: "decide", ...identity, session, seconds }); }
    catch (error) { if (grant?.session === session) grant = null; throw error; }
    finally { decisionPending = false; }
    if (pending !== session) return;
    pending = null; message = seconds ? "联调授权已开启，可随时撤销。刷新页面会结束授权。" : "已拒绝联调请求"; render();
  }
  async function execute(action: ClientDebugAction, session: string): Promise<unknown> {
    switch (action.kind) {
      case "inspect": {
        const active = activeDiagnosticClient();
        return { title: document.title, url: location.href, visibility: document.visibilityState, viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio }, connection: active?.connectionState, rtc: active?.rtcState, rtcFailure: active?.rtcFailure, contexts: Array.from(document.querySelectorAll("iframe")).map((frame, index) => ({ index, title: frame.title, sameOrigin: !!frame.contentDocument })) };
      }
      case "eval": return await (0, eval)(action.script);
      case "events": return events.slice();
      case "act": {
        const elements = document.querySelectorAll(action.selector);
        if (elements.length !== 1) throw new Error(`选择器匹配 ${elements.length} 个元素，需要恰好一个`);
        const element = elements[0];
        if (!(element instanceof HTMLElement)) throw new Error("目标不是可操作元素");
        if (action.value != null) {
          const proto = element instanceof HTMLInputElement ? HTMLInputElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : null;
          if (!proto) throw new Error("目标不是输入控件");
          Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, action.value);
          element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true }));
        } else element.click();
        return { ok: true };
      }
      case "screenshot": {
        const { domToDataUrl } = await import("modern-screenshot");
        if (!valid(session)) throw new Error("联调授权已失效");
        // Screenshot is a DOM reconstruction, not a claim of native screen capture.
        mount.style.visibility = "hidden";
        try { return { method: "dom", dataUrl: await domToDataUrl(document.body, { type: "image/jpeg", quality: 0.7, scale: Math.min(devicePixelRatio, 1) }), limitations: "Cross-origin frames, protected media and GPU surfaces may be omitted" }; }
        finally { mount.style.visibility = ""; }
      }
      case "reload": return { reloading: true, authorizationEnds: true };
    }
  }
  disconnect = () => {
    const active = connection;
    const previous = identity;
    grant = null; pending = null; generation++;
    connection = null; identity = null;
    message = "联调已断开"; render();
    if (active && previous) {
      void active.call({ type: "client.debug", payload: { op: "revoke", clientId: previous.clientId, key: previous.owner } })
        .catch(() => {}).finally(() => active.close());
    } else active?.close();
  };
  window.addEventListener("pagehide", () => {
    // Keep the already-completed reload result available for the operator.
    // The old document cannot execute again, and its broker lease expires.
    if (!reloading) disconnectClientDebug();
  });
  toggle.onclick = () => { panel.hidden = !panel.hidden; if (!pending) render(); };
  render();
  setInterval(() => {
    if (grant && !valid()) { void revoke(); }
    if (busy || !identity || !connection) return;
    busy = true;
    const run = generation;
    void (async () => {
      const response = await call({ op: "poll", ...identity! });
      if (!("grant" in response)) throw new Error("控制机器返回了无效的联调消息");
      if (run !== generation) return;
      if (!response.grant) { if (grant || pending) { grant = null; pending = null; message = "授权已结束"; render(); } return; }
      if (!response.grant.approved) {
        if (pending !== response.grant.session) {
          pending = response.grant.session; pendingLabel = response.grant.label; panel.hidden = false; render();
        }
        return;
      }
      // A server-side grant is never sufficient to execute a command.
      if (!valid(response.grant.session)) { await revoke(); return; }
      const command = response.command;
      if (!command) return;
      let result: unknown;
      try {
        if (!valid(response.grant.session) || run !== generation) throw new Error("联调授权已失效");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { result = { ok: true, value: await Promise.race([execute(command.action, response.grant.session), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("执行等待超过 20 秒；已开始的脚本可能仍在运行")), 20000); })]) ?? null }; }
        finally { clearTimeout(timer); }
        const encoded = JSON.stringify(result);
        if (new TextEncoder().encode(encoded).length > 1_900_000) throw new Error("结果超过 1.9 MB，请缩小采集范围");
        result = JSON.parse(encoded);
      } catch (error) { result = { ok: false, error: String(error).slice(0, 2000) }; }
      if (!valid(response.grant.session) || run !== generation) return;
      await call({ op: "complete", ...identity!, commandId: command.commandId, result: result as any });
      if (command.action.kind === "reload") { grant = null; reloading = true; connection?.close(); location.reload(); }
    })().catch((error) => { message = `联调连接：${String(error)}`; if (!pending) render(); }).finally(() => { busy = false; });
  }, 1000);
}
