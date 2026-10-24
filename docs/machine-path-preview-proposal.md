# 机器绝对路径、可访问目录名单与预览导航统一提案

状态：2026-10-24 已获准实施；dev-4 实施与验证中，最终验证状态以任务报告为准。  
日期：2026-10-24。  
开发槽位：`dev-4`，双仓分支均为 `dev-4`。  
源码基线：Open `3faf3350ba1f10a9096bdbfd0ffb3a590bc3de45`；Cloud `4a6d5a52a87fc99de449b0fad8b2aa321e758577`。两仓创建前已 fetch 并核对远端 main。  
问题来源：Beta 反馈 `fb_8iG_Gx_TTPz0`，以及随后对路径解析、预览器、文档和取证流程的审查。

## 1. 建议与本轮交付

建议采用用户提出的方向：**文件地址统一为“稳定机器 ID＋该机器上的绝对路径”；每台机器维护一份有效的可访问目录名单，来源为全部已登记项目目录与用户额外配置目录的并集。**

Workspace 保留会话、Agent cwd、Git、项目组织等职责。文件定位与读取不再要求调用方先选中某个 Workspace，也不再让新文件地址依赖 `workspaceHandle/rootHandle`。相对路径由明确的上下文解析成机器绝对路径后，进入同一文件访问入口。

目录名单回答“这台机器可以提供哪些文件”。已有设备能力、受限连接和分享范围继续回答“这个调用者可以读取其中哪些文件”；无需再手工维护一套重复的项目目录清单。

本轮已完成 `dev-4` 的创建、开发配置初始化和本提案落盘。产品代码、协议、内置 Skill 和部署配置均尚未修改；未构建或启动 dev 服务，未发布 Beta。

## 2. 用户场景：从实时看板打开另一个目录里的产物

假设机器 `m_example` 上的项目目录为 `/srv/game`：

```text
/srv/game/datas/board/index.html
/srv/game/datas/releases/latest/index.html
/srv/game/datas/releases/v0.5-preview/index.html
```

看板使用普通链接 `../releases/latest/index.html`。用户期望点击后仍在预览器里看到角色查看页，随后可以继续打开其他版本。文件位于哪个 Workspace、该项目登记为单目录还是多目录，不应影响这个链接的含义。

当前实现既依赖 Workspace/root handle，又先把链接交给固定在虚拟站点根的 URL 解析器。现场还存在父页面 CSP 阻止虚拟基准 URL 的问题。入口文件可以成功读取，二级入口却不能进入；原团队尝试 iframe 弹层后，又遇到预览明确不支持嵌套 frame 的边界。

拟议行为：

```json
{
  "machineId": "m_example",
  "absolutePath": "/srv/game/datas/releases/latest/index.html"
}
```

预览器依据当前文档目录完成 `..` 运算，daemon 对最终绝对路径检查可访问目录和调用者授权，再读取同一个实际文件。分享链接使用现有分享凭据，仍只覆盖分享清单里的入口和资源。

## 3. 已有证据与判断边界

### 3.1 反馈现场

反馈提交时间为 `2026-10-24T10:13:54.335Z`，浏览器记录的构建为 Open `54de78089f53` / Cloud `583fca4f8377`。

| 观察 | 证据 | 结论 |
| --- | --- | --- |
| 入口读取成功 | 10:13:09.138 UTC，`asset.preview` 经 RTC 返回成功，249,802 bytes，175 ms；随后进入 ready/remapped | 此次入口文件传输不是首要故障点 |
| 虚拟基准 URL 被拦截 | 10:13:09.161 起出现 `base-uri` 对 `https://preview.invalid` 的 enforce 记录 | 工作台父文档策略与预览器需要的 base 不兼容 |
| 二级入口点击后出现 frame 拦截 | 10:13:12.448、10:13:21.922 出现 `frame-src` enforce；附带会话记录描述了 iframe 绕行 | iframe 绕行不能作为平台导航的替代实现 |
| 相对网络请求落到宿主页面路径 | 包内含 `/api/board/live` 及工作台路径下的 `datas/board/live.json` 失败 | base 失效也会影响资源读取，不限于点击链接 |

