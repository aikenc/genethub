//! Static build checks only; package code owns rendering and quality policy.
use super::*;
use regex::Regex;
use serde_json::Value;

fn reference(
    files: &BTreeMap<String, Vec<u8>>,
    source: &str,
    value: &str,
    script: bool,
) -> Result<()> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('#') {
        return Ok(());
    }
    if value.starts_with("//") || url::Url::parse(value).is_ok() {
        if script {
            bail!("工作流视图脚本必须随构建冻结：{source} -> {value}");
        }
        return Ok(());
    }
    if value.starts_with('/') {
        bail!("工作流视图资源必须使用视图内相对路径：{source} -> {value}");
    }
    let value = value.split(['?', '#']).next().unwrap_or(value);
    let mut parts = source.split('/').collect::<Vec<_>>();
    parts.pop();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.len() > 2 => {
                parts.pop();
            }
            ".." => bail!("工作流视图引用越出自身目录：{source} -> {value}"),
            part => parts.push(part),
        }
    }
    let resolved = parts.join("/");
    if !files.contains_key(&resolved) {
        bail!("工作流视图引用不存在：{source} -> {resolved}");
    }
    Ok(())
}

pub(super) fn validate(files: &BTreeMap<String, Vec<u8>>) -> Result<()> {
    let title = Regex::new(r"(?is)<title\b[^>]*>\s*([^<]+)\s*</title\s*>")?;
    let tags = Regex::new(r"(?is)<(script|link|img|source|video|audio)\b[^>]*>")?;
    let attributes = Regex::new(r#"(?is)\b(src|href|poster)\s*=\s*["']([^"']+)["']"#)?;
    let imports = Regex::new(
        r#"(?m)(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bexport\s+[^\n]*?\bfrom\s*)["']([^"']+)["']"#,
    )?;
    let css = Regex::new(r#"(?i)url\(\s*["']?([^\s"')]+)["']?\s*\)|@import\s+["']([^"']+)["']"#)?;
    let views = files
        .keys()
        .filter_map(|path| {
            let parts = path.split('/').collect::<Vec<_>>();
            (parts.len() >= 3 && parts[0] == "views").then(|| parts[1].to_owned())
        })
        .collect::<BTreeSet<_>>();
    for view in views {
        let entry = format!("views/{view}/index.html");
        let bytes = files
            .get(&entry)
            .ok_or_else(|| anyhow!("工作流视图缺少入口：{entry}"))?;
        let html = std::str::from_utf8(bytes).context("工作流视图 HTML 不是 UTF-8")?;
        if !title
            .captures(html)
            .is_some_and(|c| !c[1].trim().is_empty())
        {
            bail!("工作流视图需要非空 title：{entry}");
        }
    }
    for (path, bytes) in files.iter().filter(|(path, _)| path.starts_with("views/")) {
        let extension = Path::new(path)
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("");
        if !matches!(extension, "html" | "htm" | "js" | "mjs" | "css") {
            continue;
        }
        let text = std::str::from_utf8(bytes)
            .with_context(|| format!("工作流视图源码不是 UTF-8：{path}"))?;
        if matches!(extension, "html" | "htm") {
            for tag in tags.captures_iter(text) {
                for attribute in attributes.captures_iter(&tag[0]) {
                    reference(
                        files,
                        path,
                        &attribute[2],
                        tag[1].eq_ignore_ascii_case("script"),
                    )?;
                }
            }
        } else if matches!(extension, "js" | "mjs") {
            for import in imports.captures_iter(text) {
                reference(files, path, &import[1], true)?;
            }
        } else {
            for item in css.captures_iter(text) {
                reference(
                    files,
                    path,
                    item.get(1).or_else(|| item.get(2)).unwrap().as_str(),
                    false,
                )?;
            }
        }
    }
    // Authored checklist lists have identities; verdicts and gate semantics
    // remain entirely package policy. Other package data is left uninterpreted.
    for (path, bytes) in files.iter().filter(|(path, _)| {
        path.starts_with("checklists/")
            && matches!(
                Path::new(path).extension().and_then(|v| v.to_str()),
                Some("yaml" | "yml" | "json")
            )
    }) {
        let value: Value =
            serde_yaml::from_slice(bytes).with_context(|| format!("规范数据格式错误：{path}"))?;
        if let Some(items) = value.as_array() {
            let mut ids = BTreeSet::new();
            for item in items {
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.trim().is_empty())
                    .ok_or_else(|| anyhow!("规范条目缺少 id：{path}"))?;
                if !ids.insert(id) {
                    bail!("规范条目 id 重复：{path} -> {id}");
                }
            }
        }
    }
    Ok(())
}
