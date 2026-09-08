# 可选 Node 多后端示例

这是供 Agent 复制改写的参考源码，GeneHub 本体不依赖它或 Node.js。

将本目录与相邻 demo 目录一起复制到工作区，执行：

```sh
npm --prefix node-adapter ci
node node-adapter/run.mjs --config demo/application.json --daemon-root /实际目标数据目录
```

只在复制后的项目安装依赖。应用可用其他语言直接实现登记和认证协议，无需这个启动器。配置、生命周期和媒体契约见 Skill 的 references/getting-started.md 与 registration-contract.md。
