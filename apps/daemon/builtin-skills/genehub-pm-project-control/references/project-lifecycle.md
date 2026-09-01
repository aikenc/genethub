# PM 项目生命周期

整个项目以 Folder Workspace 根目录为 PM cwd。

## 新项目阶段

1. `folderSelected`：执行 `pm project init`；陌生非空目录、已有 `.git` 或冲突目录必须拒绝。
2. `preflightPassed`：验证 Git 与至少一个可用的第三方 Coding Agent/模型；安装、登录和凭据必须由用户明确处理。
3. `gitReady`：建立外层 Space 管理仓库、标准忽略项与独立业务仓库，不修改全局 Git 配置。
4. `topologyVerified`：只创建当前 Workflow 所需 Space，依次执行 Builder check、explain、dry-build、build、verify，并提交人类维护的源文件。
5. `workspacesRegistered`：注册每个已验证 Space，记录 workspace id、源 commit 和 Builder lock 摘要。
6. `active`：用 `pm project advance --to active` 完成共享 phase；`lifecycle --to active` 不能替代 phase 推进。

每一步都必须幂等。恢复时验证已有事实，从首个未完成阶段继续。只有初始化 Session 推进共享阶段，其他 PM Session 复用项目并维护自己的 Run。

## PM turn 边界

派发所有 Ready 独立包、记录立即可得事实、简短报告后返回 idle。禁止用 shell 等待或轮询；daemon Supervisor 负责有退避的检查和事件唤醒。

## 终态

- `waitingUser`：等待用户指导，不启动定时模型 turn。
- `completed`：保留 Space、仓库、Session、候选和评审；后续新需求重新激活同一项目并创建新 Run。
- `cancelled`：安全停止活动工作并保留证据；不自动删除物理资源。
