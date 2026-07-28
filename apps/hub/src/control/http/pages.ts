import { Hono, type Context } from "hono";
import { html, raw } from "hono/html";

import { writeAudit } from "../audit.js";
import type { HubDatabase } from "../db.js";
import {
  approveDeviceAuthorization,
  createDeviceSession,
  createRecoveryKey,
  createTempUser,
  createTransferLink,
  denyDeviceAuthorization,
  createChannelTicket,
  findMachine,
  expireStaleDeviceAuthorizations,
  isMachineOnline,
  findDeviceAuthorizationByUserCode,
  listMachines,
  type DeviceSessionRow,
} from "../store.js";
import { isExpired, publicKeyFingerprint } from "../../shared/tokens.js";
import { CLIENT_PATH } from "../../contract/index.js";
import { consumeTransferLink } from "./app-api.js";
import { attachSessionCookie, clientIp, currentSession, userAgent } from "./session.js";

const STYLE = `
:root { color-scheme: light dark; --fg: #14161a; --muted: #6b7280; --bg: #fbfbfd; --card: #fff; --line: #e5e7eb; --accent: #2f6df6; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8eaed; --muted: #9aa0a6; --bg: #101216; --card: #181b20; --line: #2a2f36; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 48px 20px; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 560px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.01em; }
p.sub { color: var(--muted); margin: 0 0 28px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 22px; margin-bottom: 16px; }
.code { font: 600 26px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 3px; text-align: center; padding: 14px 0; }
.row { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; border-bottom: 1px solid var(--line); }
.row:last-child { border-bottom: 0; }
.row span:first-child { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all; }
button, .btn { font: inherit; border-radius: 10px; padding: 10px 18px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; text-decoration: none; display: inline-block; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.actions { display: flex; gap: 10px; margin-top: 18px; }
.notice { border-left: 3px solid var(--accent); padding: 10px 14px; background: var(--card); border-radius: 0 10px 10px 0; color: var(--muted); }
.warn { border-left-color: #d9822b; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.on { background: #21a366; } .off { background: #9aa0a6; }
input[type=text] { font: inherit; width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
`;

function layout(title: string, body: ReturnType<typeof html>) {
  return html`<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · GeneHub</title>
        <style>
          ${raw(STYLE)}
        </style>
      </head>
      <body>
        <main>${body}</main>
      </body>
    </html>`;
}

/** Signs the browser in as a temporary user so the journey never starts with a form. */
function ensureSession(c: Context, db: HubDatabase): DeviceSessionRow {
  const existing = currentSession(c, db);
  if (existing) return existing;

  const user = createTempUser(db, "临时用户");
  const session = createDeviceSession(db, {
    userId: user.id,
    name: "浏览器",
    ip: clientIp(c),
    userAgent: userAgent(c),
  });
  createRecoveryKey(db, user.id);
  writeAudit(db, {
    action: "user.temp.created",
    actorUserId: user.id,
    actorDeviceId: session.row.id,
    ip: clientIp(c),
    userAgent: userAgent(c),
    detail: { via: "browser" },
  });
  attachSessionCookie(c, session.token);
  return session.row;
}

