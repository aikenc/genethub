# Asset Preview 选取与会话批注提案

状态：提案，尚未实现。日期：2026-09-28。基线：`genethub` `de362309`、`genethub-cloud` `4fc16e9`（当日已与各自 `origin/main` 一致）。本文中的 RPC、字段和限额均为建议契约；验收通过前不应写成现有能力。

交互参考：[可直接打开的 H5 原型](../prototypes/preview-annotations/index.html)。它用示例文件和浏览器本地存储演示选取、批注、会话切换与发送预览；不连接实际 Preview、daemon 或 Agent。

## 1. 目标与决策

人在 Preview 中指出具体位置、写下批注，之后在**当前会话的一份草稿**中检查并一次发送给 Agent。支持 Markdown 原文行、运行中的 HTML 元素和图片矩形区域。一个草稿可混合多个文件和三种锚点；批注是用户输入，不因选取、保存或关闭 Preview 自动发送。

建议把它作为工作台的受信操作：Preview 只提供可选取的画面及有界候选信息；工作台确认人发起的选择、绑定精确会话并经已有认证连接保存。源文件保持只读，批注随会话保存在其 Space 中；Hub 与 Relay 不增加明文批注仓库。

首版同时覆盖工作台内的全屏 Preview 和与工作台关联的新窗口 Preview。没有会话关联的普通分享链接仍能看文件；点“添加批注”时需先选择可写会话。小/中浮窗只用于浏览和放大，选取在全屏或独立页进行，避免与拖动浮窗的手势冲突。

## 2. 现状与需要移动的边界

| 事实 | 依据 | 对方案的影响 |
| --- | --- | --- |
| `asset.preview` 返回完整文件、类型和源内容版本；`version` 来自首遍文件 SHA-256 的前 16 字节 | [文件读取](../apps/daemon/src/files.rs)、[协议类型](../packages/proto/src/data.rs) | 使用现有内容版本做失效检测，无需让 Preview URL 承载批注 |
| Markdown 文档经 `react-markdown` 渲染；渲染 DOM 不保证一行对应一个元素 | [Markdown 渲染器](../packages/workbench/src/session/Markdown.tsx)、[预览页](../packages/workbench/src/preview/AssetPreviewPage.tsx) | 精确的“按行”要以原文行为准，不能从换行后的像素或段落序号反推 |
| HTML 在 `sandbox="allow-scripts"` 且无同源权限的 `srcdoc` 中运行；现有桥接只服务诊断、快照、资源与存储 | [预览页](../packages/workbench/src/preview/AssetPreviewPage.tsx)、[Preview v4](assets-quick-preview.md) | 元素命中测试应在 iframe 内进行；父页不能读其 DOM，也不能把桥接消息当做人点击证明 |
| 图片以 Blob URL 放入 `object-contain` 的 `<img>` | [预览页](../packages/workbench/src/preview/AssetPreviewPage.tsx) | 需要把显示矩形映射回解码后图片的原始尺寸，剔除留白 |
| `SessionDraft` 是文本和附件；`session.drafts.replace` 一次替换最多五条，缺少逐条原子追加；运行产物只向 Composer 追加引用行 | [草稿类型](../packages/proto/src/domain.rs)、[daemon 草稿](../apps/daemon/src/session/manager.rs)、[运行产物引用](../packages/workbench/src/preview/sessionArtifactUpload.ts) | 不能在多个窗口上用整组 `replace` 拼批注；也不能把 Composer 中几行文字称为一份持久草稿 |

[Preview v4](assets-quick-preview.md) 的文件只读边界与 [Cloud 产品方向](../../genethub-cloud/docs/product.md) §5.1 对“严格单向”的描述需要协调：当前代码已有用户主动保存 HTML 运行产物并给 Composer 追加引用的回路，但尚无结构化选区批注。文件读取仍只读；本提案新增的是用户明确触发的**会话草稿写入**，不是任意 HTML 页面获得 daemon RPC。先更新边界文档和协议设计，再写桥接实现。

## 3. 用户操作

