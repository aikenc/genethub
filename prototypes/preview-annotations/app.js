(() => {
  "use strict";

  const STORE_KEY = "genehub-preview-annotations-prototype-v1";
  const files = {
    markdown: { name: "experience.md", path: "docs/experience.md", icon: "MD", version: "a1f6c29b", label: "Markdown" },
    html: { name: "landing.html", path: "site/landing.html", icon: "⌘", version: "e24a921d", label: "HTML" },
    image: { name: "dashboard.png", path: "design/dashboard.png", icon: "▧", version: "f10c7e82", label: "Image" },
  };
  const sessions = {
    product: { name: "产品体验讨论", avatar: "P" },
    landing: { name: "官网视觉迭代", avatar: "L" },
    mobile: { name: "移动端走查", avatar: "M" },
  };
  const markdownLines = [
    "# 让预览成为对话的一部分",
    "",
    "> 把“这里不对”变成清晰、可定位的反馈。",
    "",
    "## 目标",
    "",
    "用户可以在作品上直接圈选，并将反馈集中整理到当前会话。",
    "Agent 收到的是位置、上下文和人的判断，而不是模糊的描述。",
    "",
    "## 交互原则",
    "",
    "- 选区必须回到原始文件。",
    "- 保存批注不等于立即发送。",
    "- 文件变化后应明确提示锚点失效。",
    "",
    "```ts",
    "type Annotation = { target: SourceAnchor; comment: string };",
    "```",
    "",
    "## 验收",
    "",
    "在多文件之间来回批注，最终仍然只形成一份可检查的会话草稿。",
  ];
  const $ = (id) => document.getElementById(id);
  const els = {
    previewFileIcon: $("previewFileIcon"), previewFileName: $("previewFileName"), previewFilePath: $("previewFilePath"),
    versionPill: $("versionPill"), changeVersionButton: $("changeVersionButton"), modeAction: $("modeAction"),
    markdownView: $("markdownView"), htmlView: $("htmlView"), imageView: $("imageView"),
    lineList: $("lineList"), htmlStage: $("htmlStage"), inspectOutline: $("inspectOutline"), inspectLabel: $("inspectLabel"),
    htmlHint: $("htmlHint"), imageFrame: $("imageFrame"), sampleImage: $("sampleImage"), imageOverlay: $("imageOverlay"), imageRect: $("imageRect"), rectSize: $("rectSize"),
    selectionTitle: $("selectionTitle"), selectionDetail: $("selectionDetail"), annotateButton: $("annotateButton"),
    draftCount: $("draftCount"), draftFooterCount: $("draftFooterCount"), draftItems: $("draftItems"),
    sessionSelect: $("sessionSelect"), sessionAvatar: $("sessionAvatar"), draftCompose: $("draftCompose"),
    composeTarget: $("composeTarget"), commentInput: $("commentInput"), commentCounter: $("commentCounter"),
    saveCommentButton: $("saveCommentButton"), sendButton: $("sendButton"), toast: $("toast"),
    modalBackdrop: $("modalBackdrop"), modalTitle: $("modalTitle"), modalDescription: $("modalDescription"),
    messagePreview: $("messagePreview"), confirmSendButton: $("confirmSendButton"), cancelSendButton: $("cancelSendButton"),
  };
  const versions = Object.fromEntries(Object.entries(files).map(([kind, file]) => [kind, file.version]));
  let toastTimer = null;
  let saved = load();
  if (!saved) {
    saved = {
      product: [
        { id: "seed-1", kind: "markdown", file: files.markdown.path, version: files.markdown.version, target: { start: 7, end: 8 }, comment: "这里建议补充一个断线后继续批注的例子。" },
        { id: "seed-2", kind: "html", file: files.html.path, version: files.html.version, target: { selector: "h2", label: "h2 · 主视觉标题" }, comment: "主标题的第二行在小屏幕上需要更多留白。" },
      ],
      landing: [], mobile: [],
    };
    persist();
  }
  for (const key of Object.keys(sessions)) if (!Array.isArray(saved[key])) saved[key] = [];

  let currentFile = "markdown";
  let currentSession = "product";
  let selection = { kind: "markdown", start: 7, end: 8 };
  let lineDrag = null;
  let imageDrag = null;
  let inspectMode = false;
  let hoveredElement = null;
  let editingId = null;
  let modalMode = "send";
  let mobileRendered = false;

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const value = raw ? JSON.parse(raw) : null;
      return value && typeof value === "object" ? value : null;
    } catch { return null; }
  }
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); }
    catch { toast("本地存储不可用，本次批注只保留在页面中"); }
  }
  function id() {
    return "note-" + (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3600);
  }
  function draft() { return saved[currentSession]; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function selectFile(kind) {
    if (!files[kind]) return;
    currentFile = kind;
    selection = null;
    editingId = null;
    closeCompose();
    inspectMode = false;
    hoveredElement = null;
    mobileRendered = false;
    els.markdownView.classList.toggle("hidden", kind !== "markdown");
    els.htmlView.classList.toggle("hidden", kind !== "html");
    els.imageView.classList.toggle("hidden", kind !== "image");
    els.htmlStage.classList.remove("inspect-mode");
    els.inspectOutline.classList.add("hidden");
    els.markdownView.classList.remove("show-render");
    for (const button of document.querySelectorAll("[data-file]")) button.classList.toggle("active", button.dataset.file === kind);
    for (const button of document.querySelectorAll("[data-tab]")) {
      const active = button.dataset.tab === kind;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    }
    const file = files[kind];
    els.previewFileIcon.textContent = file.icon;
    els.previewFileIcon.className = "preview-file-icon " + kind;
    els.previewFileName.textContent = file.name;
    els.previewFilePath.textContent = file.path;
    els.versionPill.textContent = `版本 ${versions[kind].slice(0, 4)}…`;
    renderModeAction();
    renderSelection();
    renderImageRect();
  }

  function renderModeAction() {
    els.modeAction.replaceChildren();
    const button = document.createElement("button");
    button.type = "button";
    if (currentFile === "markdown") {
      button.textContent = mobileRendered ? "↔ 原文行" : "↔ 阅读视图";
      button.addEventListener("click", () => {
        mobileRendered = !mobileRendered;
        els.markdownView.classList.toggle("show-render", mobileRendered);
        renderModeAction();
      });
    } else if (currentFile === "html") {
      button.textContent = inspectMode ? "✓ 退出检查" : "⌖ 检查元素";
      button.classList.toggle("active", inspectMode);
      button.setAttribute("aria-pressed", String(inspectMode));
      button.addEventListener("click", () => {
        inspectMode = !inspectMode;
        els.htmlStage.classList.toggle("inspect-mode", inspectMode);
        els.htmlHint.textContent = inspectMode ? "检查模式：悬停预览元素并点击选中；退出后可正常操作页面。" : "浏览模式：试试点击页面里的按钮，或开启“检查元素”。";
        if (!inspectMode) els.inspectOutline.classList.add("hidden");
        renderModeAction();
        toast(inspectMode ? "检查模式已开启：点击页面元素以选取" : "已返回浏览模式");
      });
    } else {
      button.textContent = "↺ 重新框选";
      button.addEventListener("click", () => {
        selection = null;
        renderImageRect();
        renderSelection();
        toast("在图片上拖动以绘制新选区");
      });
    }
    els.modeAction.append(button);
  }

  function renderLines() {
    const fragment = document.createDocumentFragment();
    markdownLines.forEach((line, index) => {
      const number = index + 1;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "source-line";
      row.dataset.line = String(number);
      row.setAttribute("aria-label", `第 ${number} 行：${line || "空行"}`);
      const gutter = document.createElement("span");
      gutter.className = "line-number";
      gutter.textContent = String(number).padStart(2, "0");
      const content = document.createElement("span");
      content.className = "line-text";
      if (line.startsWith("#")) content.classList.add("heading");
      if (line.startsWith("```")) content.classList.add("code");
      if (line.startsWith(">")) content.classList.add("quote");
      content.textContent = line || "\u00a0";
      row.append(gutter, content);
      fragment.append(row);
    });
    els.lineList.replaceChildren(fragment);
    renderLineSelection();
  }
  function renderLineSelection() {
    for (const row of els.lineList.querySelectorAll(".source-line")) {
      const line = Number(row.dataset.line);
      const selected = selection?.kind === "markdown" && line >= selection.start && line <= selection.end;
      row.classList.toggle("selected", selected);
      row.setAttribute("aria-pressed", String(selected));
    }
  }
  function lineFromEvent(event) { return Number(event.target.closest("[data-line]")?.dataset.line || 0); }
  els.lineList.addEventListener("pointerdown", (event) => {
    if (currentFile !== "markdown") return;
    const line = lineFromEvent(event);
    if (!line) return;
    event.preventDefault();
    const anchor = event.shiftKey && selection?.kind === "markdown" ? selection.start : line;
    lineDrag = { anchor };
    selection = { kind: "markdown", start: Math.min(anchor, line), end: Math.max(anchor, line) };
    renderSelection();
  });
  els.lineList.addEventListener("pointerover", (event) => {
    if (!lineDrag) return;
    const line = lineFromEvent(event);
    if (!line) return;
    selection = { kind: "markdown", start: Math.min(lineDrag.anchor, line), end: Math.max(lineDrag.anchor, line) };
    renderSelection();
  });
  window.addEventListener("pointerup", () => { lineDrag = null; });
  els.lineList.addEventListener("keydown", (event) => {
    const line = Number(event.target.closest("[data-line]")?.dataset.line || 1);
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = Math.max(1, Math.min(markdownLines.length, line + (event.key === "ArrowDown" ? 1 : -1)));
    if (event.shiftKey && selection?.kind === "markdown") selection = { kind: "markdown", start: Math.min(selection.start, next), end: Math.max(selection.end, next) };
    else selection = { kind: "markdown", start: next, end: next };
    els.lineList.querySelector(`[data-line="${next}"]`)?.focus();
    renderSelection();
  });

  function htmlTarget(event) { return event.target.closest("[data-inspect]"); }
  function selectorFor(element) {
    if (element.id && element.id !== "htmlStage") return `${element.tagName.toLowerCase()}#${element.id}`;
    const tag = element.tagName.toLowerCase();
    const name = element.dataset.inspect;
    const siblings = [...element.parentElement.children].filter((node) => node.dataset?.inspect === name);
    return siblings.length > 1 ? `${tag}[data-inspect="${name}"]:nth-of-type(${[...element.parentElement.children].indexOf(element) + 1})` : `${tag}[data-inspect="${name}"]`;
  }
  function labelFor(element) {
    const text = element.textContent.replace(/\s+/g, " ").trim().slice(0, 35);
    return `${element.tagName.toLowerCase()}${text ? " · " + text : ""}`;
  }
  function showOutline(element) {
    if (!element || currentFile !== "html" || !inspectMode) { els.inspectOutline.classList.add("hidden"); return; }
    const stage = els.htmlStage.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    els.inspectOutline.style.left = `${box.left - stage.left}px`;
    els.inspectOutline.style.top = `${box.top - stage.top}px`;
    els.inspectOutline.style.width = `${box.width}px`;
    els.inspectOutline.style.height = `${box.height}px`;
    els.inspectLabel.textContent = element.tagName.toLowerCase();
    els.inspectOutline.classList.remove("hidden");
  }
  els.htmlStage.addEventListener("pointermove", (event) => {
    if (!inspectMode) return;
    hoveredElement = htmlTarget(event);
    showOutline(hoveredElement);
  });
  els.htmlStage.addEventListener("pointerleave", () => {
    hoveredElement = null;
    if (inspectMode) els.inspectOutline.classList.add("hidden");
  });
  els.htmlStage.addEventListener("click", (event) => {
    if (!inspectMode) return;
    event.preventDefault();
    event.stopPropagation();
    const target = htmlTarget(event);
    if (!target) return;
    selection = { kind: "html", selector: selectorFor(target), label: labelFor(target) };
    showOutline(target);
    renderSelection();
    toast(`已选中 ${target.tagName.toLowerCase()} 元素`);
  }, true);
  $("demoSiteCta").addEventListener("click", () => toast("示例页面按钮已点击。开启“检查元素”可选中它。"));
  document.querySelector(".site-contact").addEventListener("click", () => toast("示例页面：联系我们"));

  function imagePoint(event) {
    const box = els.imageOverlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
    };
  }
  function imageDimensions() {
    return { width: els.sampleImage?.naturalWidth || 1200, height: els.sampleImage?.naturalHeight || 760 };
  }
  function imageSelection(start, end) {
    const size = imageDimensions();
    const x = Math.round(Math.min(start.x, end.x) * size.width);
    const y = Math.round(Math.min(start.y, end.y) * size.height);
    const right = Math.round(Math.max(start.x, end.x) * size.width);
    const bottom = Math.round(Math.max(start.y, end.y) * size.height);
    return { kind: "image", x, y, width: right - x, height: bottom - y, naturalWidth: size.width, naturalHeight: size.height };
  }
  els.imageOverlay.addEventListener("pointerdown", (event) => {
    if (currentFile !== "image") return;
    event.preventDefault();
    els.imageOverlay.setPointerCapture(event.pointerId);
    const point = imagePoint(event);
    imageDrag = { start: point, pointerId: event.pointerId };
    selection = imageSelection(point, point);
    renderImageRect();
    renderSelection();
  });
  els.imageOverlay.addEventListener("pointermove", (event) => {
    if (!imageDrag || imageDrag.pointerId !== event.pointerId) return;
    selection = imageSelection(imageDrag.start, imagePoint(event));
    renderImageRect();
    renderSelection();
  });
  function finishImageDrag(event) {
    if (!imageDrag || imageDrag.pointerId !== event.pointerId) return;
    selection = imageSelection(imageDrag.start, imagePoint(event));
    imageDrag = null;
    if (selection.width < 8 || selection.height < 8) { selection = null; toast("请拖出稍大一些的矩形区域"); }
    renderImageRect();
    renderSelection();
  }
  els.imageOverlay.addEventListener("pointerup", finishImageDrag);
  els.imageOverlay.addEventListener("pointercancel", finishImageDrag);
  function renderImageRect() {
    const shown = currentFile === "image" && selection?.kind === "image" && selection.width > 0 && selection.height > 0;
    els.imageRect.classList.toggle("hidden", !shown);
    if (!shown) return;
    const { x, y, width, height, naturalWidth, naturalHeight } = selection;
    els.imageRect.style.left = `${x / naturalWidth * 100}%`;
    els.imageRect.style.top = `${y / naturalHeight * 100}%`;
    els.imageRect.style.width = `${width / naturalWidth * 100}%`;
    els.imageRect.style.height = `${height / naturalHeight * 100}%`;
    els.rectSize.textContent = `${width} × ${height}`;
  }

  function anchorText(item) {
    const target = item.target || item;
    if (item.kind === "markdown") return `第 ${target.start}${target.start === target.end ? "" : "–" + target.end} 行`;
    if (item.kind === "html") return target.label || target.selector;
    return `(${target.x}, ${target.y}) · ${target.width} × ${target.height} px`;
  }
  function renderSelection() {
    renderLineSelection();
    renderImageRect();
    if (!selection) {
      els.selectionTitle.textContent = "等待选取内容";
      els.selectionDetail.textContent = currentFile === "markdown" ? "点击左侧原文行" : currentFile === "html" ? "开启检查元素，然后点击页面" : "在图片上拖出矩形区域";
      els.annotateButton.disabled = true;
      return;
    }
    els.selectionTitle.textContent = selection.kind === "markdown" ? "已选中 Markdown 原文" : selection.kind === "html" ? "已选中 HTML 元素" : "已框选图片区域";
    els.selectionDetail.textContent = `${anchorText({ kind: selection.kind, target: selection })} · ${files[currentFile].path}`;
    els.annotateButton.disabled = false;
    if (els.draftCompose.classList.contains("open") && !editingId) els.composeTarget.textContent = els.selectionDetail.textContent;
  }

  function openCompose() {
    if (!selection) { toast("请先在预览中选取位置"); return; }
    els.draftCompose.classList.add("open");
    els.composeTarget.textContent = els.selectionDetail.textContent;
    els.saveCommentButton.textContent = editingId ? "保存修改" : "加入草稿";
    els.commentInput.focus();
  }
  function closeCompose() {
    els.draftCompose.classList.remove("open");
    els.commentInput.value = "";
    editingId = null;
    renderCounter();
  }
  function renderCounter() { els.commentCounter.textContent = `${els.commentInput.value.length} / 1000`; }
  function saveComment() {
    const comment = els.commentInput.value.trim();
    if (!selection || !comment) { toast("请先选中位置并写下批注"); return; }
    const items = draft();
    const candidate = { id: editingId || id(), kind: currentFile, file: files[currentFile].path, version: versions[currentFile], target: clone(selection), comment };
    if (editingId) {
      const index = items.findIndex((item) => item.id === editingId);
      if (index < 0) { toast("这条批注已被移除"); closeCompose(); return; }
      items[index] = candidate;
    } else items.push(candidate);
    persist();
    toast(editingId ? "批注已更新" : `已加入“${sessions[currentSession].name}”的同一份草稿`);
    closeCompose();
    renderDraft();
  }

  function button(label, title, callback, className) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.title = title;
    if (className) item.className = className;
    item.addEventListener("click", callback);
    return item;
  }
  function renderDraft() {
    const items = draft();
    const count = items.length;
    els.draftCount.textContent = String(count);
    els.draftFooterCount.textContent = `${count} 条批注`;
    els.sendButton.disabled = count === 0;
    els.draftItems.replaceChildren();
    if (count === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-draft";
      const title = document.createElement("strong");
      title.textContent = "还没有批注";
      const text = document.createElement("p");
      text.textContent = "打开任意预览，选中行、元素或图片区域，写下第一条想法。";
      empty.append(title, text);
      els.draftItems.append(empty);
      return;
    }
    items.forEach((item, index) => {
      const card = document.createElement("article");
      card.className = "draft-item";
      const stale = item.version !== versions[item.kind];
      card.classList.toggle("stale", stale);
      const top = document.createElement("div");
      top.className = "draft-item-top";
      const number = document.createElement("span");
      number.className = "item-number";
      number.textContent = String(index + 1);
      const kind = document.createElement("span");
      kind.className = "item-kind";
      kind.textContent = files[item.kind]?.label || item.kind;
      const path = document.createElement("span");
      path.className = "item-path";
      path.textContent = item.file;
      top.append(number, kind, path);
      const comment = document.createElement("p");
      comment.textContent = item.comment;
      const anchor = document.createElement("span");
      anchor.className = "item-anchor";
      anchor.textContent = stale ? `⚠ 文件已变化 · ${anchorText(item)}` : anchorText(item);
      const actions = document.createElement("div");
      actions.className = "item-actions";
      actions.append(
        button("↗ 跳转", "回到预览位置", () => locate(item)),
        button("编辑", "修改这条批注", () => edit(item)),
        button("↑", "向上移动", () => move(index, -1)),
        button("↓", "向下移动", () => move(index, 1)),
        button("移除", "从草稿中移除", () => { items.splice(index, 1); persist(); renderDraft(); toast("批注已移除"); }, "danger"),
      );
      card.append(top, comment, anchor, actions);
      els.draftItems.append(card);
    });
  }
  function move(index, delta) {
    const items = draft();
    const other = index + delta;
    if (other < 0 || other >= items.length) return;
    [items[index], items[other]] = [items[other], items[index]];
    persist();
    renderDraft();
  }
  function fileKindFor(item) { return files[item.kind] ? item.kind : Object.keys(files).find((key) => files[key].path === item.file); }
  function locate(item) {
    const kind = fileKindFor(item);
    if (!kind) return;
    selectFile(kind);
    selection = clone({ kind, ...item.target });
    renderSelection();
    if (kind === "markdown") els.lineList.querySelector(`[data-line="${selection.start}"]`)?.scrollIntoView({ block: "center" });
    if (kind === "html") {
      inspectMode = true;
      els.htmlStage.classList.add("inspect-mode");
      renderModeAction();
      let element = null;
      try { element = els.htmlStage.querySelector(selection.selector); } catch { /* stale selector */ }
      if (element) showOutline(element);
    }
    document.querySelector(".preview-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (item.version !== versions[kind]) toast("源文件版本已变化，请重新核对选区");
    else toast("已跳转到批注位置");
  }
  function edit(item) {
    locate(item);
    editingId = item.id;
    els.commentInput.value = item.comment;
    renderCounter();
    openCompose();
  }
  function switchSession(id) {
    if (!sessions[id]) return;
    currentSession = id;
    els.sessionSelect.value = id;
    els.sessionAvatar.textContent = sessions[id].avatar;
    closeCompose();
    renderDraft();
    toast(`当前会话：${sessions[id].name}`);
  }
  function messageText() {
    return `请根据以下预览批注继续处理（${sessions[currentSession].name}）：\n\n` + draft().map((item, index) =>
      `${index + 1}. ${item.file} · ${anchorText(item)}${item.version !== versions[item.kind] ? " [源文件已变化，请核对]" : ""}\n   ${item.comment}`
    ).join("\n\n");
  }
  function showModal(mode) {
    modalMode = mode;
    if (mode === "send") {
      if (!draft().length) return;
      els.modalTitle.textContent = "作为一条消息发送";
      els.modalDescription.textContent = `“${sessions[currentSession].name}”中的 ${draft().length} 条批注会合并为一条消息。`;
      els.messagePreview.textContent = messageText();
      els.confirmSendButton.classList.remove("hidden");
      els.cancelSendButton.textContent = "继续编辑";
    } else {
      els.modalTitle.textContent = "这个原型可以这样玩";
      els.modalDescription.textContent = "用三个文件试一遍完整的选取、批注和汇总流程。";
      els.messagePreview.textContent = "01  在 Markdown 中点击或拖动原文行。\n02  在 HTML 中开启“检查元素”，再点页面元素。\n03  在图片上拖出一个矩形。\n04  给每个选区写批注，观察右侧同一份会话草稿。\n05  切换会话、模拟文件更新，最后检查发送预览。";
      els.confirmSendButton.classList.add("hidden");
      els.cancelSendButton.textContent = "明白了";
    }
    els.modalBackdrop.classList.remove("hidden");
  }
  function hideModal() { els.modalBackdrop.classList.add("hidden"); }

  document.querySelectorAll("[data-file]").forEach((item) => item.addEventListener("click", () => selectFile(item.dataset.file)));
  document.querySelectorAll("[data-tab]").forEach((item) => item.addEventListener("click", () => selectFile(item.dataset.tab)));
  els.sessionSelect.addEventListener("change", () => switchSession(els.sessionSelect.value));
  $("clearSelectionButton").addEventListener("click", () => { selection = null; renderSelection(); closeCompose(); els.inspectOutline.classList.add("hidden"); });
  els.annotateButton.addEventListener("click", openCompose);
  $("closeCompose").addEventListener("click", closeCompose);
  els.commentInput.addEventListener("input", renderCounter);
  els.saveCommentButton.addEventListener("click", saveComment);
  els.sendButton.addEventListener("click", () => showModal("send"));
  $("helpButton").addEventListener("click", () => showModal("help"));
  $("draftInfoButton").addEventListener("click", () => showModal("help"));
  els.cancelSendButton.addEventListener("click", hideModal);
  els.confirmSendButton.addEventListener("click", () => {
    if (modalMode !== "send") return;
    const count = draft().length;
    saved[currentSession] = [];
    persist();
    renderDraft();
    hideModal();
    toast(`演示完成：${count} 条批注已合并为一条模拟消息`);
  });
  els.modalBackdrop.addEventListener("click", (event) => { if (event.target === els.modalBackdrop) hideModal(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { hideModal(); closeCompose(); } });
  els.changeVersionButton.addEventListener("click", () => {
    const initial = files[currentFile].version;
    versions[currentFile] = versions[currentFile] === initial ? initial + "-rev2" : initial;
    els.versionPill.textContent = versions[currentFile] === initial ? `版本 ${initial.slice(0, 4)}…` : "版本已更新";
    renderDraft();
    toast(versions[currentFile] === initial ? "已恢复示例文件版本" : "已模拟文件变化：旧批注会提示重新核对");
  });

  renderLines();
  renderModeAction();
  renderSelection();
  renderDraft();
})();
