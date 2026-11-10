# 团队给平台的反馈

先问：改本队定义源能否解决？能则自主维护。问题发生在样板负责的步骤且 `run.py drift` 显示未改过，
或原因码指向内核，或本队不得不在样板内打补丁/绕行，则留平台反馈线索。`drift` 本身不是根因证明。
平台从所有机器只读这些文件；真实用户的 Console `fb_*` 反馈属于另一条流程。

```bash
python3 tools/run.py feedback add --kind template --title "SpaceBuilder 生成物归属冲突" \
  --ref SB010 --fingerprint 'sb010:workspace-rule.md' \
  --evidence docs/reflection/current-observation.md --request-id observation-sb010-1 \
  --workaround '保留原生成物和身份，未删锁'
python3 tools/run.py feedback ls --open
python3 tools/run.py feedback verify pf-<返回的编号> --result fixed \
  --evidence docs/reflection/adoption-and-recheck.md --version <实际采用的版本> \
  --request-id verify-sb010-1
```

`fingerprint` 为同一原因/对象的稳定键；不填时按 kind/ref/title 生成。同一键的新观察只增加 occurrences，
不新建编号。`request-id` 表示一次观察/复验；同一编号和内容重试不重复追加，改内容会拒绝。未填写时由
当前会话及原意自动生成。证据相同时的新发生要用新观察编号，未知结果则保留原编号，不能换编号强行重试。

文件为 `datas/platform-feedback/pf-*.json`，含证据、次数、实际加载的公共样板代码摘要及复验历史。
`--version` 写真实采用的内核/发布版本，摘要不代表远程岗位也已采用；复验材料应包含必要的源端和远端身份、
原失败场景、修复后结果及未覆盖项。只收到升级提醒、拉取分支或本机成功，都不能写成全队 fixed。

只有采用并复验后才用 `fixed`；未修好用 `not-fixed`，复发用 `recurred`。fixed 后同键再次上报会自动重开
为 recurred，保留原验证历史。平台更新说明应列出已处理编号，团队决定何时采用并自己维护复验状态。
这些命令不发送消息、不清空收件箱、不唤醒前台或模型；写反馈失败不影响已有派单和结果义务。