export function pageRoutes(db: HubDatabase, workbenchUrl: string): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const session = currentSession(c, db);
    if (!session) {
      return c.html(
        layout(
          "GeneHub",
          html`<h1>GeneHub</h1>
            <p class="sub">在自己的电脑上跑 agent，手机随手遥控。</p>
            <div class="card">
              <p>还没有登录。装好桌面端后点「登录并绑定这台电脑」，浏览器会自动打开确认页。</p>
              <form method="post" action="/activate/start">
                <div class="actions"><button class="primary" type="submit">先体验（创建临时身份）</button></div>
              </form>
            </div>
            <div class="card">
              <p style="margin-top:0">已经有配对码？</p>
              <form method="get" action="/activate">
                <input type="text" name="code" placeholder="XXXX-XXXX" />
                <div class="actions"><button type="submit">继续</button></div>
              </form>
            </div>`,
        ),
      );
    }

    const machines = listMachines(db, session.user_id);
    return c.html(
      layout(
        "我的机器",
        html`<h1>我的机器</h1>
          <p class="sub">身份 ${session.user_id} · 当前设备 ${session.name}</p>
          ${machines.length === 0
            ? html`<div class="card">
                <p style="margin:0">还没有绑定任何电脑。在桌面端点「登录并绑定这台电脑」，然后回到这里。</p>
              </div>`
            : html`${machines.map(
                (m) => html`<div class="card">
                  <div class="row">
                    <span>名称</span>
                    <b>${m.name}</b>
                  </div>
                  <div class="row">
                    <span>状态</span>
                    <span
                      ><i class="dot ${isMachineOnline(m) ? "on" : "off"}"></i
                      >${isMachineOnline(m) ? "在线" : "离线"}</span
                    >
                  </div>
                  <div class="row"><span>公钥指纹</span><span class="mono">${publicKeyFingerprint(m.public_key)}</span></div>
                  <form method="post" action="/machines/${m.id}/open">
                    <div class="actions"><button class="primary" type="submit">连接</button></div>
                  </form>
                </div>`,
              )}`}
          <div class="card">
            <form method="post" action="/links/new">
              <p style="margin-top:0">换一台设备继续？生成一个 15 分钟内一次性有效的链接。</p>
              <div class="actions"><button type="submit">生成链接</button></div>
            </form>
          </div>`,
      ),
    );
  });

  app.post("/activate/start", (c) => {
    ensureSession(c, db);
    return c.redirect("/", 303);
  });

  app.get("/activate", (c) => {
    const session = ensureSession(c, db);
    const code = c.req.query("code")?.trim().toUpperCase();
    if (!code) {
      return c.html(
        layout(
          "绑定电脑",
          html`<h1>绑定这台电脑</h1>
            <p class="sub">输入桌面端显示的配对码。</p>
            <div class="card">
              <form method="get" action="/activate">
                <input type="text" name="code" placeholder="XXXX-XXXX" />
                <div class="actions"><button class="primary" type="submit">继续</button></div>
              </form>
            </div>`,
        ),
      );
    }

    expireStaleDeviceAuthorizations(db);
    const authorization = findDeviceAuthorizationByUserCode(db, code);
    if (!authorization || authorization.status === "denied") {
      return c.html(layout("绑定电脑", html`<h1>配对码无效</h1><p class="sub">请回到桌面端重新发起绑定。</p>`), 404);
    }
    if (authorization.status === "expired" || isExpired(authorization.expires_at)) {
      return c.html(layout("绑定电脑", html`<h1>配对码已过期</h1><p class="sub">请回到桌面端重新发起绑定。</p>`), 410);
    }
    if (authorization.status !== "pending") {
      return c.html(
        layout("绑定电脑", html`<h1>这台电脑已经绑定</h1><p class="sub">可以回到「我的机器」查看。</p>`),
      );
    }

    return c.html(
      layout(
        "确认绑定",
        html`<h1>把这台电脑加入你的账号？</h1>
          <p class="sub">确认后，这台电脑上的 agent 就能被你的账号远程使用。</p>
          <div class="card">
            <div class="code">${authorization.user_code}</div>
            <div class="row"><span>电脑名称</span><b>${authorization.display_name}</b></div>
            <div class="row"><span>当前身份</span><span class="mono">${session.user_id}</span></div>
          </div>
          <div class="card notice warn">
            只有你自己发起的绑定才应该确认。如果这串码不是你桌面端显示的，请点「拒绝」。
          </div>
          <form method="post" action="/activate">
            <input type="hidden" name="code" value="${authorization.user_code}" />
            <div class="actions">
              <button class="primary" name="action" value="approve" type="submit">确认绑定</button>
              <button name="action" value="deny" type="submit">拒绝</button>
            </div>
          </form>`,
      ),
    );
  });

  app.post("/activate", async (c) => {
    const session = ensureSession(c, db);
    const form = await c.req.parseBody();
    const code = String(form.code ?? "").trim().toUpperCase();
    const action = String(form.action ?? "");

    expireStaleDeviceAuthorizations(db);
    const authorization = findDeviceAuthorizationByUserCode(db, code);
    if (!authorization || authorization.status !== "pending" || isExpired(authorization.expires_at)) {
      return c.html(layout("绑定电脑", html`<h1>配对码已失效</h1><p class="sub">请回到桌面端重新发起。</p>`), 410);
    }

    if (action === "deny") {
      denyDeviceAuthorization(db, authorization.id);
      writeAudit(db, {
        action: "device_authorization.denied",
        actorUserId: session.user_id,
        actorDeviceId: session.id,
        targetType: "device_authorization",
        targetId: authorization.id,
        ip: clientIp(c),
      });
      return c.html(layout("已拒绝", html`<h1>已拒绝</h1><p class="sub">这台电脑不会被加入你的账号。</p>`));
    }

    approveDeviceAuthorization(db, authorization.id, session.user_id, session.id);
    writeAudit(db, {
      action: "device_authorization.approved",
      actorUserId: session.user_id,
      actorDeviceId: session.id,
      targetType: "device_authorization",
      targetId: authorization.id,
      ip: clientIp(c),
      userAgent: userAgent(c),
      detail: { displayName: authorization.display_name },
    });

    return c.html(
      layout(
        "绑定成功",
        html`<h1>绑定成功</h1>
          <p class="sub">回到桌面端，它会在几秒内显示「已连接」。</p>
          <div class="card"><div class="row"><span>电脑名称</span><b>${authorization.display_name}</b></div></div>
          <div class="actions"><a class="btn" href="/">查看我的机器</a></div>`,
      ),
    );
  });

  app.post("/machines/:id/open", (c) => {
    const session = currentSession(c, db);
    if (!session) return c.redirect("/", 303);

    const machine = findMachine(db, c.req.param("id"));
    if (!machine || machine.owner_user_id !== session.user_id || machine.state !== "active") {
      return c.html(layout("连接", html`<h1>机器不存在</h1>`), 404);
    }
    if (!isMachineOnline(machine)) {
      return c.html(
        layout(
          "连接",
          html`<h1>${machine.name} 当前离线</h1>
            <p class="sub">这台电脑没有连到中转，可能是关机了或者桌面端没在跑。</p>
            <div class="actions"><a class="btn" href="/">返回</a></div>`,
        ),
        409,
      );
    }

    const ticket = createChannelTicket(db, { machineId: machine.id, deviceSessionId: session.id });
    writeAudit(db, {
      action: "channel.ticket_issued",
      actorUserId: session.user_id,
      actorDeviceId: session.id,
      targetType: "machine",
      targetId: machine.id,
      ip: clientIp(c),
      userAgent: userAgent(c),
    });

    const socket = new URL(c.req.url);
    socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
    socket.pathname = CLIENT_PATH;
    socket.search = "";
    socket.searchParams.set("ticket", ticket.token);

    const workbench = new URL(workbenchUrl);
    workbench.hash = `endpoint=${encodeURIComponent(socket.toString())}`;

    return c.html(
      layout(
        "连接",
        html`<h1>连接 ${machine.name}</h1>
          <p class="sub">工作台会通过中转连到这台电脑。中转只搬运字节，不解读内容。</p>
          <div class="card">
            <div class="row"><span>公钥指纹</span><span class="mono">${publicKeyFingerprint(machine.public_key)}</span></div>
            <div class="row"><span>状态</span><span><i class="dot on"></i>在线</span></div>
          </div>
          <div class="card notice warn">
            请核对指纹与桌面端显示的一致。指纹变化意味着你换过密钥，或者中间有人。
          </div>
          <div class="actions">
            <a class="btn primary" href="${workbench.toString()}">打开工作台</a>
            <a class="btn" href="/">返回</a>
          </div>`,
      ),
    );
  });

  app.get("/link/:token", (c) => {
    const result = consumeTransferLink(db, c, c.req.param("token"));
    if (!result.ok) {
      return c.html(
        layout("链接不可用", html`<h1>${result.reason}</h1><p class="sub">请回到原设备重新生成一个链接。</p>`),
        410,
      );
    }
    attachSessionCookie(c, result.token);
    return c.redirect("/", 303);
  });

  app.post("/links/new", (c) => {
    const session = currentSession(c, db);
    if (!session) return c.redirect("/", 303);

    const link = createTransferLink(db, { userId: session.user_id, createdByDeviceId: session.id });
    writeAudit(db, {
      action: "transfer_link.created",
      actorUserId: session.user_id,
      actorDeviceId: session.id,
      targetType: "transfer_link",
      targetId: link.row.id,
    });

    const url = new URL(c.req.url);
    url.pathname = `/link/${link.token}`;
    url.search = "";
    return c.html(
      layout(
        "换设备继续",
        html`<h1>在另一台设备上打开</h1>
          <p class="sub">15 分钟内有效，只能用一次。用完后原设备能看到它被谁用了。</p>
          <div class="card"><div class="mono">${url.toString()}</div></div>
          <div class="card notice warn">
            这条链接会让打开它的浏览器进入你的身份。不要发到群里，用完即失效。
          </div>
          <div class="actions"><a class="btn" href="/">返回</a></div>`,
      ),
    );
  });

  return app;
}
