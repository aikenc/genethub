# Workbench v4 参考归档

基线 Open `25e559725e50ce664f4ff0777f3a492fa9442f43`（UI变更基线 `a5c9d79`），Cloud `2ace379f041cd3547702641aa8f9535bde49293a`。

此目录没有运行入口。旧 App、递归混排 Sidebar、桌面标签条和手机标题切换仅供源代码参考。原 shell 测试全文保留用于追溯；当前会话管理与 TitleBar 测试仍在 src 中。树和已打开标签布局的断言随外壳退役；真实文件、CAS、权限、Fork、信息流、订阅行为继续由活动组件和协议/浏览器回归验证。

活动映射：`src/App.tsx` 保持公开导出，转到 `src/app/WorkbenchApp.tsx`；`app/ConversationList.tsx` 负责列表；`shell/ConversationRows.tsx` 保留空间管理与会话菜单；Timeline、Store、Preview、协议均为同一份活动代码。

该目录在 src 之外，不进入现有 TypeScript/Vite/Tailwind 图。禁止活动源码 import 此目录。不复制 dist、依赖或运行数据。回退通过已验证旧产物完成。