已用真实 Chromium，在内存生成的隔离页面中复现相同 `srcdoc` / `sandbox="allow-scripts"` 及父 CSP：现有工作台策略阻止 base，链接无法被虚拟源导航处理器识别；加入与独立预览相同的精确 base 白名单后，该处理器可以接管链接。三个策略对照见 [浏览器复现记录](preview-path-evidence/browser-policy.json)。这证明故障机制，不代表完整产品修复已经通过。

反馈没有截图；daemon 快照与日志尾部采集失败，浏览器包记录丢弃 27,417 条事件。当前可达的同名源设备已找不到原 Workspace ID，未在原页面完整回放。以上缺口不能写成“原页面已复验”。

### 3.2 当前主干中的相似问题

| 问题 | 复核方式 | 影响与拟议处理 |
| --- | --- | --- |
| `../releases/latest/index.html` 多保留一层 `board/` | 执行当前 `htmlSite.ts` 解析函数；同目录链接作为对照成功 | 先依据真实文档目录解析，再生成虚拟 URL；不能先丢掉 `..` |
| 运行时 `../data.json`、动态媒体有同类路径偏差 | 执行同一个运行时路径解析函数 | 文件导航与资源读取共享解析结果 |
| Markdown 的 `guide.md#install`、`guide.md?view=raw` 被当作完整文件名 | 执行 `resolveArtifactRef`，结果含字面量 `#` / `?` 的文件路径 | 分离文件路径、查询参数和片段；编码后的字面文件名单独处理 |
| 文档预览缺失完整目录映射，聊天中可解析的跨根绝对链接在文档内 blocked | 对比完整 context 与预览当前单根占位 context 的解析结果 | 新模型直接使用绝对文件地址，不再重建项目根映射 |
| 独立 Markdown 页点击仍写工作台浮窗状态，独立页未挂载该浮窗 | 源码检查，尚未页面复现 | 由当前预览宿主提供导航回调；聊天默认仍打开浮窗 |
| HTML 链接到 Markdown、图片等被静默忽略；跨页参数与片段在 path-only 回调中丢失 | 源码及解析函数检查 | 统一按目标文件 metadata 渲染，失败必须可见 |
| XHR 支持承诺与实现不符 | 当前包装只记录日志，继续调用原生 `open/send` | 补齐本地 GET/HEAD XHR 的文件桥，或在未交付阶段明确标注缺口 |
| 预览诊断存在两条收集入口 | Console 直接收 message，预览页又转发自定义事件；反馈中对应事件重复 | 收敛为经当前 frame 校验的一条入口；避免重复挤占有界事件环 |

`..` 的可执行结果见 [路径复核记录](preview-path-evidence/path-resolution.json)。其余问题的源码位置见第 10 节；源码发现与现场已发生的问题分别列出，不扩大归因。

## 4. 为什么更简单，以及仍需保留什么

| 方案 | 用户需要理解的定位信息 | 成本与判断 |
| --- | --- | --- |
| 只修当前导航与 CSP，保留 Workspace/root 地址 | 机器、Workspace、root handle、相对路径 | 最快止血，但同文件多种地址、跨项目链接和登记依赖继续存在 |
| **机器＋绝对路径＋目录名单** | **机器与文件的真实地址** | 推荐；跨项目定位一致，代价是文件协议、权限入口、旧链接和文件反馈需要兼容改造 |
| 浏览器直接读取任意绝对路径 | 机器与绝对路径 | 没有 daemon 可访问目录边界，且不能保留已有分享约束；不采用 |
| 改为真实 HTTP 文件站点或新的 WebRoot 服务 | 文件地址外再增加站点与服务生命周期 | 能解决更多浏览器原生 URL 语义，但超出本次目标；不把它作为这次修复的前提 |

**路径模型简化不会自动修好 CSP、XHR 或渲染宿主导航。** 它们必须作为同一交付中的独立改动和验收项。

本期统一只读文件地址、预览和相关资源读取。终端执行位置、Agent cwd、Git、会话归属和写文件授权仍沿用现有机制。未来写 API 可以复用文件定位类型，但“可读取目录”不自动表示“可以修改目录”。

## 5. 唯一的机器目录名单

### 5.1 来源与生命周期

有效目录集合定义为：

```text
该机器全部有效项目已登记的 folders[].root
  UNION
用户配置的 additionalDirectories
```

