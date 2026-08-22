//! Which workspace a command runs in, and which directory inside it.
//!
//! Shared by the two commands that run something — `genet agent run` and
//! `genet shell` — because a question answered twice is a question answered
//! two ways. Nothing here is ever inferred: there is no fallback to the
//! caller's own process directory, since an agent that happened to be in
//! `/tmp` must not have its command quietly act on `/tmp`
//! (`genet-remote-execution.md` §5.5).

use std::path::{Path, PathBuf};

use genehub_proto::WorkspaceInfo;

use super::output::CliFailure;
use super::query;
use super::rpc::Rpc;

/// What a named directory turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Located {
    /// A workspace, and the directory inside it when one was named. The
    /// directory is absolute rather than the remainder below the root: a
    /// multi-folder workspace can hold the same relative path under two
    /// folders, and the daemon would have to guess which was meant.
    In {
        workspace_id: String,
        cwd: Option<String>,
    },
    /// A real directory that no workspace on that machine covers. The caller
    /// decides whether that is an error or an invitation to open one.
    Uncovered(PathBuf),
}

/// Resolves `--workspace` or `--cwd` against the machine that will do the work.
pub async fn locate(
    rpc: &Rpc,
    workspace_id: Option<String>,
    cwd: Option<&str>,
    here: bool,
) -> Result<Located, CliFailure> {
    if let Some(workspace_id) = workspace_id {
        if cwd.is_some() {
            return Err(CliFailure::invalid_args(
                "--workspace and --cwd are two answers to the same question; give one",
            ));
        }
        let known = query::list_workspaces(rpc).await?;
        if !known.iter().any(|workspace| workspace.id == workspace_id) {
            return Err(CliFailure::target_not_found("workspace", &workspace_id));
        }
        return Ok(Located::In {
            workspace_id,
            cwd: None,
        });
    }
    let Some(cwd) = cwd else {
        return Err(CliFailure::invalid_args(
            "which directory should this run in? pass --cwd <dir> or --workspace <id>; neither \
             is inferred",
        ));
    };
    let absolute = absolute_cwd(cwd, here)?;
    let known = query::list_workspaces(rpc).await?;
    Ok(match deepest_containing(&known, &absolute, here) {
        Some(workspace) => Located::In {
            workspace_id: workspace.id.clone(),
            cwd: Some(absolute.to_string_lossy().into_owned()),
        },
        None => Located::Uncovered(absolute),
    })
}

/// The directory named, as the machine that will run in it would write it.
///
/// Only a local directory can be resolved from here. A relative `--cwd` aimed
/// at another machine would silently mean "wherever that string lands over
/// there", so it is refused instead of resolved against the wrong filesystem.
pub fn absolute_cwd(cwd: &str, here: bool) -> Result<PathBuf, CliFailure> {
    if here {
        let path = std::path::Path::new(cwd);
        let full = if path.is_absolute() {
            path.to_path_buf()
        } else {
            super::caller_cwd().join(path)
        };
        return std::fs::canonicalize(&full)
            .map_err(|error| CliFailure::invalid_args(format!("--cwd {cwd}: {error}")));
    }
    let path = PathBuf::from(cwd);
    if !path.is_absolute() {
        return Err(CliFailure::invalid_args(format!(
            "--cwd {cwd} is relative, and this machine's directories are not the other machine's; \
             give the absolute path as it exists there"
        )));
    }
    Ok(path)
}

/// The workspace whose folders reach deepest into `path`.
///
/// Every folder counts, not only the first: a multi-folder workspace is one
/// project, and work started in its second folder is not a different workspace.
pub fn deepest_containing<'a>(
    workspaces: &'a [WorkspaceInfo],
    path: &Path,
    here: bool,
) -> Option<&'a WorkspaceInfo> {
    workspaces
        .iter()
        .filter_map(|workspace| {
            roots_of(workspace)
                .into_iter()
                .filter_map(|root| {
                    let root = PathBuf::from(root);
                    let root = if here {
                        std::fs::canonicalize(&root).unwrap_or(root)
                    } else {
                        root
                    };
                    path.strip_prefix(&root).ok()?;
                    Some(root.components().count())
                })
                .max()
                .map(|depth| (workspace, depth))
        })
        .max_by_key(|(_, depth)| *depth)
        .map(|(workspace, _)| workspace)
}

/// Every physical directory a workspace covers, first folder included.
fn roots_of(workspace: &WorkspaceInfo) -> Vec<&str> {
    let mut roots = vec![workspace.root.as_str()];
    for folder in &workspace.folders {
        if folder.root != workspace.root {
            roots.push(folder.root.as_str());
        }
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(id: &str, roots: &[&Path]) -> WorkspaceInfo {
        WorkspaceInfo {
            id: id.into(),
            name: id.into(),
            root: roots[0].to_string_lossy().into_owned(),
            is_git_repo: false,
            folders: roots
                .iter()
                .enumerate()
                .map(|(index, root)| genehub_proto::WorkspaceFolderInfo {
                    name: format!("f{index}"),
                    root: root.to_string_lossy().into_owned(),
                    root_handle: format!("h{index}"),
                })
                .collect(),
            workspace_file: None,
        }
    }

    #[test]
    fn the_deepest_workspace_wins_so_a_nested_checkout_is_not_stolen() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let inner = repo.join("services").join("api");
        std::fs::create_dir_all(&inner).unwrap();
        let workspaces = vec![
            workspace("w_home", &[dir.path()]),
            workspace("w_repo", &[&repo]),
        ];

        let chosen =
            deepest_containing(&workspaces, &std::fs::canonicalize(&inner).unwrap(), true).unwrap();
        assert_eq!(chosen.id, "w_repo");
        let at_the_root =
            deepest_containing(&workspaces, &std::fs::canonicalize(&repo).unwrap(), true).unwrap();
        assert_eq!(at_the_root.id, "w_repo");
        assert!(deepest_containing(&workspaces, Path::new("/nowhere/at/all"), true).is_none());
    }

    #[test]
    fn a_directory_in_a_second_folder_belongs_to_that_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("app");
        let second = dir.path().join("infra");
        let inside = second.join("deploy");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&first).unwrap();
        let workspaces = vec![workspace("w_pair", &[&first, &second])];

        let chosen =
            deepest_containing(&workspaces, &std::fs::canonicalize(&inside).unwrap(), true)
                .unwrap();
        assert_eq!(chosen.id, "w_pair");
    }

    #[test]
    fn a_remote_directory_is_read_as_the_other_machine_wrote_it() {
        // No canonicalization and no local existence check: the path belongs to
        // a filesystem this process cannot see.
        let (root, child) = if cfg!(windows) {
            (r"C:\srv\app", r"C:\srv\app\services")
        } else {
            ("/srv/app", "/srv/app/services")
        };
        let workspaces = vec![workspace("w_remote", &[Path::new(root)])];
        let absolute = absolute_cwd(child, false).unwrap();
        assert_eq!(
            deepest_containing(&workspaces, &absolute, false)
                .unwrap()
                .id,
            "w_remote"
        );
        assert_eq!(
            absolute_cwd("services", false).unwrap_err().code,
            "invalidArgs"
        );
    }
}
