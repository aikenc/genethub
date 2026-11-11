//! Project-pinned preview entries.
//!
//! The first slice is deliberately local and file-based: the Agent writes a
//! small project list, the daemon reads it into `workspace.list`, and the
//! Workbench renders the entry strip. Service lifecycle, ownership and
//! inheritance remain the next slices; `preview feedback` stays where it was.

use std::path::{Path, PathBuf};

use genehub_proto::WorkspaceInfo;
use serde_json::{json, Value};

use super::output::{self, CliFailure};
use super::query;
use super::target::Selection;

const USAGE: &str = "usage: genet preview list [--workspace <id>] | \
genet preview add --title <title> --entry <relative-path> [--open fullscreen|float] \
[--kind file|service] [--id <id>] [--workspace <id>] | \
genet preview remove <id> [--workspace <id>]";

fn business(message: impl Into<String>) -> CliFailure {
    CliFailure::business("previewEntryError", message.into(), None)
}

pub async fn preview(args: &[String], selection: &Selection) -> i32 {
    if selection.machine.is_some() {
        return output::fail(CliFailure::invalid_args(
            "preview 命令只在当前机器执行，不能使用 --machine",
        ));
    }
    let Some(verb) = args.first().map(String::as_str) else {
        return output::fail(CliFailure::invalid_args(USAGE));
    };
    let result = match verb {
        "list" => list(&args[1..], selection).await,
        "add" => add(&args[1..], selection).await,
        "remove" => remove(&args[1..], selection).await,
        other => Err(CliFailure::invalid_args(format!(
            "preview {other} is not a command; {USAGE}"
        ))),
    };
    match result {
        Ok((kind, value)) => output::succeed(&kind, value),
        Err(error) => output::fail(error),
    }
}

async fn workspace(selection: &Selection, explicit: Option<String>) -> Result<WorkspaceInfo, CliFailure> {
    let rpc = query::connect_selected(selection).await?;
    let workspace_id = super::project::resolve_workspace(&rpc, explicit).await?;
    let workspaces = query::list_workspaces(&rpc).await?;
    workspaces
        .into_iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| CliFailure::target_not_found("workspace", &workspace_id))
}

fn project_root(info: &WorkspaceInfo) -> PathBuf {
    info.workspace_file
        .as_deref()
        .and_then(|file| Path::new(file).parent())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(&info.root))
}

fn entries_path(info: &WorkspaceInfo) -> PathBuf {
    project_root(info).join(".genethub").join("preview-entries.json")
}

fn read_entries(path: &Path) -> Result<Vec<Value>, CliFailure> {
    let body = match std::fs::read_to_string(path) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(business(format!("读取入口清单失败：{error}"))),
    };
    let value: Value =
        serde_json::from_str(&body).map_err(|error| business(format!("入口清单不是有效 JSON：{error}")))?;
    Ok(value
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn write_entries(info: &WorkspaceInfo, entries: &[Value]) -> Result<(), CliFailure> {
    let path = entries_path(info);
    let directory = path
        .parent()
        .ok_or_else(|| business("入口清单没有父目录"))?;
    std::fs::create_dir_all(directory).map_err(|error| business(format!("创建 .genethub 失败：{error}")))?;
    let body = json!({"schema": "genet.preview-entries.v1", "entries": entries});
    crate::config::save_private(&path, body.to_string().as_bytes())
        .map_err(|error| business(format!("写入入口清单失败：{error}")))
}

fn parse_workspace(args: &[String]) -> (Option<String>, Vec<String>) {
    let mut workspace = None;
    let mut rest = Vec::new();
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--workspace" && index + 1 < args.len() {
            workspace = Some(args[index + 1].clone());
            index += 2;
        } else {
            rest.push(args[index].clone());
            index += 1;
        }
    }
    (workspace, rest)
}

async fn list(args: &[String], selection: &Selection) -> Result<(String, Value), CliFailure> {
    let (workspace_id, rest) = parse_workspace(args);
    if !rest.is_empty() {
        return Err(CliFailure::invalid_args(USAGE));
    }
    let info = workspace(selection, workspace_id).await?;
    let entries = read_entries(&entries_path(&info))?;
    Ok((
        "preview.list".into(),
        json!({
            "workspaceId": info.id,
            "projectRoot": project_root(&info).display().to_string(),
            "entries": entries,
        }),
    ))
}