“全部项目”指 daemon 已登记且未移除的项目，包括普通项目与多目录项目的全部根。不会扫描磁盘猜项目，也不隐含加入用户 home、磁盘根或另一台机器的目录。

持久配置只保存人工补充项，自动项来自现有项目登记这一唯一事实源。例如下方是拟议的配置字段，当前产品尚无此字段：

```json
{
  "fileAccess": {
    "additionalDirectories": ["/srv/shared-assets", "/data/exports"]
  }
}
```

对外展示一份合并名单，每项标明来源项目或“手工配置”；重复和重叠目录统一处理，不要求用户维护两张表。同一个目录由多个项目引用时保留来源引用，移除一个项目不会误删其他来源；移除最后一个来源且没有手工项时，目录退出有效名单。

项目新增、移除、增减根目录和手工配置更新后，daemon 原子更新有效集合与 revision，前端刷新显示。外部编辑 `.code-workspace` 必须经过 daemon 的正式刷新路径确认，不能让浏览器自读文件直接扩大授权；刷新能力也需要覆盖外部删根，避免只处理新增。

新读取使用最新 revision。目录撤销成功后，新操作立即拒绝；正在传输的操作取消尚未发送的部分，已送达的数据无法收回。名单目录暂时离线或不存在时展示 unavailable，不替换为父目录。

### 5.2 调用者授权仍然生效

```text
可读取 = 机器目录名单允许
       AND 当前调用者具备 files 等既有能力
       AND 既有受限连接 / 分享授权允许该文件
       AND daemon/Host 实际能够读取
```

这不是第二套人工目录表。受限连接与分享本来就有自己的授权，新的地址解析器继续使用它们。

现有 `PeerAccess` 可绑定一个 Workspace。旧的受限 admission 不能因为绝对路径来自另一项目就获得额外权限：兼容层将其已有 scope 解释为其允许的物理目录集合。新的 owner 文件读取通道可按机器认证，受限通道则协商明确的 file scope。发现 scope 不足时返回 `scopeDenied`，不静默扩大票据；机器地址相同的正常会话可复用对应已授权连接。

分享授权继续是入口与资源的明确清单，并受过期、撤销和当前机器名单共同约束。分享者不能通过 `../`、配置读取或新加入项目扩大访问。修改手工目录继续要求现有 settings 权限，不从“文件未找到”推导自动加白名单。

### 5.3 在 daemon 打开实际文件，而非只比较字符串

边界检查必须在目标机器完成，前端检查只改善提示：

1. 将输入转换为该机器支持的绝对路径语义；拒绝 NUL、盘符相对路径、特殊设备命名空间等非普通文件定位。
2. 对目录项进行目标系统规范化，按路径组成部分匹配；`/srv/app` 不匹配 `/srv/app-backup`。
3. 选取匹配的有效目录，在该目录能力下打开相对余项；文件 metadata、摘要和字节使用同一个已打开 handle。不能先 `realpath + startsWith`，再不受约束地重新打开环境绝对路径。
4. 符号链接/reparse point 逃出选定目录时拒绝；若用户确实需要另一已允许目录的文件，使用该文件的真实地址。重叠目录按最具体匹配处理。
5. 继续限制普通文件、64 MiB 单文件上限、传输预算、版本一致性及既有表示类型。

当前 native 与 WASI 的文件能力实现并不相同：`fs_cap.rs` 的 WASI 分支使用路径拼接和 `std::fs`。不能把 native `cap-std` 的性质直接写成全部平台的验证结果。实现前必须用 Host/WASI 的真实 symlink/reparse 与替换场景验证边界；这是开放新文件入口的门禁，不是已确认的线上越界事故。

## 6. 地址、协议与相对引用

### 6.1 拟议定位类型和读取合同

以下类型、字段、能力和 URL 都是**待实现合同**，不是可直接调用的当前接口：

```ts
type MachineFileLocator = {
  machineId: string;       // 稳定 daemon 文件身份，显示名仅用于 UI
  absolutePath: string;    // 该机器的规范绝对路径
};

type DocumentLocation = {
  file: MachineFileLocator;
  query: string;
  fragment: string;
};
```