1. 打开受支持的文件，按“批注”进入选取模式。标题栏显示目标会话；目标不明时先选会话，离线或无权限时显示不可保存原因。
2. 选取行、元素或矩形后，工作台显示锚点摘要和批注输入框。只有用户按“加入草稿”才写入。保存成功出现“已加入当前会话草稿”及总数；保存失败保留输入和选区，可重试同一操作 ID。
3. 会话 Composer 显示固定的一张“预览批注草稿”卡片。卡片按加入顺序列出不同文件的批注，允许编辑文字、删除、重排和跳回源位置。普通已存草稿及当前输入框文字不被覆盖。
4. 用户在卡片里预览将发送的单条消息，确认后发送。发送使用原有持久消息 ID 和确认语义；确认前保留草稿。若发送期间又加入批注，只清除已确认发送的快照，新条目留在同一张草稿卡片。

未发送的新会话没有 `sessionId`。建议沿用当前“保存普通草稿会先创建 Session”的实际行为：用户第一次按“加入草稿”时创建真实会话，并在按钮旁说明此动作会创建会话；创建失败则选区和文字仍留在当前页面。切换机器、Workspace 或会话后，异步保存结果只更新原来的精确目标，不抢回当前页面。独立 Preview URL 中的 `sessionId` 只是导航提示；保存前仍需用已认证连接验证该会话属于目标 Workspace 且可写。

## 4. 三种选取器

### Markdown：原文行

保留现有渲染视图，增加“原文行”选取视图。每一物理原文行有行号；点击选单行，Shift 点击或拖动选连续区间，键盘可用方向键扩展。宽屏可并排看渲染结果，窄屏在两个视图间切换。段落软换行、列表缩进、表格及 fenced code 都按源文件的 1-based 行号计算；CRLF 规范化只影响界面分行，不改变源文件内容。保存 `startLine/endLine` 和有界原文摘录；回跳时按源版本重新读取并高亮对应行。

### HTML：简化检查元素

“检查元素”模式在受信父页覆盖一层透明命中区域。父页接收真实指针位置和点击，把相对 iframe viewport 的坐标及一次请求 ID 发给 iframe；注入桥以 `elementFromPoint` 回答候选元素。父页描边和展示标签、短文本及候选路径；人点击后才可填写批注。普通浏览模式下页面交互照常，检查模式可退出后滚动再进入。键盘至少可退出模式、确认当前候选和操作批注表单。

桥接只返回有界的 `tag`、优先级为稳定 ID / `data-testid` / 结构路径的 selector、短文本、元素矩形及 DOM 指纹。不要返回整份 DOM、表单值、密码或脚本源码。页面脚本与注入桥共享 iframe 环境，因而可以伪造候选回复；父页必须把回复当不可信数据，只接受自己当前 iframe、当前请求 ID、当前预览代次和**父页真实点击**对应的回复。元素由 JS 动态生成时，锚点代表运行时 DOM，不声称能定位到 HTML 源码行。回跳时重新解析 selector 并核对指纹；不匹配则标“元素已变化”，保留原批注供人重选。

### 图片：原图矩形

在图片显示内容区域上拖出、调整矩形；触屏用手指拖动，且不把 `object-contain` 留白计入选区。保存解码后、按浏览器显示方向的 `naturalWidth/naturalHeight` 和整数 `x/y/width/height`；重绘时由这组值计算归一化比例。零面积和越界矩形不能保存。原文件内容版本或解码尺寸变化时标失效；首版不自动裁剪或上传整图副本。

## 5. 数据、身份和一致性契约

建议在 [统一协议](../packages/proto/src/domain.rs) 定义带判别字段的 `PreviewAnnotation`，由协议生成 TypeScript 类型。示意：

```ts
type PreviewAnnotation = {
  id: string;                 // 同一次保存重试复用，服务端去重
  source: {
    root: "primary" | { workspaceFolderPath: string };
    relativePath: string;
    contentVersion: string;
  };
  target:
    | { kind: "markdownLines"; startLine: number; endLine: number; excerpt: string }
    | { kind: "htmlElement"; selector: string; tag: string; excerpt: string; domFingerprint: string }
    | { kind: "imageRect"; x: number; y: number; width: number; height: number; naturalWidth: number; naturalHeight: number };
  comment: string;
  createdAtMs: number;
};
```

