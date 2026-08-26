# HTML Preview 按需加载与本地服务器代理提案

> 状态：P0+P1 已实施（分支 `preview-on-demand`）；P2/P3 与服务器代理模式未实施。基于 [轻量 Asset Preview v4](./assets-quick-preview.md) v4.2 的现行契约做增量优化，不改变其安全模型与 URL 契约。真 WebRoot HTTP origin 在 v4 中明确不做，本文 P3 重新评估其桌面端形态。

## 1. 背景与问题

现行 HTML 预览链路：

1. Viewer 经 `asset.preview` Exchange 拉取入口 HTML；
2. `remapHtmlSite`（`packages/workbench/src/preview/htmlSite.ts`）在**父页面**递归预取整个静态资源图，全部内联进一个 srcdoc：CSS（含 `url()`/`@import` 递归）内联为 `<style>`，JS module 图用正则递归改写为 data: URL 并拉平，`<img>/<video>/<audio>/<source>` 全部转 base64 data: URL；
3. 运行时相对 `fetch`/XHR 由 iframe 内注入的 bridge 拦截，postMessage 转发父页面再落到 `asset.preview`（ArrayBuffer transferable 零拷贝回传）。

瓶颈：

- **静态图串行预取**：link → script → img 分组串行 await，`rewriteJs` 递归同样串行；每个资源一次 `asset.preview` 往返 + 磁盘读；
- daemon 侧 preview 读取全局仅 2 个并发槽（`apps/daemon/src/dataplane/preview.rs` 的 `Semaphore::new(2)`）；
- base64 体积 +33%，全部拼进单个 srcdoc 一次性赋值，**首屏之前零渲染**；
- 预算上限 256 文件 / 256 MiB，稍大的应用直接触发 budget warning 或长时间白屏。

结果：稍大的 H5 应用（游戏、SPA）预览等待时间过长，几乎无法体验。

## 2. 目标与约束

**目标**：子资源按需加载，首屏时间从「全图预取完成」降到「入口 HTML + loader 就绪」。

**约束**：

- **Authoring 契约不变**：Agent 产物仍是纯静态站点——入口 `index.html` + 相对路径引用，桌面双击 html 文件可直接打开。不为预览引入任何页面侧约定；
- **Agent 零感知**：所有拦截逻辑由 Viewer 自动注入（bridge 本来就是注入的），不要求 Agent 在页面里嵌入任何脚本。理解成本为零甚至为负（见 §8 SKILL 引导）；
- **安全模型不变**：仍是 `sandbox="allow-scripts"` opaque origin srcdoc + 现有 CSP 框架，仅按需放宽 `blob:`（见 §5）；
- 不追求覆盖 H5 标准全集，只覆盖「Agent 实际生成的写法」并有降级兜底（见 §4.4）。

## 3. 核心洞察

资源加载在浏览器里有两条完全不同的路径：

1. **JS 接口路径**：`fetch`、XHR、`new Worker()`、`new Image()`、`img.src = ...` 等——全部是 JS 函数/构造器/属性 setter，**可以 mock**；
2. **标签原生路径**：`<img src>`、`<link>`、`<script src>`、CSS `url()`、ES module 静态 `import`——不经过任何 JS 函数，**没有钩子可挂**。

按需加载的**传输通道已经存在**（bridge 的 fetch/XHR 转发 + `resolveRuntimeAssetPath`）。缺的只是把声明式资源也接到这条通道上。因此方案不是新建通道，而是补一个 **iframe 内的声明式资源解析器**。

## 4. Mock 三层拦截架构

一个注入式 loader（Viewer 注入，Agent 零感知），三层汇入同一条 postMessage 资产通道：

```text
JS API 层   fetch / XHR / Worker / new Image / img.src=     → 函数/构造器/setter 替换
DOM 层      静态 HTML 与漏网的 setAttribute/innerHTML        → MutationObserver
文本层      CSS url() / ES module import 图                  → 惰性文本改写
            │
            ▼ 全部汇入 postMessage 资产通道（现有，ArrayBuffer transferable）
```

### 4.1 JS API 层