文件身份只有 `machineId + absolutePath`。`query/fragment` 属于文档导航状态，不属于文件名；打开会话的 `ownerWorkspaceId/sessionId` 如有需要，只作为可选的反馈、返回和产物归属上下文。

保留现有 `asset.preview` 方法及 E2EE 数据通道，扩展 source 为兼容 union：

```json
{
  "source": {
    "kind": "machineFile",
    "absolutePath": "/srv/game/datas/board/index.html"
  },
  "representation": "original"
}
```

目标 machineId 来自已认证连接，必须与前端 locator 一致；请求体不能借一个其他 machineId 跳过当前连接。旧 `kind: workspaceFile` 仍由兼容层处理。拟议能力 `asset.preview.machine-file.v1` 用于协商；未宣告该能力的 daemon 不接受新 source。

拟议管理接口为 `fileAccess.list` 和带 `expectedRevision` 的 `fileAccess.configure`，后者只更新 `additionalDirectories` 并返回合并结果；它们沿用现有权限检查。读取方不需要调用管理接口才能读文件。revision 冲突返回最新 revision，由管理页面刷新后重试，避免覆盖其他人刚做的配置。

预览新 URL 拟采用 `/assets/preview/v3/<machineId>?path=<编码后的绝对路径>`，导航参数使用独立字段；解析器不拼接部署 origin。fragment 空间保留现有 popout/share 凭据，文档片段通过独立 `documentFragment` 字段携带，避免与分享凭据冲突。作者仍只输出文件链接，不手拼平台 URL。

文件读取至少区分 `invalidPath`、`outsideAllowedDirectories`、`scopeDenied`、`notFound`、`unsupported`、`tooLarge`、`sourceChanged`、`machineUnavailable`。无权读取的调用者不通过错误细节探测其他文件是否存在；owner 诊断可显示足够的失败阶段。

### 6.2 路径风格与编码

Linux/macOS 的例子为 `/srv/game/index.html`；Windows 的新地址标准显示为 `C:/Work/Game/index.html`，daemon 负责宿主与 guest 挂载路径转换。协议身份宣告路径风格，不依赖浏览器所在系统判断。

当前 WASI Windows 使用 `/c/...` 等 guest 路径，`guest_paths.rs` 已承接宿主路径转换。v3 在边界使用规范宿主绝对路径，v2 适配器继续识别旧 guest 形式；不全局改写其他协议路径。盘符相对的 `C:foo` 在新入口拒绝，不能被当前宽松转换变成绝对路径。UNC 不因浏览器的 `//host` 写法自动支持；现有 WASI preopen 不覆盖 UNC，本期明确报告不支持，后续需 Host 能力后再开放。

大小写比较遵循目标机器及文件系统，不把 POSIX 路径统一转小写。只在 URI 边界解码一次；带字面量 `#`、`?`、`%` 的文件名通过明确编码区分，不能反复 decode 后变成导航或越界片段。绝对地址绑定机器，不提供机器间自动路径重定位；WSL 与 Windows 上不同 daemon 的路径不能互换。

### 6.3 所有入口共享一个解析器

| 引用位置 | 相对基准 | 解析后行为 |
| --- | --- | --- |
| 聊天中的相对文件链接 | 该条消息的实际 Agent cwd；旧消息缺失时使用其会话已知第一根，仍未知则明确提示 | 转为机器绝对地址；新消息应携带可靠 cwd，避免依赖当前 UI 所选项目 |
| Markdown 文档链接、图片 | 当前 Markdown 文件所在目录 | 可进入另一已允许目录，授权在 daemon 检查 |
| HTML 普通链接、fetch/XHR、动态媒体 | 当前文档真实目录 | 保留 `..` 语义后再生成虚拟 URL；每次导航更新当前文档目录 |
| CSS `url()`、模块 import | 各自 CSS/模块真实文件目录 | 依赖不会错误地继承入口 HTML 的目录 |
| HTML/CSS 中 `/assets/a.png` 之类站点根引用 | 本次站点初始入口目录，导航时保持该 site base | 不把网页 `/` 当作宿主磁盘根；与绝对文件 locator 分开 |
| HTTPS/WSS 外部地址 | 原有网络规则 | 不当成本地绝对文件路径 |

