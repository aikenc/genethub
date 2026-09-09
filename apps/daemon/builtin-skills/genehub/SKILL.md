---
name: genehub
description: Introduce GeneHub and route questions about its workbench, machines, workspaces, Agent sessions, CLI and built-in capabilities. Use when users ask what GeneHub is, how to use it, or which capability handles their task. Not a generic software development workflow.
---

# GeneHub 使用入口

GeneHub 通过工作台把机器上的工作区、Agent 会话和相关工具呈现给用户；daemon 在资源机器上承接
会话和操作，CLI 是命令行入口。浏览器所在设备、对话所在工作区与实际执行机器可能不同。
远程能力受当前身份和配对授权约束，不代表可以控制任意网络设备。PipeSpace 提供项目角色和流程，
不是另一台机器；用户无需因为远程执行就迁移对话。

## 按任务导航

- daemon 启动、停止、重启、环境生效、离线恢复：先读内置 genehub-daemon-management。
- 现有/转发会话的历史和证据：genehub-session-history。
- 工作台页面实时联调、DOM/交互/截图：genehub-client-debug，目标页授权和能力边界以该 Skill 为准。
- 静态 HTML/H5 预览：genehub-html-preview；运行中服务的预览：genehub-service-preview。
- 语音识别运行时：genehub-speech-runtime。
- 产品反馈修复或 Beta 发布：使用当前 Space 选中的领域 Skill；没有对应 Skill 时说明缺口，
  不凭介绍文档执行发布。dev 与 release 的职责以实际 Space 合同为准。

按会话提供的内置 Skill 目录定位文件，不硬编码安装目录；安装版本未包含目标 Skill 时如实报告，
不要假装已经读取。只加载任务相关 Skill，不必把所有参考材料一次读完。

## CLI 发现

所有命令使用 GENEHUB_CLI 的绝对路径绑定，沿用渠道，缺绑定不猜可执行名。
先用 --help、schema 和 capabilities 核对实际命令；context 可核对连接到的目标机器。
帮助/schema 只说明语法和能力，不授予操作权限；询问用法不等于要求修改或重启。
机器、workspace、session、client 是不同身份，按具体命令返回的字段选择，不相互替代。
