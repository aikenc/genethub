# WeUI 基础控件

固定上游 npm `weui@2.6.26`，取 `dist/style/widget/weui-cell/weui-cell.css` 与 `weui-tab/weui-tab.css` 中以 `.weui-cell` / `.weui-tabbar` 开头的规则，增加 `.genehub-ui` 作用域。原始 npm 包不作为运行依赖。没有导入 reset、body、字体或项目 Preview 样式。

`controls.css` 为选取的上游规则；`theme.css` 接入 GeneHub 外壳布局与主题。版权和许可见 [LICENSE.txt](LICENSE.txt)。更新时用 PostCSS 选择同一规则集，检查媒体规则是否需要同步，不直接覆盖本地主题适配。