site base 是一次预览的普通渲染上下文，不是新的可访问目录名单，也不禁止 `../` 访问另一个已授权目录。

前端完成绝对文件地址解析后再产生 `preview.invalid` 的内部虚拟地址。虚拟地址应编码已经解析的绝对文件信息，避免再次以虚拟根为基准消掉 `..`；不再将浏览器已规范化的虚拟 pathname 反向猜成本地相对路径。

## 7. 统一预览导航与资源桥

聊天、工作台浮窗、独立预览页、分享页使用同一文件定位和文件类型分派。当前宿主通过导航回调接收目标 `DocumentLocation`，复用同机器已有的已授权 Client；独立 Markdown 页不再仅修改一个无人渲染的工作台状态。

HTML 链接不再只允许 `.html/.htm` 后缀。读取返回 metadata 后分派 HTML、Markdown、图片、文本和媒体；不能预览的目标显示明确结果。同文档片段滚动不重新取文件；跨文档片段在目标内容就绪后定位。页面内导航提供返回能力，浮窗与独立页一致。

查询字符串与文件地址始终分离，资源 `data.json?v=2` 读取 `data.json`；查询可以参与渲染/缓存区分，不能成为磁盘文件名。**保留导航参数不等于让 opaque srcdoc 获得真实网页的 `location.search/history` 全部语义。** 本期先保证参数保留、静态文件读取和锚点；依赖原生查询路由的应用必须完成原型验证后才能宣告支持，失败时给出明确的不支持提示，不能静默丢参。

`fetch` 与本地 GET/HEAD XHR 使用同一文件桥；XHR 必须覆盖实际调用方需要的 responseType、abort 和错误事件。POST 等本地文件写入不借读取桥执行；已登记服务的 API、WS、SSE 继续走其显式服务桥与授权。未登记的 API 路径不能回退请求 Cloud 宿主接口。

CSP 同时修两端：工作台和独立预览的父页面精确允许 `https://preview.invalid` 作为 base，iframe 内继续收紧。加载器在应用脚本执行前检查实际 base 是否生效；失败时显示平台配置错误，不继续以工作台 URL 解析本地请求。继续保留 opaque sandbox、嵌套 frame/object/form 限制，本次不以 iframe 绕行代替导航。

预览诊断只保留一条经当前 frame 来源检查的采集入口，补充“解析目标、授权阶段、加载结果”的关联信息。导出的路径继续按诊断隐私规则脱敏，不记录分享 token；重复 CSP/轮询错误聚合计数，避免重要导航事件被大量重复记录挤出。

## 8. 旧链接、分享、文件反馈和存储的兼容

### 8.1 v2 读取适配

旧 `/assets/preview/v2/...` URL、root-qualified 路径和旧请求继续可读。兼容层用原机器上的旧 Workspace/root mapping 转成绝对地址，然后调用同一名单与授权检查。新前端默认生成 v3；旧 daemon 仍使用 v2，不能通过前端模拟声明 v3 能力。

原 Workspace 记录已被删除且没有可信旧映射时，旧地址可能无法恢复，必须明确提示，不能在磁盘上按文件名搜索后猜中一个文件。实施后新增的 v3 地址在同一路径仍由其他项目或手工项覆盖时，不受 Workspace 改名、重分组或 ID 变化影响。文件搬家或机器身份重建仍可能失效，这是绝对地址的真实限制。

迁移按能力协商逐步启用。先部署兼容读取与新地址支持，再让客户端生成 v3，最后清理旧内部调用；不能先删掉旧地址解析。Cloud 路由、admission 的 scope 和独立页面首屏必须同步覆盖；Relay 仍只承接既有 E2EE 传输，不增加读取文件或解释绝对路径的职责。

### 8.2 文件反馈、分享和浏览器存储

当前文件反馈与分享记录保存在项目第一根的 `.genethub/preview-feedback`，不能只改 URL 就宣布与 Workspace 解耦。新记录拟转到 daemon 的机器级文件元数据存储，以规范绝对路径、文件版本和稳定记录 ID 建立索引；项目归属仅为可选 UI 上下文。

