  var reviewParentOrigin = document.currentScript?.dataset.parentOrigin || "*";
  var mutationCount = 0;
  var scrollTimer = 0;
  function send(kind, detail){
    try {
      parent.postMessage({ source: "genehub-preview-diag", kind: kind, detail: detail || {} }, reviewParentOrigin);
    } catch (e) {}
  }
  function sendRuntime(kind, requestId, detail){
    try {
      parent.postMessage({ source: "genehub-preview-runtime", kind: kind, requestId: requestId, detail: detail || {} }, reviewParentOrigin);
    } catch (e) {}
  }
  function text(value, limit){
    var rendered;
    if (typeof value === "string") rendered = value;
    else if (value instanceof Error) rendered = value.name + ": " + value.message;
    else { try { rendered = JSON.stringify(value); } catch (e) { rendered = String(value); } }
    return String(rendered == null ? "" : rendered).slice(0, limit || 500);
  }
  function safeUrl(value){
    var raw = String(value || "");
    try {
      var parsed = new URL(raw, document.baseURI);
      return (parsed.origin === "null" ? "" : parsed.origin) + parsed.pathname;
    } catch (e) {
      return raw.split(/[?#]/)[0].slice(0, 500);
    }
  }
  function targetLabel(target){
    if (!target || !target.tagName) return "unknown";
    var label = String(target.tagName).toLowerCase();
    if (target.id) label += "#" + String(target.id).slice(0, 80);
    if (target.getAttribute && target.getAttribute("role")) label += "[role=" + String(target.getAttribute("role")).slice(0, 80) + "]";
    if (target.getAttribute && target.getAttribute("name")) label += "[name=" + String(target.getAttribute("name")).slice(0, 80) + "]";
    return label.slice(0, 240);
  }
  function captureDom(){
    var root = document.documentElement;
    var clone = root.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll("[data-genehub-render-sandbox]"), function(node){ node.remove(); });
    Array.prototype.forEach.call(clone.querySelectorAll("script,style"), function(node){
      node.textContent = "[omitted from runtime DOM snapshot]";
    });
    var originals = root.querySelectorAll("input,textarea,select,option,details,dialog");
    var copies = clone.querySelectorAll("input,textarea,select,option,details,dialog");
    Array.prototype.forEach.call(originals, function(node, index){
      var copy = copies[index];
      if (!copy) return;
      var tag = String(node.tagName || "").toLowerCase();
      if (tag === "input") {
        var type = String(node.type || "text").toLowerCase();
        copy.setAttribute("data-runtime-value", type === "password" ? "[redacted]" : String(node.value || "").slice(0, 500));
        copy.setAttribute("data-runtime-checked", node.checked ? "true" : "false");
      } else if (tag === "textarea") {
        copy.textContent = String(node.value || "").slice(0, 2_000);
      } else if (tag === "select") {
        copy.setAttribute("data-runtime-selected-index", String(node.selectedIndex));
      } else if (tag === "option") {
        if (node.selected) copy.setAttribute("selected", ""); else copy.removeAttribute("selected");
      } else if (tag === "details" || tag === "dialog") {
        copy.setAttribute("data-runtime-open", node.open ? "true" : "false");
      }
    });
    Array.prototype.forEach.call(clone.querySelectorAll("*"), function(node){
      Array.prototype.forEach.call(Array.prototype.slice.call(node.attributes || []), function(attribute){
        var name = String(attribute.name || "");
        var value = String(attribute.value || "");
        if (/password|authorization|access[-_]?token|secret/i.test(name)) {
          node.setAttribute(name, "[redacted]");
        } else if (value.indexOf("data:") === 0 && value.length > 240) {
          node.setAttribute(name, value.slice(0, 80) + "…[data omitted]");
        } else if (value.length > 2_000) {
          node.setAttribute(name, value.slice(0, 2_000) + "…[truncated]");
        }
      });
    });
    var html = "<!doctype html>\n" + clone.outerHTML;
    var limit = 300000;
    return {
      capturedAt: Date.now(),
      html: html.slice(0, limit),
      truncated: html.length > limit,
      title: String(document.title || "").slice(0, 500),
      location: safeUrl(location.href),
      viewportWidth: window.innerWidth || 0,
      viewportHeight: window.innerHeight || 0,
      scrollX: Math.round(window.scrollX || 0),
      scrollY: Math.round(window.scrollY || 0),
      activeElement: targetLabel(document.activeElement),
      mutationCount: mutationCount
    };
  }
  function captureRenderedFrame(requestId){
    var api = window.modernScreenshot;
    if (!api || typeof api.createContext !== "function" || typeof api.domToBlob !== "function") {
      sendRuntime("render-snapshot", requestId, { error: "Preview 画面采样器未就绪" });
      return;
    }
    var root = document.documentElement;
    var viewportWidth = Math.max(1, Math.round(window.innerWidth || root.clientWidth || 1));
    var viewportHeight = Math.max(1, Math.round(window.innerHeight || root.clientHeight || 1));
    var edgeScale = 1600 / Math.max(viewportWidth, viewportHeight);
    var scale = Math.max(0.25, Math.min(window.devicePixelRatio || 1, edgeScale));
    var background = "#ffffff";
    try {
      var bodyBackground = document.body ? getComputedStyle(document.body).backgroundColor : "";
      var rootBackground = getComputedStyle(root).backgroundColor;
      background = bodyBackground && bodyBackground !== "rgba(0, 0, 0, 0)" && bodyBackground !== "transparent"
        ? bodyBackground
        : rootBackground && rootBackground !== "rgba(0, 0, 0, 0)" && rootBackground !== "transparent"
          ? rootBackground
          : background;
    } catch (e) {}
    // Descendant iframes inherit this Preview's opaque sandbox origin, so the
    // renderer cannot read its usual style-probe iframe. A hidden shadow root
    // supplies uncontaminated UA default styles without weakening the Preview.
    var sandboxHost = document.createElement("div");
    sandboxHost.setAttribute("data-genehub-render-sandbox", "");
    sandboxHost.style.setProperty("position", "fixed", "important");
    sandboxHost.style.setProperty("left", "-10000px", "important");
    sandboxHost.style.setProperty("top", "-10000px", "important");
    sandboxHost.style.setProperty("width", "1px", "important");
    sandboxHost.style.setProperty("height", "1px", "important");
    sandboxHost.style.setProperty("overflow", "hidden", "important");
    sandboxHost.style.setProperty("visibility", "hidden", "important");
    var sandboxRoot = sandboxHost.attachShadow ? sandboxHost.attachShadow({ mode: "closed" }) : sandboxHost;
    document.documentElement.appendChild(sandboxHost);
    var sandboxDocument = {
      createElement: document.createElement.bind(document),
      createElementNS: document.createElementNS.bind(document),
      body: {
        appendChild: function(node){ return sandboxRoot.appendChild(node); },
        removeChild: function(node){ return sandboxRoot.removeChild(node); }
      }
    };
    var sandboxFrame = {
      contentWindow: {
        document: sandboxDocument,
        getComputedStyle: window.getComputedStyle.bind(window)
      },
      remove: function(){ sandboxHost.remove(); }
    };
    Promise.resolve(api.createContext(root, {
      width: viewportWidth,
      height: viewportHeight,
      scale: scale,
      type: "image/webp",
      quality: 0.78,
      backgroundColor: background,
      maximumCanvasSize: 1600,
      timeout: 10000,
      features: { restoreScrollPosition: true },
      filter: function(node){
        return !(node && node.nodeType === 1 && node.hasAttribute && node.hasAttribute("data-genehub-render-sandbox"));
      },
      autoDestruct: true
    })).then(function(context){
      context.sandbox = sandboxFrame;
      return api.domToBlob(context);
    }).then(function(blob){
      if (!blob || !blob.size) throw new Error("Preview 画面为空");
      sendRuntime("render-snapshot", requestId, {
        blob: blob,
        width: Math.max(1, Math.floor(viewportWidth * scale)),
        height: Math.max(1, Math.floor(viewportHeight * scale)),
        capturedAt: Date.now(),
        mode: "dom-render"
      });
    }).catch(function(error){
      sendRuntime("render-snapshot", requestId, { error: text(error, 500) || "无法生成 Preview 画面" });
    }).finally(function(){
      sandboxHost.remove();
    });
  }
  function previewSelector(element) {
    if (element.id && /^[A-Za-z][\w-]*$/.test(element.id)) return element.tagName.toLowerCase() + "#" + element.id;
    var testid = element.getAttribute && element.getAttribute("data-testid");
    if (testid && testid.length < 80 && testid.indexOf("\"") < 0) return element.tagName.toLowerCase() + "[data-testid=\"" + testid + "\"]";
    var parts = [];
    var current = element;
    var depth = 0;
    while (current && current.nodeType === 1 && current !== document.body && depth < 6) {
      var tag = current.tagName.toLowerCase();
      var parentNode = current.parentElement;
      if (parentNode) {
        var same = 0;
        var index = 1;
        for (var i = 0; i < parentNode.children.length; i++) {
          if (parentNode.children[i].tagName === current.tagName) {
            same++;
            if (parentNode.children[i] === current) index = same;
          }
        }
        if (same > 1) tag += ":nth-of-type(" + index + ")";
      }
      parts.unshift(tag);
      current = parentNode;
      depth++;
    }
    return parts.join(" > ");
  }
  function scrollableAt(x, y) {
    var node = document.elementFromPoint(x, y);
    while (node && node !== document.documentElement) {
      var taller = node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1;
      if (taller) {
        var style = window.getComputedStyle(node);
        var scrollable = /auto|scroll|overlay/.test(style.overflowY) || /auto|scroll|overlay/.test(style.overflowX);
        if (scrollable) return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  var locatedItems = [];
  var annotationActive = false;
  var selectedElement = null;
  var annotationPointer = null;
  var annotationMoved = false;
  var markFrame = 0;
  function elementHit(target) {
    var excerpt = String(target.innerText || target.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 256);
    var box = target.getBoundingClientRect();
    return {
      selector: previewSelector(target).slice(0, 512), tag: target.tagName.toLowerCase().slice(0, 32),
      excerpt: excerpt, domFingerprint: (target.tagName.toLowerCase() + ":" + excerpt.slice(0, 80)).slice(0, 128),
      x: box.left, y: box.top, width: box.width, height: box.height
    };
  }
  function scheduleMarks() {
    if (markFrame || (!locatedItems.length && !selectedElement)) return;
    markFrame = requestAnimationFrame(function(){ markFrame = 0; locateMarks("locate"); });
  }
  function locateMarks(requestId) {
    var marks = [];
    for (var i = 0; i < locatedItems.length && i < 32; i++) {
      var item = locatedItems[i] || {};
      var node = null;
      try { node = document.querySelector(String(item.selector || "")); } catch (e) { node = null; }
      if (!node || !node.getBoundingClientRect) {
        marks.push({ id: String(item.id || ""), missing: true });
        continue;
      }
      var box = node.getBoundingClientRect();
      marks.push({ id: String(item.id || ""), x: box.left, y: box.top, width: box.width, height: box.height });
    }
    sendRuntime("locate", requestId || "locate", {
      marks: marks, selection: selectedElement && selectedElement.isConnected ? elementHit(selectedElement) : null
    });
  }
  // Let WebKit handle pan, momentum and nested scrolling inside the iframe.
  // Capture taps only; no transparent parent layer or synthetic scroll deltas.
  document.addEventListener("pointerdown", function(event){
    if (!annotationActive) return;
    annotationPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    annotationMoved = false;
  }, true);
  document.addEventListener("pointermove", function(event){
    if (!annotationPointer || event.pointerId !== annotationPointer.id) return;
    if (Math.hypot(event.clientX - annotationPointer.x, event.clientY - annotationPointer.y) > 8) annotationMoved = true;
  }, true);
  document.addEventListener("pointercancel", function(){ annotationMoved = true; annotationPointer = null; }, true);
  document.addEventListener("click", function(event) {
    if (annotationActive) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (annotationMoved && event.detail !== 0) return;
      var picked = event.target;
      if (picked && picked.nodeType !== 1) picked = picked.parentElement;
      if (!picked || picked === document.documentElement || picked === document.body) return;
      selectedElement = picked;
      sendRuntime("hit-test", "annotation-pick", elementHit(picked));
      return;
    }
    var node = event.target;
    if (node && node.nodeType !== 1) node = node.parentElement;
    while (node && node !== document.body && String(node.tagName || "").toUpperCase() !== "A") node = node.parentElement;
    if (!node || String(node.tagName || "").toUpperCase() !== "A") return;
    var href = node.getAttribute("href") || "";
    if (!href || /^(javascript:|mailto:|tel:)/i.test(href)) return;
    var parsed;
    try { parsed = new URL(href, document.baseURI); } catch (e) { return; }
    var newWindow = String(node.target || "").toLowerCase() === "_blank";
    if (reviewParentOrigin !== "*") {
      if (!newWindow || !/^https?:$/.test(parsed.protocol)) return;
      event.preventDefault();
      event.stopPropagation();
      sendRuntime("review-new-window", "", { url: parsed.href.slice(0, 4096) });
      return;
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "preview.invalid") return;
    event.preventDefault();
    event.stopPropagation();
    var path = parsed.pathname.replace(/^\/+/, "");
    if (href.charAt(0) === "#" || !path) {
      sendRuntime("open-path", "open-path", { url: href, newWindow: newWindow });
      if (parsed.hash && !newWindow) {
        var target = document.getElementById(decodeURIComponent(parsed.hash.slice(1)));
        if (target && target.scrollIntoView) target.scrollIntoView();
      }
      return;
    }
    sendRuntime("open-path", "open-path", { url: href, newWindow: newWindow });
  }, true);
  window.addEventListener("message", function(event){
    if (event.source !== parent || (reviewParentOrigin !== "*" && event.origin !== reviewParentOrigin)) return;
    var data = event.data;
    if (!data || data.source !== "genehub-preview-runtime-command") return;
    var requestId = String(data.requestId || "");
    if (data.command === "review-go" && reviewParentOrigin !== "*") {
      try {
        var next = new URL(data.url);
        if (next.origin === location.origin && !next.pathname.startsWith("/.well-known/")) location.replace(next.href);
      } catch (e) {}
      return;
    }
    if (data.command === "snapshot-render") {
      if (reviewParentOrigin !== "*" && !window.modernScreenshot
          && typeof data.renderer === "string" && data.renderer.length < 200000) {
        var renderer = document.createElement("script");
        renderer.textContent = data.renderer;
        document.head.appendChild(renderer);
        renderer.remove();
      }
      captureRenderedFrame(requestId);
      return;
    }
    if (data.command === "annotation-mode") {
      annotationActive = data.active === true;
      selectedElement = null;
      if (annotationActive && typeof data.selection === "string") {
        try { selectedElement = document.querySelector(data.selection); } catch (e) {}
      }
      annotationPointer = null;
      annotationMoved = false;
      locateMarks("locate");
      return;
    }
    if (data.command === "scroll-by") {
      var scroller = scrollableAt(Number(data.x) || 0, Number(data.y) || 0);
      if (scroller && scroller.scrollBy) scroller.scrollBy(Number(data.dx) || 0, Number(data.dy) || 0);
      return;
    }
    if (data.command === "locate") {
      locatedItems = Array.isArray(data.items) ? data.items.slice(0, 32) : [];
      locateMarks(requestId);
      return;
    }
    if (data.command === "hit-test") {
      var target = document.elementFromPoint(Number(data.x), Number(data.y));
      if (!target || target === document.documentElement || target === document.body) {
        sendRuntime("hit-test", requestId, { error: "empty" });
        return;
      }
      var excerpt = String(target.innerText || target.getAttribute("alt") || "").replace(/s+/g, " ").trim().slice(0, 256);
      var fingerprint = target.tagName.toLowerCase() + ":" + excerpt.slice(0, 80);
      var hitBox = target.getBoundingClientRect();
      sendRuntime("hit-test", requestId, {
        selector: previewSelector(target).slice(0, 512),
        tag: target.tagName.toLowerCase().slice(0, 32),
        excerpt: excerpt,
        domFingerprint: fingerprint.slice(0, 128),
        x: hitBox.left,
        y: hitBox.top,
        width: hitBox.width,
        height: hitBox.height
      });
      return;
    }
    if (data.command !== "snapshot-dom") return;
    try {
      sendRuntime("dom-snapshot", requestId, captureDom());
    } catch (error) {
      sendRuntime("dom-snapshot", requestId, {
        capturedAt: Date.now(), html: "<!-- DOM snapshot failed: " + text(error, 500) + " -->", truncated: false,
        title: String(document.title || ""), location: safeUrl(location.href), viewportWidth: window.innerWidth || 0,
        viewportHeight: window.innerHeight || 0, scrollX: 0, scrollY: 0, activeElement: "unknown", mutationCount: mutationCount
      });
    }
  });
  window.addEventListener("error", function(e){
    var t = e.target;
    if (t && t !== window && t.tagName) {
      var failedUrl = String(t.currentSrc || t.src || t.href || "");
      // Placeholder failures are expected: the lazy media resolver swaps them
      // for blob URLs and reports its own errors.
      if (isPlaceholderUrl(failedUrl)) return;
      send("resource", {
        tag: String(t.tagName).toLowerCase(),
        src: safeUrl(failedUrl),
        message: "resource load failed"
      });
      return;
    }
    send("error", {
      message: text(e.message || "error", 500),
      source: safeUrl(e.filename || ""),
      line: e.lineno || 0,
      column: e.colno || 0
    });
  }, true);
  window.addEventListener("unhandledrejection", function(e){
    send("error", { message: text(e.reason, 500) });
  });
  if (reviewParentOrigin === "*") {
    window.addEventListener("submit", function(event) {
      if (event.defaultPrevented) return;
      // Local event handlers can process forms. The preview never submits a
      // form as a document navigation; the document CSP also enforces this
      // for direct calls to HTMLFormElement.submit().
      event.preventDefault();
      send("csp", { effectiveDirective: "form-action", message: "预览已阻止表单提交" });
    });
  }
  window.addEventListener("securitypolicyviolation", function(e){
    send("csp", {
      violatedDirective: text(e.violatedDirective, 200),
      effectiveDirective: text(e.effectiveDirective, 200),
      blockedURI: safeUrl(e.blockedURI),
      disposition: text(e.disposition, 80),
      sampleLength: String(e.sample || "").length
    });
  });
  ["debug", "log", "info", "warn", "error"].forEach(function(level){
    var original = console[level] && console[level].bind(console);
    if (!original) return;
    console[level] = function(){
      var rendered = Array.prototype.slice.call(arguments).map(function(arg){ return text(arg, 500); }).join(" ").slice(0, 1000);
      send("console", { level: level, text: rendered });
      return original.apply(console, arguments);
    };
  });
