function bootPreviewAnnotationPrototype() {
  "use strict";

  const STORE_KEY = "genehub-preview-annotations-prototype-v2";
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
    layout: $("demoLayout"), preview: $("previewCard"), name: $("previewFileName"), path: $("previewFilePath"),
    modeButton: $("annotationToggle"), draftButton: $("draftToggle"), draftCount: $("draftCount"), draftPanel: $("draftPanel"),
    runtimeToolbar: $("runtimeToolbar"), runtimeStatus: $("runtimeStatus"), runtimeLogCount: $("runtimeLogCount"),
    runtimeFrameCount: $("runtimeFrameCount"), runtimeLogList: $("runtimeLogList"), runtimeLogPanel: $("runtimeLogPanel"),
    modeHint: $("modeHint"), markdownView: $("markdownView"), htmlView: $("htmlView"), htmlStage: $("htmlStage"),
    inspectOutline: $("inspectOutline"), inspectLabel: $("inspectLabel"), imageView: $("imageView"),
    imageFrame: $("imageFrame"), sampleImage: $("sampleImage"), imageOverlay: $("imageOverlay"), imageRect: $("imageRect"),
    rectLabel: $("rectLabel"), compose: $("composeSheet"), composeTarget: $("composeTarget"), commentInput: $("commentInput"),
    commentCount: $("commentCount"), lineAdjust: $("lineAdjustButton"), lineChoices: $("lineChoices"),
    saveButton: $("saveCommentButton"), draftItems: $("draftItems"),
    draftFooterCount: $("draftFooterCount"), sessionSelect: $("sessionSelect"), sendButton: $("sendButton"),
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
      nextMarker: {
        product: { "dashboard:f10c7e82": 2, "mobile:9c816e42": 2 },
        landing: {},
      },
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
  for (const session of Object.keys(sessions)) {
    if (!saved.nextMarker[session]) saved.nextMarker[session] = {};
  }
  let currentSession = "product";
  let currentFile = "markdown";
  let annotate = false;
  let selection = null;
  let mdRangeBase = null;
  let editingId = null;
  let imageDrag = null;
  let recording = false;
  let modalMode = "send";
  let runtimeFrames = 0;
  const runtimeEvents = [];
  let toastTimer;

  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); }
    catch { notify("本地存储已满；本次编辑只保留在页面中"); }
  }
  function notify(message) {
    el.toast.textContent = message;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2600);
  }
  function draft() { return saved[currentSession]; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
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
    const row = node("li", "", entry);
    el.runtimeLogList.prepend(row);
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
    closeCompose();
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
      el.imageFrame.style.aspectRatio = String(file.width) + " / " + String(file.height);
    }
    document.querySelectorAll("[data-file]").forEach((button) => button.classList.toggle("active", button.dataset.file === key));
    updateModeHint();
    renderMarkers();
  }
  function updateModeHint() {
    const kind = files[currentFile].kind;
    el.modeHint.classList.toggle("hidden", !annotate);
    el.modeHint.textContent = kind === "markdown"
      ? "点渲染后的段落或列表项，直接写批注"
      : kind === "html"
        ? "点页面元素，直接写批注；退出后恢复页面操作"
        : "轻点生成默认区域，或拖动框选；放手后直接写批注";
    el.htmlStage.classList.toggle("inspect-mode", annotate && kind === "html");
    el.imageOverlay.classList.toggle("drawing", annotate && kind === "image");
    el.markdownView.classList.toggle("annotating", annotate && kind === "markdown");
  }
  function setAnnotate(next) {
    annotate = next;
    el.modeButton.textContent = annotate ? "完成批注" : "进入批注";
    el.modeButton.classList.toggle("active", annotate);
    el.modeButton.setAttribute("aria-pressed", String(annotate));
    if (!annotate) closeCompose();
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
    const halfW = .12;
    const halfH = .14;
    const a = { x: Math.max(0, point.x - halfW), y: Math.max(0, point.y - halfH) };
    const b = { x: Math.min(1, point.x + halfW), y: Math.min(1, point.y + halfH) };
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
    if (!element || !annotate || files[currentFile].kind !== "html") {
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
    return "#" + item.markerNo + " 标记区域";
  }
  function mdBlockFor(line) {
    return [...el.markdownView.querySelectorAll("[data-md-start]")].find((block) =>
      Number(block.dataset.mdStart) <= line && Number(block.dataset.mdEnd) >= line);
  }
  function updateLineChoices() {
    const multiLine = selection?.kind === "markdown" && mdRangeBase && mdRangeBase.end > mdRangeBase.start;
    el.lineAdjust.classList.toggle("hidden", !multiLine);
    el.lineChoices.replaceChildren();
    if (!multiLine) { el.lineChoices.classList.add("hidden"); return; }
    const choices = [{
      start: mdRangeBase.start, end: mdRangeBase.end,
      label: "整段 · 第 " + mdRangeBase.start + "–" + mdRangeBase.end + " 行",
    }];
    for (let line = mdRangeBase.start; line <= mdRangeBase.end; line += 1) {
      choices.push({ start: line, end: line, label: "第 " + line + " 行 · " + (sourceLineText[line] || "源文件这一行") });
    }
    for (const choice of choices) {
      const choiceButton = action(choice.label, () => {
        selection.start = choice.start;
        selection.end = choice.end;
        el.composeTarget.textContent = anchorText({ target: selection });
        renderSelection();
        el.lineChoices.classList.add("hidden");
      });
      el.lineChoices.append(choiceButton);
    }
  }
  function openSelection(target, markerNo) {
    selection = clone(target);
    mdRangeBase = target.kind === "markdown" ? { start: target.start, end: target.end } : null;
    editingId = null;
    if (target.kind === "image") selection.markerNo = markerNo || nextImageNumber(currentFile);
    el.composeTarget.textContent = target.kind === "image" ? "区域 #" + selection.markerNo + " · " + files[currentFile].name : anchorText({ target });
    el.compose.classList.remove("hidden");
    el.commentInput.value = "";
    el.commentCount.textContent = "0 / 1000";
    updateLineChoices();
    renderSelection();
    el.commentInput.focus({ preventScroll: true });
  }
  function renderSelection() {
    el.markdownView.querySelectorAll(".selected-target").forEach((item) => item.classList.remove("selected-target"));
    if (selection?.kind === "markdown" && files[currentFile].kind === "markdown") {
      mdBlockFor(selection.start)?.classList.add("selected-target");
    }
    if (selection?.kind !== "html") el.inspectOutline.classList.add("hidden");
    const showRect = selection?.kind === "image" && files[currentFile].kind === "image";
    el.imageRect.classList.toggle("hidden", !showRect);
    if (showRect) {
      applyGeometry(el.imageRect, selection);
      el.rectLabel.textContent = "#" + selection.markerNo;
    }
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
        try { target = el.htmlStage.querySelector(item.target.selector); } catch { /* changed DOM */ }
        if (!target) continue;
        const stage = el.htmlStage.getBoundingClientRect();
        const box = target.getBoundingClientRect();
        const pin = action("●", (event) => { event.stopPropagation(); showDraft(item.id); }, "html-marker");
        pin.style.left = Math.max(0, box.right - stage.left - 10) + "px";
        pin.style.top = Math.max(0, box.top - stage.top - 10) + "px";
        pin.setAttribute("aria-label", "查看这条 HTML 批注");
        el.htmlStage.append(pin);
      } else if (item.target.kind === "image" && files[currentFile].kind === "image") {
        const region = action("#" + item.markerNo, (event) => { event.stopPropagation(); showDraft(item.id); }, "saved-image-region");
        applyGeometry(region, item.target);
        region.dataset.number = "#" + item.markerNo;
        region.setAttribute("aria-label", "查看区域 #" + item.markerNo + " 的批注");
        el.imageOverlay.append(region);
      }
    }
    renderSelection();
  }
  function saveComment() {
    const comment = el.commentInput.value.trim();
    if (!selection || !comment) { notify("请填写批注内容"); return; }
    const file = files[currentFile];
    const items = draft();
    const markerNo = selection.kind === "image" ? selection.markerNo : undefined;
    const target = clone(selection);
    delete target.markerNo;
    const candidate = {
      id: editingId || makeId(), fileKey: currentFile, version: file.version,
      target, ...(markerNo ? { markerNo } : {}), comment,
    };
    if (editingId) {
      const index = items.findIndex((item) => item.id === editingId);
      if (index < 0) { notify("这条批注已移除"); closeCompose(); return; }
      items[index] = candidate;
    } else {
      items.push(candidate);
      if (markerNo) saved.nextMarker[currentSession][currentFile + ":" + file.version] = markerNo + 1;
    }
    persist();
    closeCompose();
    renderMarkers();
    renderDraft();
    notify("已加入当前会话的同一份草稿");
  }
  function showDraft(focusId) {
    el.layout.classList.add("draft-open");
    el.draftButton.setAttribute("aria-expanded", "true");
    renderDraft();
    if (focusId) {
      const card = $("draft-" + focusId);
      card?.classList.add("focused");
      card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
  function hideDraft() {
    el.layout.classList.remove("draft-open");
    el.draftButton.setAttribute("aria-expanded", "false");
  }
  function imageGroup(file, items) {
    const panel = node("div", "draft-image-proof");
    const image = node("img");
    image.src = file.src;
    image.alt = file.name + " 原图和编号区域";
    panel.append(image);
    for (const item of items) {
      const region = node("span", "draft-proof-region", "#" + item.markerNo);
      applyGeometry(region, item.target);
      region.dataset.number = "#" + item.markerNo;
      panel.append(region);
    }
    return panel;
  }
  function edit(item) {
    hideDraft();
    selectFile(item.fileKey);
    setAnnotate(true);
    selection = clone(item.target);
    const block = item.target.kind === "markdown" ? mdBlockFor(item.target.start) : null;
    mdRangeBase = block ? { start: Number(block.dataset.mdStart), end: Number(block.dataset.mdEnd) } : null;
    if (item.markerNo) selection.markerNo = item.markerNo;
    editingId = item.id;
    el.composeTarget.textContent = anchorText(item) + " · " + files[item.fileKey].name;
    el.compose.classList.remove("hidden");
    el.commentInput.value = item.comment;
    el.commentCount.textContent = String(item.comment.length) + " / 1000";
    updateLineChoices();
    renderSelection();
    el.commentInput.focus({ preventScroll: true });
  }
  function remove(item) {
    saved[currentSession] = draft().filter((other) => other.id !== item.id);
    persist(); renderDraft(); renderMarkers(); notify("已移除批注");
  }
  function renderDraft() {
    const items = draft();
    el.draftCount.textContent = String(items.length);
    el.draftFooterCount.textContent = items.length + " 条批注";
    el.sendButton.disabled = items.length === 0;
    el.draftItems.replaceChildren();
    if (!items.length) {
      el.draftItems.append(node("p", "empty-draft", "还没有批注。进入批注模式后，直接点内容即可添加。"));
      return;
    }
    const groups = new Map();
    for (const item of items) {
      const key = item.fileKey + ":" + item.version;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const groupItems of groups.values()) {
      const first = groupItems[0];
      const file = files[first.fileKey];
      if (!file) continue;
      const group = node("section", "draft-group");
      const header = node("div", "draft-group-head");
      header.append(node("strong", "", file.name), node("small", "", file.path + " · " + first.version.slice(0, 6)));
      group.append(header);
      if (file.kind === "image") group.append(imageGroup(file, groupItems));
      for (const item of groupItems) {
        const card = node("article", "draft-item");
        card.id = "draft-" + item.id;
        const lead = node("div", "draft-item-lead");
        lead.append(node("b", "", anchorText(item)), action("↗", () => {
          hideDraft(); selectFile(item.fileKey); setAnnotate(false);
          if (item.target.kind === "markdown") mdBlockFor(item.target.start)?.scrollIntoView({ block: "center" });
          if (item.target.kind === "html") {
            let target = null; try { target = el.htmlStage.querySelector(item.target.selector); } catch { /* stale */ }
            target?.scrollIntoView({ block: "center" });
          }
        }, "jump-button"));
        card.append(lead, node("p", "", item.comment));
        const foot = node("div", "draft-item-actions");
        foot.append(action("编辑", () => edit(item)), action("移除", () => remove(item)));
        card.append(foot);
        group.append(card);
      }
      el.draftItems.append(group);
    }
  }
  function messageText() {
    const groups = new Map();
    for (const item of draft()) {
      const key = item.fileKey + ":" + item.version;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const lines = ["请按以下预览批注继续处理（" + sessions[currentSession] + "）：", ""];
    for (const items of groups.values()) {
      const file = files[items[0].fileKey];
      lines.push("【" + file.path + " · 版本 " + items[0].version + "】");
      if (file.kind === "image") lines.push("原图快照 + 带编号的标注图 + 以下编号批注（原型仅展示，正式版作为会话附件保存）：");
      for (const item of items) lines.push("- " + anchorText(item) + "：" + item.comment);
      lines.push("");
    }
    return lines.join("\n");
  }
  function showMessage() {
    if (!draft().length) return;
    modalMode = "send";
    $("confirmSendButton").classList.remove("hidden");
    el.modalTitle.textContent = "检查一条消息";
    el.modalDescription.textContent = "当前会话的 " + draft().length + " 条批注汇成一条消息；图片按文件分别附原图和编号标注图。";
    el.messagePreview.textContent = messageText();
    el.modal.classList.remove("hidden");
  }

  document.querySelectorAll("[data-file]").forEach((button) => button.addEventListener("click", () => selectFile(button.dataset.file)));
  document.querySelectorAll("[data-shell-action]").forEach((button) => button.addEventListener("click", () => notify("这里是外壳示意；点击左侧文件可继续体验")));
  el.modeButton.addEventListener("click", () => setAnnotate(!annotate));
  el.draftButton.addEventListener("click", () => el.layout.classList.contains("draft-open") ? hideDraft() : showDraft());
  $("draftCloseButton").addEventListener("click", hideDraft);
  el.markdownView.addEventListener("click", (event) => {
    if (event.target.closest(".note-pin")) return;
    if (!annotate || files[currentFile].kind !== "markdown") return;
    const block = event.target.closest("[data-md-start]");
    if (!block) return;
    openSelection({ kind: "markdown", start: Number(block.dataset.mdStart), end: Number(block.dataset.mdEnd) });
  });
  el.htmlStage.addEventListener("pointermove", (event) => {
    if (!annotate || files[currentFile].kind !== "html") return;
    showOutline(event.target.closest("[data-inspect]"));
  });
  el.htmlStage.addEventListener("pointerleave", () => el.inspectOutline.classList.add("hidden"));
  el.htmlStage.addEventListener("click", (event) => {
    if (event.target.closest(".html-marker")) return;
    logRuntime("interaction", "点击 " + event.target.tagName.toLowerCase());
    if (!annotate || files[currentFile].kind !== "html") return;
    const target = event.target.closest("[data-inspect]");
    if (!target) return;
    event.preventDefault(); event.stopPropagation();
    const descriptor = { kind: "html", selector: selectorFor(target), label: labelFor(target) };
    showOutline(target);
    openSelection(descriptor);
  }, true);
  $("demoSiteCta").addEventListener("click", () => notify("示例站点按钮已点击"));
  el.imageOverlay.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".saved-image-region")) return;
    if (!annotate || files[currentFile].kind !== "image") return;
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
    const target = moved < 5 ? defaultImageTarget(imageDrag.origin) : targetFromPoints(imageDrag.origin, imagePoint(event));
    imageDrag = null;
    if (target.width < 8 || target.height < 8) { closeCompose(); notify("区域太小，请重试"); return; }
    openSelection(target);
  }
  el.imageOverlay.addEventListener("pointerup", finishImageDrag);
  el.imageOverlay.addEventListener("pointercancel", () => { imageDrag = null; closeCompose(); });
  $("composeCloseButton").addEventListener("click", closeCompose);
  el.lineAdjust.addEventListener("click", () => el.lineChoices.classList.toggle("hidden"));
  el.commentInput.addEventListener("input", () => { el.commentCount.textContent = el.commentInput.value.length + " / 1000"; });
  el.saveButton.addEventListener("click", saveComment);
  el.sessionSelect.addEventListener("change", () => {
    currentSession = el.sessionSelect.value;
    closeCompose(); renderDraft(); renderMarkers();
    notify("已切换至 " + sessions[currentSession] + " 的草稿");
  });
  el.sendButton.addEventListener("click", showMessage);
  $("modalCloseButton").addEventListener("click", () => el.modal.classList.add("hidden"));
  el.modal.addEventListener("click", (event) => { if (event.target === el.modal) el.modal.classList.add("hidden"); });
  $("confirmSendButton").addEventListener("click", () => {
    if (modalMode !== "send") return;
    const count = draft().length;
    saved[currentSession] = []; persist(); renderDraft(); renderMarkers();
    el.modal.classList.add("hidden");
    notify("演示完成：" + count + " 条批注合为一条模拟消息");
  });
  $("infoButton").addEventListener("click", () => {
    modalMode = "help";
    $("confirmSendButton").classList.add("hidden");
    el.modalTitle.textContent = "最短路径";
    el.modalDescription.textContent = "头部进入批注，直接点内容写批注；头部草稿查看全部，点击标记也可定位批注。";
    el.messagePreview.textContent = "Markdown：点渲染后的段落或列表项。\nH5：点页面元素。退出批注后页面恢复正常交互。\n图片：轻点生成默认区域，拖动可精确框选。每张图独立编号。\n手机：草稿从底部打开。";
    el.modal.classList.remove("hidden");
  });
  $("runtimeLogButton").addEventListener("click", () => el.runtimeLogPanel.classList.toggle("hidden"));
  $("runtimeLogCloseButton").addEventListener("click", () => el.runtimeLogPanel.classList.add("hidden"));
  $("runtimeShotButton").addEventListener("click", () => {
    runtimeFrames += 1; el.runtimeFrameCount.textContent = String(runtimeFrames);
    logRuntime("snapshot", "现场 " + runtimeFrames + " 已采集（演示）");
  });
  $("runtimeRecordButton").addEventListener("click", () => {
    recording = !recording;
    $("runtimeRecordButton").textContent = recording ? "停止" : "录制";
    el.runtimeStatus.textContent = recording ? "● 正在录制；日志继续记录" : "日志已开始记录";
    logRuntime("recording", recording ? "开始录制（演示）" : "停止录制（演示）");
  });
  $("runtimeSaveButton").addEventListener("click", () => {
    logRuntime("artifact", "保存运行产物（演示）");
    notify("演示：真实 Preview 会把诊断 Bundle 保存到会话");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { el.modal.classList.add("hidden"); closeCompose(); }
  });
  window.addEventListener("resize", () => { if (files[currentFile].kind === "html") renderMarkers(); });

  selectFile("markdown");
  renderDraft();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootPreviewAnnotationPrototype, { once: true });
} else {
  bootPreviewAnnotationPrototype();
}
