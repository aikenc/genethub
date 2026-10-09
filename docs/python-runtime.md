# 平台 Python 运行时

脚本 Agent（codex、cursor）和内置 Skill 的脚本都跑在同一份 GeneHub 自带的 Python 上。它由安装程序装好，
daemon 只读、不安装。

## 1. 谁来装

一份脚本 `scripts/python-runtime/install-python.sh`（Windows 是 `install-python.ps1`），版本和各平台 sha256 只在
`scripts/python-runtime/python.pin` 一处。三个平台都用 python-build-standalone 的 `install_only_stripped`。

| 入口 | 做法 |
|------|------|
| `scripts/install.sh`（curl \| sh） | 脚本随 CLI 压缩包发布（同一份 SHA256SUMS 校验），解包后、替换任何二进制之前运行；失败就整体失败，旧版本不变 |
| Windows 安装器（NSIS） | 脚本进 `bin/python-runtime/`，安装钩子 `NSIS_HOOK_POSTINSTALL` 在文件就位后运行；应用内更新是同一个安装器，Python 已在时不下载 |
| 开发环境（`devctl serve`） | 启动 daemon 之前运行同一份脚本；`GENEHUB_PYTHON_CACHE` 让同一台机器上的所有 dev slot 共享下载 |

目标是外壳或 daemon 实际使用的数据目录下的 `agents/runtime/`：Linux/macOS 是渠道数据目录
（`GeneHub[-beta|-dev]`，可被 `GENEHUB_*_DATA_DIR` 覆盖），Windows 桌面端是 `%APPDATA%\<bundle id>\<渠道目录>`。
桌面安装器只准备外壳自己的 daemon 使用的目录；用 CLI 另起、数据目录不同的 daemon 需要对它的 `agents/runtime/` 另外运行一次脚本。
换 Python 版本只随 App 版本升级：新安装包带新的 `python.pin`，安装程序重新运行脚本。

## 2. 目录与记录

```
<数据目录>/agents/runtime/
  python.json                       {"python":"<绝对路径>"}，脚本原子写入，daemon 只读这个
  python-<版本>-<release>/          解压出的 Python；只保留当前版本
```

脚本幂等：已有解释器能以 `-I` 启动并报告 `python.pin` 里的版本就直接复用，不联网。下载顺序是
`GENEHUB_PYTHON_MIRRORS`（空格分隔的镜像前缀）→ GitHub → 阿里云镜像；哈希对不上就换下一个地址，所以镜像不需要可信。

## 3. daemon 一侧

`apps/daemon/src/adapter/script/runtime.rs` 读 `python.json`，确认解释器存在后启动脚本 Agent。找不到时 Agent 显示
不可用，原因是「Python 运行时未安装」，daemon 不下载、不重试。daemon 同时把路径作为环境变量 `GENEHUB_PYTHON`
和系统提示里的 `<genehub_python>` 交给每个会话。

## 4. 不污染平台 Python

解压后在标准库目录写入 `EXTERNALLY-MANAGED`（PEP 668）：往这份 Python 里全局 `pip install` 会直接失败，
并提示 `"$GENEHUB_PYTHON" -m venv <dir>`；虚拟环境本身不受影响。这防的是误操作，不防刻意绕过
（`--break-system-packages`）。运行时目录绝不加进 Agent CLI 子进程的 `PATH`，也不设置 `VIRTUAL_ENV`
或 `PIP_*` 之类的环境变量。

## 5. 测试

- `testing/specialties/agent/install-runtime.specialty.ts`：直接测安装脚本（内置地址、镜像回退与哈希、全部失败），
  再用同一数据目录启动 daemon 验证脚本 Agent 跑在装好的解释器上，或在缺失时给出明确原因。
- `testing/specialties/install/installer.specialty.ts`：`install.sh` 在替换二进制之前运行 Python 安装脚本，
  失败时旧版本不变。
- 其余脚本 Agent 用例由测试基础设施按安装器同样的方式预置（`seedScriptAgentRuntime`：复制一份并写 `python.json`）。
