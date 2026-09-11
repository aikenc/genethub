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
use sha2::{Digest, Sha256};
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BootstrapState {
    pub direct: bool,
    pub head: Option<String>,
    pub status_digest: String,
    pub changes: Vec<String>,
    pub commit_identity: GitIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GitIdentity {
    pub name: String,
    pub email: String,
    pub product_fallback: bool,
}

impl GitIdentity {
    fn product() -> Self {
        Self {
            name: "GeneHub Bootstrap".into(),
            email: "bootstrap@genehub.local".into(),
            product_fallback: true,
        }
    }

    pub(crate) fn display(&self) -> String {
        format!("{} <{}>", self.name, self.email)
    }
}

/// Git facts safe to pin in a PM bootstrap plan.
///
/// Session-owned runtime paths are deliberately excluded: the Human may leave
/// a plan card open while the stopped interaction updates its own metadata,
/// and that is not a project-source drift. `--untracked-files=all` prevents a
/// top-level `?? .genethub/` row from hiding which child caused the change.
pub(crate) async fn bootstrap_state(root: &Path) -> Result<BootstrapState> {
    let marker = root.join(".git");
    let direct = match crate::config::sensitive_metadata(&marker) {
        Ok(metadata) => {
            crate::config::reject_link_or_reparse(&marker, &metadata)?;
            metadata.is_dir() || metadata.is_file()
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if !direct {
        // A nested ordinary folder must not inherit the enclosing repository's
        // local identity. Only the user's global identity applies before this
        // folder becomes its own repository.
        let commit_identity = bootstrap_identity(root, true).await;
        return Ok(BootstrapState {
            direct: false,
            head: None,
            status_digest: directory_status_digest(root)?,
            changes: non_session_entries(root)?,
            commit_identity,
        });
    }
    let top = git(root, &["rev-parse", "--show-toplevel"])
        .await?
        .trim()
        .to_string();
    let canonical = root.canonicalize()?;
    if Path::new(&top).canonicalize()? != canonical {
        anyhow::bail!("wrongProjectRoot: current Workspace is not the direct Git top-level");
    }
    let head = git(root, &["rev-parse", "--verify", "HEAD"])
        .await
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let raw = git(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await?;
    let changes = parse_status(&raw)
        .into_iter()
        .map(|change| change.path)
        .filter(|path| !session_runtime_path(path))
        .collect::<Vec<_>>();
    let mut digest = Sha256::new();
    digest.update(b"genehub.bootstrap-git-status.v1\0");
    digest.update(head.as_deref().unwrap_or("unborn").as_bytes());
    for path in &changes {
        digest.update((path.len() as u64).to_le_bytes());
        digest.update(path.as_bytes());
    }
    Ok(BootstrapState {
        direct: true,
        head,
        status_digest: format!("sha256:{:x}", digest.finalize()),
        changes,
        commit_identity: bootstrap_identity(root, false).await,
    })
}

async fn bootstrap_identity(root: &Path, global_only: bool) -> GitIdentity {
    let args = |key: &'static str| {
        if global_only {
            vec!["config", "--global", "--get", key]
        } else {
            vec!["config", "--get", key]
        }
    };
    let name = git(root, &args("user.name"))
        .await
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| safe_identity_value(value));
    let email = git(root, &args("user.email"))
        .await
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| safe_identity_value(value));
    match (name, email) {
        (Some(name), Some(email)) => GitIdentity {
            name,
            email,
            product_fallback: false,
        },
        _ => GitIdentity::product(),
    }
}

fn safe_identity_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 320
        && !value.chars().any(char::is_control)
        && !value.contains(['<', '>'])
}

pub(crate) async fn init(root: &Path) -> Result<()> {
    git(root, &["init", "-q"]).await.map(|_| ())
}

