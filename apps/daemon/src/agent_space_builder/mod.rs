//! Deterministic, local-only Agent Space projections.
//!
//! Agent Space intentionally uses the PipeBuilder v1 source contract and
//! ownership files.  This implementation lives in the daemon crate so the
//! same business rules compile into the Rust/WASM guest; the native CLI is
//! only a transport.

mod diagnostic;
mod manifest;
mod ownership;
mod planner;
mod pm_template;

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use diagnostic::{fail, BuilderResult};
pub use diagnostic::{BuilderError, Diagnostic};
use manifest::{load_manifest, load_providers, load_workspace};
use ownership::{apply, check_conflicts, clean, load_lock, verify, BuildGuard};
use planner::{create_plan, Plan};
pub use pm_template::{
    pm_space_requires_bootstrap, pm_space_template_paths, pm_space_template_status,
    render_pm_space, render_pm_space_template_candidate, PmSpaceTemplateCandidateReport,
    PmSpaceTemplateReport, PmSpaceTemplateStatus, PmSpaceTemplateValues, PM_SPACE_NAME,
    PM_SPACE_TEMPLATE_VERSION,
};

pub const VERSION: &str = "0.1.4";
pub const REPORT_SCHEMA: &str = "pipebuilder-report.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Init,
    Check,
    Explain,
    Build { dry_run: bool },
    Verify,
    Clean,
}

