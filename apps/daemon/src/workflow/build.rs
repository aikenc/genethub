//! Materializing a Workflow package's Space sources into product Spaces.
//!
//! The package directory stays pure source. `build` writes `<project>/spaces/
//! <flat-id>--<name>/`, which is exactly where `validate_space_root` already
//! allows a managed Space to live — so the Builder's path rule is untouched
//! and a materialized Space is indistinguishable from a hand-written one.
//!
//! Build is also where authority is granted. Copying files into a directory
//! must never confer scheduling rights, so registering the declared component
//! topology goes through the same human challenge the old Pack installer used.
//! The installer is gone; the authorization is not.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

use super::package::{self, Package, SpaceSource};
use crate::state::Shared;

/// Files written per Space, and the total across the build. Both are checked
/// while planning so an oversized package fails before it touches the project.
const MAX_BUILD_FILES: usize = 2_048;
const MAX_BUILD_BYTES: u64 = 32 * 1024 * 1024;

/// One product Space the build will write.
#[derive(Debug, Clone)]
pub(crate) struct PlannedSpace {
    pub(crate) name: String,
    /// Project-relative product directory, e.g. `spaces/studio-game-build--executor`.
    pub(crate) relative: String,
    pub(crate) root: PathBuf,
    pub(crate) lifecycle: String,
    pub(crate) components: Vec<(String, Option<String>)>,
    pub(crate) guidance: Vec<String>,
    /// Fully resolved files: `pipespace.json`, the `.code-workspace`, and the
    /// Space's own Skill tree when it ships one.
    files: Vec<(PathBuf, Vec<u8>)>,
    /// Copied verbatim from `spaces/<name>/skills/` in the source.
    skill_sources: Vec<(PathBuf, PathBuf)>,
}

/// Everything a build will do, computed without writing anything.
#[derive(Debug, Clone)]
pub(crate) struct Plan {
    pub(crate) package_id: String,
    pub(crate) source_digest: String,
    pub(crate) spaces: Vec<PlannedSpace>,
    pub(crate) project_root: PathBuf,
}

impl Plan {
    /// Stable identity of exactly what was previewed, so `apply` can refuse a
    /// plan whose facts moved after the human approved it.
    pub(crate) fn digest(&self, expected_revision: u64) -> String {
        use sha2::{Digest, Sha256};
        let mut digest = Sha256::new();
        digest.update(self.package_id.as_bytes());
        digest.update(self.source_digest.as_bytes());
        digest.update(expected_revision.to_le_bytes());
        for space in &self.spaces {
            digest.update(space.relative.as_bytes());
            digest.update(space.lifecycle.as_bytes());
            for (component, role) in &space.components {
                digest.update(component.as_bytes());
                digest.update(role.as_deref().unwrap_or("").as_bytes());
            }
            for (path, body) in &space.files {
                digest.update(path.to_string_lossy().as_bytes());
                digest.update(Sha256::digest(body));
            }
        }
        format!("sha256:{:x}", digest.finalize())
    }

    /// Product directories this plan writes, for the approval card and for
    /// `list` to report which Spaces a package owns.
    pub(crate) fn space_paths(&self) -> Vec<String> {
        self.spaces
            .iter()
            .map(|space| space.relative.clone())
            .collect()
    }
}

