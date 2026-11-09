# 系统权限：看缺什么、能不能自动修

任务在这台机器上失败或停住，并怀疑是操作系统拦截（读写磁盘、网络、程序被拦下）时，先查，不要猜：

```sh
"$GENEHUB_CLI" access status              # 本机
"$GENEHUB_CLI" access status --machine <id>   # 另一台机器
```

返回每一项的 `id`、`state`（granted / denied / notDetermined / unknown / needsRecheck / notApplicable）、
`action`（fix / prompt / settings / command / none）、`holders`（系统把权限算在哪个程序上）和
`command`（需要管理员时的原命令）。

- `action = fix`：daemon 自己能修，直接申请：`"$GENEHUB_CLI" access request <id>`。
- `action = prompt / settings`：必须有人在那台电脑前点系统对话框或打开开关。**锁屏时不要申请**，
  申请会被跳过；告诉用户去处理，并说明具体 `id`，不要写成“进程没起来”。
- `action = command`：把 `command` 原样交给有管理员权限的人，不要自己加 `sudo` 绕开。
- “已申请”不等于“已允许”：`access request` 返回后再看 `report` 里的 `state`。
- 不要为了通过检查去改 TCC 数据库、防火墙或杀软设置；只用上面的接口。

只想一次办完：`"$GENEHUB_CLI" access request --all`（只处理推荐且仍缺的项）。