| 接口 | mock 方式 | 优先级 |
|---|---|---|
| `fetch()` | 替换 `window.fetch` | ✅ 已实现 |
| `XMLHttpRequest` | hook prototype open/send | ✅ 已有日志钩子，可扩展为接管 |
| `img.src = ...` / `new Image()` | `Object.defineProperty(HTMLImageElement.prototype, "src", ...)` 拦截 setter，通道取字节后 iframe 内 `createObjectURL` 赋回 | **必做** |
| `script.src` / `link.href` / `video.src` / `source.src/srcset` | 同名原型 setter hook | 必做 |
| `new Worker("w.js")` | 替换构造器：通道取脚本 → blob URL → `new Worker(blobUrl)` | P2 可选 |
| `WebAssembly.instantiateStreaming(fetch(...))` | fetch 已接管，Response 带对 MIME 即可 | ✅ 间接可用 |

**Worker 说明**：mock 替换的只是「脚本从哪来」，不是「在哪跑」——blob worker 照样由浏览器开独立线程，**多线程能力原封不动**。现有 CSP 已放行 `worker-src blob: data:`，无需改安全策略。对齐 Mobile H5 标准，worker 不是必须项，定位为 P2 可选增强（wasm 游戏、图像处理类会用）。worker 内部的 `importScripts()` 是同步 API，走不了异步 postMessage 通道，需在 worker 创建时对脚本做文本预改写（参数解析为 data:/blob: URL），用到才解析，仍是惰性。

### 4.2 DOM 层

标签触发的加载无法拦截本身，但「属性赋值」这个动作可以：

- **MutationObserver**：兜底覆盖静态 HTML 与一切漏网写法，扫到指向 `https://preview.invalid/` 的 src/href 就走通道解析为 blob URL 替换；
- 配合 §4.1 的原型 setter hook，三条写入路径（静态标签、`el.src = ...`、`setAttribute`）全覆盖；`srcset` 一并处理；
- 可选 IntersectionObserver 实现视口内才加载（游戏大图集收益明显）。

iframe 内创建的 blob: URL 在 opaque origin 中可用（只有父页面创建的不可用），这正是现行内联方案的注释所确认的边界，本方案在其内侧工作。

### 4.3 文本层

运行期没有任何 JS 附着点的两类，只能在文本进入文档前改写（复用现有逻辑，从「预取」变「用到才取」）：

- **CSS `url()` / `@import`**：`<link rel=stylesheet>` 按需取回文本 → `rewriteCssUrls` 改写 → 内联 `<style>` 注入。懒加载粒度是 CSS 文件；CSS 内的媒体资源在该 CSS 应用时并行拉取（等同真实浏览器行为）；
- **ES module 静态/字面量动态 import**：`import` 是语法不是函数，无法运行期覆盖。保留 `rewriteJs` 正则改写，移到 iframe 内**惰性递归**——fetch 到哪个模块才改写哪个，不再提前拉平全图。

### 4.4 拦不住的与降级策略

不需要完美符合 H5 标准全集：页面本身照常写标准 H5（满足双击可开契约），mock 层只需覆盖 Agent 实际生成的写法集合。已知冷僻边界（`sendBeacon`、SVG `<use>` 跨文档、非字面量动态 import、`srcset` 特殊语法）走**降级**：取不到就保留原行为（失败），经 bridge 已有的 error/resource 诊断事件上报，暴露出来再补，而不是追求一步到位的全覆盖。

附带收益：非字面量动态 `import()`、相对路径 `new Worker()` 在现行模型下本就失败（解析到 `preview.invalid` 后真实请求不可达），本方案修复这两类。

## 5. CSP 调整

| 指令 | 现状 | 调整为 | 原因 |
|---|---|---|---|
| `img-src` | `data: https:` | 加 `blob:` | 懒加载图片 |
| `media-src` | `data: https:` | 加 `blob:` | 懒加载音视频 |
| `font-src` | `data: https:` | 加 `blob:` | CSS 内字体 |
| `script-src` | 已含 `blob:` | 不变 | blob module/worker 已可用 |
| `worker-src` | `blob: data:` | 不变 | 已放行 |

