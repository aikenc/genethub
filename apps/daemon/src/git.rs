//! Git status, diff and commit by shelling out to `git`.
//!
//! No libgit2: linking it would add megabytes to a binary with a hard size
//! budget, and every machine that has a checkout already has the CLI.

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::os_process::Command;
use anyhow::{anyhow, Context, Result};
use genehub_proto::{GitChange, GitChangeKind, GitStatus};
use tokio::io::{AsyncRead, AsyncReadExt};

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_STDOUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateIntegration {
    pub previous_head: String,
    pub integrated_commit: String,
    pub integrated_tree: String,
}

async fn git(root: &Path, args: &[&str]) -> Result<String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("running git; is it installed?")?;
    let stdout = child.stdout.take().context("capturing git stdout")?;
    let stderr = child.stderr.take().context("capturing git stderr")?;
    let collected = tokio::time::timeout(GIT_TIMEOUT, async move {
        tokio::try_join!(
            read_bounded(stdout, MAX_STDOUT_BYTES, "git output"),
            read_bounded(stderr, MAX_STDERR_BYTES, "git error output"),
            async { child.wait().await.context("waiting for git") },
        )
    })
    .await
    .map_err(|_| anyhow!("git {} timed out", args.join(" ")))??;
    let (stdout, stderr, status) = collected;
    if !status.success() {
        return Err(anyhow!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&stdout).to_string())
}

async fn read_bounded(
    mut input: impl AsyncRead + Unpin,
    limit: usize,
    label: &'static str,
) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = input.read(&mut buffer).await?;
        if count == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(count) > limit {
            return Err(anyhow!("{label} exceeded the {limit}-byte safety limit"));
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

pub async fn status(root: &Path) -> Result<GitStatus> {
    let branch = git(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "HEAD");

    // Expand untracked directories to individual files. Security-sensitive
    // callers compare exact candidate paths and must not receive Git's
    // directory-collapsed shorthand.
    let raw = git(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await?;
    let changes = parse_status(&raw);
    Ok(GitStatus {
        branch,
        clean: changes.is_empty(),
        changes,
    })
}

/// Parses `--porcelain=v1 -z`.
///
/// NUL separation rather than newlines because filenames may contain newlines,
/// and the quoted form that avoids that is harder to unescape correctly.
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

        // A rename entry is followed by its original path, which we consume so
        // it is not mistaken for another change.
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

        // The worktree column wins when both are set: it is the newer state.
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

pub async fn diff(root: &Path, path: Option<&str>) -> Result<String> {
    let mut args = vec!["diff", "HEAD", "--no-color"];
    if let Some(path) = path {
        args.push("--");
        args.push(path);
    }
    match git(root, &args).await {
        Ok(diff) if !diff.trim().is_empty() => Ok(diff),
        // Before the first commit there is no HEAD to diff against, so fall
        // back to the index. Returning an error here would make a fresh repo
        // look broken.
        _ => {
            let mut args = vec!["diff", "--no-color"];
            if let Some(path) = path {
                args.push("--");
                args.push(path);
            }
            git(root, &args).await
        }
    }
}

pub async fn commit(root: &Path, message: &str, paths: &[String]) -> Result<String> {
    if message.trim().is_empty() {
        return Err(anyhow!("a commit needs a message"));
    }
    if paths.is_empty() {
        git(root, &["add", "-A"]).await?;
    } else {
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().map(String::as_str));
        git(root, &args).await?;
    }

    let staged = git(root, &["diff", "--cached", "--name-only"]).await?;
    if staged.trim().is_empty() {
        return Err(anyhow!("nothing staged to commit"));
    }

    git(root, &["commit", "-m", message]).await?;
    Ok(git(root, &["rev-parse", "HEAD"]).await?.trim().to_string())
}

/// Restore only the index entries staged by a failed controlled commit. This
/// never changes working-tree bytes.
pub async fn unstage(root: &Path, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Err(anyhow!("unstage requires at least one bounded path"));
    }
    let mut args = vec!["reset", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(root, &args).await.map(|_| ())
}

/// Prove that an Agent Space subtree still has the exact tree recorded at one
/// clean project commit. Later descendant commits may change unrelated project
/// files (for example the project's own Workflow) without invalidating this
/// Space; changes inside the recorded subtree and any uncommitted project
/// source drift are rejected.
pub async fn verify_clean_project_sources_at_commit(
    repository_root: &Path,
    commit: &str,
    subtree: &Path,
) -> Result<()> {
    verify_clean_project_sources_at_commit_allowing_untracked(repository_root, commit, subtree, &[])
        .await
}

/// Prove that committed project-owned sources still match one exact ancestor
/// commit, while permitting only explicitly named, project-managed staging
/// trees.
///
/// Workflow improvement bundles are intentionally materialized as inert,
/// untracked project data before independent review. They are digest-bound by
/// the PM domain and must not force the Agent Space source verifier to accept
/// unrelated untracked files elsewhere in the repository.
pub async fn verify_clean_project_sources_at_commit_allowing_untracked(
    repository_root: &Path,
    commit: &str,
    subtree: &Path,
    allowed_untracked_subtrees: &[&Path],
) -> Result<()> {
    validate_object_id("commit", commit)?;
    let root = repository_root
        .canonicalize()
        .context("canonicalizing Git repository root")?;
    let subtree = subtree
        .canonicalize()
        .context("canonicalizing Git subtree")?;
    let relative = git_relative_path(&root, &subtree)?;
    let commit_object = format!("{commit}^{{commit}}");
    git(&root, &["rev-parse", "--verify", &commit_object])
        .await
        .context("source commit is not a local commit object")?;
    git(&root, &["merge-base", "--is-ancestor", commit, "HEAD"])
        .await
        .context("Agent Space source commit is not an ancestor of the current project HEAD")?;
    let committed_path = format!("{commit}:{relative}");
    let current_path = format!("HEAD:{relative}");
    let committed_tree = git(&root, &["rev-parse", "--verify", &committed_path])
        .await
        .context("source commit does not contain the Agent Space")?;
    let current_tree = git(&root, &["rev-parse", "--verify", &current_path])
        .await
        .context("current project HEAD does not contain the Agent Space")?;
    if !committed_tree
        .trim()
        .eq_ignore_ascii_case(current_tree.trim())
    {
        anyhow::bail!("Agent Space or Provider sources changed after the recorded source commit");
    }
    git(&root, &["diff", "--quiet", "HEAD", "--", "."])
        .await
        .context("the outer project has uncommitted tracked source changes")?;
    let allowed_untracked = allowed_untracked_subtrees
        .iter()
        .map(|path| {
            path.canonicalize()
                .context("canonicalizing allowed project-managed staging subtree")
                .and_then(|path| git_relative_path(&root, &path))
        })
        .collect::<Result<Vec<_>>>()?;
    let untracked = git(
        &root,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
        ],
    )
    .await?;
    let unexpected = untracked
        .split('\0')
        .filter(|path| !path.is_empty())
        .filter(|path| {
            !allowed_untracked.iter().any(|allowed| {
                *path == allowed
                    || path
                        .strip_prefix(allowed)
                        .is_some_and(|suffix| suffix.starts_with('/'))
            })
        })
        .take(8)
        .collect::<Vec<_>>();
    if !unexpected.is_empty() {
        anyhow::bail!(
            "the outer project has untracked human-owned Agent Space or Provider sources: {}",
            unexpected.join(", ")
        );
    }
    Ok(())
}