准确的写入目标由已认证连接、Workspace 和 Session 决定，浏览器不能用请求字段改投别的机器。`rootHandle` 是设备本地映射，只用于本次 Preview 寻址，不写进会话持久数据；daemon 在保存时把它核验并转换为稳定的 Workspace 根描述。普通 folder 项目使用 `primary`；`.code-workspace` 多根使用规范化的 `folders[].path`，不用显示名称或可变索引。跨设备无法解析绝对路径根时，批注仍可读，但回跳显示“源文件在此设备不可用”。不要以用户给的 URL 字符串作为持久身份或授权凭证。

每个真实 Session 拥有零或一份 `previewReviewDraft`，由 daemon 保存在该 Session 的 `.genethub/sessions/<session>/` 内；不在浏览器 `localStorage`、Hub 或 daemon `<data>` 目录放业务副本。建议独立于旧版会反序列化和重写的 `meta.json`，例如使用会话级追加日志 `preview-review.jsonl`，避免旧 daemon 打开会话时抹掉新字段。实现前须确定有界恢复及必要的快照/压缩规则，并更新 [会话布局](session-storage.md)。它在 Composer 中算一张专用草稿卡片，不占普通最多五条草稿的额度。会话删除时一同删除；草稿版本用单调 `revision`，每条批注用稳定 `id`。

新增按**单个草稿**操作的受限 RPC：`get`、`upsertAnnotation`、`removeAnnotation`、`reorder`，写入在会话锁内完成并返回新 revision；`upsert` 对同一 `id` 幂等，编辑和删除带预期 revision，冲突时回读、提示并保留人的未提交文字。不能通过现有整组 `session.drafts.replace` 隐式覆盖它。新客户端只在 daemon 明确声明该会话支持批注草稿时展示保存按钮；旧 daemon 明确显示不可用，旧客户端继续使用普通草稿，不会擦掉新字段。协议兼容先由 daemon 接受新字段/RPC，再由 Web 开启入口。

发送时从 revision 固定一份快照，序列化成一条可编辑、可预览的用户消息：每项包含工作区相对文件引用、锚点、版本和人的批注。文件摘录与 HTML 文本用明确的“不可信预览内容”边界引用，不把其中的句子当 Agent 指令。例如一张草稿可以显示为：

```text
请按以下批注检查预览：
1. docs/spec.md，第 12–18 行；批注：这里需要解释失败后的恢复。
2. demos/app/index.html，元素 button#submit；批注：手机上按钮被遮住。
3. assets/screen.png，矩形 (120, 80, 340, 190)，原图 1280×720；批注：这块对比度偏低。
```

实际发送还应包含源版本和可解析的根描述；示例只展示人看到的摘要。`session.send` 复用同一个 `messageId` 处理未知结果；只有拿到持久接收证明才按快照 revision 清除已发送项。若清除失败，卡片显示“已发送，待核对”，查询原消息收据后恢复，不用新 ID 再投递。

## 6. 安全、预算与可观察性

- 人的“加入草稿”是唯一写入入口；iframe 的 `postMessage`、鼠标事件或网站脚本本身都不能写会话。父页验证 frame 身份、请求 ID、预览代次、目标 Session 与 payload schema。HTML 候选只作定位提示，任何页面文本进入发送消息时按不可信来源转义和标注。
- 建议初值：每份草稿最多 40 项；单条批注正文最多 1 KiB UTF-8，摘录 256 字符，selector 512 字节；持久草稿最多 64 KiB，单次发送序列化文本最多 48 KiB；同会话每秒最多 4 次写操作。超限明确提示编辑、删除或先发送现有草稿，不截断人的文字。48 KiB 低于当前持久输入 [65,536 字节上限](../apps/daemon/src/session/inbox.rs)，为引用格式留余量；实施时以实际编码后的字节数复验。
- 新增不含路径、正文和批注的诊断事实：选取模式、保存成功/失败类别与耗时、冲突次数、失效锚点数、发送收据状态。试点衡量“从选中到加入草稿”的成功率和延迟、关闭页面后恢复率；任何目标数值需先有真实测量，不能写成已达成 SLO。