/// Computes the full materialization without touching the project.
///
/// Logical Provider references resolve here, against the package's real
/// location, so the generated `pipespace.json` contains only ordinary relative
/// paths and the Builder needs no new syntax.
pub(crate) fn plan(project_root: &Path, package: &Package) -> Result<Plan> {
    let project_root = project_root
        .canonicalize()
        .with_context(|| format!("读取项目根目录：{}", project_root.display()))?;
    if package.spaces.is_empty() {
        bail!(
            "Workflow 包 {} 没有声明任何 Space；纯定义包无需 build，直接由其他包的 executor 运行",
            package.id
        );
    }
    // Refuse ambiguity before writing anything: these two both mean the
    // package cannot say which carrier the platform should bind.
    package.executor_space()?;
    package.diagnostic_space()?;

    let mut spaces = Vec::new();
    let mut total_files = 0usize;
    let mut total_bytes = 0u64;
    for source in &package.spaces {
        let relative = format!("spaces/{}", package.space_directory(&source.name));
        let root = project_root.join(&relative);
        let manifest = render_manifest(package, &project_root, &root, source)?;
        let workspace = render_workspace(source)?;
        let mut files = vec![
            (root.join("pipespace.json"), manifest),
            (
                root.join(format!("{}.code-workspace", source.name)),
                workspace,
            ),
        ];
        let mut skill_sources = Vec::new();
        if source.has_local_skills {
            let from = package.root.join("spaces").join(&source.name).join("skills");
            collect_skill_files(&from, &from, &root.join("skills"), &mut skill_sources)?;
        }
        total_files += files.len() + skill_sources.len();
        for (_, body) in &files {
            total_bytes = total_bytes.saturating_add(body.len() as u64);
        }
        for (from, _) in &skill_sources {
            total_bytes = total_bytes.saturating_add(fs::metadata(from)?.len());
        }
        if total_files > MAX_BUILD_FILES {
            bail!("Workflow 包 {} 的构建产物文件数超过 {MAX_BUILD_FILES} 上限", package.id);
        }
        if total_bytes > MAX_BUILD_BYTES {
            bail!("Workflow 包 {} 的构建产物字节数超过 {MAX_BUILD_BYTES} 上限", package.id);
        }
        files.sort_by(|left, right| left.0.cmp(&right.0));
        spaces.push(PlannedSpace {
            name: source.name.clone(),
            relative,
            root,
            lifecycle: source.lifecycle.clone(),
            components: source.components.clone(),
            guidance: source.guidance.clone(),
            files,
            skill_sources,
        });
    }
    spaces.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(Plan {
        package_id: package.id.clone(),
        source_digest: package::source_digest(package)?,
        spaces,
        project_root,
    })
}

/// Rewrites `pipespace.json.src` into a real manifest: logical references
/// become relative paths and the Space's own `skills/` is prepended as the
/// highest-priority Provider.
///
/// Prepending here rather than materializing `.pipebuilder/skills/` means the
/// four Skill layers are all plain Providers with one precedence rule, instead
/// of one magic directory plus three ordinary ones.
fn render_manifest(
    package: &Package,
    project_root: &Path,
    space_root: &Path,
    source: &SpaceSource,
) -> Result<Vec<u8>> {
    let mut manifest: Value = serde_json::from_slice(&source.manifest_source).with_context(|| {
        format!(
            "解析 Workflow 包 {} 的 {}/pipespace.json.src",
            package.id, source.name
        )
    })?;
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| anyhow!("pipespace.json.src 必须是 JSON 对象"))?;
    // The product directory name carries the package prefix, and the Builder
    // derives the .code-workspace file name from `name`, so both must agree.
    object.insert("name".into(), json!(source.name));
    let mut providers = Vec::new();
    if source.has_local_skills {
        providers.push(json!({"type": "folder", "path": "skills"}));
    }
    if let Some(declared) = object.get("skillProviders") {
        let declared = declared
            .as_array()
            .ok_or_else(|| anyhow!("skillProviders 必须是数组"))?;
        for provider in declared {
            let mut provider = provider.clone();
            let entry = provider
                .as_object_mut()
                .ok_or_else(|| anyhow!("skillProvider 必须是对象"))?;
            if let Some(path) = entry.get("path").and_then(Value::as_str) {
                let resolved =
                    package::resolve_reference(package, project_root, space_root, path)?;
                entry.insert("path".into(), json!(resolved));
            }
            providers.push(provider);
        }
    }
    object.insert("skillProviders".into(), json!(providers));
    let mut body = serde_json::to_vec_pretty(&manifest)?;
    body.push(b'\n');
    Ok(body)
}

/// Builds the `.code-workspace` from the declared folders. The Builder requires
/// the Space's own root as the first folder, so it is supplied rather than
/// demanded from the author.
fn render_workspace(source: &SpaceSource) -> Result<Vec<u8>> {
    let mut folders = vec![json!({"name": source.name, "path": "."})];
    for folder in &source.folders {
        if folder.path == "." {
            continue;
        }
        folders.push(json!({"name": folder.name, "path": folder.path}));
    }
    let mut body = serde_json::to_vec_pretty(&json!({ "folders": folders }))?;
    body.push(b'\n');
    Ok(body)
}

