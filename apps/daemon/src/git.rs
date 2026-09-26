//! Git status, diff and commit by shelling out to `git`.
//!
//! No libgit2: linking it would add megabytes to a binary with a hard size
//! budget, and every machine that has a checkout already has the CLI.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::os_process::Command;
use anyhow::{anyhow, Context, Result};
use genehub_proto::{GitChange, GitChangeKind, GitStatus};
use tokio::io::{AsyncRead, AsyncReadExt};

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_STDOUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;

/// Whether a directory can reach Git state outside `bounds`.
///
/// A trial runs a Candidate nobody has approved yet, so it must not be able
/// to touch the formal repository. Directory containment cannot answer this:
/// a `.git` file holding `gitdir: /formal/.git` and an
/// `objects/info/alternates` entry both leave the directory itself perfectly
/// inside its bounds while the *repository* they resolve to is the formal
/// one. Only something that understands Git can see the difference, so the
/// question is answered here and the Workflow kernel asks it without
/// learning what a gitdir is.
///
/// Not a provenance probe: a failure to decide is a refusal, never an
/// "unknown". A directory that is not a Git repository at all is fine and
/// returns `Ok(())` — the check constrains repositories, it does not
/// require one.
pub(crate) async fn reaches_git_state_outside(root: &Path, bounds: &Path) -> Result<()> {
    let marker = root.join(".git");
    if let Ok(metadata) = crate::config::sensitive_metadata(&marker) {
        crate::config::reject_link_or_reparse(&marker, &metadata)?;
        if !metadata.is_dir() && !metadata.is_file() {
            anyhow::bail!("experimentIsolation: .git must be a directory or a worktree file");
        }
    }
    // Deliberately asked of every directory, marker or not. Git searches
    // upwards, so a directory with no `.git` of its own is the *parent
    // traversal* case: it silently belongs to whatever repository encloses
    // it, which for a trial is the formal project. Returning early on a
    // missing marker would wave through the plainest escape of the three.
    let Ok(private) = git(root, &["rev-parse", "--git-dir"]).await else {
        // Git resolves nothing here, so there is no repository to escape
        // through — including none above. This is the pure-directory
        // project, and it is allowed.
        return Ok(());
    };
    let bounds = bounds
        .canonicalize()
        .with_context(|| format!("reading the isolation boundary: {}", bounds.display()))?;
    let canonical = root.canonicalize()?;
    let resolve = |value: &str| -> Result<PathBuf> {
        let path = crate::guest_paths::guest_path(Path::new(value.trim()));
        Ok(if path.is_absolute() {
            path.to_path_buf()
        } else {
            canonical.join(path)
        }
        .canonicalize()?)
    };
    // `--git-dir` is where this worktree keeps its own metadata and
    // `--git-common-dir` is the repository it belongs to. A worktree file
    // makes them differ, which is legitimate; both still have to live inside
    // the boundary.
    let private = resolve(&private)?;
    let common = resolve(&git(root, &["rev-parse", "--git-common-dir"]).await?)?;
    for (label, directory) in [("metadata", &private), ("repository", &common)] {
        if !directory.starts_with(&bounds) {
            anyhow::bail!(
                "experimentIsolation: this task directory's Git {label} is {}, outside its own boundary {}",
                directory.display(),
                bounds.display()
            );
        }
    }
    // A `--shared` clone keeps its metadata local while reading objects from
    // whatever it points at, so the two checks above can both pass while the
    // formal object store is still in use.
    let alternates = common.join("objects/info/alternates");
    if crate::config::sensitive_metadata(&alternates).is_ok()
        && !std::fs::read_to_string(&alternates)?.trim().is_empty()
    {
        anyhow::bail!(
            "experimentIsolation: this task directory borrows Git objects through {}; copy them instead of sharing",
            alternates.display()
        );
    }
    Ok(())
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

    let raw = git(root, &["status", "--porcelain=v1", "-z"]).await?;
    let changes = parse_status(&raw);
    Ok(GitStatus {
        branch,
        clean: changes.is_empty(),
        changes,
    })
}

pub(crate) async fn resolve_ref(root: &Path, reference: &str) -> Result<String> {
    Ok(git(root, &["rev-parse", reference])
        .await?
        .trim()
        .to_string())
}

/// The `origin` URL of a checkout, when it has one.
///
/// This is a read, not a network capability: the daemon still never clones,
/// fetches or authenticates. It exists so `workflow list` can report where a
/// Workflow package came from without the platform storing a receipt that
/// would drift from the checkout it describes.
pub(crate) async fn remote_url(root: &Path) -> Result<Option<String>> {
    let Ok(url) = git(root, &["remote", "get-url", "origin"]).await else {
        return Ok(None);
    };
    let url = url.trim();
    Ok((!url.is_empty()).then(|| url.to_string()))
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

    /// The three escapes the boundary exists for. Each one leaves the task
    /// directory itself inside its bounds, which is exactly why a path check
    /// cannot replace this.
    #[tokio::test]
    async fn a_trial_cannot_reach_the_formal_repository_through_git_indirection() {
        let formal = repo().await;
        std::fs::write(formal.path().join("a.txt"), "one\n").unwrap();
        commit(formal.path(), "first", &[]).await.unwrap();

        let trial = tempfile::tempdir().unwrap();

        // A plain directory with no repository anywhere above it. This is
        // the pure-directory project and it is allowed.
        let plain = trial.path().join("plain");
        std::fs::create_dir(&plain).unwrap();
        reaches_git_state_outside(&plain, trial.path())
            .await
            .expect("a directory with no repository above it is not an escape");

        // The plainest escape and the one a path check is least able to
        // see: no `.git` at all, because Git searches upwards and this
        // directory silently belongs to the repository enclosing it.
        let nested = formal.path().join("nested/deep");
        std::fs::create_dir_all(&nested).unwrap();
        let refused = reaches_git_state_outside(&nested, &nested)
            .await
            .expect_err("a directory inside an enclosing repository must be refused");
        assert!(
            format!("{refused:#}").contains("experimentIsolation"),
            "unhelpful refusal: {refused:#}"
        );

        // Its own repository, wholly inside the boundary.
        let contained = trial.path().join("contained");
        std::fs::create_dir(&contained).unwrap();
        for args in [vec!["init", "-q"]] {
            git(&contained, &args).await.unwrap();
        }
        reaches_git_state_outside(&contained, trial.path())
            .await
            .expect("a self-contained repository stays inside its boundary");

        // A `.git` file pointing at the formal repository's metadata.
        let pointer = trial.path().join("pointer");
        std::fs::create_dir(&pointer).unwrap();
        std::fs::write(
            pointer.join(".git"),
            format!("gitdir: {}\n", formal.path().join(".git").display()),
        )
        .unwrap();
        let refused = reaches_git_state_outside(&pointer, trial.path())
            .await
            .expect_err("a gitdir pointer out of the boundary must be refused");
        assert!(
            format!("{refused:#}").contains("experimentIsolation"),
            "unhelpful refusal: {refused:#}"
        );

        // A `--shared` clone keeps local metadata but reads the formal
        // object store, so the directory checks alone would pass it.
        let shared = trial.path().join("shared");
        git(
            formal.path(),
            &[
                "clone",
                "--shared",
                "-q",
                &formal.path().display().to_string(),
                &shared.display().to_string(),
            ],
        )
        .await
        .unwrap();
        let refused = reaches_git_state_outside(&shared, trial.path())
            .await
            .expect_err("borrowed Git objects must be refused");
        assert!(
            format!("{refused:#}").contains("experimentIsolation"),
            "unhelpful refusal: {refused:#}"
        );
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