先增加旧存储兼容 reader，再对已知项目根中的历史记录做可重复的增量导入，记录来源 ID 防重；不删除原记录，不扫描整盘。旧分享凭据继续解析到原授权清单，再转成绝对文件地址；移除机器目录权限时分享也不能继续取新字节。新分享默认固定已批准入口与依赖清单，需要扩展依赖时由分享者更新，不能让远端页面任意扩大清单。

localStorage 的隔离键从 Workspace/root 组合迁移为“机器、产品渠道、访问主体范围、初始站点目录”。同目录 owner 页面仍可共享；分享与 owner 数据保持隔离。旧数据只有能唯一对应到同主体、同绝对目录时才迁移；不把歧义条目覆盖到新位置，不以分享 token 本体作为存储键。

Service Preview 的注册入口也适配到绝对文件定位，但服务路由与用户授权继续沿用，不因为文件所在目录在名单中就自动开放后端或设备权限。

### 8.3 回退

以能力与功能开关控制 v3 生成；出现兼容故障时停止生成新地址，保留 v2 reader、原目录配置和原反馈数据。新机器级反馈数据不删除，老版本无法显示的新条目明确保留待恢复，不把回退说成双向格式兼容。所有名单、分享和数据迁移都要有幂等记录，不能靠删除重建恢复。

## 9. 内置 Skill、文档和运维脚本

| 来源 | 拟议变化 | 验收 |
| --- | --- | --- |
| 产品内置 `genehub-preview` | 增加机器绝对路径模型、相对目录与站点根语义、多文件导航、真实平台验收说明；继续要求普通静态文件与入口 HTML | Agent 能产出普通链接，在工作台和独立页实际点击验证；不会改成嵌套 iframe 绕过平台错误 |
| 产品内置 `genehub` 及诊断说明 | 区分机器、Workspace、文件地址和 client；补充父 CSP / iframe CSP、导航和资源桥的诊断树 | 入口成功、二级失败时能定位平台层，不一律要求修页面 |
| `docs/assets-quick-preview.md` 等事实文档 | 更新地址、名单、授权、CSP 和 XHR 实际支持；移除“工作台不含 unsafe-inline”等与当前部署不符的表述 | 文档示例与对应能力版本的真实页面一致；提案状态与已支持功能分开 |
| Spaces 的 `genethub-self-devops` | 服务器显示名仅作发现提示，使用稳定身份与目标部署证据核验；沿用会话绑定 CLI 运输，不把 CLI 渠道直接当反馈渠道 | 显示名变化、Stable CLI 访问 Beta 部署均有明确定义的预检结果，歧义时不误连机器 |
| 取证 preflight / repair 脚本 | 只读预检一次返回所有前置条件和修复建议；登记修复走正式产品接口，在已授权范围内执行并保留 Workspace ID，结束后实际读回反馈 | 不再靠临时改函数、手写 loopback admission 或要求用户逐项修目录登记；未授权的配置修改仍不自动执行 |
| 产品 CLI 的可发现性 | 工作区登记/刷新能力进入正式 schema，支持明确的目标执行方式和结束回执 | Agent 能从 schema 找到受支持路径；接收回执与完成结果可区分 |
| 回归脚本 | 覆盖父 CSP 继承、路径解析、授权、分享与跨宿主交互，不只检查字符串 | 使用真实浏览器和真实 daemon 文件打开，不以普通 Chrome 直开文件替代平台验收 |

内置 Skill 的源在产品仓 `apps/daemon/builtin-skills`，Spaces Skill 的源在 `skills/common` 等 Provider。修改源后分别走对应构建与发布链；不直接编辑安装目录或 `.agents/skills` 生成物。此次只把这些改进列入方案，尚未修改它们。

## 10. 改动落点与现有代码依据