fn collect_skill_files(
    base: &Path,
    directory: &Path,
    target_base: &Path,
    out: &mut Vec<(PathBuf, PathBuf)>,
) -> Result<()> {
    for entry in fs::read_dir(directory)
        .with_context(|| format!("读取 Space Skill 源：{}", directory.display()))?
    {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_skill_files(base, &entry.path(), target_base, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(base)
            .map_err(|_| anyhow!("Space Skill 文件越出源目录"))?
            .to_path_buf();
        out.push((entry.path(), target_base.join(relative)));
    }
    out.sort();
    Ok(())
}

/// Writes the planned product Spaces, runs the Builder over each, then commits
/// the declared component topology under the caller's already-reserved
/// authorization.
///
/// Product directories are replaced wholesale: they are build output by
/// definition, so preserving a hand edit there would preserve exactly the
/// drift the `builder_lock_digest` check exists to catch.
pub(crate) async fn apply(
    state: &Shared,
    project_workspace_id: &str,
    plan: &Plan,
    expected_revision: u64,
) -> Result<Vec<genehub_proto::WorkspaceInfo>> {
    // The project root is a managed Space too: the plan registers it as PM,
    // so its Builder projection has to exist and verify before the registry
    // will accept a lock digest for it.
    ensure_project_space(&plan.project_root)?;
    crate::agent_space_builder::run(
        &plan.project_root,
        &plan.project_root,
        crate::agent_space_builder::Command::Build { dry_run: false },
        true,
    )
    .map_err(|error| anyhow!("builderVerifyFailed: AgentSpaceBuilder 拒绝项目根：{error}"))?;

    let mut opened = BTreeMap::new();
    for space in &plan.spaces {
        materialize(space)?;
        crate::agent_space_builder::run(
            &plan.project_root,
            &space.root,
            crate::agent_space_builder::Command::Build { dry_run: false },
            true,
        )
        .map_err(|error| {
            anyhow!(
                "builderVerifyFailed: AgentSpaceBuilder 拒绝 {}: {error}",
                space.relative
            )
        })?;
        let verified = crate::agent_space_builder::verify_space(&plan.project_root, &space.root)
            .map_err(|error| {
                anyhow!(
                    "builderVerifyFailed: AgentSpaceBuilder 无法校验 {}: {error}",
                    space.relative
                )
            })?;
        let workspace = state
            .workspaces
            .open(&verified.workspace_path, None)
            .await?;
        opened.insert(space.name.clone(), workspace);
    }

    // The carrier's parent is the project; every other Space hangs off the
    // carrier. A Worker that also mounts `executor` owns a subteam but is
    // still a child here, so the carrier is identified by the same predicate
    // `Package::executor_space` used to refuse an ambiguous source.
    let executor_name = plan
        .spaces
        .iter()
        .find(|space| package::is_executor_carrier(&space.components))
        .map(|space| space.name.clone());
    let executor_workspace_id = executor_name
        .as_ref()
        .and_then(|name| opened.get(name))
        .map(|workspace| workspace.id.clone());

    let mut registrations = Vec::new();
    // The project root is the PM AgentSpace and the parent every carrier
    // hangs off. Registering it here is what makes the tree well-formed;
    // without it `check_tree` has no parent to walk up to. Its Builder
    // projection is verified by the same plan application as the carriers.
    registrations.push(crate::workspace::BootstrapSpaceRegistration {
        workspace_id: project_workspace_id.to_string(),
        parent_workspace_id: None,
        lifecycle: "persistent".into(),
        components: vec![(crate::agent_space::COMPONENT_PM.to_string(), None)],
        guidance: Vec::new(),
    });
    for space in &plan.spaces {
        let workspace = opened
            .get(&space.name)
            .expect("every planned Space was opened");
        let is_executor = Some(&space.name) == executor_name.as_ref();
        let parent_workspace_id = if is_executor {
            Some(project_workspace_id.to_string())
        } else {
            Some(
                executor_workspace_id
                    .clone()
                    .ok_or_else(|| {
                        anyhow!(
                            "Workflow 包 {} 的 Space {} 需要挂在 executor 下，但包未声明 executor 载体",
                            plan.package_id,
                            space.name
                        )
                    })?,
            )
        };
        registrations.push(crate::workspace::BootstrapSpaceRegistration {
            workspace_id: workspace.id.clone(),
            parent_workspace_id,
            lifecycle: space.lifecycle.clone(),
            components: space.components.clone(),
            guidance: space.guidance.clone(),
        });
    }
    // Ordered parent-before-child, because the registry validates each entry
    // against the tree built so far: the project root, then the carrier that
    // hangs off it, then the Workers that hang off the carrier.
    registrations.sort_by_key(|registration| match registration.parent_workspace_id.as_deref() {
        None => 0u8,
        Some(parent) if parent == project_workspace_id => 1,
        Some(_) => 2,
    });

    let configured = state
        .workspaces
        .apply_bootstrap_space_plan(project_workspace_id, expected_revision, &registrations)
        .await?;
    Ok(configured)
}

/// Gives the project root the minimal Builder source it needs to be a managed
/// PM Space, without touching one the user already wrote.
///
/// PM's own methods are a product built-in, so this manifest deliberately
/// selects no Skills and declares no Providers: what a package contributes is
/// carriers, never the root's capability surface.
fn ensure_project_space(project_root: &Path) -> Result<()> {
    let name = project_root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| crate::agent_space_builder::valid_space_name(name))
        .map(str::to_string)
        .unwrap_or_else(|| "project".to_string());
    let manifest = project_root.join("pipespace.json");
    if !manifest.exists() {
        write_file(
            &manifest,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&json!({
                    "schema": "pipespace.v1",
                    "name": name,
                    "agents": ["codex", "cursor", "codebuddy", "claude-code"],
                    "skills": [],
                    "tags": ["project", "pm"],
                    "skillProviders": [],
                    "children": { "scanDepth": 0 },
                }))?
            )
            .as_bytes(),
        )?;
    }
    let workspace = project_root.join(format!("{name}.code-workspace"));
    if !workspace.exists() {
        write_file(
            &workspace,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&json!({
                    "folders": [{ "name": name, "path": "." }],
                }))?
            )
            .as_bytes(),
        )?;
    }
    Ok(())
}

