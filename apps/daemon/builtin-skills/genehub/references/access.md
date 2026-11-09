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

## 在 macOS 上不要做的事

- **不要替换、重新安装或手工运行已被授权的 `genet` / `genehub-host`**，也不要用未签名的副本读受保护目录：
  系统按“程序身份”记授权，未签名的新程序读过一次受保护数据，授权可能被改写成拒绝，事后重签也未必恢复。
  更新走 `genet update app`（机器已设置稳定身份时，它会在替换前先签名；这一步尚未随任何已发布版本提供，
  所以目前更新后仍可能需要重新授权）；需要验证权限时用专门的测试程序，不动用户授权的那份。
- 不要读 `TCC.db`，也不要声称“已核对授权库”：读不到，只能以 `access status` 的探测结果为准。
- `locked` 为 true 时不要发起会弹窗的申请；告诉用户去解锁并说明具体项目 `id`。
- `mac.code-identity` 显示 `denied` 时，修复按钮是在**更新前或首次迁移**用的；它会让程序换成稳定身份，
  这一次之后需要用户重新授予一次磁盘权限，之后的更新才不再丢。