## 7. 实施次序与验收

| 阶段 | 产物 | 必须通过的观察 |
| --- | --- | --- |
| A. 边界与草稿 | 更新 [Preview v4](assets-quick-preview.md)、必要的 [架构边界](architecture.md)、[会话布局](session-storage.md)及 Cloud 产品说明；协议、daemon 原子草稿及 Composer 卡片 | 两个浏览器窗口并发追加无丢项；断线重试同 ID 不重复；换设备打开同一会话能恢复；旧端不破坏普通草稿 |
| B. Markdown 与图片 | 原文行视图和图片矩形覆盖层 | CRLF、代码块、表格、软换行选区准确；缩放、留白和触屏拖拽所得原图矩形一致；文件改变显示失效 |
| C. HTML | 父页检查模式、受限 hit-test 桥和重定位 | 静态与动态元素可选；正常页面脚本不能自行入草稿；伪造桥接回复不能绕过父页用户动作；元素变化有明确失效状态 |
| D. 发送与回归 | 单条消息预览、持久发送与条件清理 | 混合三类、多个文件仍只有一张草稿卡片；发送中新增项保留；未知接收结果不重复发送；会话切换不误投 |

测试以真实 Workbench、协议和 daemon 会话存储为 oracle，覆盖本机与经现有认证通道的远端浏览器；单元层只验证坐标换算、行号、schema 和幂等函数。HTML 安全用真实 sandbox iframe；并发和重启用真实会话写入与回读，不能仅以 mock store 证明。按受影响范围经 `testctl` 选择 gate，协议变化验证新旧组合；不把文档编写当作这些产品测试已经通过。

## 8. 方案门声明与明确不做

本提案依据 [工程引导](engineering-guidance.md) Git blob `0668e079136b4f0033db893a16628922bb51b973` 和 [工程律法](engineering-laws.md) Git blob `e23dbb87e2168181010feb4d8585e016b5ab02f2`。实施时若两份文件变化，需重过方案门。

| 引导项 | 判定与本次设计 |
| --- | --- |
| G01 | 适用；先修订 Preview 回传边界，保留文件只读、iframe 隔离与 daemon 授权 |
| G02 | 适用；统一锚点的第二、第三种形状是图片矩形与 HTML 元素，不围绕 Markdown 单形状造接口 |
| G03 | 适用；新字段和 RPC 只定义于 `packages/proto`，Web/daemon 生成类型并验证混合版本 |
| G04 | 适用；预计 `guest-only`，只改 Web、协议和 WASM guest；若触及 WIT/host 改报 `full` |
| G05 | 适用；会话所在 Space 的 daemon 是事实来源，远端离线不能假装保存成功 |
| G06 | 适用；一条批注替代手写文件路径、行号或屏幕位置，多个批注一次发送 |
| G07 | 适用；先声明会话批注能力，再显示可写按钮；旧 daemon 显式不可用 |
| G08 | 适用；预览摘录标不可信，锚点用枚举 schema，预算与超限行为见 §6 |
| G09 | 适用；保存、冲突、失效、收据四类无正文诊断见 §6 |
| G10 | 适用；不做完整 DevTools、HTML 源码行映射、自动截图/裁图上传、视频/WASM 批注、自动发送、Hub 明文同步 |
| G11 | 适用；真实组件边界、oracle 与用例形状见 §7 |
| G12 | 适用；批注归当前 Session，放其 Space 的会话目录，生命周期与会话一致 |

实现前还需锁定两个细节：其一，多根绝对路径项目在另一设备上的“可回跳”条件，以源设备核验和失效提示为默认；其二，HTML 检查模式下的滚动与键盘遍历细节，以不放开 iframe 权限为前提。它们不改变一会话一草稿、用户动作门禁与源版本失效规则。