其余（object/frame/form/navigate-to 禁令、opaque sandbox）不动。edge 按路径区分 CSP 的部署契约（v4 §7）不变。

## 6. 分层路线图

### P0 — 并行化与缓存（不改模型，纯提速）

- `remapHtmlSite` 内加并发池（6–8），同层资源并行拉取；
- daemon preview 信号量从 2 调大（或按会话分配）；
- 按 `(path, version)` 缓存资源字节，重复打开/共享资源不重复拉。

### P1 — 媒体懒加载（改动小，收益最大）

- remap 时 `<img>/<video>/<audio>/<source>/<use>` 的 src **不取字节**，只改写为 `https://preview.invalid/...` 占位 URL，立即出 srcdoc；
- bridge 加 MutationObserver + 原型 setter hook（§4.1/§4.2），用到才经通道取字节、iframe 内 blob 化赋值；
- 游戏类应用字节大头在媒体，此步即可让首屏秒出、图片渐显。

### P2 — CSS/JS 全面按需 + Worker（loader 完整形态）

- `remapHtmlSite` 逻辑从父页面搬进 iframe loader：`script[src]` 按序 fetch+执行，module 图惰性递归改写，`<link>` 文件粒度按需；
- 父页面零预取，首屏 = 入口 HTML + loader；
- Worker 构造器 mock + `importScripts` 文本预改写（可选增强）。

### P3 — 真实源 + Service Worker（桌面端长期方向）

- 桌面端（Tauri）注册自定义协议（如 `genehub-preview://<session>/<path>` → daemon 读工作区文件），iframe 用 `src` 而非 srcdoc，浏览器**原生**按需加载一切——流式、HTTP 缓存、lazy img、video range、module worker、import map，这些是 JS 桥永远拦不全的；
- 代价：安全模型从 opaque srcdoc 改为「随机会话源 + CSP 头 + 鉴权」；web/移动宿主需 localhost 端口方案或停留在 P1/P2；
- 与 [云端 Assets Gateway](./assets-cloud-gateway.md)、[daemon HTTPS + SNI 隧道](./assets-daemon-https-sni-tunnel.md) 的关系届时一并评估。

**建议**：先做 P0+P1（不改安全模型、不改 authoring 契约、Agent 零感知），P2 在 P1 的 loader 框架上自然延伸，P3 单独立项。

## 7. 本地服务器代理模式

### 7.1 动机与定位

Agent 起本地 HTTP 服务器有两类原因：

- **误区的**：以为 ES module / wasm / 相对路径必须走 http://。现行 preview 已解决，**静态站点不需要服务器**；
- **真实的**：后端逻辑——Express/Flask API、服务端状态、WebSocket 后端、SSR。静态 preview 给不了。

直接 iframe `http://127.0.0.1:PORT` 不可取：web/移动宿主下 mixed content 被挡；页面跑在真实 localhost 源上，cookie/localStorage 暴露，安全模型改变。

**方案**：复用同一条 mock 通道，把「源」做成可插拔的——

```text
mock 通道的目标：
  默认模式   → 工作区文件系统（asset.preview，现状）
  服务器模式 → HTTP 转发到 Agent 登记的 127.0.0.1:PORT
```

iframe 仍是 opaque srcdoc + `preview.invalid` 基址，安全模型零变化、无 mixed content；静态资源、API 响应、SSE/WebSocket（通道加消息类型）都能过。两种模式同一份 mock 层，只是父页面 `fetchAsset` 的实现不同。

### 7.2 注册：代理是被追踪进程的属性，不是独立资源

daemon 已按 session 追踪 Agent 留下的进程（`genet process list/kill/kill-all --session`，会话结束统一回收）。代理注册与服务器启动**合并为一步**：

```bash
genet shell --background --expose 127.0.0.1:1211 --name api \
  -- python3 server.py --port 1211
```

daemon 侧记录挂在已有进程表上：

```text
session_id → process(pid, 已追踪) → proxy { name, addr, ready }
```