impl Command {
    fn report_name(self) -> &'static str {
        match self {
            Self::Init => "init",
            Self::Check => "check",
            Self::Explain => "explain",
            Self::Build { dry_run: true } => "build --dry-run",
            Self::Build { dry_run: false } => "build",
            Self::Verify => "verify",
            Self::Clean => "clean",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub schema: &'static str,
    pub builder_version: &'static str,
    pub command: &'static str,
    pub status: &'static str,
    pub pipespace_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipespace: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub summary: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

/// Exact Builder facts required before a Space can be promoted into the
/// product registry or persisted in PM state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedSpace {
    pub name: String,
    pub workspace_path: PathBuf,
    pub lock_digest: String,
}

/// Verify the complete PipeBuilder ownership boundary and return the source
/// identity that other GeneHub modules must bind. Keeping this in the Rust
/// core prevents the registry and PM state from accepting a merely
/// JSON-shaped lock file.
pub fn verify_space(project_root: &Path, space_root: &Path) -> BuilderResult<VerifiedSpace> {
    let project_root = project_root.canonicalize().map_err(|error| {
        BuilderError(Diagnostic::error(
            "PB011",
            format!("PM project root is unavailable: {error}"),
        ))
    })?;
    let space_root = validate_space_root(&project_root, space_root)?;
    detect_legacy(&space_root)?;
    let manifest = load_manifest(&space_root)?;
    let workspace = load_workspace(&project_root, &space_root, &manifest)?;
    let lock_digest = verify(&project_root, &space_root)?;
    Ok(VerifiedSpace {
        name: manifest.name,
        workspace_path: workspace.path,
        lock_digest,
    })
}

/// Run one Agent Space operation. `project_root` is an authenticated PM
/// project root, never a caller-selected authority boundary.
pub fn run(
    project_root: &Path,
    space_root: &Path,
    command: Command,
    require_no_post_commands: bool,
) -> BuilderResult<Report> {
    let project_root = project_root.canonicalize().map_err(|error| {
        BuilderError(Diagnostic::error(
            "PB011",
            format!("PM project root is unavailable: {error}"),
        ))
    })?;
    if command == Command::Init {
        return init(&project_root, space_root);
    }
    let space_root = validate_space_root(&project_root, space_root)?;
    detect_legacy(&space_root)?;

    match command {
        Command::Init => unreachable!("init returned before existing-root validation"),
        Command::Verify => {
            let verified = verify_space(&project_root, &space_root)?;
            Ok(report(
                command,
                &space_root,
                Some(verified.name.clone()),
                Vec::new(),
                json!({"members": 1, "verified": 1}),
                Some(json!({
                    "members": [{"kind": "parent", "path": ".", "name": verified.name, "lockDigest": verified.lock_digest}],
                    "receiptDigest": verified.lock_digest,
                })),
            ))
        }
        Command::Clean => {
            let _guard = BuildGuard::acquire(&space_root)?;
            let removed = clean(&space_root)?;
            Ok(report(
                command,
                &space_root,
                None,
                Vec::new(),
                json!({"removed": removed}),
                None,
            ))
        }
        Command::Check | Command::Explain | Command::Build { .. } => {
            let manifest = load_manifest(&space_root)?;
            reject_nested_spaces(&space_root, manifest.children.scan_depth)?;
            let workspace = load_workspace(&project_root, &space_root, &manifest)?;
            let providers = load_providers(&project_root, &space_root, &manifest)?;
            if providers.iter().any(|provider| provider.has_build) {
                return fail(Diagnostic::error(
                    "PB006",
                    "Executable Skill Provider builders are outside the pure local Agent Space MVP",
                ));
            }
            let plan = create_plan(space_root.clone(), manifest, workspace, providers)?;
            let previous = load_lock(&space_root)?;
            check_conflicts(&plan, previous.as_ref())?;
            let post_commands = plan
                .providers
                .iter()
                .filter(|provider| provider.has_command)
                .count();
            if require_no_post_commands && post_commands > 0 {
                return fail(
                    Diagnostic::error(
                        "PB018",
                        format!(
                            "--require-no-post-commands requires a pure projection build; found {post_commands} Provider post command(s)"
                        ),
                    )
                    .sources(
                        plan.providers
                            .iter()
                            .filter(|provider| provider.has_command)
                            .map(|provider| provider.id.clone()),
                    ),
                );
            }
            if matches!(command, Command::Build { dry_run: false }) && post_commands > 0 {
                return fail(Diagnostic::error(
                    "PB006",
                    "Provider post commands cannot execute inside the Rust/WASM Agent Space Builder",
                ));
            }

            let name = plan.manifest.name.clone();
            let warnings = plan.warnings.clone();
            // The embedded CLI is always a structured JSON consumer. Match
            // PipeBuilder's `--format json`: check, explain, and dry-run all
            // carry the complete planned model.
            let details = matches!(
                command,
                Command::Check | Command::Explain | Command::Build { dry_run: true }
            )
            .then(|| model_details(&plan));
            let summary = if matches!(command, Command::Build { dry_run: false }) {
                let _guard = BuildGuard::acquire(&space_root)?;
                // Re-read the lock after acquiring the process-wide filesystem
                // guard so a concurrent writer cannot invalidate preflight.
                let previous = load_lock(&space_root)?;
                check_conflicts(&plan, previous.as_ref())?;
                let (generated, removed) = apply(&plan, previous.as_ref())?;
                json!({
                    "generated": generated,
                    "removed": removed,
                    "skills": plan.skills.len(),
                })
            } else {
                json!({
                    "planned": plan.operations.len(),
                    "skills": plan.skills.len(),
                    "postCommands": post_commands,
                })
            };
            Ok(report(
                command,
                &space_root,
                Some(name),
                warnings,
                summary,
                details,
            ))
        }
    }
}

fn init(project_root: &Path, requested_root: &Path) -> BuilderResult<Report> {
    let spaces = project_root
        .join("spaces")
        .canonicalize()
        .map_err(|error| {
            BuilderError(Diagnostic::error(
                "PB001",
                format!("PM project spaces directory is unavailable: {error}"),
            ))
        })?;
    let name = requested_root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| manifest::valid_name(value))
        .ok_or_else(|| {
            BuilderError(Diagnostic::error(
                "PB002",
                "Agent Space directory name must match ^[a-z][a-z0-9-]*$",
            ))
        })?
        .to_string();
    if requested_root.parent() != Some(spaces.as_path()) {
        return fail(
            Diagnostic::error(
                "PB011",
                "Agent Space must be a direct local directory under <project>/spaces",
            )
            .source(requested_root.display().to_string()),
        );
    }
    if is_symlink(requested_root) || (requested_root.exists() && !requested_root.is_dir()) {
        return fail(
            Diagnostic::error("PB001", "Agent Space root must be a real directory")
                .source(requested_root.display().to_string()),
        );
    }
    std::fs::create_dir_all(requested_root).map_err(io_error)?;
    let root = requested_root.canonicalize().map_err(io_error)?;
    if root.parent() != Some(spaces.as_path()) {
        return fail(
            Diagnostic::error("PB011", "Agent Space root escaped project spaces/")
                .source(root.display().to_string()),
        );
    }
    detect_legacy(&root)?;
    let _guard = BuildGuard::acquire(&root)?;
    let manifest_path = root.join("pipespace.json");
    let mut created = Vec::new();
    let mut validated = Vec::new();
    let manifest = if manifest_path.exists() || is_symlink(&manifest_path) {
        let manifest = load_manifest(&root)?;
        if manifest.name != name {
            return fail(
                Diagnostic::error(
                    "PB002",
                    format!(
                        "existing manifest.name {} does not match Agent Space directory {name}",
                        manifest.name
                    ),
                )
                .source(manifest_path.display().to_string()),
            );
        }
        validated.push("pipespace.json".to_string());
        manifest
    } else {
        write_new_json(
            &manifest_path,
            &json!({
                "schema": manifest::SPACE_SCHEMA,
                "name": name,
                "agents": manifest::AGENTS,
                "skills": [],
                "tags": [],
                "skillProviders": [],
            }),
        )?;
        created.push("pipespace.json".to_string());
        load_manifest(&root)?
    };
    let workspace_name = format!("{}.code-workspace", manifest.name);
    let workspace_path = root.join(&workspace_name);
    if workspace_path.exists() || is_symlink(&workspace_path) {
        load_workspace(project_root, &root, &manifest)?;
        validated.push(workspace_name);
    } else {
        write_new_json(
            &workspace_path,
            &json!({"folders": [{"name": "project", "path": "."}]}),
        )?;
        created.push(workspace_name);
    }
    let files = created
        .iter()
        .map(|path| json!({"path": path, "status": "created"}))
        .chain(
            validated
                .iter()
                .map(|path| json!({"path": path, "status": "validated"})),
        )
        .collect::<Vec<_>>();
    Ok(report(
        Command::Init,
        &root,
        Some(manifest.name),
        Vec::new(),
        json!({"created": created.len(), "validated": validated.len()}),
        Some(json!({"files": files})),
    ))
}

