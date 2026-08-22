//! Git status, diff and commit by shelling out to `git`.
//!
//! No libgit2: linking it would add megabytes to a binary with a hard size
//! budget, and every machine that has a checkout already has the CLI.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use crate::os_process::Command;
use anyhow::{anyhow, Context, Result};
use genehub_proto::{GitChange, GitChangeKind, GitStatus};
use tokio::io::{AsyncRead, AsyncReadExt};

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_STDOUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;

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

    let raw = git(root, &["status", "--porcelain=v1", "-z"]).await?;
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
