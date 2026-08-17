use std::collections::BTreeMap;

use genehub_proto::{ErrorCode, GitChange, GitChangeKind, GitStatus, ProtocolError};
use genet_daemon_logic_api::{
    CapabilityRequest, CapabilityValue, FileLocator, FileRoot, ProcessRequest, ProcessSpec,
};

use crate::capability::Client;
use crate::config::WorkspaceEntry;
use crate::CapabilityExecutor;

const GIT_TIMEOUT_MILLIS: u32 = 30_000;
const MAX_STDOUT_BYTES: u32 = 2 * 1024 * 1024;
const MAX_STDERR_BYTES: u32 = 64 * 1024;

pub fn status(
    workspace: &WorkspaceEntry,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<GitStatus, ProtocolError> {
    let mut client = Client::new(executor, next);
    let branch = git(
        workspace,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        &mut client,
    )
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty() && value != "HEAD");
    let raw = git(workspace, &["status", "--porcelain=v1", "-z"], &mut client)?;
    let changes = parse_status(&raw);
    Ok(GitStatus {
        branch,
        clean: changes.is_empty(),
        changes,
    })
}

pub fn diff(
    workspace: &WorkspaceEntry,
    path: Option<&str>,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<String, ProtocolError> {
    if let Some(path) = path {
        validate_path(path)?;
    }
    let mut client = Client::new(executor, next);
    let mut args = vec!["diff", "HEAD", "--no-color"];
    if let Some(path) = path {
        args.extend(["--", path]);
    }
    match git(workspace, &args, &mut client) {
        Ok(diff) if !diff.trim().is_empty() => Ok(diff),
        _ => {
            let mut args = vec!["diff", "--no-color"];
            if let Some(path) = path {
                args.extend(["--", path]);
            }
            git(workspace, &args, &mut client)
        }
    }
}

pub fn commit(
    workspace: &WorkspaceEntry,
    message: &str,
    paths: &[String],
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<String, ProtocolError> {
    if message.trim().is_empty() {
        return Err(bad_request("a commit needs a message"));
    }
    if message.contains('\0') {
        return Err(bad_request("commit message contains NUL"));
    }
    for path in paths {
        validate_path(path)?;
    }
    let mut client = Client::new(executor, next);
    if paths.is_empty() {
        git(workspace, &["add", "-A"], &mut client)?;
    } else {
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().map(String::as_str));
        git(workspace, &args, &mut client)?;
    }
    let staged = git(workspace, &["diff", "--cached", "--name-only"], &mut client)?;
    if staged.trim().is_empty() {
        return Err(bad_request("nothing staged to commit"));
    }
    git(workspace, &["commit", "-m", message], &mut client)?;
    Ok(git(workspace, &["rev-parse", "HEAD"], &mut client)?
        .trim()
        .to_string())
}

fn git<E: CapabilityExecutor>(
    workspace: &WorkspaceEntry,
    args: &[&str],
    client: &mut Client<'_, E>,
) -> Result<String, ProtocolError> {
    let folder = workspace
        .folders
        .first()
        .ok_or_else(|| bad_request("workspace has no folders"))?;
    let output = match client.call(CapabilityRequest::Process(ProcessRequest::Run {
        spec: ProcessSpec {
            program: "git".to_string(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            env: BTreeMap::new(),
            cwd: Some(FileLocator {
                root: FileRoot::Workspace {
                    handle: folder.root_handle.clone(),
                },
                path: String::new(),
            }),
            confinement: genet_daemon_logic_api::ConfinementMode::None,
            capture_stdout: true,
            capture_stderr: true,
        },
        stdin: Vec::new(),
        timeout_millis: GIT_TIMEOUT_MILLIS,
        max_stdout_bytes: MAX_STDOUT_BYTES,
        max_stderr_bytes: MAX_STDERR_BYTES,
    }))? {
        CapabilityValue::ProcessCompleted {
            code,
            stdout,
            stderr,
        } => (code, stdout, stderr),
        _ => return Err(internal("git process returned the wrong value")),
    };
    if output.0 != Some(0) {
        return Err(ProtocolError {
            code: ErrorCode::Internal,
            message: format!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.2).trim()
            ),
        });
    }
    Ok(String::from_utf8_lossy(&output.1).to_string())
}

fn parse_status(raw: &str) -> Vec<GitChange> {
    let mut changes = Vec::new();
    let mut fields = raw.split('\0').filter(|field| !field.is_empty());
    while let Some(entry) = fields.next() {
        if entry.len() < 3 {
            continue;
        }
        let bytes = entry.as_bytes();
        let index = bytes[0] as char;
        let worktree = bytes[1] as char;
        let path = entry[3..].to_string();
        if index == 'R' || worktree == 'R' {
            let _ = fields.next();
            changes.push(GitChange {
                path,
                kind: GitChangeKind::Renamed,
                staged: index != ' ',
            });
            continue;
        }
        if index == '?' && worktree == '?' {
            changes.push(GitChange {
                path,
                kind: GitChangeKind::Untracked,
                staged: false,
            });
            continue;
        }
        let (code, staged) = if worktree != ' ' {
            (worktree, false)
        } else {
            (index, true)
        };
        let kind = match code {
            'A' => GitChangeKind::Added,
            'D' => GitChangeKind::Deleted,
            _ => GitChangeKind::Modified,
        };
        changes.push(GitChange { path, kind, staged });
    }
    changes
}

fn validate_path(path: &str) -> Result<(), ProtocolError> {
    if path.is_empty()
        || path.contains('\0')
        || path.contains('\\')
        || path.starts_with('/')
        || path.split('/').any(|part| matches!(part, "" | "." | ".."))
    {
        return Err(ProtocolError {
            code: ErrorCode::Forbidden,
            message: "git path escapes the workspace".to_string(),
        });
    }
    Ok(())
}

fn bad_request(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::BadRequest,
        message: message.into(),
    }
}

fn internal(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Internal,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_output_parses_into_typed_changes() {
        let raw = "?? new.txt\0 M edited.txt\0A  added.txt\0 D gone.txt\0";
        let changes = parse_status(raw);
        assert_eq!(changes.len(), 4);
        assert_eq!(changes[0].kind, GitChangeKind::Untracked);
        assert_eq!(changes[1].kind, GitChangeKind::Modified);
        assert!(!changes[1].staged);
        assert_eq!(changes[2].kind, GitChangeKind::Added);
        assert!(changes[2].staged);
        assert_eq!(changes[3].kind, GitChangeKind::Deleted);
    }
}