- daemon 对端口做**就绪探测**，连得上才标记 `ready`；
- workbench 从会话元数据看到活跃 proxy 列表，Preview 面板显示为可预览目标；
- 独立命令 `genet proxy add 127.0.0.1:1211 --name api --pid <pid>` 保留为兼容形式（给已在跑的进程补登记），同样必须绑定 pid。

### 7.3 移除：四条清理路径

1. **进程退出 → 自动移除（主路径）**。daemon 本就在 reap 追踪的子进程，进程死，附着的 proxy 元数据随之销毁。Agent 不需要、也不应该负责「移除代理」——它只对服务器进程负责，而进程管理是现有契约；
2. **会话结束 / daemon reload → 连带移除**。session 销毁时其进程全部被杀，代理自然清零；
3. **显式移除（逃生口）**。`genet process kill <pid>` 杀服务器连带删代理；`genet proxy remove <name>` 只摘登记不杀进程（误登记场景）；Preview 面板上用户可「断开」；
4. **健康检查兜底**。端口持续拒绝连接但进程未退（服务器内部 crash）→ 标记 `dead`、UI 变灰，超时后移除登记。

设计原则：**代理不是资源，是被追踪进程的一个属性**——孤儿代理在构造上不可能出现。

### 7.4 边界

- 只允许登记 `127.0.0.1`，拒绝 `0.0.0.0`/外部地址，防止预览通道变成跳板；
- 默认**会话隔离**：只有本会话的 preview 能用本会话的 proxy；跨会话共享需显式授权。

## 8. SKILL 引导契约

内置 SKILL 把 Agent 的理解成本降为一条规则——**静态优先，服务器是例外**：

1. 纯静态 H5（含 module/wasm/worker）→ 直接产静态文件，preview 原生支持，桌面双击 `index.html` 也能开；
2. 确实需要后端 → `genet shell --expose 127.0.0.1:PORT --name <name>` 起服务，preview 入口自动出现；服务停，入口自动消失；
3. 禁令：禁止绑 `0.0.0.0`；禁止假设固定端口（端口须可配置并以 `--expose` 的实参为准）。

Agent 无需了解 preview 内部机制（srcdoc、bridge、通道），只需遵守上述契约。

## 9. 非目标

- 不改变 `asset.preview` Exchange 契约、64 MiB 单文件上限、类型 allowlist；
- 不做缩略图、转码、Range（P3 再评估）；
- 不追求 H5 标准全集的拦截覆盖（§4.4）；
- web/移动宿主的 P3 真实源方案不在本期。

## 10. 验收（按阶段）

**P0**

- 100 个小资源的静态图拉取总耗时显著低于串行基线；并发上限生效；
- 同一 `(path, version)` 二次打开不重复请求。

**P1**

- 含 50+ 媒体的页面：srcdoc 生成不等待任何媒体字节，首屏即时可见，媒体随解析渐显；
- 静态 `<img src>`、`img.src = ...`、`new Image()`、`setAttribute("src")` 四条路径都能懒加载；
- CSP 含 `blob:` 后诊断无违例；缺资源走降级并有诊断事件。

**P2**

- 父页面零预取：首屏网络请求只有入口 HTML；
- module 图按运行时实际访问顺序惰性加载；非字面量动态 import 与相对路径 Worker 可用；
- blob worker 在多核上真实并行（计时验证）。

**代理模式**

- `genet shell --expose` 起服务后 preview 面板出现入口，页面内相对 fetch/标签均落到该端口；
- 服务器进程退出 / 会话结束 / `process kill` 后入口自动消失；`proxy remove` 不杀进程；
- 登记 `0.0.0.0` 或外部地址被拒绝；跨会话访问他方 proxy 被拒绝。

## 11. 待决问题

- P1 占位 URL 的失效策略：媒体在预览打开期间被 Agent 改写，`version` 变化后 blob 缓存如何失效；
- SSE/WebSocket 经 postMessage 通道的消息类型与背压设计；
- `--expose` 与 `genet shell` 现有输出流契约的合并方式（同一进程既要管 stdout/stderr 又要管端口）；
- P3 自定义协议与既有 [SNI 隧道](./assets-daemon-https-sni-tunnel.md) 提案的取舍。
