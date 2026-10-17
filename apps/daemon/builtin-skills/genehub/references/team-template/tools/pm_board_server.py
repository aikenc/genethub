#!/usr/bin/env python3
"""Permanent Live Team Board Service & Data Aggregator for GeneHub 1+N Expert Teams.

Provides:
1. `<team-root>/datas/board/index.html`: Permanent interactive H5 Team Board entry.
2. `<team-root>/datas/board/live.json`: Real-time aggregated team state (1+N spaces, sessions,
   worktree git status, milestones, human guidance, playable releases, QA reports/screenshots,
   and 2-tier reflection memory).
3. Background Service Preview v1 daemon (`<daemon-root>/service-previews/<sha256(entry)>.json`)
   speaking RFC 6455 binary WebSocket frames with HMAC-SHA256 mutual authentication (stdlib only).
"""

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import signal
import struct
import subprocess
import sys
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

BOARD_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>实时团队作战看板 · GeneHub Expert Team</title>
<style>
  :root {
    --bg: #0b0f17;
    --panel: #131a26;
    --panel-alt: #182132;
    --border: #26334d;
    --text: #e6edf3;
    --muted: #8b9bb4;
    --accent: #38bdf8;
    --accent-soft: rgba(56, 189, 248, 0.14);
    --ok: #22c55e;
    --ok-soft: rgba(34, 197, 94, 0.14);
    --warn: #f59e0b;
    --warn-soft: rgba(245, 158, 11, 0.15);
    --purple: #a855f7;
    --purple-soft: rgba(168, 85, 247, 0.15);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: radial-gradient(circle at 15% 0%, #162238 0%, var(--bg) 55%);
    color: var(--text);
    line-height: 1.55;
    min-height: 100vh;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 1240px; margin: 0 auto; padding: 20px 24px 48px; }
  .topbar {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
    gap: 14px; padding: 18px 22px; background: rgba(19, 26, 38, 0.9);
    border: 1px solid var(--border); border-radius: 14px; backdrop-filter: blur(10px);
    position: sticky; top: 12px; z-index: 20; box-shadow: 0 10px 30px rgba(0,0,0,0.35);
  }
  .brand { display: flex; align-items: center; gap: 14px; }
  .brand-icon {
    width: 44px; height: 44px; border-radius: 12px;
    background: linear-gradient(135deg, #0ea5e9, #6366f1);
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; box-shadow: 0 4px 14px rgba(14, 165, 233, 0.35);
  }
  .brand h1 { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: 0.2px; }
  .brand p { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }
  .top-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 11px; border-radius: 999px; font-size: 12px; font-weight: 600;
    border: 1px solid var(--border); background: var(--panel-alt); color: var(--text);
  }
  .pill.live { background: var(--ok-soft); border-color: rgba(34, 197, 94, 0.4); color: #4ade80; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); display: inline-block; }
  .dot.pulse { animation: pulse 1.6s infinite; }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
    70% { box-shadow: 0 0 0 7px rgba(34, 197, 94, 0); }
    100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
  }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 14px; border-radius: 9px; font-size: 13px; font-weight: 600;
    border: 1px solid var(--border); background: var(--panel-alt); color: var(--text);
    cursor: pointer; transition: all 0.15s ease; text-decoration: none !important;
  }
  .btn:hover { border-color: var(--accent); background: rgba(56, 189, 248, 0.12); }
  .btn.primary {
    background: linear-gradient(135deg, #0284c7, #2563eb);
    border-color: #38bdf8; color: #fff;
  }
  .btn.primary:hover { filter: brightness(1.1); }
  .tabs {
    display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0;
    border-bottom: 1px solid var(--border); padding-bottom: 12px;
  }
  .tab {
    padding: 8px 16px; border-radius: 9px; font-size: 13.5px; font-weight: 600;
    background: transparent; color: var(--muted); border: 1px solid transparent; cursor: pointer;
  }
  .tab:hover { color: var(--text); background: var(--panel); }
  .tab.active {
    color: var(--accent); background: var(--accent-soft);
    border-color: rgba(56, 189, 248, 0.35);
  }
  .kpis {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 14px; margin-bottom: 20px;
  }
  .kpi {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 12px; padding: 15px 18px;
  }
  .kpi .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .kpi .val { font-size: 26px; font-weight: 700; margin: 4px 0 2px; color: var(--text); }
  .kpi .sub { font-size: 12px; color: var(--muted); }
  .section { display: none; }
  .section.active { display: block; }
  .card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 13px; padding: 18px 20px; margin-bottom: 16px;
  }
  .card h2 {
    margin: 0 0 12px; font-size: 16px; font-weight: 700;
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 11px 10px; border-bottom: 1px solid rgba(38, 51, 77, 0.65); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; background: rgba(24, 33, 50, 0.5); }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11.5px; font-weight: 600;
  }
  .badge.running { background: var(--ok-soft); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.35); }
  .badge.idle { background: rgba(139, 155, 180, 0.14); color: #cbd5e1; border: 1px solid rgba(139, 155, 180, 0.25); }
  .badge.standby { background: var(--warn-soft); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
  .badge.effort { background: var(--purple-soft); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  .pre-box {
    background: #0d131f; border: 1px solid var(--border); border-radius: 10px;
    padding: 14px 16px; white-space: pre-wrap; word-break: break-word;
    font-size: 13px; max-height: 440px; overflow-y: auto; color: #dbeafe;
  }
  .item-list { display: flex; flex-direction: column; gap: 10px; }
  .item-row {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
    gap: 10px; padding: 12px 14px; background: var(--panel-alt);
    border: 1px solid var(--border); border-radius: 10px;
  }
  .gallery {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; margin-top: 12px;
  }
  .shot {
    background: #0d131f; border: 1px solid var(--border); border-radius: 10px; overflow: hidden;
  }
  .shot img { width: 100%; height: 165px; object-fit: cover; display: block; }
  .shot .cap { padding: 8px 12px; font-size: 12px; color: var(--muted); }
  .muted { color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <div class="brand">
      <div class="brand-icon">📊</div>
      <div>
        <h1 id="team-title">项目团队实时作战看板</h1>
        <p id="team-desc">常驻团队看板服务 · 自动聚合 1+N 空间、工位、里程碑、可玩版本与 QA 报告</p>
      </div>
    </div>
    <div class="top-actions">
      <span class="pill live" id="service-pill"><span class="dot pulse"></span><span id="service-text">看板服务实时同步中</span></span>
      <span class="pill mono" id="updated-at">--:--:--</span>
      <button class="btn" type="button" onclick="refreshBoard(true)">🔄 立即刷新</button>
      <a class="btn primary" id="latest-play-btn" href="../releases/index.html">🎮 试玩最新版本</a>
    </div>
  </div>

  <div class="tabs">
    <button class="tab active" data-tab="overview" onclick="switchTab('overview')">📊 1+N 团队与工位总览</button>
    <button class="tab" data-tab="milestones" onclick="switchTab('milestones')">🎯 里程碑与版本可达性评估</button>
    <button class="tab" data-tab="artifacts" onclick="switchTab('artifacts')">🎮 可玩版本 & 🧪 QA/研究报告</button>
    <button class="tab" data-tab="memory" onclick="switchTab('memory')">💬 老板指令追踪 & 🧠 二级记忆</button>
  </div>

  <div class="kpis">
    <div class="kpi">
      <div class="label">1+N 团队编制 / 在岗工位</div>
      <div class="val" id="kpi-members">-</div>
      <div class="sub" id="kpi-members-sub">加载中...</div>
    </div>
    <div class="kpi">
      <div class="label">活跃会话 / 总会话数</div>
      <div class="val" id="kpi-sessions">-</div>
      <div class="sub" id="kpi-sessions-sub">含主入口、组长与管线组员</div>
    </div>
    <div class="kpi">
      <div class="label">已发布可玩版本 (Releases)</div>
      <div class="val" id="kpi-releases">-</div>
      <div class="sub" id="kpi-releases-sub">持久归档于 datas/releases/</div>
    </div>
    <div class="kpi">
      <div class="label">QA 验收 / 数值报告 / 经验条数</div>
      <div class="val" id="kpi-reports">-</div>
      <div class="sub" id="kpi-reports-sub">持久归档于 datas/reports/</div>
    </div>
  </div>

  <!-- TAB 1: OVERVIEW -->
  <div class="section active" id="tab-overview">
    <div class="card">
      <h2>
        <span>🧭 1+N 团队成员、Git Worktree 工位与实时会话状态</span>
        <span class="muted" style="font-size:12px;font-weight:400">每 3 秒自动同步 · 无需打断后台开发</span>
      </h2>
      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>岗位角色</th>
              <th>编制 / 状态</th>
              <th>Git 工位 & 最新提交</th>
              <th>模型 & 思考挡位</th>
              <th>当前主会话 & 最新进展摘要</th>
            </tr>
          </thead>
          <tbody id="members-tbody">
            <tr><td colspan="5" class="muted">正在加载实时团队数据...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <h2><span>🚀 最新可玩版本入口</span><a href="../releases/index.html" style="font-size:12.5px">查看全部 &rarr;</a></h2>
        <div class="item-list" id="overview-releases"></div>
      </div>
      <div class="card">
        <h2><span>🧪 最新 QA 验收与研究报告</span><span class="muted" style="font-size:12px">点击直接打开</span></h2>
        <div class="item-list" id="overview-reports"></div>
      </div>
    </div>
  </div>

  <!-- TAB 2: MILESTONES -->
  <div class="section" id="tab-milestones">
    <div class="card">
      <h2><span>🎯 团队里程碑规划与版本内容可达性评估（.pm/trunk/）</span></h2>
      <div id="milestones-list" class="item-list"></div>
    </div>
  </div>

  <!-- TAB 3: ARTIFACTS -->
  <div class="section" id="tab-artifacts">
    <div class="grid-2">
      <div class="card">
        <h2><span>🎮 已发布可玩版本列表（datas/releases/）</span></h2>
        <div id="full-releases" class="item-list"></div>
      </div>
      <div class="card">
        <h2><span>📑 已发布报告列表（datas/reports/）</span></h2>
        <div id="full-reports" class="item-list"></div>
      </div>
    </div>
    <div class="card">
      <h2><span>📸 QA 无头浏览器实操取证画廊</span></h2>
      <div id="screenshots-gallery" class="gallery"></div>
    </div>
  </div>

  <!-- TAB 4: GUIDANCE & MEMORY -->
  <div class="section" id="tab-memory">
    <div class="grid-2">
      <div class="card">
        <h2><span>💬 用户自然语言诉求与团队响应记录（.pm/guidance/human/）</span></h2>
        <div id="guidance-list" class="item-list"></div>
      </div>
      <div class="card">
        <h2><span>🧠 二级反思记忆库（全局 memory.md + 各岗位 index.md）</span></h2>
        <div id="memory-list" class="item-list"></div>
      </div>
    </div>
  </div>
</div>

<script>
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function switchTab(id) {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === id);
  });
  document.querySelectorAll(".section").forEach(sec => {
    sec.classList.toggle("active", sec.id === "tab-" + id);
  });
}

function renderBoard(data) {
  if (!data) return;
  document.getElementById("team-title").textContent = (data.teamName || "项目团队") + " · 实时团队作战看板";
  document.getElementById("team-desc").textContent = data.description || "常驻团队看板服务 · 实时监控 1+N 成员、工位、里程碑与版本交付";
  document.getElementById("updated-at").textContent = "更新于 " + (data.updatedAt || "--:--:--");

  const svc = data.service || {};
  const svcText = document.getElementById("service-text");
  if (svc.running) {
    svcText.textContent = "看板常驻服务在线 (PID " + svc.pid + ")";
  } else {
    svcText.textContent = "看板实时快照就绪 (3s 自动同步)";
  }

  const releases = data.releases || [];
  const reports = data.reports || [];
  const members = data.members || [];
  const milestones = data.milestones || [];
  const guidance = data.guidance || [];
  const memory = data.memory || {};

  if (releases.length > 0) {
    document.getElementById("latest-play-btn").setAttribute("href", releases[0].href);
    document.getElementById("latest-play-btn").textContent = "🎮 立即试玩 " + releases[0].version;
  }

  const onDuty = members.filter(m => m.onDuty).length;
  const runningCount = members.filter(m => m.activeSession && (m.activeSession.status === "running" || m.activeSession.status === "waiting")).length;
  const totalSessions = members.reduce((acc, m) => acc + (m.sessionCount || 0), 0);

  document.getElementById("kpi-members").textContent = onDuty + " / " + members.length + " 在岗";
  document.getElementById("kpi-members-sub").textContent = (members.length - onDuty) > 0
    ? (members.length - onDuty) + " 个预置角色待岗（按需激活）"
    : "全员已配置独立职责";

  document.getElementById("kpi-sessions").textContent = runningCount + " 运行中 / " + totalSessions + " 总计";
  document.getElementById("kpi-sessions-sub").textContent = runningCount > 0 ? "后台管线正在并发工作" : "当前全员空闲待命";

  document.getElementById("kpi-releases").textContent = String(releases.length) + " 个版本";
  document.getElementById("kpi-releases-sub").textContent = releases.length > 0 ? "最新: " + releases[0].version : "等待首个版本发布";

  const expCount = (memory.roles || []).reduce((acc, r) => acc + (r.entries || []).length, 0);
  document.getElementById("kpi-reports").textContent = reports.length + " 份报告 / " + expCount + " 条经验";
  document.getElementById("kpi-reports-sub").textContent = "含 QA 实操截图与数值仿真验证";

  // Members table
  const tbody = document.getElementById("members-tbody");
  tbody.innerHTML = members.map(m => {
    const sess = m.activeSession;
    let statusBadge = '<span class="badge standby">待岗 (未绑工位)</span>';
    if (m.onDuty || sess) {
      const st = sess ? sess.status : "idle";
      if (st === "running" || st === "waiting") {
        statusBadge = '<span class="badge running">● ' + esc(st) + '</span>';
      } else {
        statusBadge = '<span class="badge idle">● ' + esc(st) + '</span>';
      }
    }
    const gitInfo = m.git && m.git.branch
      ? '<div class="mono" style="color:#38bdf8">' + esc(m.git.branch) + ' @ ' + esc(m.git.headSha || "-") + '</div>' +
        '<div class="muted" style="font-size:11.5px">' + esc(m.git.headSubject || "") + (m.git.dirtyCount ? ' <span style="color:#f59e0b">(+' + m.git.dirtyCount + ' 修改)</span>' : '') + '</div>'
      : '<span class="muted">' + esc(m.worktreeLabel || "无代码工位") + '</span>';

    // 拿不到真实模型就显式标未知，绝不伪装成 "auto (Max/Pro)"。
    const knownModel = !!(sess && sess.modelId);
    const modelStr = knownModel ? sess.modelId : (sess ? "未知（会话未上报模型）" : "未运行（无会话）");
    const effortStr = (sess && sess.effortId) || m.effort || "high";
    const modelCell = '<div class="mono"' + (knownModel ? '' : ' style="color:#f59e0b"') + '>' + esc(modelStr) + '</div>' +
      '<span class="badge effort">effort: ' + esc(effortStr) + '</span>';

    // 会话 title 创建后改不了，description 可以随时改，所以以 description 为准显示"现在在做什么"。
    const sessCell = sess
      ? '<div><strong>' + esc((sess.description || sess.title || sess.id).slice(0, 100)) + '</strong> <span class="mono muted">(' + esc(sess.id) + ')</span></div>' +
        '<div class="muted" style="font-size:12px;margin-top:3px">' + esc((sess.preview || "").slice(0, 140)) + '</div>'
      : '<span class="muted">暂无会话</span>';

    return '<tr>' +
      '<td><div style="font-weight:700;color:#f8fafc">' + esc(m.displayRole) + '</div><div class="muted" style="font-size:11.5px">' + esc(m.roleDesc || "") + '</div></td>' +
      '<td>' + statusBadge + '<div class="muted" style="font-size:11px;margin-top:4px">会话数: ' + (m.sessionCount || 0) + '</div></td>' +
      '<td>' + gitInfo + '</td>' +
      '<td>' + modelCell + '</td>' +
      '<td>' + sessCell + '</td>' +
    '</tr>';
  }).join("");

  // Releases
  const relHtml = releases.length ? releases.map(r => (
    '<div class="item-row">' +
      '<div><strong>🎮 ' + esc(r.version) + '</strong><div class="muted" style="font-size:12px">发布时间: ' + esc(r.time) + '</div></div>' +
      '<a class="btn primary" href="' + esc(r.href) + '">立即打开试玩 &rarr;</a>' +
    '</div>'
  )).join("") : '<div class="muted">暂无已发布可玩版本</div>';
  document.getElementById("overview-releases").innerHTML = relHtml;
  document.getElementById("full-releases").innerHTML = relHtml;

  // Reports
  const repHtml = reports.length ? reports.map(r => (
    '<div class="item-row">' +
      '<div><strong>📑 ' + esc(r.title || r.slug) + '</strong><div class="muted" style="font-size:12px">' + esc(r.slug) + ' · ' + esc(r.time) + '</div></div>' +
      '<a class="btn" href="' + esc(r.href) + '">查看完整报告 &rarr;</a>' +
    '</div>'
  )).join("") : '<div class="muted">暂无已归档报告</div>';
  document.getElementById("overview-reports").innerHTML = repHtml;
  document.getElementById("full-reports").innerHTML = repHtml;

  // Milestones
  document.getElementById("milestones-list").innerHTML = milestones.length ? milestones.map(ms => (
    '<div class="card" style="background:var(--panel-alt);margin-bottom:10px">' +
      '<h2 style="font-size:14.5px;margin-bottom:8px"><span>📌 ' + esc(ms.name) + '</span><span class="mono muted">' + esc(ms.updatedAt || "") + '</span></h2>' +
      '<div class="pre-box">' + esc(ms.content) + '</div>' +
    '</div>'
  )).join("") : '<div class="muted">团队尚未生成里程碑规划文件</div>';

  // Screenshots
  const shots = data.screenshots || [];
  document.getElementById("screenshots-gallery").innerHTML = shots.length ? shots.map(s => (
    '<div class="shot">' +
      '<a href="' + esc(s.href) + '" target="_blank"><img src="' + esc(s.href) + '" alt="' + esc(s.name) + '" loading="lazy" /></a>' +
      '<div class="cap"><strong>' + esc(s.report) + '</strong> · ' + esc(s.name) + '</div>' +
    '</div>'
  )).join("") : '<div class="muted">暂无 QA 截图</div>';

  // Guidance
  document.getElementById("guidance-list").innerHTML = guidance.length ? guidance.map(g => (
    '<div class="item-row" style="align-items:flex-start;flex-direction:column">' +
      '<div style="display:flex;justify-content:space-between;width:100%"><strong style="color:#38bdf8">[' + esc(g.kind) + '] ' + esc(g.name) + '</strong><span class="mono muted">' + esc(g.time) + '</span></div>' +
      '<div class="pre-box" style="width:100%;max-height:180px;margin-top:6px">' + esc(g.content) + '</div>' +
    '</div>'
  )).join("") : '<div class="muted">暂无指令归档</div>';

  // Memory
  const roleMems = (memory.roles || []).map(r => (
    '<div class="item-row" style="align-items:flex-start;flex-direction:column">' +
      '<strong>🔹 岗位记忆: spaces/' + esc(r.role) + '/index.md</strong>' +
      '<div class="pre-box" style="width:100%;max-height:160px;margin-top:6px">' + esc(r.content || "（空）") + '</div>' +
    '</div>'
  )).join("");
  document.getElementById("memory-list").innerHTML =
    '<div class="item-row" style="align-items:flex-start;flex-direction:column">' +
      '<strong>🌟 团队全局铁律: memory.md</strong>' +
      '<div class="pre-box" style="width:100%;max-height:180px;margin-top:6px">' + esc(memory.rootContent || "（空）") + '</div>' +
    '</div>' + roleMems;
}

async function refreshBoard() {
  const urls = ["/api/board/live?t=" + Date.now(), "./live.json?t=" + Date.now()];
  for (const url of urls) {
    try {
      const resp = await fetch(url, { cache: "no-store" });
      if (resp.ok) {
        const ctype = resp.headers.get("content-type") || "";
        if (ctype.includes("json") || url.includes("live.json")) {
          const data = await resp.json();
          if (data && data.teamName) {
            renderBoard(data);
            return;
          }
        }
      }
    } catch (_e) {
      // fallback to next URL
    }
  }
}

refreshBoard();
setInterval(refreshBoard, 3000);
</script>
</body>
</html>
"""


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return default


def write_json_atomic(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def read_text(path, max_chars=8000):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read(max_chars)
    except OSError:
        return ""


def parse_env_file(path):
    env = {}
    if not os.path.isfile(path):
        return env
    for raw in read_text(path, 16000).splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def detect_daemon_root(team_root):
    cur = os.path.realpath(team_root)
    # Typical layout: <daemon-root>/spaces/<team-name>
    parent = os.path.dirname(cur)
    if os.path.basename(parent) == "spaces":
        cand = os.path.dirname(parent)
        if os.path.isfile(os.path.join(cand, "config.json")) or os.path.isdir(os.path.join(cand, "spaces")):
            return cand
    if os.environ.get("GENEHUB_DEV_DATA_DIR"):
        return os.path.realpath(os.environ["GENEHUB_DEV_DATA_DIR"])
    return parent


def inspect_git_worktree(wt_dir):
    if not wt_dir or not os.path.isdir(wt_dir):
        return None
    branch = subprocess.run(
        ["git", "-C", wt_dir, "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True, text=True, timeout=5
    ).stdout.strip()
    if not branch:
        return None
    head = subprocess.run(
        ["git", "-C", wt_dir, "log", "-1", "--format=%h|%s"],
        capture_output=True, text=True, timeout=5
    ).stdout.strip()
    sha, _, subj = head.partition("|")
    status = subprocess.run(
        ["git", "-C", wt_dir, "status", "--porcelain"],
        capture_output=True, text=True, timeout=5
    ).stdout.splitlines()
    return {
        "branch": branch,
        "headSha": sha,
        "headSubject": subj,
        "dirtyCount": len([ln for ln in status if ln.strip()]),
    }


# `genet session list` 单次约 3s（全守护进程会话），看板 6s 一刷不能每次都打，缓存 20s。
_DAEMON_QUERY_TTL = 20.0
_daemon_query_cache = {}


def query_daemon_spaces_and_sessions(team_root):
    """Cached wrapper: one uncached round costs ~4s of `genet` CLI time."""
    key = os.path.realpath(team_root)
    hit = _daemon_query_cache.get(key)
    if hit and time.time() - hit[0] < _DAEMON_QUERY_TTL:
        return hit[1]
    result = _query_daemon_spaces_and_sessions_uncached(team_root)
    if result != ({}, {}):
        _daemon_query_cache[key] = (time.time(), result)
    return result


def _query_daemon_spaces_and_sessions_uncached(team_root):
    """Query sessions and workspaces using `genet` CLI if available, else fallback to daemon sqlite/files."""
    daemon_root = detect_daemon_root(team_root)
    slot_cli = os.path.realpath(os.path.join(daemon_root, "..", "..", "install", "bin", "genet-dev"))
    cli = os.environ.get("GENEHUB_CLI")
    if os.path.isfile(slot_cli) and os.access(slot_cli, os.X_OK):
        cli = slot_cli
    elif not cli:
        # Try sibling install/bin/genet-dev or genet-beta
        for cand in (
            slot_cli,
            "/root/.local/bin/genet-dev",
            "/root/.local/bin/genet-beta",
            "/root/.local/bin/genet",
        ):
            if os.path.isfile(cand) and os.access(cand, os.X_OK):
                cli = os.path.realpath(cand)
                break
    if not cli:
        return {}, {}
    env = dict(os.environ)
    env.pop("GENEHUB_SESSION_ID", None)
    env.pop("GENEHUB_EXECUTION_LEASE", None)
    env.pop("GENEHUB_CONTROLLER_TOKEN", None)
    if os.path.isdir(os.path.join(daemon_root, "spaces")):
        env["GENEHUB_DEV_DATA_DIR"] = daemon_root
    try:
        # 该 CLI 不接受 --json（会被当成未知参数），且输出信封是 {"data": {...}}。
        ws_out = subprocess.run(
            [cli, "workspace", "list"],
            capture_output=True, text=True, env=env, timeout=30
        )
        sess_out = subprocess.run(
            [cli, "session", "list"],
            capture_output=True, text=True, env=env, timeout=30
        )
        workspaces = ((json.loads(ws_out.stdout).get("data") or {}).get("workspaces") or []) \
            if ws_out.returncode == 0 and ws_out.stdout.strip() else []
        sessions = ((json.loads(sess_out.stdout).get("data") or {}).get("sessions") or []) \
            if sess_out.returncode == 0 and sess_out.stdout.strip() else []
    except Exception:
        return {}, {}
    real_root = os.path.realpath(team_root)
    spaces_by_role = {}
    for w in workspaces:
        # workspace 只有 root 字段，没有 location.kind/path。
        p = os.path.realpath(w.get("root") or "")
        if p == real_root:
            spaces_by_role["root"] = w
        elif p.startswith(real_root + os.sep):
            rel = os.path.relpath(p, real_root).replace(os.sep, "/")
            if rel.startswith("spaces/") and "/" not in rel[7:]:
                spaces_by_role[rel[7:]] = w
    sessions_by_ws = {}
    for s in sessions:
        if s.get("archived"):
            continue
        wid = s.get("workspaceId") or ""
        sessions_by_ws.setdefault(wid, []).append(s)
    return spaces_by_role, sessions_by_ws


ROLE_DISPLAY_ORDER = {
    "root": (0, "📌 巡查主入口 (front)"),
    "leader": (1, "🧭 研发组长 (leader)"),
    "skill-lead": (2, "⚔️ 功法技能管线 (skill-lead)"),
    "monster-lead": (3, "👹 妖兽与战斗管线 (monster-lead)"),
    "map-lead": (4, "🗺️ 秘境地图管线 (map-lead)"),
    "qa": (10, "🧪 QA 验收专家 (qa)"),
    "research": (11, "📐 数值与玩法研究 (research)"),
    "team-reflect": (12, "🧠 团队自省专家 (team-reflect)"),
    "reflect": (13, "🧠 自省专家 (reflect)"),
}


def build_board_live_data(team_root):
    team_root = os.path.realpath(team_root)
    desc = read_json(os.path.join(team_root, "agent-space.genet.json"), {}) or {}
    team_name = desc.get("name") or os.path.basename(team_root)
    team_desc = desc.get("description") or ""

    svc_state = read_json(os.path.join(team_root, ".genethub", "expert", "board-service.json"), {}) or {}
    pid = svc_state.get("pid")
    svc_running = False
    if isinstance(pid, int) and pid > 0:
        try:
            os.kill(pid, 0)
            svc_running = True
        except OSError:
            svc_running = False

    spaces_by_role, sessions_by_ws = query_daemon_spaces_and_sessions(team_root)

    # Discover roles from filesystem + daemon
    role_names = ["root"]
    spaces_dir = os.path.join(team_root, "spaces")
    if os.path.isdir(spaces_dir):
        for entry in sorted(os.listdir(spaces_dir)):
            if os.path.isfile(os.path.join(spaces_dir, entry, "agent-space.genet.json")):
                role_names.append(entry)
    role_names.sort(key=lambda r: (ROLE_DISPLAY_ORDER.get(r, (5, r))[0], r))

    members = []
    role_memories = []
    for role in role_names:
        role_dir = team_root if role == "root" else os.path.join(team_root, "spaces", role)
        env_dir = os.path.join(team_root, "front") if role == "root" and os.path.isdir(os.path.join(team_root, "front")) else role_dir
        role_desc_json = read_json(os.path.join(role_dir, "agent-space.genet.json"), {}) or {}
        env = parse_env_file(os.path.join(env_dir, ".genethub", "open.env"))
        wt_dir = team_root if role == "root" else env.get("WORKTREE_DIR")
        effort = env.get("EXPERT_EFFORT") or "high"
        ws_info = spaces_by_role.get(role) or {}
        wid = ws_info.get("id") or ""
        sess_list = sorted(sessions_by_ws.get(wid, []), key=lambda s: -s.get("updatedAtMs", 0))
        active_sess = None
        if sess_list:
            top = sess_list[0]
            preview_obj = top.get("messagePreview") or {}
            active_sess = {
                "id": top.get("id"),
                "title": top.get("title") or top.get("description") or "",
                "description": top.get("description") or "",
                "status": top.get("status") or "idle",
                "modelId": top.get("modelId") or "",
                "effortId": top.get("effortId") or effort,
                "updatedAtMs": top.get("updatedAtMs") or 0,
                "preview": preview_obj.get("text") or "",
            }
        git_info = inspect_git_worktree(wt_dir) if wt_dir and role != "root" else None
        on_duty = bool(
            role in ("root", "leader", "qa", "research", "team-reflect")
            or (wt_dir and os.path.isdir(wt_dir))
            or sess_list
        )
        disp = ROLE_DISPLAY_ORDER.get(role, (5, "🔧 %s" % role))[1]
        members.append({
            "role": role,
            "displayRole": disp,
            "roleDesc": role_desc_json.get("description") or "",
            "workspaceId": wid,
            "worktreeDir": wt_dir,
            "worktreeLabel": "主入口接待台" if role == "root" else (os.path.basename(wt_dir) if wt_dir else "未绑工位 (待岗)"),
            "onDuty": on_duty,
            "effort": effort,
            "git": git_info,
            "activeSession": active_sess,
            "sessionCount": len(sess_list),
        })
        idx_file = os.path.join(env_dir, "index.md")
        if os.path.isfile(idx_file):
            content = read_text(idx_file, 4000).strip()
            entries = [ln for ln in content.splitlines() if ln.strip() and not ln.strip().startswith("#")]
            role_memories.append({
                "role": "front" if role == "root" else role,
                "content": content,
                "entries": entries,
            })

    # Milestones
    milestones = []
    trunk_dir = os.path.join(team_root, ".pm", "trunk")
    if os.path.isdir(trunk_dir):
        for fname in sorted(os.listdir(trunk_dir)):
            if not fname.endswith(".md") or fname == "status-live.md":
                continue
            fpath = os.path.join(trunk_dir, fname)
            if os.path.isfile(fpath):
                milestones.append({
                    "name": fname,
                    "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(fpath))),
                    "content": read_text(fpath, 6000).strip(),
                })

    # Releases
    releases = []
    rel_root = os.path.join(team_root, "datas", "releases")
    if os.path.isdir(rel_root):
        for entry in sorted(os.listdir(rel_root), reverse=True):
            if entry == "latest":
                continue
            idx = os.path.join(rel_root, entry, "index.html")
            if os.path.isfile(idx):
                mtime = os.path.getmtime(idx)
                releases.append({
                    "version": entry,
                    "mtime": mtime,
                    "time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(mtime)),
                    "href": "../releases/%s/index.html" % entry,
                    "workspacePath": "datas/releases/%s/index.html" % entry,
                })
        releases.sort(key=lambda r: -r["mtime"])

    # Reports & Screenshots
    reports = []
    screenshots = []
    rep_root = os.path.join(team_root, "datas", "reports")
    seen_titles = set()
    if os.path.isdir(rep_root):
        for entry in sorted(os.listdir(rep_root), reverse=True):
            rdir = os.path.join(rep_root, entry)
            idx = os.path.join(rdir, "index.html")
            if os.path.isfile(idx):
                mtime = os.path.getmtime(idx)
                html_head = read_text(idx, 2000)
                title = entry
                if "<title>" in html_head and "</title>" in html_head:
                    title = html_head.split("<title>", 1)[1].split("</title>", 1)[0].strip()
                # Deduplicate dated copy vs stable slug copy in UI list, preferring stable slug
                dedup_key = title
                if dedup_key not in seen_titles:
                    seen_titles.add(dedup_key)
                    reports.append({
                        "slug": entry,
                        "title": title,
                        "mtime": mtime,
                        "time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(mtime)),
                        "href": "../reports/%s/index.html" % entry,
                        "workspacePath": "datas/reports/%s/index.html" % entry,
                    })
                for sub in sorted(os.listdir(rdir)):
                    if sub.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                        screenshots.append({
                            "report": entry,
                            "name": sub,
                            "href": "../reports/%s/%s" % (entry, sub),
                        })

    # Guidance
    guidance = []
    for kind in ("human", "patrol"):
        gdir = os.path.join(team_root, ".pm", "guidance", kind)
        if os.path.isdir(gdir):
            for fname in sorted(os.listdir(gdir), reverse=True)[:12]:
                fpath = os.path.join(gdir, fname)
                if os.path.isfile(fpath):
                    guidance.append({
                        "kind": kind,
                        "name": fname,
                        "time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(fpath))),
                        "content": read_text(fpath, 2500).strip(),
                    })

    return {
        "teamName": team_name,
        "description": team_desc,
        "teamRoot": team_root,
        "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "updatedAtMs": int(time.time() * 1000),
        "service": {
            "running": svc_running,
            "pid": pid if svc_running else None,
            "port": svc_state.get("port") if svc_running else None,
            "entry": "datas/board/index.html",
        },
        "members": members,
        "milestones": milestones,
        "releases": releases,
        "reports": reports,
        "screenshots": screenshots[:12],
        "guidance": guidance,
        "memory": {
            "rootContent": read_text(os.path.join(team_root, "memory.md"), 4000).strip(),
            "roles": role_memories,
        },
    }


def ensure_team_board(team_root, start_service=True, force_sync=False):
    """Ensure `datas/board/index.html` and `datas/board/live.json` exist and optionally start the background daemon."""
    team_root = os.path.realpath(team_root)
    board_dir = os.path.join(team_root, "datas", "board")
    os.makedirs(board_dir, exist_ok=True)
    index_path = os.path.join(board_dir, "index.html")
    if not os.path.isfile(index_path) or force_sync:
        with open(index_path, "w", encoding="utf-8") as handle:
            handle.write(BOARD_HTML)

    if start_service:
        ensure_board_daemon(team_root)

    live_path = os.path.join(board_dir, "live.json")
    if force_sync or not os.path.isfile(live_path):
        live_data = build_board_live_data(team_root)
        write_json_atomic(live_path, live_data)
    else:
        live_data = read_json(live_path, {}) or {}
    return index_path, live_data


def ensure_board_daemon(team_root):
    team_root = os.path.realpath(team_root)
    state_file = os.path.join(team_root, ".genethub", "expert", "board-service.json")
    state = read_json(state_file, {}) or {}
    pid = state.get("pid")
    if isinstance(pid, int) and pid > 0:
        try:
            os.kill(pid, 0)
            return pid
        except OSError:
            pass
    script_path = os.path.realpath(__file__)
    log_path = os.path.join(team_root, ".genethub", "expert", "board-service.log")
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as log_handle:
        proc = subprocess.Popen(
            [sys.executable, script_path, "--serve", "--team-root", team_root],
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=log_handle,
            start_new_session=True,
        )
    # Wait briefly for state file to be written
    for _ in range(15):
        time.sleep(0.05)
        st = read_json(state_file, {}) or {}
        if st.get("pid") == proc.pid and st.get("port"):
            break
    return proc.pid


# ---------------------------------------------------------------- RFC 6455 WebSocket + Service Preview v1 Bridge

async def ws_read_frame(reader):
    hdr = await reader.readexactly(2)
    b1, b2 = hdr[0], hdr[1]
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack("!H", await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", await reader.readexactly(8))[0]
    mask_key = await reader.readexactly(4) if masked else None
    payload = await reader.readexactly(length) if length else b""
    if masked and mask_key:
        payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
    return opcode, payload


def ws_encode_frame(payload, opcode=0x02):
    length = len(payload)
    out = bytearray([0x80 | (opcode & 0x0F)])
    if length < 126:
        out.append(length)
    elif length < 65536:
        out.append(126)
        out.extend(struct.pack("!H", length))
    else:
        out.append(127)
        out.extend(struct.pack("!Q", length))
    out.extend(payload)
    return bytes(out)


def ctrl_frame(obj):
    raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    return ws_encode_frame(b"\x00" + raw, opcode=0x02)


def data_frame(rid, chunk):
    rid_b = rid.encode("utf-8")
    return ws_encode_frame(b"\x01" + bytes([len(rid_b)]) + rid_b + chunk, opcode=0x02)


async def handle_ws_client(reader, writer, team_root, run_id, secret_str, stop_event):
    try:
        req_data = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5.0)
        headers = {}
        for line in req_data.decode("latin1").splitlines()[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        if "origin" in headers:
            writer.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            await writer.drain()
            return
        ws_key = headers.get("sec-websocket-key", "")
        accept = base64.b64encode(hashlib.sha1((ws_key + WS_GUID).encode("ascii")).digest()).decode("ascii")
        resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: %s\r\n\r\n" % accept
        )
        writer.write(resp.encode("ascii"))
        await writer.drain()

        secret_bytes = secret_str.encode("utf-8")

        # 1. Read daemon challenge: {"nonce": "..."}
        opcode, payload = await asyncio.wait_for(ws_read_frame(reader), timeout=5.0)
        if opcode != 0x02 or not payload or payload[0] != 0x00:
            return
        hello = json.loads(payload[1:].decode("utf-8"))
        c_nonce = hello.get("nonce") or ""
        if not c_nonce:
            return
        s_proof = hmac.new(secret_bytes, ("server:%s:%s" % (c_nonce, run_id)).encode("utf-8"), hashlib.sha256).hexdigest()
        writer.write(ctrl_frame({"proof": s_proof}))
        await writer.drain()

        # 2. Read daemon proof: {"proof": "..."}
        opcode, payload = await asyncio.wait_for(ws_read_frame(reader), timeout=5.0)
        if opcode != 0x02 or not payload or payload[0] != 0x00:
            return
        c_auth = json.loads(payload[1:].decode("utf-8"))
        expected_proof = hmac.new(secret_bytes, ("client:%s:%s" % (c_nonce, run_id)).encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected_proof, c_auth.get("proof") or ""):
            return

        # 3. Send ready
        writer.write(ctrl_frame({"kind": "ready"}))
        await writer.drain()

        # 4. Serve requests (shutdown or http bridge)
        while not stop_event.is_set():
            opcode, payload = await ws_read_frame(reader)
            if opcode == 0x08:  # Close
                break
            if opcode == 0x09:  # Ping
                writer.write(ws_encode_frame(payload, opcode=0x0A))
                await writer.drain()
                continue
            if opcode != 0x02 or not payload:
                continue
            if payload[0] == 0x02:  # Credit ACK
                continue
            if payload[0] != 0x00:
                continue
            msg = json.loads(payload[1:].decode("utf-8"))
            kind = msg.get("kind") or msg.get("t") or ""
            if kind == "shutdown":
                writer.write(ctrl_frame({"kind": "stopping"}))
                await writer.drain()
                stop_event.set()
                break
            if kind in ("http", "request"):
                live_path = os.path.join(team_root, "datas", "board", "live.json")
                live_data = read_json(live_path) or await asyncio.to_thread(build_board_live_data, team_root)
                body = json.dumps(live_data, ensure_ascii=False).encode("utf-8")
                writer.write(ctrl_frame({
                    "kind": "headers",
                    "status": 200,
                    "headers": {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"},
                }))
                writer.write(ws_encode_frame(b"\x01" + body, opcode=0x02))
                writer.write(ctrl_frame({"kind": "end"}))
                await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def serve_board(team_root):
    team_root = os.path.realpath(team_root)
    daemon_root = detect_daemon_root(team_root)
    board_dir = os.path.join(team_root, "datas", "board")
    os.makedirs(board_dir, exist_ok=True)
    entry_path = os.path.realpath(os.path.join(board_dir, "index.html"))
    if not os.path.isfile(entry_path):
        with open(entry_path, "w", encoding="utf-8") as handle:
            handle.write(BOARD_HTML)

    run_id = secrets.token_hex(16)   # 32 hex chars
    secret_str = secrets.token_hex(32)  # 64 hex chars
    stop_event = asyncio.Event()

    server = await asyncio.start_server(
        lambda r, w: handle_ws_client(r, w, team_root, run_id, secret_str, stop_event),
        host="127.0.0.1",
        port=0,
    )
    port = server.sockets[0].getsockname()[1]

    desc = read_json(os.path.join(team_root, "agent-space.genet.json"), {}) or {}
    tname = desc.get("name") or os.path.basename(team_root)

    # Register in <daemon-root>/service-previews/<sha256(entry)>.json
    entry_hash = hashlib.sha256(entry_path.encode("utf-8")).hexdigest()
    reg_dir = os.path.join(daemon_root, "service-previews")
    os.makedirs(reg_dir, exist_ok=True)
    os.chmod(reg_dir, 0o700)
    reg_path = os.path.join(reg_dir, "%s.json" % entry_hash)
    write_json_atomic(reg_path, {
        "version": 1,
        "pid": os.getpid(),
        "control": True,
        "entry": entry_path,
        "runId": run_id,
        "secret": secret_str,
        "port": port,
        "name": "%s · 实时团队看板服务" % tname,
        "routes": ["/api/board/"],
        "media": [],
    })
    os.chmod(reg_path, 0o600)

    state_file = os.path.join(team_root, ".genethub", "expert", "board-service.json")
    write_json_atomic(state_file, {
        "pid": os.getpid(),
        "port": port,
        "runId": run_id,
        "entry": entry_path,
        "regPath": reg_path,
        "startedAtMs": int(time.time() * 1000),
    })

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass

    async def periodic_refresh():
        while not stop_event.is_set():
            try:
                live = await asyncio.to_thread(build_board_live_data, team_root)
                write_json_atomic(os.path.join(team_root, "datas", "board", "live.json"), live)
            except Exception:
                pass
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=6.0)
            except asyncio.TimeoutError:
                pass

    refresh_task = asyncio.create_task(periodic_refresh())
    try:
        await stop_event.wait()
    finally:
        refresh_task.cancel()
        server.close()
        await server.wait_closed()
        for p in (reg_path, state_file):
            try:
                if os.path.isfile(p):
                    os.remove(p)
            except OSError:
                pass


def main():
    parser = argparse.ArgumentParser(description="GeneHub Expert Team Live Board Service")
    parser.add_argument("--team-root", required=True)
    parser.add_argument("--serve", action="store_true", help="Run as background Service Preview daemon")
    parser.add_argument("--once", action="store_true", help="Generate index.html + live.json once and exit")
    args = parser.parse_args()
    if args.serve:
        asyncio.run(serve_board(args.team_root))
    else:
        idx, _ = ensure_team_board(args.team_root, start_service=not args.once)
        print(idx)


if __name__ == "__main__":
    main()