| 模块 | 当前依据 | 拟议改动 |
| --- | --- | --- |
| 文件协议 | [data.rs](../packages/proto/src/data.rs) | 增加 machineFile source union、版本/能力协商和规范地址回复 |
| daemon 文件入口 | [dataplane/preview.rs](../apps/daemon/src/dataplane/preview.rs)、[files.rs](../apps/daemon/src/files.rs) | 用机器目录解析器替代 v3 的 Workspace resolve，复用表示、摘要、预算和流式传输 |
| 目录与授权 | [workspace.rs](../apps/daemon/src/workspace.rs)、[authz.rs](../apps/daemon/src/authz.rs)、[PeerAccess](../apps/daemon/src/dataplane/endpoint.rs) | 汇总项目根与手工目录；保留受限连接/调用者授权，不改变项目组织职责 |
| 宿主路径与文件能力 | [guest_paths.rs](../apps/daemon/src/guest_paths.rs)、[fs_cap.rs](../apps/daemon/src/fs_cap.rs) | 承接 Windows/WASI 边界，补平台一致的目录与符号链接约束 |
| 前端文件定位 | [url.ts](../packages/workbench/src/preview/url.ts)、[resolveArtifactRef.ts](../packages/workbench/src/preview/resolveArtifactRef.ts)、[client.ts](../packages/workbench/src/protocol/client.ts) | 单一机器文件类型、v2 adapter、cwd/文档相对解析和连接 scope 选择 |
| 预览导航与资源 | [AssetPreviewPage.tsx](../packages/workbench/src/preview/AssetPreviewPage.tsx)、[htmlSite.ts](../packages/workbench/src/preview/htmlSite.ts)、[Markdown.tsx](../packages/workbench/src/session/Markdown.tsx)、[PreviewPopoutPage.tsx](../packages/workbench/src/preview/PreviewPopoutPage.tsx) | 当前宿主导航、跨类型渲染、统一文件桥和可见错误 |
| 文件反馈与分享 | [preview_feedback.rs](../apps/daemon/src/preview_feedback.rs)、[storage.ts](../packages/workbench/src/preview/storage.ts) | 机器级索引、旧存储读取、分享清单与浏览器存储迁移 |
| Cloud 策略与准入 | [Caddyfile](../../genethub-cloud/deploy/Caddyfile)、[peer-admission.ts](../../genethub-cloud/server/src/http/peer-admission.ts)、[enrollment.ts](../../genethub-cloud/server/src/http/enrollment.ts)、[store.ts](../../genethub-cloud/server/src/store.ts) | v3 路由与机器文件 scope；工作台和独立页 CSP 同步；不让 Cloud 读取文件内容 |
| Cloud 诊断 | [diagnostics.ts](../../genethub-cloud/console/src/diagnostics.ts) | 收敛已校验的预览事件入口，聚合同类失败 |
| 内置预览 Skill | [static.md](../apps/daemon/builtin-skills/genehub-preview/references/static.md) | 新定位合同、支持矩阵和验收路径 |
| 取证 Skill source | [self-devops](../../../../skills/common/genethub-self-devops/SKILL.md)、[beta_inspect.py](../../../../skills/common/genethub-self-devops/scripts/beta_inspect.py) | 身份核验、一次预检与受支持的登记恢复流程 |

API 名称、配置字段和前端类型的最终命名可在实现评审中微调，表中的行为与兼容边界不得只因改名而省略。

## 11. 分期与可观察验收

### 阶段 A：固定故障与合同，先验证关键原型

完成父 CSP、原始相对引用、XHR、独立 Markdown 页和多根文件引用的复现。冻结绝对路径、目录名单、旧 admission scope 和版本协商合同。验证 Windows/WASI 的路径打开与撤销，明确原生 query 路由的支持边界。

这一阶段产出证据与接口候选，不宣告新地址模型已开放。若目标平台不能证明目录边界，该平台的 machine-file 能力不启用，其他平台可以独立推进。

### 阶段 B：后端和兼容 reader，再接入统一预览

先让 daemon 支持名单与 v3，保留旧 reader；再接前端与 Cloud 的能力协商、CSP、地址和宿主导航。owner 场景、独立页和分享页的核心旅程共同通过后，才默认生成 v3。修复原看板时恢复普通链接，并在 GeneHub 内实际点击，不能让 iframe 绕行成为验收前提。

### 阶段 C：元数据迁移、Skills/文档和发布候选

验证反馈、分享和存储迁移，更新内置 Skill 与事实文档，修复取证脚本的受支持操作路径。按实际改动确定 Live 是否足够：若需要新的 Host 文件能力/ABI，必须另走 App 发布范围，不能先假定只发网页即可。当前任务只交付提案，不含发布授权。