fn write_new_json(path: &Path, value: &Value) -> BuilderResult<()> {
    use std::io::Write as _;

    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        BuilderError(Diagnostic::error("PB001", format!("JSON error: {error}")))
    })?;
    bytes.push(b'\n');
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(io_error)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)
}

fn report(
    command: Command,
    root: &Path,
    name: Option<String>,
    diagnostics: Vec<Diagnostic>,
    summary: Value,
    details: Option<Value>,
) -> Report {
    Report {
        schema: REPORT_SCHEMA,
        builder_version: VERSION,
        command: command.report_name(),
        status: "ok",
        pipespace_root: root.display().to_string(),
        pipespace: name,
        diagnostics,
        summary,
        details,
    }
}

fn model_details(plan: &Plan) -> Value {
    let adapters = |agent: &str| match agent {
        "codex" => ("2", "client-verified"),
        "cursor" => ("1", "client-verified"),
        "codebuddy" => ("2", "generated-only"),
        "claude-code" => ("2", "client-verified"),
        _ => unreachable!(),
    };
    json!({
        "agents": plan.manifest.agents.iter().map(|agent| {
            let (version, status) = adapters(agent);
            json!({"id": agent, "adapterVersion": version, "capabilityStatus": status})
        }).collect::<Vec<_>>(),
        "workspace": {
            "file": plan.workspace.path.file_name().and_then(|value| value.to_str()).unwrap_or_default(),
            "folders": plan.workspace.folders.iter().map(|folder| json!({"name": folder.name, "path": folder.path})).collect::<Vec<_>>(),
        },
        "providers": plan.providers.iter().map(|provider| json!({
            "id": provider.id,
            "type": "folder",
            "path": provider.configured_path,
            "subdir": provider.subdir,
            "priority": provider.priority,
            "digest": provider.digest,
            "snapshot": provider.digest,
            "resolvedPath": ownership::relative_path(&plan.root, &provider.root),
        })).collect::<Vec<_>>(),
        "skillBuilders": [],
        "postCommands": [],
        "skills": plan.skills.iter().map(|skill| json!({
            "name": skill.name,
            "provider": skill.provider_id,
            "selectedBy": skill.selected_by,
            "matchedTags": skill.matched_tags,
            "shadowedCandidates": skill.shadowed,
        })).collect::<Vec<_>>(),
        "operations": plan.operations.iter().map(|operation| json!({
            "target": operation.target,
            "sources": operation.sources,
            "logicalType": operation.logical_type,
            "semanticKey": operation.semantic_key,
            "operation": operation.operation,
            "digest": operation.digest(),
            "risks": [],
        })).collect::<Vec<_>>(),
    })
}

