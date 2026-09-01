//! Deployment-agnostic guidance for how Agents share workspace files.
//!
//! The workbench binds Preview URLs at Markdown render time, so Agents must
//! not invent `/assets/preview/...` prefixes. They should emit concrete file
//! paths (especially an entry `.html` for H5 / static sites).

/// Fixed system context appended on the first turn of a session.
pub fn guidance() -> &'static str {
    "\
向用户分享工作区文件时，使用相对于 Agent 工作目录（第一个工作区根目录）的具体文件路径，\
写成 Markdown `[标签](relative/path.ext)`，或直接写 `demos/game/index.html`。\
不要编造 `/assets/preview/...` URL 或部署域名；Workbench 会在展示时解析路径。

只能链接 Asset Preview 可打开且不超过 64 MiB 的普通文件，不能只链接目录。

支持的文件类型：
- HTML（`.html` / `.htm`）：H5、WASM 游戏和多文件静态站点必须链接入口 HTML（通常是 `index.html`），\
  不能链接文件夹。Preview 会重映射模块、相对/站点根资源，并把运行时 fetch/import 转发到工作区。
- Markdown（`.md` / `.markdown` / `.mdown`）
- 图片：`.png`、`.jpg` / `.jpeg`、`.gif`、`.webp`
- 视频：`.mp4`、`.webm`
- WASM（`.wasm`）以及由入口 HTML 加载的其他二进制资源
- 文本、源码和配置：不含 NUL 的有效 UTF-8 文本（已识别格式会高亮）

编写用于 Preview 的 HTML、H5 游戏或静态站点时，读取 `genehub-html-preview` Skill。\
创建可直接本地打开的普通静态站点（入口 HTML + 相对路径）。不要为静态资源启动 HTTP 服务，\
也不要嵌入 Preview 专用脚本；GeneHub 会注入加载器。`localStorage` 通过持久沙箱垫片可用；\
IndexedDB、cookie、嵌套 iframe 和表单不可用。"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guidance_requires_html_entry_and_forbids_preview_url_invention() {
        let text = guidance();
        assert!(text.contains("index.html"));
        assert!(text.contains(".png"));
        assert!(text.contains(".mp4"));
        assert!(text.contains(".md"));
        assert!(text.contains(".wasm"));
        assert!(text.contains("64 MiB"));
        assert!(text.contains("genehub-html-preview"));
        assert!(text.contains("localStorage"));
    }
}
