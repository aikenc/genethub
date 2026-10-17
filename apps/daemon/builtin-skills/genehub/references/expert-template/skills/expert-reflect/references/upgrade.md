# 升级平台文件（在 temp/ 里做，失败不污染专家）

触发：留言 `kind=upgrade`（模板比 `platform` 分支新），或用户要求。`expert.py drift` 看现在与平台的差异。

1. `expert.py snapshot` 先把现状提交。`expert.py temp new upgrade --purpose "升级平台文件"` 得到目录 T，`git clone <专家根目录> T/x`。
2. 在克隆 `T/x` 里运行 `"$GENEHUB_PYTHON" tools/expert.py snapshot --refresh-platform`，会自动把 `<数据目录>/builtin-skills/genehub/references/expert-template/` 的新模板记录到 `platform` 分支（提交说明为 `platform: <摘要>`）。
3. 在克隆 `T/x` 的 `main` 分支运行真实三方合并 `git merge --no-commit platform`（`main` 从初始化起就以 `platform` 为祖先，不得使用 `-X ours` 掩盖平台更新）。若仅有自动合并，检查无误后 `git commit`；若有冲突，阅读两侧改动意图手工消解后提交。
4. 在克隆里运行 `"$GENEHUB_PYTHON" tools/spacebuilder.py build .` 与 `verify .`，并核对 `expert-core` ≤40 行、合并指令 ≤32 KiB；有测试脚本就跑。不过就继续改或放弃。
5. 通过后回到专家根目录：`git fetch T/x platform:platform && git pull --ff-only T/x main`，运行 `"$GENEHUB_PYTHON" <专家根目录>/tools/expert.py sync-identity`（编译并更新身份指纹），再把 `upgrade` 留言标为 `notes done`。
6. 提交说明写升级了什么、迁移了哪些改动；无法决定的冲突写成外部问题交给用户，不要硬合。

`expert.py reset` 是用户明确要求时的强制手段，会覆盖平台文件和 `soul.md`（默认保留 `memory.md` 与各空间 `index.md`）；默认走上面的三方合并。