fn validate_space_root(project_root: &Path, space_root: &Path) -> BuilderResult<PathBuf> {
    let root = space_root.canonicalize().map_err(|error| {
        BuilderError(Diagnostic::error(
            "PB001",
            format!("Agent Space root is unavailable: {error}"),
        ))
    })?;
    let spaces = project_root.join("spaces");
    if !root.is_dir()
        || root.parent() != Some(spaces.as_path())
        || root.file_name().is_none()
        || !root.starts_with(project_root)
    {
        return fail(
            Diagnostic::error(
                "PB011",
                "Agent Space must be a direct local directory under <project>/spaces",
            )
            .source(root.display().to_string()),
        );
    }
    Ok(root)
}

fn detect_legacy(root: &Path) -> BuilderResult<()> {
    const LEGACY: [&str; 9] = [
        "tagents",
        "private",
        "harness-space.json",
        "harness-space-tree.json",
        "pipespace-tree.json",
        ".harness-builder",
        ".harness-agents",
        ".harness-space.yaml",
        ".harness-lock.yaml",
    ];
    let mut found: Vec<String> = LEGACY
        .into_iter()
        .filter(|name| root.join(name).exists() || is_symlink(&root.join(name)))
        .map(str::to_string)
        .collect();
    if let Ok(entries) = std::fs::read_dir(root) {
        found.extend(entries.flatten().filter_map(|entry| {
            entry
                .file_name()
                .to_str()
                .filter(|name| name.ends_with(".code-workspace.src"))
                .map(str::to_string)
        }));
    }
    found.sort();
    found.dedup();
    if found.is_empty() {
        Ok(())
    } else {
        fail(
            Diagnostic::error(
                "PB015",
                format!("Legacy THarness layout detected: {}", found.join(", ")),
            )
            .sources(found),
        )
    }
}

fn reject_nested_spaces(root: &Path, scan_depth: u32) -> BuilderResult<()> {
    if scan_depth == 0 {
        return Ok(());
    }
    let mut pending = vec![(root.to_path_buf(), 0u32)];
    while let Some((directory, depth)) = pending.pop() {
        if depth >= scan_depth {
            continue;
        }
        let mut entries = std::fs::read_dir(&directory)
            .map_err(io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_error)?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if [
                ".agents",
                ".claude",
                ".codebuddy",
                ".codex",
                ".cursor",
                ".git",
                ".pipebuilder",
                "build",
                "dist",
                "node_modules",
                "out",
                "target",
            ]
            .contains(&name.as_str())
            {
                continue;
            }
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(io_error)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            if path.join("pipespace.json").is_file() {
                return fail(
                    Diagnostic::error(
                        "PB006",
                        "Nested PipeSpace trees are outside the flat local Agent Space MVP",
                    )
                    .source(path.display().to_string()),
                );
            }
            pending.push((path, depth + 1));
        }
    }
    Ok(())
}