/// Prove that a writable path is a worktree of the expected local repository
/// and is on the branch assigned by the PM graph.
pub async fn verify_worktree_binding(
    worktree: &Path,
    repository_root: &Path,
    expected_branch: &str,
) -> Result<()> {
    if expected_branch.trim().is_empty() || expected_branch.chars().any(char::is_control) {
        anyhow::bail!("expected Git branch is invalid");
    }
    let worktree = worktree
        .canonicalize()
        .context("canonicalizing package worktree")?;
    let repository_root = repository_root
        .canonicalize()
        .context("canonicalizing package repository")?;
    let common = git(&worktree, &["rev-parse", "--git-common-dir"])
        .await
        .context("package worktree is not a Git worktree")?;
    let common = resolve_git_path(&worktree, common.trim())?;
    let expected_common = if repository_root.join(".git").exists() {
        repository_root.join(".git").canonicalize()?
    } else {
        repository_root.clone()
    };
    if common != expected_common {
        anyhow::bail!("package worktree belongs to another local repository");
    }
    let branch = git(&worktree, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await
        .context("package worktree has a detached HEAD")?;
    if branch.trim() != expected_branch {
        anyhow::bail!(
            "package worktree is on branch {}, expected {expected_branch}",
            branch.trim()
        );
    }
    Ok(())
}

/// Bind candidate evidence to the exact clean HEAD of its assigned worktree.
pub async fn verify_worktree_candidate(
    worktree: &Path,
    repository_root: &Path,
    expected_branch: &str,
    commit: &str,
    tree: &str,
) -> Result<()> {
    validate_object_id("candidate commit", commit)?;
    validate_object_id("candidate tree", tree)?;
    verify_worktree_binding(worktree, repository_root, expected_branch).await?;
    let head = git(worktree, &["rev-parse", "HEAD"]).await?;
    if !head.trim().eq_ignore_ascii_case(commit) {
        anyhow::bail!("candidate commit is not the assigned worktree HEAD");
    }
    let actual_tree = git(worktree, &["show", "-s", "--format=%T", commit]).await?;
    if !actual_tree.trim().eq_ignore_ascii_case(tree) {
        anyhow::bail!("candidate tree does not match the candidate commit");
    }
    let status = git(
        worktree,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )
    .await?;
    if !status.is_empty() {
        anyhow::bail!("candidate worktree is not clean");
    }
    Ok(())
}

/// Derive immutable candidate identity from the exact clean HEAD of a bound
/// package worktree.  Callers still pass the repository and branch contract;
/// this is not an inference from an Agent's prose.
pub async fn worktree_candidate_identity(
    worktree: &Path,
    repository_root: &Path,
    expected_branch: &str,
) -> Result<(String, String)> {
    verify_worktree_binding(worktree, repository_root, expected_branch).await?;
    let commit = git(worktree, &["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_string();
    let tree = git(worktree, &["show", "-s", "--format=%T", &commit])
        .await?
        .trim()
        .to_string();
    verify_worktree_candidate(worktree, repository_root, expected_branch, &commit, &tree).await?;
    Ok((commit, tree))
}

/// Integrate one exact, independently accepted local candidate into the clean
/// `main` baseline. The operation is idempotent: a retry after a successful
/// merge but before PM state persistence simply re-proves ancestry and records
/// the current baseline. Conflicts are aborted before returning an error.
pub async fn integrate_candidate(
    repository_root: &Path,
    candidate_commit: &str,
    candidate_tree: &str,
) -> Result<CandidateIntegration> {
    validate_object_id("candidate commit", candidate_commit)?;
    validate_object_id("candidate tree", candidate_tree)?;
    let repository_root = repository_root
        .canonicalize()
        .context("canonicalizing integration repository")?;
    reject_unsafe_integration_config(&repository_root).await?;
    let before = status(&repository_root).await?;
    if before.branch.as_deref() != Some("main") {
        anyhow::bail!("accepted candidates can be integrated only into local main");
    }
    if !before.clean {
        anyhow::bail!("integration baseline is not clean");
    }
    let candidate_object = format!("{candidate_commit}^{{commit}}");
    git(
        &repository_root,
        &["rev-parse", "--verify", &candidate_object],
    )
    .await
    .context("candidate commit is not a local commit object")?;
    let actual_candidate_tree = git(
        &repository_root,
        &["show", "-s", "--format=%T", candidate_commit],
    )
    .await?;
    if !actual_candidate_tree
        .trim()
        .eq_ignore_ascii_case(candidate_tree)
    {
        anyhow::bail!("candidate tree does not match the candidate commit");
    }

    let previous_head = git(&repository_root, &["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_string();
    let already_integrated = git(
        &repository_root,
        &["merge-base", "--is-ancestor", candidate_commit, "HEAD"],
    )
    .await
    .is_ok();
    if !already_integrated {
        let merge = git(
            &repository_root,
            &[
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "commit.gpgsign=false",
                "merge",
                "--no-edit",
                candidate_commit,
            ],
        )
        .await;
        if let Err(error) = merge {
            let abort = git(&repository_root, &["merge", "--abort"]).await;
            if let Err(abort_error) = abort {
                return Err(error.context(format!(
                    "integration conflicted and git merge --abort also failed: {abort_error:#}"
                )));
            }
            return Err(error.context("accepted candidate could not be merged cleanly"));
        }
    }

    let after = status(&repository_root).await?;
    if after.branch.as_deref() != Some("main") || !after.clean {
        anyhow::bail!("integration did not leave a clean local main baseline");
    }
    git(
        &repository_root,
        &["merge-base", "--is-ancestor", candidate_commit, "HEAD"],
    )
    .await
    .context("integrated baseline does not contain the accepted candidate")?;
    let integrated_commit = git(&repository_root, &["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_string();
    let integrated_tree = git(&repository_root, &["show", "-s", "--format=%T", "HEAD"])
        .await?
        .trim()
        .to_string();
    Ok(CandidateIntegration {
        previous_head,
        integrated_commit,
        integrated_tree,
    })
}

async fn reject_unsafe_integration_config(repository_root: &Path) -> Result<()> {
    let names = git(
        repository_root,
        &["config", "--local", "--name-only", "--list"],
    )
    .await?;
    for name in names.lines().map(str::trim).filter(|name| !name.is_empty()) {
        let normalized = name.to_ascii_lowercase();
        let executable = normalized == "core.fsmonitor"
            || (normalized.starts_with("merge.") && normalized.ends_with(".driver"))
            || (normalized.starts_with("filter.")
                && [".clean", ".smudge", ".process"]
                    .iter()
                    .any(|suffix| normalized.ends_with(suffix)));
        if executable {
            anyhow::bail!("integration repository config {name} may execute an external command");
        }
    }
    Ok(())
}

fn validate_object_id(label: &str, value: &str) -> Result<()> {
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        anyhow::bail!("{label} must be a full Git object id");
    }
    Ok(())
}

fn git_relative_path(root: &Path, path: &Path) -> Result<String> {
    let relative = path
        .strip_prefix(root)
        .context("Git path escaped its repository")?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        anyhow::bail!("Git path must be a strict repository descendant");
    }
    relative
        .components()
        .map(|component| {
            component
                .as_os_str()
                .to_str()
                .context("Git path is not UTF-8")
        })
        .collect::<Result<Vec<_>>>()
        .map(|parts| parts.join("/"))
}

fn resolve_git_path(worktree: &Path, value: &str) -> Result<PathBuf> {
    if value.is_empty() {
        anyhow::bail!("Git returned an empty common directory");
    }
    let path = Path::new(value);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        worktree.join(path)
    };
    path.canonicalize()
        .context("canonicalizing Git common directory")
}
#[cfg(test)]
mod tests {
    use super::*;

    async fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            git(dir.path(), &args).await.unwrap();
        }
        dir
    }

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

    /// A rename emits two NUL-separated fields; treating the second as another
    /// change would invent a file that does not exist.
    #[test]
    fn a_rename_consumes_its_original_path() {
        let changes = parse_status("R  new.txt\0old.txt\0 M other.txt\0");
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].kind, GitChangeKind::Renamed);
        assert_eq!(changes[0].path, "new.txt");
        assert_eq!(changes[1].path, "other.txt");
    }

    #[tokio::test]
    async fn a_fresh_repo_is_clean() {
        let dir = repo().await;
        let status = status(dir.path()).await.unwrap();
        assert!(status.clean);
        assert!(status.changes.is_empty());
    }

    #[tokio::test]
    async fn a_new_file_shows_up_as_untracked_then_commits() {
        let dir = repo().await;
        std::fs::write(dir.path().join("a.txt"), "hello").unwrap();

        let before = status(dir.path()).await.unwrap();
        assert!(!before.clean);
        assert_eq!(before.changes[0].kind, GitChangeKind::Untracked);

        let sha = commit(dir.path(), "add a", &[]).await.unwrap();
        assert_eq!(sha.len(), 40, "a full sha comes back: {sha}");
        assert!(status(dir.path()).await.unwrap().clean);
    }

    #[tokio::test]
    async fn committing_nothing_is_refused_rather_than_creating_an_empty_commit() {
        let dir = repo().await;
        let error = commit(dir.path(), "empty", &[]).await.unwrap_err();
        assert!(error.to_string().contains("nothing staged"));
    }

    #[tokio::test]
    async fn a_commit_without_a_message_is_refused() {
        let dir = repo().await;
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        assert!(commit(dir.path(), "   ", &[]).await.is_err());
    }

    #[tokio::test]
    async fn only_the_named_paths_are_committed() {
        let dir = repo().await;
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        std::fs::write(dir.path().join("b.txt"), "b").unwrap();
        commit(dir.path(), "just a", &["a.txt".to_string()])
            .await
            .unwrap();

        let status = status(dir.path()).await.unwrap();
        assert_eq!(status.changes.len(), 1);
        assert_eq!(status.changes[0].path, "b.txt");
    }

    /// Before the first commit there is no HEAD; a diff must still work rather
    /// than surfacing a git error to the user.
    #[tokio::test]
    async fn diffing_before_the_first_commit_still_works() {
        let dir = repo().await;
        std::fs::write(dir.path().join("a.txt"), "hello\n").unwrap();
        git(dir.path(), &["add", "a.txt"]).await.unwrap();
        let diff = diff(dir.path(), None).await.unwrap();
        assert!(diff.is_empty() || diff.contains("a.txt"));
    }

    #[tokio::test]
    async fn a_modification_appears_in_the_diff() {
        let dir = repo().await;
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        commit(dir.path(), "first", &[]).await.unwrap();
        std::fs::write(dir.path().join("a.txt"), "two\n").unwrap();

        let diff = diff(dir.path(), None).await.unwrap();
        assert!(diff.contains("-one"));
        assert!(diff.contains("+two"));
    }

    #[tokio::test]
    async fn child_output_is_bounded_before_it_can_exhaust_daemon_memory() {
        let data = vec![b'x'; 1025];
        assert!(read_bounded(data.as_slice(), 1024, "test output")
            .await
            .is_err());
        assert_eq!(
            read_bounded(b"small".as_slice(), 1024, "test output")
                .await
                .unwrap(),
            b"small"
        );
    }
}