pub(crate) async fn bootstrap_commit(
    root: &Path,
    message: &str,
    paths: &[String],
    identity: &GitIdentity,
) -> Result<String> {
    if paths.is_empty() {
        anyhow::bail!("bootstrap commit requires explicit paths");
    }
    let mut add = vec!["add", "--"];
    add.extend(paths.iter().map(String::as_str));
    git(root, &add).await?;
    let staged = git(root, &["diff", "--cached", "--name-only"]).await?;
    if staged.trim().is_empty() {
        anyhow::bail!("nothing staged to commit");
    }
    git(
        root,
        &[
            "-c",
            &format!("user.name={}", identity.name),
            "-c",
            &format!("user.email={}", identity.email),
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            message,
        ],
    )
    .await?;
    resolve_ref(root, "HEAD").await
}

/// Returns the index/ref to the exact state pinned by a Bootstrap plan.
/// Worktree files are intentionally retained for the caller's path-scoped
/// compensation. Refusing a moved HEAD protects user commits made outside the
/// transaction from being rewritten as part of rollback.
pub(crate) async fn rollback_bootstrap_git(
    root: &Path,
    previous_head: Option<&str>,
    bootstrap_commit: Option<&str>,
) -> Result<()> {
    if let Some(expected) = bootstrap_commit {
        let current = resolve_ref(root, "HEAD").await?;
        if current != expected {
            anyhow::bail!(
                "rollback refused because HEAD moved from bootstrap commit {expected} to {current}"
            );
        }
    }

    match previous_head {
        Some(previous) => {
            git(root, &["reset", "--mixed", previous]).await?;
        }
        None => {
            if bootstrap_commit.is_some() {
                let reference = git(root, &["symbolic-ref", "-q", "HEAD"])
                    .await?
                    .trim()
                    .to_string();
                if reference.is_empty() {
                    anyhow::bail!("rollback refused because bootstrap HEAD is detached");
                }
                git(root, &["update-ref", "-d", &reference]).await?;
            }
            git(root, &["read-tree", "--empty"]).await?;
        }
    }
    Ok(())
}

pub(crate) async fn bootstrap_paths(root: &Path) -> Result<Vec<String>> {
    let raw = git(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await?;
    let mut paths = parse_status(&raw)
        .into_iter()
        .map(|change| change.path)
        // The Session store creates this exact ignore file before bootstrap.
        // It is project-safe, deterministic bootstrap infrastructure and must
        // become tracked; otherwise the brand-new repository is immediately
        // dirty and cannot grant the first Worker a direct-write lease.
        .filter(|path| path == ".genethub/.gitignore" || !session_runtime_path(path))
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn session_runtime_path(path: &str) -> bool {
    let Some(relative) = path.strip_prefix(".genethub/") else {
        return false;
    };
    let first = relative.split('/').next().unwrap_or_default();
    session_home_entry(first)
}

/// Entries owned by the Session store rather than by project source.
///
/// A normal Session necessarily creates these before its Agent can ask the
/// Human whether to bootstrap. Treating them as user project content makes
/// the advertised "empty folder + normal Session" entry journey impossible.
fn session_home_entry(name: &str) -> bool {
    matches!(
        name,
        ".gitignore"
            | "owner.lock"
            | "owner"
            | "sessions"
            | "tombstones"
            | "artifacts"
            | "components"
    )
}

fn non_session_entries(root: &Path) -> Result<Vec<String>> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".genethub" {
            let disallowed = std::fs::read_dir(entry.path())?
                .filter_map(Result::ok)
                .map(|child| child.file_name().to_string_lossy().to_string())
                .filter(|child| !session_home_entry(child))
                .collect::<Vec<_>>();
            entries.extend(
                disallowed
                    .into_iter()
                    .map(|child| format!(".genethub/{child}")),
            );
        } else {
            entries.push(name);
        }
    }
    entries.sort();
    Ok(entries)
}