pub(super) fn read_json<T: DeserializeOwned>(
    path: &Path,
    code: &'static str,
    label: &str,
) -> BuilderResult<T> {
    let bytes = read_bytes(path, code)?;
    serde_json::from_slice(&bytes).map_err(|error| {
        BuilderError(
            Diagnostic::error(code, format!("Invalid {label} JSON: {error}"))
                .source(path.display().to_string()),
        )
    })
}

pub(super) fn read_bytes(path: &Path, code: &'static str) -> BuilderResult<Vec<u8>> {
    if is_symlink(path) || !path.is_file() {
        return fail(
            Diagnostic::error(code, format!("Expected a regular file: {}", path.display()))
                .source(path.display().to_string()),
        );
    }
    std::fs::read(path).map_err(io_error)
}

pub(super) fn scan_files(
    root: &Path,
    exclude_agent_extensions: bool,
) -> BuilderResult<Vec<PathBuf>> {
    let mut output = Vec::new();
    scan_directory(root, root, exclude_agent_extensions, &mut output)?;
    Ok(output)
}

fn scan_directory(
    root: &Path,
    directory: &Path,
    exclude_agent_extensions: bool,
    output: &mut Vec<PathBuf>,
) -> BuilderResult<()> {
    let mut entries = std::fs::read_dir(directory)
        .map_err(io_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut directories = Vec::new();
    let mut files = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        if name == ".DS_Store"
            || (exclude_agent_extensions && directory == root && name == ".pipe-agents")
        {
            continue;
        }
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            return fail(
                Diagnostic::error(
                    "PB011",
                    "Symlinks are not allowed in generated source trees",
                )
                .source(path.display().to_string()),
            );
        }
        if metadata.is_dir() {
            directories.push(path);
        } else if metadata.is_file() {
            files.push(path);
        } else {
            return fail(
                Diagnostic::error("PB011", "Unsupported source file kind")
                    .source(path.display().to_string()),
            );
        }
    }
    // Match Python os.walk: files in the current directory first, followed by
    // recursively visited sorted directories. This order is part of the
    // PipeBuilder v0.1.4 provider/Skill digest contract.
    output.extend(files);
    for directory in directories {
        scan_directory(root, &directory, exclude_agent_extensions, output)?;
    }
    Ok(())
}

pub(super) fn tree_digest(root: &Path, exclude_agent_extensions: bool) -> BuilderResult<String> {
    let mut digest = Sha256::new();
    if root.exists() {
        for path in scan_files(root, exclude_agent_extensions)? {
            let relative = path
                .strip_prefix(root)
                .expect("scan_files confines output")
                .to_string_lossy()
                .replace('\\', "/");
            digest.update(relative.as_bytes());
            digest.update([0]);
            digest.update(file_mode(&path)?.as_bytes());
            digest.update([0]);
            digest.update(read_bytes(&path, "PB011")?);
            digest.update([0]);
        }
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}

fn file_mode(path: &Path) -> BuilderResult<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(format!(
            "0o{:o}",
            std::fs::metadata(path)
                .map_err(io_error)?
                .permissions()
                .mode()
                & 0o7777
        ))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok("0o644".into())
    }
}

pub(super) fn sha256_file(path: &Path) -> BuilderResult<String> {
    Ok(sha256_bytes(&read_bytes(path, "PB011")?))
}

pub(super) fn sha256_bytes(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

pub(super) fn builder_digest() -> String {
    sha256_bytes(
        concat!(
            include_str!("mod.rs"),
            include_str!("diagnostic.rs"),
            include_str!("manifest.rs"),
            include_str!("planner.rs"),
            include_str!("ownership.rs")
        )
        .as_bytes(),
    )
}

pub(super) fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn io_error(error: std::io::Error) -> BuilderError {
    BuilderError(Diagnostic::error(
        "PB011",
        format!("Filesystem error: {error}"),
    ))
}
