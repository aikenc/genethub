# GeneHub 内置 Skill

GeneHub 内置 Skill 是产品源码的一部分，由 daemon 构建、分发和注入所有内置及第三方 Agent。它们不使用
PipeBuilder，不属于 PipeSpace，也不从工作区或用户目录加载。

## 目录

每个 Skill 是 `apps/daemon/builtin-skills/` 下的一个一级目录：

```text
apps/daemon/builtin-skills/<skill-name>/
├── SKILL.md                 # 必需
├── agents/openai.yaml       # 可选 UI 元数据
├── scripts/                 # 可选确定性工具
├── references/              # 可选按需读取的资料
└── assets/                  # 可选输出资源；可以是二进制
```

`<skill-name>` 只能使用小写 ASCII 字母、数字和连字符，最长 64 字节。`SKILL.md` 必须是 UTF-8，YAML
frontmatter 必须包含与目录名完全相同的 `name` 和非空 `description`。描述最长 1024 字节，并应同时说明
能力和触发场景。保持正文简短；细节放入直接链接的 `references/`，重复或脆弱操作放入 `scripts/`。

整个树只允许普通目录和普通文件，不允许符号链接。资源文件名必须是 UTF-8 且跨平台；构建器会递归嵌入
所有普通文件，因此不需要维护手写文件清单。

## 构建与分发

`apps/daemon/build.rs` 与可原生单测的 `apps/daemon/build_support.rs` 在构建期完成以下工作：

1. 递归扫描并排序 `builtin-skills/`。
2. 校验每个一级 Skill 根目录和 `SKILL.md`。
3. 生成 `OUT_DIR/builtin_skills.rs`，其中每个资源使用 `include_bytes!`。
4. 将文件内容随 `genet-daemon` 编进 `genehub_guest.wasm`。

发布流水线对 guest component 签名，再把同一份 `genehub_guest.wasm` 与当前 channel 的 CLI、Host 一起放入
桌面或命令行安装包。daemon 启动时把内嵌文件物化到当前数据目录的 `builtin-skills/`，并生成只含产品
entrypoint 的 `.entrypoints`。第三方 Agent 从统一系统摘要读取 `{name, description, path}`；内置 Agent
使用 `.entrypoints` 提供 `/skill:<name>`。运行时目录里的未知或遗留文件不会进入任何产品 Skill 清单。

组件更新会同时更新内置 Skill，不需要独立复制或迁移 Skill 文件。

## 新增或修改

1. 在 `apps/daemon/builtin-skills/<skill-name>/` 添加或修改 `SKILL.md` 和必要资源。
2. 不修改 `apps/daemon/src/skills.rs` 的文件列表；构建期扫描器会自动发现增删。
3. 运行格式与编译检查：

   ```bash
   cargo fmt --all
   cargo check -p genet-daemon -p genet-agent
   cargo build -p genehub-guest --profile iterate --target wasm32-wasip2
   ```

4. 用 `testctl plan` 选择 `builtin-skills` case，再运行该 case。它通过真实 CLI、Host、guest component、
   daemon、内置 Agent 和 mock LLM，逐字节比较源码树与新数据目录中的物化树，并检查摘要没有重复或
   workspace overlay。
5. 需要发布时仍走正常 Dev/Beta/Stable component 流水线；不要单独发布 Skill。

构建失败应直接修正目录或 frontmatter。不要通过放宽扫描器、运行时猜测名称、复制到 PipeSpace 或手工
修改 daemon 数据目录来绕过门禁。