async fn add(args: &[String], selection: &Selection) -> Result<(String, Value), CliFailure> {
    let (workspace_id, rest) = parse_workspace(args);
    let mut title = None;
    let mut entry = None;
    let mut open_mode = "fullscreen".to_string();
    let mut kind = "file".to_string();
    let mut id = None;
    let mut index = 0;
    while index < rest.len() {
        let flag = rest[index].as_str();
        let value = rest.get(index + 1).cloned();
        match (flag, value) {
            ("--title", Some(v)) => title = Some(v),
            ("--entry", Some(v)) => entry = Some(v),
            ("--open", Some(v)) => open_mode = v,
            ("--kind", Some(v)) => kind = v,
            ("--id", Some(v)) => id = Some(v),
            _ => return Err(CliFailure::invalid_args(USAGE)),
        }
        index += 2;
    }
    let title = title.ok_or_else(|| CliFailure::invalid_args(USAGE))?;
    let entry = entry.ok_or_else(|| CliFailure::invalid_args(USAGE))?;
    if !matches!(open_mode.as_str(), "fullscreen" | "float") {
        return Err(CliFailure::invalid_args("--open must be fullscreen or float"));
    }
    if !matches!(kind.as_str(), "file" | "service") {
        return Err(CliFailure::invalid_args("--kind must be file or service"));
    }
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 120 {
        return Err(CliFailure::invalid_args("--title must be 1-120 characters"));
    }
    let relative = entry.trim().replace('\\', "/");
    if relative.is_empty() || relative.starts_with('/') {
        return Err(CliFailure::invalid_args("--entry must be a workspace-relative path"));
    }
    if relative
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
        || relative.split('/').next() == Some(".genethub")
    {
        return Err(CliFailure::invalid_args("--entry must not escape the project folder"));
    }
    let info = workspace(selection, workspace_id).await?;
    let folder = info
        .folders
        .first()
        .ok_or_else(|| business("项目没有可用的 folder"))?;
    let root = std::fs::canonicalize(&folder.root)
        .map_err(|error| business(format!("项目目录不可用：{error}")))?;
    let canonical = std::fs::canonicalize(root.join(&relative)).map_err(|_| {
        business(format!(
            "入口文件不存在：{}",
            root.join(&relative).display()
        ))
    })?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return Err(business("入口文件必须位于项目目录内且是普通文件"));
    }
    let path = entries_path(&info);
    let mut entries = read_entries(&path)?;
    if entries
        .iter()
        .any(|existing| existing.get("entry").and_then(Value::as_str) == Some(relative.as_str()))
    {
        return Err(business("这个入口文件已经固定过了；用 preview remove 后再改"));
    }
    let id = match id {
        Some(id) => {
            if id.is_empty()
                || id.len() > 64
                || !id.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                || !id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
            {
                return Err(CliFailure::invalid_args(
                    "--id must match [a-z0-9][a-z0-9._-]{0,63}",
                ));
            }
            id
        }
        None => {
            let base = slug(title);
            let base = if base.is_empty() { "entry".to_string() } else { base };
            let mut candidate = base.clone();
            let mut suffix = 2;
            while entries.iter().any(|existing| existing.get("id").and_then(Value::as_str) == Some(candidate.as_str())) {
                candidate = format!("{base}-{suffix}");
                suffix += 1;
            }
            candidate
        }
    };
    if entries.iter().any(|existing| existing.get("id").and_then(Value::as_str) == Some(id.as_str())) {
        return Err(business("这个入口 id 已经存在"));
    }
    entries.push(json!({
        "id": id,
        "title": title,
        "entry": relative,
        "openMode": open_mode,
        "kind": kind,
    }));
    write_entries(&info, &entries)?;
    Ok((
        "preview.add".into(),
        json!({
            "workspaceId": info.id,
            "projectRoot": project_root(&info).display().to_string(),
            "entry": entries.last().cloned().unwrap_or(Value::Null),
            "total": entries.len(),
        }),
    ))
}

async fn remove(args: &[String], selection: &Selection) -> Result<(String, Value), CliFailure> {
    let (workspace_id, rest) = parse_workspace(args);
    let mut id = None;
    let mut index = 0;
    while index < rest.len() {
        match rest[index].as_str() {
            "--keep-service" => index += 1,
            other => {
                if id.is_some() {
                    return Err(CliFailure::invalid_args(USAGE));
                }
                id = Some(other.to_string());
                index += 1;
            }
        }
    }
    let id = id.ok_or_else(|| CliFailure::invalid_args(USAGE))?;
    let info = workspace(selection, workspace_id).await?;
    let path = entries_path(&info);
    let mut entries = read_entries(&path)?;
    let before = entries.len();
    entries.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id.as_str()));
    if entries.len() == before {
        return Err(CliFailure::target_not_found("preview entry", &id));
    }
    write_entries(&info, &entries)?;
    Ok((
        "preview.remove".into(),
        json!({
            "workspaceId": info.id,
            "removed": id,
            "total": entries.len(),
        }),
    ))
}

fn slug(value: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            out.push(character.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    out.trim_matches('-').to_string()
}
