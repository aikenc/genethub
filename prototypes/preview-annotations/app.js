function bootPreviewAnnotationPrototype() {
  "use strict";

  const STORE_KEY = "genehub-preview-annotations-prototype-v3";
  const AGENT_MESSAGE = "msg_agent_1";
  const files = {
    markdown: { kind: "markdown", name: "experience.md", path: "docs/experience.md", version: "a1f6c29b" },
    html: { kind: "html", name: "landing.html", path: "site/landing.html", version: "e24a921d" },
    dashboard: { kind: "image", name: "dashboard.png", path: "design/dashboard.png", version: "f10c7e82", src: "./sample-dashboard.png", width: 1200, height: 760 },
    mobile: { kind: "image", name: "mobile.png", path: "design/mobile.png", version: "9c816e42", src: "./sample-mobile.png", width: 800, height: 560 },
  };
  const sessions = { product: "产品体验讨论", landing: "官网视觉迭代" };
  const sourceLineText = {
    7: "用户可以在作品上直接圈选…", 8: "Agent 收到的是位置…",
    16: "```ts", 17: "type Annotation = …", 18: "```",
  };
  const $ = (id) => document.getElementById(id);
  const el = {
    name: $("previewFileName"), path: $("previewFilePath"), modeButton: $("annotationToggle"),
    draftButton: $("draftToggle"), draftCount: $("draftCount"), draftPanel: $("draftPanel"),
    runtimeToolbar: $("runtimeToolbar"), runtimeStatus: $("runtimeStatus"), runtimeLogCount: $("runtimeLogCount"),
    runtimeFrameCount: $("runtimeFrameCount"), runtimeLogList: $("runtimeLogList"), runtimeLogPanel: $("runtimeLogPanel"),
    modeHint: $("modeHint"), markdownView: $("markdownView"), htmlView: $("htmlView"), htmlStage: $("htmlStage"),
    inspectOutline: $("inspectOutline"), inspectLabel: $("inspectLabel"), imageView: $("imageView"),
    imageFrame: $("imageFrame"), sampleImage: $("sampleImage"), imageOverlay: $("imageOverlay"), imageRect: $("imageRect"),
    rectLabel: $("rectLabel"), compose: $("composeSheet"), composeTarget: $("composeTarget"), commentInput: $("commentInput"),
    commentCount: $("commentCount"), lineAdjust: $("lineAdjustButton"), lineChoices: $("lineChoices"),
    saveButton: $("saveCommentButton"), copyPending: $("copyPendingButton"), draftItems: $("draftItems"),
    draftFooterCount: $("draftFooterCount"), draftSessionLabel: $("draftSessionLabel"),
    returnButton: $("returnWorkbenchButton"), externalDraftNote: $("externalDraftNote"),
    protoStatus: $("protoStatus"), receiptText: $("receiptText"), connectionToggle: $("connectionToggle"),
    reviewCheckbox: $("reviewCheckbox"), reviewSummary: $("reviewSummary"),
    composerInput: $("composerInput"), composerSendButton: $("composerSendButton"),
    sessionTitle: $("sessionTitle"), agentAnnotate: $("agentAnnotate"), agentBody: $("agentBody"),
    toast: $("toast"), modal: $("modalBackdrop"), modalTitle: $("modalTitle"), modalDescription: $("modalDescription"),
    messagePreview: $("messagePreview"),
  };

  function seeds() {
    return {
      product: [
        { id: "example-md", fileKey: "markdown", version: files.markdown.version, target: { kind: "markdown", start: 7, end: 8 }, comment: "这里加一个中断后继续批注的例子。" },
        { id: "example-dashboard", fileKey: "dashboard", version: files.dashboard.version, target: { kind: "image", x: 170, y: 150, width: 490, height: 245, naturalWidth: 1200, naturalHeight: 760 }, markerNo: 1, comment: "这块指标的层级再拉开一些。" },
        { id: "example-mobile", fileKey: "mobile", version: files.mobile.version, target: { kind: "image", x: 40, y: 55, width: 275, height: 260, naturalWidth: 800, naturalHeight: 560 }, markerNo: 1, comment: "手机首页标题和第一张卡片之间留白太多。" },
      ],
      landing: [],
      nextMarker: { product: { "dashboard:f10c7e82": 2, "mobile:9c816e42": 2 }, landing: {} },
    };
  }
  function load() {
    try {
      const value = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      return value && Array.isArray(value.product) && Array.isArray(value.landing) ? value : seeds();
    } catch { return seeds(); }
  }
  let saved = load();
  if (!saved.nextMarker) saved.nextMarker = { product: {}, landing: {} };
  for (const session of Object.keys(sessions)) if (!saved.nextMarker[session]) saved.nextMarker[session] = {};
  let currentSession = "product";
  let currentFile = "markdown";
  let mode = "off";
  let selection = null;
  let mdRangeBase = null;
  let editingId = null;
  let imageDrag = null;
  let recording = false;
  let modalMode = "send";
  let runtimeFrames = 0;
  let surface = "workbench";
  let externalOnline = true;
  let lastReceipt = "";
  const runtimeEvents = [];
  let toastTimer;

  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); return true; }
    catch { notify("模拟会话存储失败，批注仍留在输入卡里"); return false; }
  }
  function notify(message) {
    el.toast.textContent = message;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2800);
  }
  function draft() { return saved[currentSession]; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function unsavedText() {
    return !el.compose.classList.contains("hidden") && el.commentInput.value.trim().length > 0;
  }
  function renderSurface() {
    document.body.dataset.surface = surface;
    const name = sessions[currentSession];
    el.sessionTitle.textContent = name;
    el.draftSessionLabel.textContent = name + " · 一份草稿";
    el.protoStatus.textContent = surface === "external"
      ? (externalOnline ? (lastReceipt ? "模拟回执 " + lastReceipt : "外部 Preview 已连接") : "外部 Preview 连接中断")
      : surface === "preview" ? "Preview · " + name : "工作台 · " + name;
    document.querySelectorAll("[data-surface-nav]").forEach((button) => {
      button.classList.toggle("active", button.dataset.surfaceNav === surface);
    });
    document.querySelectorAll("[data-session]").forEach((button) => {
      button.classList.toggle("active", button.dataset.session === currentSession);
    });
    el.connectionToggle.classList.toggle("offline", !externalOnline);
    el.connectionToggle.textContent = externalOnline ? "模拟连接中断" : "模拟重新连接";
    el.receiptText.textContent = !externalOnline
      ? "连接已中断。已经确认的批注仍在「" + name + "」；这一条还没保存。"
      : lastReceipt
        ? "已保存到「" + name + "」。请切回原来的 PWA 再发送。这个页面没有输入框。"
        : "独立 Preview，绑定打开时的会话「" + name + "」。这里不能改选对话，也不能发送。";
    el.copyPending.classList.toggle("hidden", surface !== "external");
  }
  function setSurface(next) {
    if (next === surface) return;
    if (unsavedText()) { notify("这条批注还没保存"); return; }
    const previous = surface;
    if (previous === "external" && next === "workbench") saved = load();
    closeCompose();
    hideDraft();
    if (next === "external") { externalOnline = true; lastReceipt = ""; }
    surface = next;
    if (next !== "preview" && mode === "file") setMode("off");
    if (next !== "workbench" && mode === "agent") setMode("off");
    renderSurface();
    renderDraft();
    requestAnimationFrame(renderMarkers);
    if (next === "external") notify("模拟：外部浏览器只打开 Preview，发送仍回到原来的 PWA");
    if (previous === "external" && next === "workbench") notify("模拟：PWA 重新读取了同一份会话草稿");
  }
  function makeId() { return "note-" + (globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(36).slice(2)); }
  function node(tag, className, textValue) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (textValue !== undefined) item.textContent = textValue;
    return item;
  }
  function action(label, handler, className) {
    const item = node("button", className, label);
    item.type = "button";
    item.addEventListener("click", handler);
    return item;
  }
  function currentNotes() { return draft().filter((item) => item.fileKey === currentFile); }
  function agentNotes() { return draft().filter((item) => item.source === "transcript" && item.messageId === AGENT_MESSAGE); }
  function nextImageNumber(fileKey) {
    const key = fileKey + ":" + files[fileKey].version;
    const existing = 1 + Math.max(0, ...draft().filter((item) => item.fileKey === fileKey).map((item) => Number(item.markerNo) || 0));
    return Math.max(existing, saved.nextMarker[currentSession][key] || 1);
  }
  function logRuntime(kind, detail) {
    const entry = new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "  " + kind + "  " + detail;
    runtimeEvents.push(entry);
    if (runtimeEvents.length > 100) runtimeEvents.shift();
    el.runtimeLogCount.textContent = String(runtimeEvents.length);
    el.runtimeLogList.prepend(node("li", "", entry));
    while (el.runtimeLogList.children.length > 100) el.runtimeLogList.lastElementChild.remove();
  }
  function closeCompose() {
    el.compose.classList.add("hidden");
    el.commentInput.value = "";
    el.commentCount.textContent = "0 / 1000";
    selection = null;
    mdRangeBase = null;
    editingId = null;
    el.lineChoices.classList.add("hidden");
    renderSelection();
  }
  function selectFile(key) {
    if (!files[key]) return;
    currentFile = key;
    const file = files[key];
    el.name.textContent = file.name;
    el.path.textContent = file.path;
    el.markdownView.classList.toggle("hidden", file.kind !== "markdown");
    el.htmlView.classList.toggle("hidden", file.kind !== "html");
    el.imageView.classList.toggle("hidden", file.kind !== "image");
    el.runtimeToolbar.classList.toggle("hidden", file.kind !== "html");
    el.runtimeLogPanel.classList.add("hidden");
    if (file.kind === "html" && runtimeEvents.length === 0) logRuntime("log", "HTML 预览诊断已就绪");
    if (file.kind === "image") {
      el.sampleImage.src = file.src;
      el.sampleImage.alt = file.name + " 原图";
    }
    document.querySelectorAll("[data-file]").forEach((button) => button.classList.toggle("active", button.dataset.file === key));
    updateModeHint();
    renderMarkers();
  }
  function openFile(key) {
    if (unsavedText()) { notify("这条批注还没保存"); return; }
    closeCompose();
    selectFile(key);
    surface = "preview";
    setMode("off");
    renderSurface();
    requestAnimationFrame(renderMarkers);
  }
  function updateModeHint() {
    const kind = files[currentFile].kind;
    const fileMode = mode === "file";
    el.modeHint.classList.toggle("hidden", !fileMode);
    el.modeHint.textContent = kind === "markdown"
      ? "点渲染后的段落或列表项"
      : kind === "html" ? "点页面元素；退出后恢复页面点击" : "轻点得到默认区域，拖动得到精确区域";
    el.htmlStage.classList.toggle("inspect-mode", fileMode && kind === "html");
    el.imageOverlay.classList.toggle("drawing", fileMode && kind === "image");
    el.markdownView.classList.toggle("annotating", fileMode && kind === "markdown");
    el.agentBody.classList.toggle("annotating", mode === "agent");
  }
  function syncModeChrome() {
    el.modeButton.textContent = mode === "file" ? "完成批注" : "进入批注";
    el.modeButton.classList.toggle("active", mode === "file");
    el.modeButton.setAttribute("aria-pressed", String(mode === "file"));
    el.agentAnnotate.textContent = mode === "agent" ? "完成批注" : "批注这条回复";
    el.agentAnnotate.setAttribute("aria-pressed", String(mode === "agent"));
  }
  function setMode(next) {
    if (mode === next) return;
    mode = next;
    syncModeChrome();
    closeCompose();
    updateModeHint();
  }
  function imageGeometry(target) {
    return {
      left: target.x / target.naturalWidth * 100 + "%",
      top: target.y / target.naturalHeight * 100 + "%",
      width: target.width / target.naturalWidth * 100 + "%",
      height: target.height / target.naturalHeight * 100 + "%",
    };
  }
  function applyGeometry(element, target) { Object.assign(element.style, imageGeometry(target)); }
  function imagePoint(event) {
    const box = el.imageOverlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
    };
  }
  function targetFromPoints(first, last) {
    const file = files[currentFile];
    const x = Math.round(Math.min(first.x, last.x) * file.width);
    const y = Math.round(Math.min(first.y, last.y) * file.height);
    const right = Math.round(Math.max(first.x, last.x) * file.width);
    const bottom = Math.round(Math.max(first.y, last.y) * file.height);
    return { kind: "image", x, y, width: right - x, height: bottom - y, naturalWidth: file.width, naturalHeight: file.height };
  }
  function defaultImageTarget(point) {
    const a = { x: Math.max(0, point.x - 0.12), y: Math.max(0, point.y - 0.14) };
    const b = { x: Math.min(1, point.x + 0.12), y: Math.min(1, point.y + 0.14) };
    return targetFromPoints(a, b);
  }
  function selectorFor(element) {
    if (element.id && element.id !== "htmlStage") return element.tagName.toLowerCase() + "#" + element.id;
    const name = element.dataset.inspect;
    const siblings = [...element.parentElement.children].filter((other) => other.dataset?.inspect === name);
    const tag = element.tagName.toLowerCase();
    if (siblings.length < 2) return tag + '[data-inspect="' + name + '"]';
    const sameTag = [...element.parentElement.children].filter((other) => other.tagName === element.tagName);
    return tag + '[data-inspect="' + name + '"]:nth-of-type(' + (sameTag.indexOf(element) + 1) + ')';
  }
  function labelFor(element) {
    const value = element.textContent.replace(/\s+/g, " ").trim().slice(0, 40);
    return element.tagName.toLowerCase() + (value ? " · " + value : "");
  }
  function showOutline(element) {
    if (!element || mode !== "file" || files[currentFile].kind !== "html") {
      el.inspectOutline.classList.add("hidden");
      return;
    }
    const stage = el.htmlStage.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    Object.assign(el.inspectOutline.style, {
      left: box.left - stage.left + "px", top: box.top - stage.top + "px",
      width: box.width + "px", height: box.height + "px",
    });
    el.inspectLabel.textContent = element.tagName.toLowerCase();
    el.inspectOutline.classList.remove("hidden");
  }
  function anchorText(item) {
    const target = item.target;
    if (target.kind === "markdown") return "第 " + target.start + (target.start === target.end ? "" : "–" + target.end) + " 行";
    if (target.kind === "html") return target.label;
    if (target.kind === "transcript") return "回复块 " + target.block;
    return "#" + item.markerNo + " 标记区域";
  }
  function mdBlockFor(line) {
    return [...el.markdownView.querySelectorAll("[data-md-start]")].find((block) =>
      Number(block.dataset.mdStart) <= line && Number(block.dataset.mdEnd) >= line);
  }
  function agentBlock(index) { return el.agentBody.querySelector('[data-agent-block="' + index + '"]'); }
  function updateLineChoices() {
    const multiLine = selection?.kind === "markdown" && mdRangeBase && mdRangeBase.end > mdRangeBase.start;
    el.lineAdjust.classList.toggle("hidden", !multiLine);
    el.lineChoices.replaceChildren();
    if (!multiLine) { el.lineChoices.classList.add("hidden"); return; }
    const choices = [{ start: mdRangeBase.start, end: mdRangeBase.end, label: "整段 · 第 " + mdRangeBase.start + "–" + mdRangeBase.end + " 行" }];
    for (let line = mdRangeBase.start; line <= mdRangeBase.end; line += 1) {
      choices.push({ start: line, end: line, label: "第 " + line + " 行 · " + (sourceLineText[line] || "源文件这一行") });
    }
    for (const choice of choices) {
      el.lineChoices.append(action(choice.label, () => {
        selection.start = choice.start;
        selection.end = choice.end;
        el.composeTarget.textContent = anchorText({ target: selection });
        renderSelection();
        el.lineChoices.classList.add("hidden");
      }));
    }
  }
  function openSelection(target, markerNo) {
    selection = clone(target);
    mdRangeBase = target.kind === "markdown" ? { start: target.start, end: target.end } : null;
    editingId = null;
    if (target.kind === "image") selection.markerNo = markerNo || nextImageNumber(currentFile);
    el.composeTarget.textContent = target.kind === "image"
      ? "区域 #" + selection.markerNo + " · " + files[currentFile].name
      : target.kind === "transcript" ? "Agent 回复 · 块 " + target.block : anchorText({ target });
    el.compose.classList.remove("hidden");
    el.commentInput.value = "";
    el.commentCount.textContent = "0 / 1000";
    updateLineChoices();
    renderSelection();
    el.commentInput.focus({ preventScroll: true });
  }
  function renderSelection() {
    document.querySelectorAll(".selected-target").forEach((item) => item.classList.remove("selected-target"));
    if (selection?.kind === "markdown" && files[currentFile].kind === "markdown") mdBlockFor(selection.start)?.classList.add("selected-target");
    if (selection?.kind === "transcript") agentBlock(selection.block)?.classList.add("selected-target");
    if (selection?.kind !== "html") el.inspectOutline.classList.add("hidden");
    const showRect = selection?.kind === "image" && files[currentFile].kind === "image";
    el.imageRect.classList.toggle("hidden", !showRect);
    if (showRect) { applyGeometry(el.imageRect, selection); el.rectLabel.textContent = "#" + selection.markerNo; }
  }
  function renderMarkers() {
    document.querySelectorAll(".note-pin,.html-marker,.saved-image-region").forEach((item) => item.remove());
    for (const item of currentNotes()) {
      if (item.target.kind === "markdown" && files[currentFile].kind === "markdown") {
        const block = mdBlockFor(item.target.start);
        if (!block) continue;
        const pin = action("●", () => showDraft(item.id), "note-pin");
        pin.setAttribute("aria-label", "查看这条 Markdown 批注");
        block.append(pin);
      } else if (item.target.kind === "html" && files[currentFile].kind === "html") {
        let target = null;
        try { target = el.htmlStage.querySelector(item.target.selector); } catch { /* stale */ }
        if (!target) continue;
        const stage = el.htmlStage.getBoundingClientRect();
        const box = target.getBoundingClientRect();
        const pin = action("●", (event) => { event.stopPropagation(); showDraft(item.id); }, "html-marker");
        pin.style.left = Math.max(0, box.right - stage.left - 12) + "px";
        pin.style.top = Math.max(0, box.top - stage.top - 8) + "px";
        pin.setAttribute("aria-label", "查看这条 HTML 批注");
        el.htmlStage.append(pin);
      } else if (item.target.kind === "image" && files[currentFile].kind === "image") {
        const region = action("", (event) => { event.stopPropagation(); showDraft(item.id); }, "saved-image-region");
        applyGeometry(region, item.target);
        region.dataset.number = "#" + item.markerNo;
        region.setAttribute("aria-label", "查看区域 #" + item.markerNo);
        el.imageOverlay.append(region);
      }
    }
    for (const item of agentNotes()) {
      const block = agentBlock(item.target.block);
      if (!block) continue;
      const pin = action("●", () => showDraft(item.id), "note-pin");
      pin.setAttribute("aria-label", "查看这条回复批注");
      block.append(pin);
    }
    renderSelection();
  }
  function saveComment() {
    const comment = el.commentInput.value.trim();
    if (!selection || !comment) { notify("请填写批注"); return; }
    if (surface === "external" && !externalOnline) {
      notify("连接中断：还没进入会话，文字仍留在这里");
      renderSurface();
      return;
    }
    const before = clone(saved);
    const items = draft();
    let candidate;
    if (selection.kind === "transcript") {
      candidate = {
        id: editingId || makeId(), source: "transcript", messageId: AGENT_MESSAGE,
        target: { kind: "transcript", block: selection.block, excerpt: selection.excerpt }, comment,
      };
    } else {
      const file = files[currentFile];
      const markerNo = selection.kind === "image" ? selection.markerNo : undefined;
      const target = clone(selection);
      delete target.markerNo;
      candidate = { id: editingId || makeId(), fileKey: currentFile, version: file.version, target, ...(markerNo ? { markerNo } : {}), comment };
      if (!editingId && markerNo) saved.nextMarker[currentSession][currentFile + ":" + file.version] = markerNo + 1;
    }
    if (editingId) {
      const index = items.findIndex((item) => item.id === editingId);
      if (index < 0) { notify("这条批注已经不在草稿里"); closeCompose(); return; }
      items[index] = candidate;
    } else items.push(candidate);
    if (!persist()) { saved = before; return; }
    if (surface === "external") lastReceipt = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    closeCompose();
    renderMarkers();
    renderDraft();
    renderSurface();
    notify(surface === "external" ? "模拟回执：已写入绑定的会话。回到 PWA 后重新读取。" : "已加入当前会话的同一份草稿");
  }
  async function copyPending() {
    const comment = el.commentInput.value.trim();
    if (!selection || !comment) { notify("先写一条还没保存的批注"); return; }
    const where = selection.kind === "transcript" ? "Agent 回复" : files[currentFile].path;
    const text = sessions[currentSession] + " · " + where + " · " + anchorText({ target: selection, markerNo: selection.markerNo }) + "\n批注：" + comment + "\n（尚未进入会话）";
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      notify("已复制待存文字。这不是保存回执。");
    } catch {
      modalMode = "copy";
      $("confirmSendButton").classList.add("hidden");
      el.modalTitle.textContent = "复制还没保存的批注";
      el.modalDescription.textContent = "这条文字还没有进入会话。";
      el.messagePreview.textContent = text;
      el.modal.classList.remove("hidden");
    }
  }
  function showDraft(focusId) {
    document.body.classList.add("draft-open");
    el.draftButton.setAttribute("aria-expanded", "true");
    renderDraft();
    if (focusId) {
      const card = $("draft-" + focusId);
      card?.classList.add("focused");
      card?.scrollIntoView({ block: "nearest" });
    }
  }
  function hideDraft() {
    document.body.classList.remove("draft-open");
    el.draftButton.setAttribute("aria-expanded", "false");
  }
  function imageGroup(file, items) {
    const panel = node("div", "draft-image-proof");
    const image = node("img");
    image.src = file.src;
    image.alt = file.name + " 原图和编号区域";
    panel.append(image);
    for (const item of items) {
      const region = node("span", "draft-proof-region");
      applyGeometry(region, item.target);
      region.dataset.number = "#" + item.markerNo;
      panel.append(region);
    }
    return panel;
  }
  function reveal(item) {
    hideDraft();
    if (item.source === "transcript") {
      surface = "workbench";
      setMode("off");
      renderSurface();
      agentBlock(item.target.block)?.scrollIntoView({ block: "center" });
      return;
    }
    surface = "preview";
    renderSurface();
    selectFile(item.fileKey);
    setMode("off");
    requestAnimationFrame(() => {
      if (item.target.kind === "markdown") mdBlockFor(item.target.start)?.scrollIntoView({ block: "center" });
      if (item.target.kind === "html") {
        let target = null;
        try { target = el.htmlStage.querySelector(item.target.selector); } catch { /* stale */ }
        target?.scrollIntoView({ block: "center" });
      }
    });
  }
  function edit(item) {
    hideDraft();
    if (item.source === "transcript") {
      surface = "workbench";
      mode = "agent";
    } else {
      surface = "preview";
      selectFile(item.fileKey);
      mode = "file";
    }
    renderSurface();
    syncModeChrome();
    updateModeHint();
    selection = clone(item.target);
    if (item.markerNo) selection.markerNo = item.markerNo;
    const block = item.target.kind === "markdown" ? mdBlockFor(item.target.start) : null;
    mdRangeBase = block ? { start: Number(block.dataset.mdStart), end: Number(block.dataset.mdEnd) } : null;
    editingId = item.id;
    el.composeTarget.textContent = anchorText(item);
    el.compose.classList.remove("hidden");
    el.commentInput.value = item.comment;
    el.commentCount.textContent = String(item.comment.length) + " / 1000";
    updateLineChoices();
    renderSelection();
    el.commentInput.focus({ preventScroll: true });
  }
  function remove(item) {
    if (surface === "external" && !externalOnline) { notify("连接中断，不能从会话里移除"); return; }
    const before = clone(saved);
    saved[currentSession] = draft().filter((other) => other.id !== item.id);
    if (!persist()) { saved = before; return; }
    renderDraft(); renderMarkers(); renderSurface();
    notify("已从这份草稿移除");
  }
  function renderDraft() {
    const items = draft();
    el.draftCount.textContent = String(items.length);
    el.draftFooterCount.textContent = items.length + " 条批注";
    el.reviewSummary.textContent = sessions[currentSession] + " · " + items.length + " 条批注";
    el.reviewCheckbox.disabled = items.length === 0;
    if (!items.length) el.reviewCheckbox.checked = false;
    el.composerSendButton.disabled = surface !== "workbench" || !items.length || !el.reviewCheckbox.checked;
    el.draftItems.replaceChildren();
    if (!items.length) {
      el.draftItems.append(node("p", "empty-draft", "还没有批注。在 Preview 里点文件内容，或在工作台里批注已完成的 Agent 回复。"));
      return;
    }
    const groups = new Map();
    for (const item of items) {
      const key = item.source === "transcript" ? "transcript:" + item.messageId : item.fileKey + ":" + item.version;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const groupItems of groups.values()) {
      const first = groupItems[0];
      const group = node("section", "draft-group");
      const header = node("div", "draft-group-head");
      if (first.source === "transcript") {
        header.append(node("strong", "", "Agent 回复"), node("small", "", first.messageId + " · 已完成，不是文件版本"));
      } else {
        const file = files[first.fileKey];
        if (!file) continue;
        header.append(node("strong", "", file.name), node("small", "", file.path + " · " + first.version.slice(0, 7)));
        group.append(header);
        if (file.kind === "image") group.append(imageGroup(file, groupItems));
      }
      if (first.source === "transcript") group.append(header);
      for (const item of groupItems) {
        const card = node("article", "draft-item");
        card.id = "draft-" + item.id;
        const lead = node("div", "draft-item-lead");
        lead.append(node("b", "", anchorText(item)), action("↗", () => reveal(item), "jump-button"));
        const foot = node("div", "draft-item-actions");
        foot.append(action("编辑", () => edit(item)), action("移除", () => remove(item)));
        card.append(lead, node("p", "", item.comment), foot);
        group.append(card);
      }
      el.draftItems.append(group);
    }
  }
  function messageText() {
    const lines = ["请按这份会话批注继续（" + sessions[currentSession] + "）：", ""];
    const groups = new Map();
    for (const item of draft()) {
      const key = item.source === "transcript" ? "transcript:" + item.messageId : item.fileKey + ":" + item.version;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const items of groups.values()) {
      const first = items[0];
      if (first.source === "transcript") {
        lines.push("【Agent 回复 " + first.messageId + " · 已完成】");
        for (const item of items) lines.push("- 回复块 " + item.target.block + "：" + item.comment);
      } else {
        const file = files[first.fileKey];
        lines.push("【" + file.path + " · " + first.version + "】");
        if (file.kind === "image") lines.push("原图 + 带编号标注图（原型只展示关系）：");
        for (const item of items) lines.push("- " + anchorText(item) + "：" + item.comment);
      }
      lines.push("");
    }
    const extra = el.composerInput.value.trim();
    if (extra) lines.push("补充说明：" + extra);
    return lines.join("\n");
  }
  function showMessage() {
    if (surface !== "workbench") { notify("发送只在工作台输入区"); return; }
    if (!draft().length || !el.reviewCheckbox.checked) { notify("先勾选输入区里的预览批注"); return; }
    modalMode = "send";
    $("confirmSendButton").classList.remove("hidden");
    el.modalTitle.textContent = "检查一条消息";
    el.modalDescription.textContent = "已勾选当前会话的 " + draft().length + " 条批注。文件和 Agent 回复在同一份草稿里。这是模拟发送。";
    el.messagePreview.textContent = messageText();
    el.modal.classList.remove("hidden");
  }

  document.querySelectorAll("[data-surface-nav]").forEach((button) => {
    button.addEventListener("click", () => setSurface(button.dataset.surfaceNav));
  });
  document.querySelectorAll("[data-file]").forEach((button) => button.addEventListener("click", () => openFile(button.dataset.file)));
  document.querySelectorAll("[data-session]").forEach((button) => button.addEventListener("click", () => {
    if (unsavedText()) { notify("这条批注还没保存"); return; }
    currentSession = button.dataset.session;
    el.reviewCheckbox.checked = false;
    closeCompose();
    renderSurface();
    renderDraft();
    renderMarkers();
    notify("已切换到「" + sessions[currentSession] + "」。每份会话各有一份草稿。");
  }));
  el.connectionToggle.addEventListener("click", () => {
    externalOnline = !externalOnline;
    renderSurface();
    notify(externalOnline ? "模拟连接恢复，可以按原选区重试" : "模拟连接中断，未确认内容不会进入会话");
  });
  $("minimizeButton").addEventListener("click", () => {
    notify("真实 Preview 会缩成浮窗，工作台仍在下面");
    setSurface("workbench");
  });
  $("closePreviewButton").addEventListener("click", () => setSurface("workbench"));
  $("popoutButton").addEventListener("click", () => setSurface("external"));
  el.reviewCheckbox.addEventListener("change", renderDraft);
  $("reviewOpenButton").addEventListener("click", () => showDraft());
  el.composerSendButton.addEventListener("click", showMessage);
  el.modeButton.addEventListener("click", () => setMode(mode === "file" ? "off" : "file"));
  el.agentAnnotate.addEventListener("click", () => {
    if (surface !== "workbench") return;
    setMode(mode === "agent" ? "off" : "agent");
  });
  el.draftButton.addEventListener("click", () => document.body.classList.contains("draft-open") ? hideDraft() : showDraft());
  $("draftCloseButton").addEventListener("click", hideDraft);
  el.returnButton.addEventListener("click", () => {
    const previous = surface;
    setSurface("workbench");
    if (previous === "preview" && surface === "workbench") {
      el.composerInput.focus({ preventScroll: true });
      notify("回到工作台后，勾选输入区的预览批注再发送");
    }
  });
  el.markdownView.addEventListener("click", (event) => {
    if (event.target.closest(".note-pin")) return;
    if (mode !== "file" || files[currentFile].kind !== "markdown") return;
    const block = event.target.closest("[data-md-start]");
    if (!block) return;
    openSelection({ kind: "markdown", start: Number(block.dataset.mdStart), end: Number(block.dataset.mdEnd) });
  });
  el.agentBody.addEventListener("click", (event) => {
    if (event.target.closest(".note-pin")) return;
    if (mode !== "agent") return;
    const block = event.target.closest("[data-agent-block]");
    if (!block) return;
    const excerpt = block.textContent.replace(/\s+/g, " ").trim().slice(0, 80);
    openSelection({ kind: "transcript", block: Number(block.dataset.agentBlock), excerpt });
  });
  el.htmlStage.addEventListener("pointermove", (event) => {
    if (mode !== "file" || files[currentFile].kind !== "html") return;
    showOutline(event.target.closest("[data-inspect]"));
  });
  el.htmlStage.addEventListener("pointerleave", () => el.inspectOutline.classList.add("hidden"));
  el.htmlStage.addEventListener("click", (event) => {
    if (event.target.closest(".html-marker")) return;
    logRuntime("interaction", "点击 " + event.target.tagName.toLowerCase());
    if (mode !== "file" || files[currentFile].kind !== "html") return;
    const target = event.target.closest("[data-inspect]");
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    showOutline(target);
    openSelection({ kind: "html", selector: selectorFor(target), label: labelFor(target) });
  }, true);
  $("demoSiteCta").addEventListener("click", () => { if (mode !== "file") notify("示例页面按钮已点击"); });
  el.imageOverlay.addEventListener("pointerdown", (event) => {
    if (!mode || mode !== "file" || files[currentFile].kind !== "image") return;
    if (event.target.closest(".saved-image-region") && !el.imageOverlay.classList.contains("drawing")) return;
    event.preventDefault();
    el.imageOverlay.setPointerCapture(event.pointerId);
    imageDrag = { pointerId: event.pointerId, origin: imagePoint(event), x: event.clientX, y: event.clientY };
    selection = targetFromPoints(imageDrag.origin, imageDrag.origin);
    selection.markerNo = nextImageNumber(currentFile);
    renderSelection();
  });
  el.imageOverlay.addEventListener("pointermove", (event) => {
    if (!imageDrag || imageDrag.pointerId !== event.pointerId) return;
    selection = targetFromPoints(imageDrag.origin, imagePoint(event));
    selection.markerNo = nextImageNumber(currentFile);
    renderSelection();
  });
  function finishImageDrag(event) {
    if (!imageDrag || imageDrag.pointerId !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - imageDrag.x, event.clientY - imageDrag.y);
    const target = moved < 6 ? defaultImageTarget(imageDrag.origin) : targetFromPoints(imageDrag.origin, imagePoint(event));
    imageDrag = null;
    if (target.width < 8 || target.height < 8) { closeCompose(); notify("区域太小"); return; }
    openSelection(target);
  }
  el.imageOverlay.addEventListener("pointerup", finishImageDrag);
  el.imageOverlay.addEventListener("pointercancel", () => { imageDrag = null; closeCompose(); });
  $("composeCloseButton").addEventListener("click", closeCompose);
  el.lineAdjust.addEventListener("click", () => el.lineChoices.classList.toggle("hidden"));
  el.commentInput.addEventListener("input", () => { el.commentCount.textContent = el.commentInput.value.length + " / 1000"; });
  el.saveButton.addEventListener("click", saveComment);
  el.copyPending.addEventListener("click", () => void copyPending());
  $("modalCloseButton").addEventListener("click", () => el.modal.classList.add("hidden"));
  el.modal.addEventListener("click", (event) => { if (event.target === el.modal) el.modal.classList.add("hidden"); });
  $("confirmSendButton").addEventListener("click", () => {
    if (modalMode !== "send") return;
    const count = draft().length;
    const before = clone(saved);
    saved[currentSession] = [];
    if (!persist()) { saved = before; return; }
    el.reviewCheckbox.checked = false;
    el.composerInput.value = "";
    renderDraft();
    renderMarkers();
    el.modal.classList.add("hidden");
    notify("演示完成：" + count + " 条批注合成一条模拟消息");
  });
  $("infoButton").addEventListener("click", () => {
    modalMode = "help";
    $("confirmSendButton").classList.add("hidden");
    el.modalTitle.textContent = "三个界面";
    el.modalDescription.textContent = "工作台有会话列表、对话和输入框。Preview 只有当前文件。外部浏览器也只有 Preview。";
    el.messagePreview.textContent = "工作台：左侧换会话，点文件打开 Preview；在已完成的 Agent 回复上批注。\nPreview：头部进入批注，点内容写批注。关闭或最小化回到工作台。\n外部浏览器：保存后出现回执。断线时文字留在原地。发送必须回到原来的 PWA，在输入区勾选草稿。\n本页不能验证真实跨浏览器同步。";
    el.modal.classList.remove("hidden");
  });
  $("runtimeLogButton").addEventListener("click", () => el.runtimeLogPanel.classList.toggle("hidden"));
  $("runtimeLogCloseButton").addEventListener("click", () => el.runtimeLogPanel.classList.add("hidden"));
  $("runtimeShotButton").addEventListener("click", () => {
    runtimeFrames += 1;
    el.runtimeFrameCount.textContent = String(runtimeFrames);
    logRuntime("snapshot", "现场 " + runtimeFrames + "（演示）");
  });
  $("runtimeRecordButton").addEventListener("click", () => {
    recording = !recording;
    $("runtimeRecordButton").textContent = recording ? "停止" : "录制";
    el.runtimeStatus.textContent = recording ? "正在录制" : "日志已开始记录";
    logRuntime("recording", recording ? "开始" : "停止");
  });
  $("runtimeSaveButton").addEventListener("click", () => {
    logRuntime("artifact", "保存运行产物（演示）");
    notify("演示：运行产物仍是诊断 Bundle，不是这条批注草稿");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    el.modal.classList.add("hidden");
    closeCompose();
  });
  window.addEventListener("resize", renderMarkers);

  selectFile("markdown");
  renderDraft();
  renderSurface();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootPreviewAnnotationPrototype, { once: true });
else bootPreviewAnnotationPrototype();
