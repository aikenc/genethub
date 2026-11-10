# 升级边界

- 定义源先保存当前提交、制品和原任务记录；运行副本不初始化 Git、不 snapshot、不直接编译。
- 对已采用 Class 扩展的团队：从平台候选更新 `tools/genet_builtin/`、`skills/genet_builtin/` 及薄入口，保留 `agent-space.genet.json.team`、业务 tools/Skills、身份、数据和回执。比较 `tools/run.py describe` 的 Class、API 与 binding 版本；兼容更新无需改写业务源。
- 使用者仍可修改内置包，但这些修改是明确维护的补丁，升级需要三方核对，不是零成本覆盖。
- 首次从旧版迁移：把已有业务差异提取为 `WorkflowPolicy` / `ResourcePolicy` / `ReflectionPolicy` / `BoardPresenter` / `TeamCommands` 子类；`team.class` 可选，不需要空壳包装。旧目录入口仅转发；移除替换内部函数、猴子补丁与重复锁。见 team-core `references/extensions.md`。
- 不给在途旧任务补造新归属。先在原 Class/settings/binding 下结算或显式交接，再部署变更。Class/API/binding/settings 不匹配时保留记录并报错，不自动回退默认类。兼容修复可保留 binding_version；改变准备、释放或账本业务语义时升级版本并安排迁移。
- 构建完整制品，源目录移走后验证 `describe`、业务命令、timer、看板和实际任务；执行端 `spacebuilder.py verify --artifacts-only`。制品部署后已有进程需按团队安装器滚动更新，不能把替换磁盘文件当作所有在途进程已采用。
- 不使用 `reset` 作为模板升级；不覆盖 `datas`、会话、临时材料、本机配置或已有任务。没有完整发布回执不能声称已部署。

## 旧式团队三方升级（尚未采用扩展层时）

保留原定义源的 `platform` 模板基线分支。源端 `tools/run.py snapshot --refresh-platform` 将当前平台记录为新基线；在受管候选中合并平台与团队改动。不能新建并注册自动运行的临时团队来试合并。

冲突须区分平台机制和业务规则：前者反馈平台，后者提取到项目 Class / Skill。验证并生成完整制品后再安装；源仓命名或 worktree 布局由团队自己决定，不强行套用 main/platform 操作。无法兼容的旧任务保留原执行制品收尾，不重派未知操作。

升级本次通知/恢复/结算修复时，逐项检查项目子类是否覆盖相关方法；仅换基类不能证明采用。定义源三方合入、完整 build/install 后 verify，保留数据、原回执和新租约，验证成果实际回原 Owner。

## 已结束任务的未确认准备

公共样板可在任务已有结论后，对无会话回执、无源端资源的远程准备意图请求持久撤回。执行端须与源端都支持 `receive --require-dispatch-fence`；旧执行包会在解析时拒绝，不会尝试该新操作。原编号在执行端被封住后才解除源端等待，已有会话回执或不明资源仍保留。不能手删派单、锁或把一次无回执查询当作未创建；兼容更新与原任务复验后再核对交付状态。