/// Replaces one product directory with exactly the planned content.
fn materialize(space: &PlannedSpace) -> Result<()> {
    if let Ok(metadata) = crate::config::sensitive_metadata(&space.root) {
        crate::config::reject_link_or_reparse(&space.root, &metadata)?;
        if !metadata.is_dir() {
            bail!("Workflow 产物路径不是目录：{}", space.root.display());
        }
        // Generated Agent targets and the previous projection are rebuilt in
        // full; leaving a stale file behind would make the lock digest depend
        // on history rather than on the source.
        for name in [
            ".agents",
            ".codex",
            ".cursor",
            ".codebuddy",
            ".claude",
            "skills",
            "AGENTS.md",
            "pipespace.json",
        ] {
            let path = space.root.join(name);
            match crate::config::sensitive_metadata(&path) {
                Ok(metadata) => {
                    crate::config::reject_link_or_reparse(&path, &metadata)?;
                    if metadata.is_dir() {
                        fs::remove_dir_all(&path)
                            .with_context(|| format!("清理产物目录：{}", path.display()))?;
                    } else {
                        fs::remove_file(&path)
                            .with_context(|| format!("清理产物文件：{}", path.display()))?;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error).with_context(|| format!("检查 {}", path.display()))
                }
            }
        }
    } else {
        crate::config::ensure_real_directory(&space.root)?;
    }
    for (from, to) in &space.skill_sources {
        let body = fs::read(from).with_context(|| format!("读取 {}", from.display()))?;
        write_file(to, &body)?;
    }
    for (path, body) in &space.files {
        write_file(path, body)?;
    }
    Ok(())
}

fn write_file(path: &Path, body: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        crate::config::ensure_real_directory(parent)?;
    }
    if let Ok(metadata) = crate::config::sensitive_metadata(path) {
        crate::config::reject_link_or_reparse(path, &metadata)?;
    }
    fs::write(path, body).with_context(|| format!("写入 {}", path.display()))
}