fn directory_status_digest(root: &Path) -> Result<String> {
    let entries = non_session_entries(root)?;
    let mut digest = Sha256::new();
    digest.update(b"genehub.bootstrap-directory-status.v1\0");
    for entry in entries {
        digest.update((entry.len() as u64).to_le_bytes());
        digest.update(entry.as_bytes());
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
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

pub(crate) async fn current_ref(root: &Path) -> Result<String> {
    let reference = git(root, &["symbolic-ref", "-q", "HEAD"]).await?;
    let reference = reference.trim();
    if reference.is_empty() {
        anyhow::bail!("当前仓库处于 detached HEAD，不能取得独占目标 ref 租约");
    }
    Ok(reference.to_string())
}

pub(crate) async fn is_ancestor(root: &Path, ancestor: &str, descendant: &str) -> Result<bool> {
    let mut child = Command::new("git")
        .args(["merge-base", "--is-ancestor", ancestor, descendant])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("running git merge-base")?;
    let stderr = child
        .stderr
        .take()
        .context("capturing git merge-base stderr")?;
    let (stderr, status) = tokio::time::timeout(GIT_TIMEOUT, async move {
        tokio::try_join!(
            read_bounded(stderr, MAX_STDERR_BYTES, "git merge-base error output"),
            async { child.wait().await.context("waiting for git merge-base") },
        )
    })
    .await
    .map_err(|_| anyhow!("git merge-base timed out"))??;
    if status.success() {
        return Ok(true);
    }
    if status.code() == Some(1) {
        return Ok(false);
    }
    Err(anyhow!(
        "git merge-base failed: {}",
        String::from_utf8_lossy(&stderr).trim()
    ))
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
    async fn an_ordinary_folder_with_only_session_storage_is_bootstrap_empty() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join(".genethub");
        std::fs::create_dir_all(home.join("sessions/s_pm")).unwrap();
        std::fs::create_dir_all(home.join("tombstones")).unwrap();
        for (name, body) in [
            (".gitignore", "*\n"),
            ("owner.lock", ""),
            ("owner", "local\n"),
        ] {
            std::fs::write(home.join(name), body).unwrap();
        }
        std::fs::write(home.join("sessions/s_pm/meta.json"), "{}\n").unwrap();

        let state = bootstrap_state(dir.path()).await.unwrap();
        assert!(!state.direct);
        assert!(state.changes.is_empty(), "{:?}", state.changes);
    }

    #[tokio::test]
    async fn project_content_beside_session_storage_is_not_bootstrap_empty() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".genethub/sessions/s_pm")).unwrap();
        std::fs::write(dir.path().join("README.md"), "user content\n").unwrap();

        let state = bootstrap_state(dir.path()).await.unwrap();
        assert_eq!(state.changes, vec!["README.md"]);
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
    async fn bootstrap_plan_and_commit_use_the_existing_user_identity() {
        let dir = repo().await;
        git(dir.path(), &["config", "user.name", "Project Author"])
            .await
            .unwrap();
        git(dir.path(), &["config", "user.email", "author@example.com"])
            .await
            .unwrap();
        std::fs::write(dir.path().join("pack.txt"), "owned by the pack\n").unwrap();

        let state = bootstrap_state(dir.path()).await.unwrap();
        assert_eq!(
            state.commit_identity.display(),
            "Project Author <author@example.com>"
        );
        assert!(!state.commit_identity.product_fallback);
        bootstrap_commit(
            dir.path(),
            "bootstrap",
            &["pack.txt".into()],
            &state.commit_identity,
        )
        .await
        .unwrap();
        assert_eq!(
            git(dir.path(), &["log", "-1", "--format=%an <%ae>"])
                .await
                .unwrap()
                .trim(),
            state.commit_identity.display()
        );
    }

    #[test]
    fn unsafe_or_incomplete_identity_falls_back_to_the_product_pair() {
        assert!(!safe_identity_value("Agent\nInjected"));
        assert!(!safe_identity_value("Agent <other>"));
        let identity = GitIdentity::product();
        assert!(identity.product_fallback);
        assert_eq!(
            identity.display(),
            "GeneHub Bootstrap <bootstrap@genehub.local>"
        );
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