| 编号 | 输入条件 | 期望可观察结果 |
| --- | --- | --- |
| A1 | 同一实际文件从两个项目、聊天、文件树和文档链接进入 | 新定位都得到相同机器与规范绝对路径，不依赖当前 UI 项目 |
| A2 | 看板 `datas/board/index.html` 点击 `../releases/latest/index.html`，继续进入兄弟版本 | 浮窗、独立页均到正确文件，返回可用，无 base CSP 违例 |
| A3 | HTML 到 Markdown/图片/文本；独立 Markdown 再点本地链接 | 当前预览宿主真正展示目标，不只更新不可见状态，也不静默吞掉 |
| A4 | 多层 CSS/import、fetch、XHR、动态媒体中的 `../`，以及中文、空格、编码字符 | 按各自真实文件目录读取；fetch/XHR 响应与错误行为一致 |
| A5 | 文件链接含锚点、查询参数或编码后的字面 `#/?/%` | 文件路径和导航状态不混淆，锚点定位正确；不支持的原生路由行为有明确提示 |
| A6 | 新登记一个多根项目、删除一个根、两个项目重复引用同根、手工项重叠 | 合并名单随确认后的登记变化；来源可见，不误删仍有来源的目录 |
| A7 | 读取 `/srv/app-backup`，名单仅有 `/srv/app`；symlink/reparse 逃出、并发替换、编码越界 | native/真实 WASI 均拒绝，返回前未送出文件字节；不能只用 native 单测证明 |
| A8 | 受限旧连接和分享者构造另一项目的合法绝对路径 | 即使该目录在机器名单中，仍因自身 scope 不足拒绝；撤销后新读取失败 |
| A9 | Windows 盘符绝对路径、旧 `/c` 地址、Linux 大小写路径、不可达盘/UNC | 支持形式正确归一；不支持形式明确拒绝，不猜其他机器或父目录 |
| A10 | 新旧前端/daemon 组合，历史 v2 链接，项目重分组或移除 | 能力降级准确；有可信映射的旧链接可读，无法恢复的旧映射明确失败，不错读同名文件 |
| A11 | 历史反馈/分享导入执行两次，切回 v2 生成，owner 与 share 存储并存 | 无重复或覆盖，原数据保留，分享范围和浏览器存储隔离保持 |
| A12 | 未生效 base、未登记 API、缺文件、重复 CSP/轮询错误 | 提示可定位到平台/授权/文件阶段；不误请求 Cloud 业务接口，不重复淹没诊断 |
| A13 | 用新内置 Skill 生成多页静态产物；取证遇到机器改名与旧目录登记 | Agent 在真实 GeneHub 内验证，并通过受支持预检/恢复继续任务；不会要求逐项改名或复制反馈 |

## 12. 当前槽位与评审决策

已创建 `spaces/dev-4` 和 `worktrees/dev-4/{genethub,genethub-cloud}`，端口 offset 为 4，独立 `dev.env` 已初始化，`devctl check` 通过。根级 PipeBuilder `check/explain/build/verify` 对全部 15 个 Space 通过。两仓从上述 main 建立；未继承 2026-08 的旧远端 `dev-4` 内容，未改写该远端分支。

当前构建状态：未构建。运行状态：未启动，不提供可用 dev 体验链接。本提案及脱敏证据为文档改动，后续实现留在该槽继续。

工作台登记状态：尝试用绑定 CLI 的正式 `space open` 登记 `dev-4.code-workspace`，返回 `caller lacks the settings capability`。因此本次只确认磁盘上的 Space、双仓槽和文档就绪，不宣称已自动出现在工作台项目列表；未切换身份、绕过该拒绝或修改设备授权。具备相应权限的工作台可直接打开现有 `spaces/dev-4/dev-4.code-workspace`。

推荐评审决定：采用机器绝对路径与单一有效目录名单；保留既有主体/分享授权交集；将导航、CSP、资源桥、旧链接和元数据兼容纳入同一整体交付；取证流程改进作为可单独提交的配套工作。

实施前仍需原型解决的事项是 Windows/WASI 的目录能力、旧 Workspace scope 的机器文件 admission、历史反馈/分享迁移，以及 opaque srcdoc 下原生查询路由的能力上限。它们已分别落入阶段和验收门，不以本提案落盘代替验证，也不为尚未测量的工作给出精确工期。