/// Product directories that belong to packages no longer present, so `list`
/// can report leftovers instead of letting them look like live carriers.
pub(crate) fn orphan_product_directories(
    project_root: &Path,
    packages: &[Package],
) -> Result<Vec<String>> {
    let spaces = project_root.join("spaces");
    if !spaces.is_dir() {
        return Ok(Vec::new());
    }
    let expected = packages
        .iter()
        .flat_map(|package| {
            package
                .spaces
                .iter()
                .map(|space| package.space_directory(&space.name))
        })
        .collect::<BTreeSet<_>>();
    let mut orphans = Vec::new();
    for entry in fs::read_dir(&spaces)
        .with_context(|| format!("读取产物目录：{}", spaces.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Only names carrying the package separator are ours to judge; a
        // hand-composed Space under spaces/ is none of this module's business.
        if name.contains("--") && !expected.contains(&name) {
            orphans.push(format!("spaces/{name}"));
        }
    }
    orphans.sort();
    Ok(orphans)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercises the whole materialization against the shipped package, so a
    /// Builder or path failure surfaces here rather than only in a journey.
    #[test]
    fn the_shipped_package_materializes_and_verifies_every_space() {
        fn copy_tree(from: &Path, to: &Path) {
            fs::create_dir_all(to).unwrap();
            for entry in fs::read_dir(from).unwrap() {
                let entry = entry.unwrap();
                let target = to.join(entry.file_name());
                if entry.file_type().unwrap().is_dir() {
                    copy_tree(&entry.path(), &target);
                } else {
                    fs::copy(entry.path(), target).unwrap();
                }
            }
        }

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir_all(&project).unwrap();
        copy_tree(
            &super::super::builtin_package_source(),
            &project.join(".genethub/workflows/game-delivery"),
        );
        let package = package::load(&project, "game-delivery").unwrap();
        let plan = plan(&project, &package).unwrap();

        ensure_project_space(&plan.project_root).unwrap();
        crate::agent_space_builder::run(
            &plan.project_root,
            &plan.project_root,
            crate::agent_space_builder::Command::Build { dry_run: false },
            true,
        )
        .expect("the project root must be a buildable PM Space");

        for space in &plan.spaces {
            materialize(space).unwrap();
            crate::agent_space_builder::run(
                &plan.project_root,
                &space.root,
                crate::agent_space_builder::Command::Build { dry_run: false },
                true,
            )
            .unwrap_or_else(|error| panic!("{} did not build: {error}", space.relative));
            crate::agent_space_builder::verify_space(&plan.project_root, &space.root)
                .unwrap_or_else(|error| panic!("{} did not verify: {error}", space.relative));
        }
    }

    /// The whole authorized build: materialize, verify, open and register.
    /// This is the step a journey can only observe indirectly, so its failure
    /// text belongs in a unit test.
    #[tokio::test]
    async fn an_authorized_build_registers_the_package_team() {
        fn copy_tree(from: &Path, to: &Path) {
            fs::create_dir_all(to).unwrap();
            for entry in fs::read_dir(from).unwrap() {
                let entry = entry.unwrap();
                let target = to.join(entry.file_name());
                if entry.file_type().unwrap().is_dir() {
                    copy_tree(&entry.path(), &target);
                } else {
                    fs::copy(entry.path(), target).unwrap();
                }
            }
        }

        let home = tempfile::tempdir().unwrap();
        let project = home.path().join("project");
        fs::create_dir_all(&project).unwrap();
        copy_tree(
            &super::super::builtin_package_source(),
            &project.join(".genethub/workflows/game-delivery"),
        );
        let paths = crate::config::Paths::new(home.path().join("data"));
        let (state, _pty) = crate::state::AppState::build(paths).await.unwrap();
        let workspace = state.workspaces.open(&project, None).await.unwrap();

        let package = package::load(&project, "game-delivery").unwrap();
        let plan = plan(&project, &package).unwrap();
        let configured = apply(&state, &workspace.id, &plan, 0)
            .await
            .expect("an authorized build must register the package team");

        let executor = configured
            .iter()
            .find(|space| space.name.contains("executor") && !space.name.contains("manager"))
            .expect("the carrier is among the registered Spaces");
        assert_eq!(
            executor.agent_space.as_ref().unwrap().parent_workspace_id.as_deref(),
            Some(workspace.id.as_str()),
            "the carrier must hang off the project root",
        );
        assert_eq!(
            state
                .workspaces
                .reusable_component_space_at(
                    &workspace.id,
                    crate::agent_space::COMPONENT_EXECUTOR,
                    Some(&project.join("spaces/game-delivery--executor")),
                )
                .await
                .unwrap()
                .map(|space| space.id),
            Some(executor.id.clone()),
        );
        for role in ["coder", "reviewer", "workflow-manager", "workflow-reviewer"] {
            state
                .workspaces
                .worker_space_for_role(&executor.id, role)
                .await
                .unwrap_or_else(|error| panic!("{role} is not a dispatchable Worker: {error}"));
        }
    }
}
