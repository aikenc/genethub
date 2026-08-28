use std::collections::BTreeSet;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::diagnostic::{fail, BuilderError, BuilderResult, Diagnostic};
use super::manifest::{load_manifest, load_workspace};
use super::planner::{is_executable, normalize_target, Plan};
use super::{builder_digest, is_symlink, sha256_file, VERSION};

pub const LOCK_SCHEMA: &str = "pipebuilder-lock.v1";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LockFile {
    pub schema: String,
    pub builder: LockBuilder,
    pub pipespace: LockSpace,
    pub agents: Vec<Value>,
    pub providers: Vec<Value>,
    pub skills: Vec<Value>,
    pub artifacts: Vec<LockArtifact>,
    #[serde(
        rename = "generatedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub _generated_at: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LockBuilder {
    pub version: String,
    pub digest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LockSpace {
    pub name: String,
    pub root: String,
    pub manifest_digest: String,
    pub workspace: String,
    pub workspace_digest: String,
    pub folders: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LockArtifact {
    pub target: String,
    pub sources: Vec<String>,
    pub logical_type: String,
    #[serde(default)]
    pub semantic_key: Option<String>,
    pub operation: String,
    pub digest: String,
    pub executable: bool,
    #[serde(default)]
    pub risks: Vec<Value>,
}

#[derive(Debug)]
pub struct BuildGuard {
    path: PathBuf,
}

impl BuildGuard {
    pub fn acquire(root: &Path) -> BuilderResult<Self> {
        let state = root.join(".pipebuilder");
        if is_symlink(&state) {
            return fail(
                Diagnostic::error("PB011", ".pipebuilder must not be a symlink")
                    .source(state.display().to_string()),
            );
        }
        std::fs::create_dir_all(&state).map_err(io_error)?;
        let path = state.join("build.lock");
        if is_symlink(&path) {
            return fail(
                Diagnostic::error("PB011", "build.lock must not be a symlink")
                    .source(path.display().to_string()),
            );
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    existing_build_lock(&path)
                } else {
                    io_error(error)
                }
            })?;
        let payload = json!({
            "pid": crate::host_pid::current(),
            "host": current_host(),
            "startedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        });
        let mut bytes = serde_json::to_vec_pretty(&payload).map_err(json_error)?;
        bytes.push(b'\n');
        file.write_all(&bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        Ok(Self { path })
    }
}

fn existing_build_lock(path: &Path) -> BuilderError {
    let previous = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let pid = previous
        .as_ref()
        .and_then(|value| value.get("pid"))
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok());
    let host = previous
        .as_ref()
        .and_then(|value| value.get("host"))
        .and_then(Value::as_str);
    if host == Some(current_host().as_str()) && pid.is_some_and(|pid| !process_alive(pid)) {
        return BuilderError(
            Diagnostic::error(
                "PB014",
                format!("Stale build lock detected for pid {}", pid.unwrap()),
            )
            .source(path.display().to_string()),
        );
    }
    BuilderError(
        Diagnostic::error(
            "PB013",
            "Another Agent Space build or clean operation holds .pipebuilder/build.lock",
        )
        .source(path.display().to_string()),
    )
}

#[cfg(not(target_family = "wasm"))]
fn process_alive(pid: u32) -> bool {
    crate::lifecycle::pid_alive(pid)
}

#[cfg(target_family = "wasm")]
fn process_alive(pid: u32) -> bool {
    genet_wasi::wit::genehub::host::process::pid_alive(pid)
}

pub(super) fn current_host() -> String {
    std::env::var(crate::channel::ENV_HOST_NAME)
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

impl Drop for BuildGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }
}

pub fn load_lock(root: &Path) -> BuilderResult<Option<LockFile>> {
    let path = root.join(".pipebuilder/lock.json");
    if !path.exists() {
        return Ok(None);
    }
    if is_symlink(&path) {
        return fail(
            Diagnostic::error("PB011", "Ownership lock must not be a symlink")
                .source(path.display().to_string()),
        );
    }
    let bytes = std::fs::read(&path).map_err(io_error)?;
    let lock: LockFile = serde_json::from_slice(&bytes).map_err(|error| {
        BuilderError(
            Diagnostic::error("PB001", format!("Invalid ownership lock: {error}"))
                .source(path.display().to_string()),
        )
    })?;
    validate_lock(&lock, &path)?;
    Ok(Some(lock))
}

fn validate_lock(lock: &LockFile, path: &Path) -> BuilderResult<()> {
    if lock.schema != LOCK_SCHEMA
        || lock.builder.version.trim().is_empty()
        || !valid_digest(&lock.builder.digest)
        || lock.pipespace.root != "."
        || lock.agents.iter().any(|value| !value.is_object())
        || lock.providers.iter().any(|value| !value.is_object())
        || lock.skills.iter().any(|value| !value.is_object())
    {
        return fail(
            Diagnostic::error("PB001", "Invalid .pipebuilder/lock.json structure")
                .source(path.display().to_string()),
        );
    }
    for artifact in &lock.artifacts {
        normalize_target(&artifact.target)?;
        if artifact.sources.is_empty()
            || artifact.sources.iter().any(|source| source.is_empty())
            || artifact.logical_type.is_empty()
            || artifact.semantic_key.as_ref().is_some_and(String::is_empty)
            || !matches!(
                artifact.operation.as_str(),
                "copy" | "render" | "merge-document" | "merge-json" | "merge-toml"
            )
            || !valid_digest(&artifact.digest)
            || artifact.risks.iter().any(|risk| !risk.is_object())
            || !managed_target_matches(&artifact.logical_type, &artifact.target)
        {
            return fail(
                Diagnostic::error("PB001", "Invalid ownership lock artifact")
                    .source(path.display().to_string())
                    .target(artifact.target.clone()),
            );
        }
    }
    Ok(())
}

pub fn check_conflicts(plan: &Plan, previous: Option<&LockFile>) -> BuilderResult<()> {
    let owned = owned_targets(previous);
    for operation in &plan.operations {
        let target = plan.root.join(&operation.target);
        ensure_safe_parent(&plan.root, &target)?;
        if is_symlink(&target) {
            return fail(
                Diagnostic::error(
                    "PB011",
                    format!("Generated target is a symlink: {}", operation.target),
                )
                .target(operation.target.clone()),
            );
        }
        if target.exists() && !target.is_file() {
            return fail(
                Diagnostic::error(
                    "PB010",
                    format!(
                        "Generated file target has incompatible kind: {}",
                        operation.target
                    ),
                )
                .target(operation.target.clone()),
            );
        }
        if owned.contains(&operation.target) || !target.exists() {
            continue;
        }
        let current = std::fs::read(&target).map_err(io_error)?;
        if current != operation.content {
            return fail(
                Diagnostic::error(
                    "PB010",
                    format!(
                        "Generated target already exists but is not owned: {}",
                        operation.target
                    ),
                )
                .target(operation.target.clone()),
            );
        }
    }
    let planned: BTreeSet<_> = plan
        .operations
        .iter()
        .map(|operation| operation.target.clone())
        .collect();
    for target in owned.difference(&planned) {
        let path = plan.root.join(target);
        ensure_safe_parent(&plan.root, &path)?;
        if path.exists() && !path.is_file() && !is_symlink(&path) {
            return fail(
                Diagnostic::error("PB010", format!("Owned file target changed type: {target}"))
                    .target(target.clone()),
            );
        }
    }
    Ok(())
}

pub fn apply(plan: &Plan, previous: Option<&LockFile>) -> BuilderResult<(usize, usize)> {
    let new_targets: BTreeSet<_> = plan
        .operations
        .iter()
        .map(|operation| operation.target.clone())
        .collect();
    let old_targets = owned_targets(previous);
    for operation in &plan.operations {
        atomic_write(
            &plan.root,
            &operation.target,
            &operation.content,
            operation.executable,
        )?;
    }
    let mut removed = 0;
    let stale: Vec<_> = old_targets.difference(&new_targets).cloned().collect();
    for target in stale.iter().rev() {
        remove_owned_target(&plan.root, target)?;
        removed += 1;
    }
    let lock = make_lock(plan)?;
    let mut bytes = serde_json::to_vec_pretty(&lock).map_err(json_error)?;
    bytes.push(b'\n');
    atomic_write(&plan.root, ".pipebuilder/lock.json", &bytes, false)?;
    Ok((plan.operations.len(), removed))
}

pub fn verify(project_root: &Path, root: &Path) -> BuilderResult<String> {
    let lock_path = root.join(".pipebuilder/lock.json");
    let lock = load_lock(root)?.ok_or_else(|| {
        BuilderError(
            Diagnostic::error("PB017", "Agent Space has no ownership lock")
                .source(lock_path.display().to_string()),
        )
    })?;
    let manifest = load_manifest(root)?;
    let workspace = load_workspace(project_root, root, &manifest)?;
    let providers = super::manifest::load_providers(project_root, root, &manifest)?;
    if providers
        .iter()
        .any(|provider| provider.has_command || provider.has_build)
    {
        return fail(Diagnostic::error(
            "PB006",
            "Executable Skill Provider commands are outside the pure local Agent Space MVP",
        ));
    }
    let plan = super::planner::create_plan(root.to_path_buf(), manifest, workspace, providers)?;
    let expected = make_lock(&plan)?;
    let mut recorded = serde_json::to_value(&lock).map_err(json_error)?;
    if let Some(object) = recorded.as_object_mut() {
        // PipeBuilder v1 may include this informational timestamp. It is not
        // part of the reproducible ownership identity.
        object.remove("generatedAt");
    }
    if recorded != expected {
        return fail(
            Diagnostic::error(
                "PB017",
                "Agent Space sources or planned artifacts drifted from its ownership lock",
            )
            .sources([
                plan.manifest.path.display().to_string(),
                plan.workspace.path.display().to_string(),
                lock_path.display().to_string(),
            ]),
        );
    }
    for artifact in &lock.artifacts {
        let target = root.join(normalize_target(&artifact.target)?);
        ensure_safe_parent(root, &target)?;
        if is_symlink(&target) || !target.is_file() {
            return fail(
                Diagnostic::error(
                    "PB017",
                    format!("Agent Space artifact is missing: {}", artifact.target),
                )
                .source(target.display().to_string())
                .target(artifact.target.clone()),
            );
        }
        if sha256_file(&target)? != artifact.digest
            || is_executable(&target)? != artifact.executable
        {
            return fail(
                Diagnostic::error(
                    "PB017",
                    format!("Agent Space artifact drifted: {}", artifact.target),
                )
                .sources([
                    target.display().to_string(),
                    lock_path.display().to_string(),
                ])
                .target(artifact.target.clone()),
            );
        }
    }
    sha256_file(&lock_path)
}

pub fn clean(root: &Path) -> BuilderResult<usize> {
    let Some(lock) = load_lock(root)? else {
        return Ok(0);
    };
    let targets = owned_targets(Some(&lock));
    for target in targets.iter().rev() {
        remove_owned_target(root, target)?;
    }
    let lock_path = root.join(".pipebuilder/lock.json");
    std::fs::remove_file(&lock_path).map_err(io_error)?;
    prune_empty_parents(root, lock_path.parent().unwrap_or(root));
    Ok(targets.len())
}

fn make_lock(plan: &Plan) -> BuilderResult<Value> {
    let adapter = |agent: &str| match agent {
        "codex" => ("2", "client-verified"),
        "cursor" => ("1", "client-verified"),
        "codebuddy" => ("2", "generated-only"),
        "claude-code" => ("2", "client-verified"),
        _ => unreachable!(),
    };
    let agents: Vec<_> = plan
        .manifest
        .agents
        .iter()
        .map(|agent| {
            let (version, status) = adapter(agent);
            json!({"id": agent, "adapterVersion": version, "capabilityStatus": status})
        })
        .collect();
    let providers: Vec<_> = plan
        .providers
        .iter()
        .map(|provider| {
            json!({
                "id": provider.id,
                "type": "folder",
                "digest": provider.digest,
                "snapshot": provider.digest,
                "priority": provider.priority,
                "path": provider.configured_path,
                "subdir": provider.subdir,
                "resolvedPath": relative_path(&plan.root, &provider.root),
            })
        })
        .collect();
    let skills: Vec<_> = plan
        .skills
        .iter()
        .map(|skill| {
            json!({
                "name": skill.name,
                "provider": skill.provider_id,
                "source": provider_skill_source(skill),
                "digest": skill.digest,
                "selectedBy": skill.selected_by,
                "matchedTags": skill.matched_tags,
                "shadowedCandidates": skill.shadowed,
            })
        })
        .collect();
    let artifacts: Vec<_> = plan
        .operations
        .iter()
        .map(|operation| {
            json!({
                "target": operation.target,
                "sources": operation.sources,
                "logicalType": operation.logical_type,
                "semanticKey": operation.semantic_key,
                "operation": operation.operation,
                "digest": operation.digest(),
                "executable": operation.executable,
                "risks": [],
            })
        })
        .collect();
    Ok(json!({
        "schema": LOCK_SCHEMA,
        "builder": {"version": VERSION, "digest": builder_digest()},
        "pipespace": {
            "name": plan.manifest.name,
            "root": ".",
            "manifestDigest": sha256_file(&plan.manifest.path)?,
            "workspace": plan.workspace.path.file_name().and_then(|value| value.to_str()).unwrap_or_default(),
            "workspaceDigest": sha256_file(&plan.workspace.path)?,
            "folders": plan.workspace.folders.iter().map(|folder| json!({"name": folder.name, "path": folder.path})).collect::<Vec<_>>(),
        },
        "agents": agents,
        "providers": providers,
        "skills": skills,
        "artifacts": artifacts,
    }))
}

fn owned_targets(previous: Option<&LockFile>) -> BTreeSet<String> {
    previous
        .into_iter()
        .flat_map(|lock| lock.artifacts.iter())
        .map(|artifact| artifact.target.clone())
        .collect()
}

fn atomic_write(root: &Path, target: &str, content: &[u8], executable: bool) -> BuilderResult<()> {
    let target = root.join(normalize_target(target)?);
    ensure_safe_parent(root, &target)?;
    let parent = target.parent().ok_or_else(|| {
        BuilderError(Diagnostic::error("PB011", "generated target has no parent"))
    })?;
    std::fs::create_dir_all(parent).map_err(io_error)?;
    if is_symlink(&target) || (target.exists() && !target.is_file()) {
        return fail(
            Diagnostic::error(
                "PB010",
                format!(
                    "Generated file target has incompatible kind: {}",
                    target.display()
                ),
            )
            .target(target.display().to_string()),
        );
    }
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("artifact"),
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| -> BuilderResult<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(io_error)?;
        file.write_all(content).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        set_executable(&temporary, executable)?;
        std::fs::rename(&temporary, &target).map_err(io_error)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn remove_owned_target(root: &Path, target: &str) -> BuilderResult<()> {
    let target = root.join(normalize_target(target)?);
    ensure_safe_parent(root, &target)?;
    if is_symlink(&target) || target.is_file() {
        match std::fs::remove_file(&target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
    } else if target.exists() {
        return fail(
            Diagnostic::error(
                "PB010",
                format!("Owned file target changed type: {}", target.display()),
            )
            .target(target.display().to_string()),
        );
    }
    if let Some(parent) = target.parent() {
        prune_empty_parents(root, parent);
    }
    Ok(())
}

fn prune_empty_parents(root: &Path, start: &Path) {
    let protected = [
        root.to_path_buf(),
        root.join(".pipebuilder"),
        root.join(".pipebuilder/agents"),
        root.join(".pipebuilder/skills"),
    ];
    let mut current = start.to_path_buf();
    while current != root && current.starts_with(root) && !protected.contains(&current) {
        if std::fs::remove_dir(&current).is_err() {
            break;
        }
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent.to_path_buf();
    }
}

fn ensure_safe_parent(root: &Path, target: &Path) -> BuilderResult<()> {
    let relative = target.strip_prefix(root).map_err(|_| {
        BuilderError(
            Diagnostic::error(
                "PB011",
                format!("Target escapes Agent Space: {}", target.display()),
            )
            .target(target.display().to_string()),
        )
    })?;
    let mut current = root.to_path_buf();
    let components: Vec<_> = relative.components().collect();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        let Component::Normal(part) = component else {
            return fail(Diagnostic::error("PB011", "Unsafe generated target path"));
        };
        current.push(part);
        if is_symlink(&current) {
            return fail(
                Diagnostic::error(
                    "PB011",
                    format!("Target parent is a symlink: {}", current.display()),
                )
                .target(target.display().to_string()),
            );
        }
        if current.exists() && !current.is_dir() {
            return fail(
                Diagnostic::error(
                    "PB010",
                    format!("Target parent is not a directory: {}", current.display()),
                )
                .target(target.display().to_string()),
            );
        }
    }
    Ok(())
}

pub(super) fn relative_path(from: &Path, to: &Path) -> String {
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    let common = from
        .iter()
        .zip(&to)
        .take_while(|(left, right)| left == right)
        .count();
    let mut parts = vec!["..".to_string(); from.len().saturating_sub(common)];
    parts.extend(
        to[common..]
            .iter()
            .map(|part| part.as_os_str().to_string_lossy().to_string()),
    );
    if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn provider_skill_source(skill: &super::planner::Skill) -> String {
    let mut parts = vec![skill.provider_path.trim_end_matches('/').to_string()];
    if skill.provider_subdir != "." {
        parts.push(skill.provider_subdir.trim_matches('/').to_string());
    }
    parts.push(skill.name.clone());
    parts.join("/")
}

fn managed_target_matches(logical_type: &str, target: &str) -> bool {
    let exact: &[&str] = match logical_type {
        "workspace-rule" => &[
            ".pipebuilder/generated/workspace-rule.md",
            ".cursor/rules/pipebuilder-workspace.mdc",
            ".codebuddy/rules/pipebuilder-workspace.md",
            ".claude/rules/pipebuilder-workspace.md",
        ],
        "project-instructions" => &["AGENTS.md", "CLAUDE.md"],
        "codex-config" => &[".codex/config.toml"],
        "codex-hooks" => &[".codex/hooks.json"],
        "codebuddy-settings" => &[".codebuddy/settings.json"],
        "codebuddy-mcp" => &[".codebuddy/mcp.json"],
        "claude-settings" => &[".claude/settings.json"],
        "claude-mcp" => &[".mcp.json"],
        _ => &[],
    };
    if !exact.is_empty() {
        return exact.contains(&target);
    }
    let prefix = match logical_type {
        "codex-rule" => Some((".codex/rules/", ".rules")),
        "codex-hook-file" => Some((".codex/hooks/", "")),
        "cursor-rule" => Some((".cursor/rules/", ".mdc")),
        "cursor-command" => Some((".cursor/commands/", ".md")),
        "codebuddy-command" => Some((".codebuddy/commands/", ".md")),
        "codebuddy-agent" => Some((".codebuddy/agents/", ".md")),
        "codebuddy-hook-file" => Some((".codebuddy/hooks/", "")),
        "claude-rule" => Some((".claude/rules/", ".md")),
        "claude-command" => Some((".claude/commands/", ".md")),
        "claude-agent" => Some((".claude/agents/", ".md")),
        "claude-hook-file" => Some((".claude/hooks/", "")),
        _ => None,
    };
    if let Some((prefix, suffix)) = prefix {
        return target.starts_with(prefix)
            && target.len() > prefix.len()
            && (suffix.is_empty() || target.ends_with(suffix));
    }
    if logical_type == "common-skill" {
        return [
            ".agents/skills/",
            ".cursor/skills/",
            ".codebuddy/skills/",
            ".claude/skills/",
        ]
        .iter()
        .any(|prefix| {
            target
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.split('/').count() >= 2)
        });
    }
    false
}

fn set_executable(path: &Path, executable: bool) -> BuilderResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path).map_err(io_error)?.permissions();
        permissions.set_mode(if executable { 0o755 } else { 0o644 });
        std::fs::set_permissions(path, permissions).map_err(io_error)?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, executable);
    }
    Ok(())
}

fn io_error(error: std::io::Error) -> BuilderError {
    BuilderError(Diagnostic::error(
        "PB011",
        format!("Filesystem error: {error}"),
    ))
}

fn json_error(error: serde_json::Error) -> BuilderError {
    BuilderError(Diagnostic::error("PB001", format!("JSON error: {error}")))
}
