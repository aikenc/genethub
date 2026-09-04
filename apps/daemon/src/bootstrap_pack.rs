//! Versioned project Bootstrap Packs.
//!
//! Packs contain PM methods, DCG source, role prompts, and AgentSpace source
//! files. The kernel deliberately knows none of those business choices: it
//! validates one manifest, renders a tiny fixed variable set, installs files
//! without overwriting project edits, invokes AgentSpaceBuilder, and commits
//! the declared component tree.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use genehub_proto::{BootstrapPackInfo, BootstrapPackReport, WorkspaceInfo};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::state::Shared;
use crate::workspace::BootstrapSpaceRegistration;

const PACK_SCHEMA: &str = "genehub.bootstrap-pack.v1";
const REPORT_SCHEMA: &str = "genehub.bootstrap-pack.report.v1";
const MAX_PACK_FILES: usize = 256;
const MAX_PACK_BYTES: usize = 4 * 1024 * 1024;

struct BootstrapFile {
    relative_path: &'static str,
    contents: &'static [u8],
}

include!(concat!(env!("OUT_DIR"), "/bootstrap_packs.rs"));

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackManifest {
    schema: String,
    id: String,
    version: u32,
    description: String,
    entry_skill: String,
    #[serde(default)]
    root_components: Vec<ComponentSpec>,
    spaces: Vec<SpaceSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpaceSpec {
    name: String,
    parent: String,
    lifecycle: String,
    components: Vec<ComponentSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComponentSpec {
    component_id: String,
    #[serde(default)]
    role: Option<String>,
}

struct LoadedPack {
    manifest: PackManifest,
    digest: String,
    files: Vec<&'static BootstrapFile>,
}

struct RenderedFile {
    target: PathBuf,
    relative: String,
    body: Vec<u8>,
}

pub fn list() -> Result<Vec<BootstrapPackInfo>> {
    let mut ids = BOOTSTRAP_FILES
        .iter()
        .filter_map(|file| file.relative_path.strip_suffix("/pack.json"))
        .map(str::to_string)
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    ids.into_iter()
        .map(|id| {
            let pack = load(&id)?;
            Ok(BootstrapPackInfo {
                id: pack.manifest.id,
                version: pack.manifest.version,
                description: pack.manifest.description,
                digest: pack.digest,
                entry_skill: pack.manifest.entry_skill,
            })
        })
        .collect()
}

pub async fn execute(
    state: &Shared,
    project_workspace_id: &str,
    pack_id: &str,
    apply: bool,
    agent_id: &str,
    model_id: Option<&str>,
) -> Result<BootstrapPackReport> {
    let project = state.workspaces.project_entry(project_workspace_id).await?;
    let pack = load(pack_id)?;
    let rendered = render(&pack, &project.root, agent_id, model_id)?;
    let current = rendered
        .iter()
        .all(|file| fs::read(&file.target).ok().as_deref() == Some(file.body.as_slice()));
    let files = rendered
        .iter()
        .map(|file| file.relative.clone())
        .collect::<Vec<_>>();
    if !apply {
        return Ok(report(
            &pack,
            project_workspace_id,
            "planned",
            files,
            Vec::new(),
            current,
        ));
    }

    preflight_targets(&project.root, &rendered)?;
    for file in &rendered {
        write_new_or_same(&project.root, file)?;
    }
    crate::workflow::ensure_source_visible(&project.root.join(".genethub"))?;

    build_space(&project.root, &project.root)?;
    let mut by_name = BTreeMap::new();
    for space in &pack.manifest.spaces {
        let root = project.root.join("spaces").join(&space.name);
        let verified = build_space(&project.root, &root)?;
        let workspace = state
            .workspaces
            .open(&verified.workspace_path, None)
            .await?;
        by_name.insert(space.name.clone(), workspace);
    }

    let mut registrations = vec![BootstrapSpaceRegistration {
        workspace_id: project_workspace_id.to_string(),
        parent_workspace_id: None,
        lifecycle: "persistent".into(),
        components: pack
            .manifest
            .root_components
            .iter()
            .map(component_pair)
            .collect(),
    }];
    for space in &pack.manifest.spaces {
        let workspace = by_name
            .get(&space.name)
            .expect("every manifest Space was opened");
        let parent_workspace_id = match space.parent.as_str() {
            "$project" => project_workspace_id.to_string(),
            parent => by_name
                .get(parent)
                .map(|workspace| workspace.id.clone())
                .ok_or_else(|| {
                    anyhow!("Bootstrap Space {} has unknown parent {parent}", space.name)
                })?,
        };
        registrations.push(BootstrapSpaceRegistration {
            workspace_id: workspace.id.clone(),
            parent_workspace_id: Some(parent_workspace_id),
            lifecycle: space.lifecycle.clone(),
            components: space.components.iter().map(component_pair).collect(),
        });
    }
    let configured = state
        .workspaces
        .apply_bootstrap_space_plan(project_workspace_id, &registrations)
        .await?;
    let configured_by_id = configured
        .into_iter()
        .map(|workspace| (workspace.id.clone(), workspace))
        .collect::<BTreeMap<_, _>>();
    let spaces = pack
        .manifest
        .spaces
        .iter()
        .filter_map(|space| by_name.get(&space.name))
        .filter_map(|workspace| configured_by_id.get(&workspace.id))
        .cloned()
        .collect::<Vec<_>>();

    let runtime =
        crate::workflow::RuntimeStore::new(&state.paths.root, project_workspace_id, &project.root)?;
    crate::workflow::activate_bootstrap_source(&project.root, &runtime, pack.digest.clone())?;
    save_receipt(&project.root, &pack, &spaces)?;

    Ok(report(
        &pack,
        project_workspace_id,
        "applied",
        files,
        spaces,
        true,
    ))
}

fn load(pack_id: &str) -> Result<LoadedPack> {
    validate_id(pack_id, "Bootstrap Pack id")?;
    let prefix = format!("{pack_id}/");
    let manifest_path = format!("{prefix}pack.json");
    let manifest_file = BOOTSTRAP_FILES
        .iter()
        .find(|file| file.relative_path == manifest_path)
        .ok_or_else(|| anyhow!("unknown Bootstrap Pack: {pack_id}"))?;
    let manifest: PackManifest = serde_json::from_slice(manifest_file.contents)
        .with_context(|| format!("parsing Bootstrap Pack {pack_id}"))?;
    if manifest.schema != PACK_SCHEMA || manifest.id != pack_id || manifest.version == 0 {
        bail!("invalid Bootstrap Pack identity: {pack_id}");
    }
    if manifest.description.trim().is_empty() {
        bail!("Bootstrap Pack {pack_id} has no description");
    }
    safe_relative(&manifest.entry_skill)?;
    if manifest.spaces.is_empty() || manifest.spaces.len() > 16 {
        bail!("Bootstrap Pack {pack_id} must declare 1..=16 AgentSpaces");
    }
    let mut names = BTreeSet::new();
    for space in &manifest.spaces {
        if !crate::agent_space_builder::valid_space_name(&space.name)
            || !names.insert(space.name.clone())
        {
            bail!("Bootstrap Pack {pack_id} has an invalid or duplicate Space name");
        }
        if space.parent != "$project"
            && !manifest.spaces.iter().any(|item| item.name == space.parent)
        {
            bail!(
                "Bootstrap Space {} has unknown parent {}",
                space.name,
                space.parent
            );
        }
        if !matches!(
            space.lifecycle.as_str(),
            "persistent" | "pooled" | "ephemeral"
        ) {
            bail!("Bootstrap Space {} has an invalid lifecycle", space.name);
        }
    }
    let files = BOOTSTRAP_FILES
        .iter()
        .filter(|file| {
            file.relative_path.starts_with(&prefix) && file.relative_path != manifest_path
        })
        .collect::<Vec<_>>();
    let entry_source = format!("{prefix}project/{}", manifest.entry_skill);
    if !files.iter().any(|file| file.relative_path == entry_source) {
        bail!(
            "Bootstrap Pack {pack_id} entrySkill is not a project asset: {}",
            manifest.entry_skill
        );
    }
    if files.is_empty() || files.len() > MAX_PACK_FILES {
        bail!("Bootstrap Pack {pack_id} has an invalid file count");
    }
    let bytes = files
        .iter()
        .try_fold(manifest_file.contents.len(), |total, file| {
            total.checked_add(file.contents.len())
        })
        .ok_or_else(|| anyhow!("Bootstrap Pack {pack_id} size overflow"))?;
    if bytes > MAX_PACK_BYTES {
        bail!("Bootstrap Pack {pack_id} exceeds {MAX_PACK_BYTES} bytes");
    }
    let mut digest = Sha256::new();
    digest.update(b"genehub.bootstrap-pack.v1\0");
    digest.update(manifest_file.contents);
    for file in &files {
        digest.update((file.relative_path.len() as u64).to_le_bytes());
        digest.update(file.relative_path.as_bytes());
        digest.update((file.contents.len() as u64).to_le_bytes());
        digest.update(file.contents);
    }
    Ok(LoadedPack {
        manifest,
        digest: format!("sha256:{:x}", digest.finalize()),
        files,
    })
}

fn render(
    pack: &LoadedPack,
    project_root: &Path,
    agent_id: &str,
    model_id: Option<&str>,
) -> Result<Vec<RenderedFile>> {
    validate_id(agent_id, "agent id")?;
    let project_name = project_root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| crate::agent_space_builder::valid_space_name(name))
        .ok_or_else(|| {
            anyhow!("project directory name must be lowercase kebab-case before Bootstrap")
        })?;
    let prefix = format!("{}/", pack.manifest.id);
    let agent_yaml = serde_json::to_string(agent_id)?;
    let model_yaml = model_id
        .filter(|model| !model.trim().is_empty())
        .map(|model| serde_json::to_string(model).map(|model| format!("modelId: {model}\n")))
        .transpose()?
        .unwrap_or_default();
    let mut rendered = Vec::new();
    for file in &pack.files {
        let inside = file
            .relative_path
            .strip_prefix(&prefix)
            .expect("pack files share their prefix");
        let relative = if let Some(relative) = inside.strip_prefix("project/") {
            relative.to_string()
        } else if inside.starts_with("spaces/") {
            inside.to_string()
        } else {
            bail!("Bootstrap Pack file must live under project/ or spaces/: {inside}");
        };
        let mut relative = relative.replace("__PROJECT_SPACE_NAME__", project_name);
        if let Some(stripped) = relative.strip_suffix(".tmpl") {
            relative = stripped.to_string();
        }
        safe_relative(&relative)?;
        let raw = std::str::from_utf8(file.contents)
            .with_context(|| format!("Bootstrap Pack text is not UTF-8: {inside}"))?;
        let body = raw
            .replace("{{PROJECT_SPACE_NAME}}", project_name)
            .replace("{{AGENT_ID}}", &agent_yaml)
            .replace("{{MODEL_ID_YAML}}", &model_yaml)
            .into_bytes();
        if body.windows(2).any(|window| window == b"{{") {
            bail!("Bootstrap Pack has an unresolved template token: {inside}");
        }
        rendered.push(RenderedFile {
            target: project_root.join(&relative),
            relative,
            body,
        });
    }
    rendered.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(rendered)
}

fn preflight_targets(project_root: &Path, rendered: &[RenderedFile]) -> Result<()> {
    for file in rendered {
        if let Ok(metadata) = crate::config::sensitive_metadata(&file.target) {
            crate::config::reject_link_or_reparse(&file.target, &metadata)?;
            if !metadata.is_file() || fs::read(&file.target)? != file.body {
                bail!(
                    "Bootstrap Pack refuses to overwrite project file: {}",
                    file.relative
                );
            }
        }
        let resolved_parent = file.target.parent().expect("Pack files have parents");
        let relative_parent = resolved_parent
            .strip_prefix(project_root)
            .map_err(|_| anyhow!("Bootstrap target escaped the project"))?;
        ensure_directory_tree(project_root, relative_parent, false)?;
    }
    Ok(())
}

fn write_new_or_same(project_root: &Path, file: &RenderedFile) -> Result<()> {
    if fs::read(&file.target).ok().as_deref() == Some(file.body.as_slice()) {
        return Ok(());
    }
    let parent = file.target.parent().expect("Pack files have parents");
    let relative_parent = parent
        .strip_prefix(project_root)
        .map_err(|_| anyhow!("Bootstrap target escaped the project"))?;
    ensure_directory_tree(project_root, relative_parent, true)?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o644);
    }
    let mut target = options
        .open(&file.target)
        .with_context(|| format!("creating Bootstrap file {}", file.relative))?;
    target.write_all(&file.body)?;
    target.sync_all()?;
    Ok(())
}

fn ensure_directory_tree(root: &Path, relative: &Path, create: bool) -> Result<PathBuf> {
    let root = root.canonicalize()?;
    let mut current = root.clone();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            bail!("Bootstrap directory must be a normal relative path");
        };
        current.push(component);
        match crate::config::sensitive_metadata(&current) {
            Ok(metadata) => {
                crate::config::reject_link_or_reparse(&current, &metadata)?;
                if !metadata.is_dir() {
                    bail!(
                        "Bootstrap directory path is not a directory: {}",
                        current.display()
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                fs::create_dir(&current)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(current)
}

fn build_space(
    project_root: &Path,
    space_root: &Path,
) -> Result<crate::agent_space_builder::VerifiedSpace> {
    crate::agent_space_builder::run(
        project_root,
        space_root,
        crate::agent_space_builder::Command::Build { dry_run: false },
        true,
    )
    .map_err(|error| {
        anyhow!(
            "AgentSpaceBuilder rejected {}: {error}",
            space_root.display()
        )
    })?;
    crate::agent_space_builder::verify_space(project_root, space_root).map_err(|error| {
        anyhow!(
            "AgentSpaceBuilder could not verify {}: {error}",
            space_root.display()
        )
    })
}

fn component_pair(component: &ComponentSpec) -> (String, Option<String>) {
    (component.component_id.clone(), component.role.clone())
}

fn save_receipt(root: &Path, pack: &LoadedPack, spaces: &[WorkspaceInfo]) -> Result<()> {
    let path = root
        .join(".genethub/bootstrap-packs")
        .join(format!("{}.json", pack.manifest.id));
    let receipt = serde_json::json!({
        "schema": "genehub.bootstrap-pack.receipt.v1",
        "packId": pack.manifest.id,
        "packVersion": pack.manifest.version,
        "packDigest": pack.digest,
        "spaces": spaces.iter().map(|space| serde_json::json!({
            "workspaceId": space.id,
            "name": space.name,
        })).collect::<Vec<_>>(),
        "appliedAtMs": chrono::Utc::now().timestamp_millis(),
    });
    crate::config::save_private(&path, &serde_json::to_vec_pretty(&receipt)?)
}

fn report(
    pack: &LoadedPack,
    project_workspace_id: &str,
    status: &str,
    files: Vec<String>,
    spaces: Vec<WorkspaceInfo>,
    current: bool,
) -> BootstrapPackReport {
    BootstrapPackReport {
        schema: REPORT_SCHEMA.into(),
        status: status.into(),
        pack_id: pack.manifest.id.clone(),
        pack_version: pack.manifest.version,
        pack_digest: pack.digest.clone(),
        project_workspace_id: project_workspace_id.into(),
        entry_skill: pack.manifest.entry_skill.clone(),
        files,
        spaces,
        current,
    }
}

fn safe_relative(value: &str) -> Result<()> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        bail!("unsafe Bootstrap Pack target: {value}");
    }
    Ok(())
}

fn validate_id(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 96
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        bail!("{label} is invalid");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_game_pack_is_complete_and_renders_without_business_code() {
        let pack = load("game-delivery-v1").expect("embedded pack");
        assert_eq!(pack.manifest.spaces.len(), 4);
        assert_eq!(
            pack.manifest.entry_skill,
            ".pipebuilder/skills/project-manager/SKILL.md"
        );
        assert!(pack
            .manifest
            .spaces
            .iter()
            .any(|space| space.name == "workflow-manager"));
        let temp = tempfile::tempdir().expect("temporary project");
        let project = temp.path().join("game-project");
        fs::create_dir(&project).expect("project");
        let rendered = render(&pack, &project, "codex", Some("test-model")).expect("render");
        assert!(rendered
            .iter()
            .any(|file| file.relative == "game-project.code-workspace"));
        assert!(rendered
            .iter()
            .any(|file| file.relative.ends_with("game-project.yaml")));
        let pm_skill = rendered
            .iter()
            .find(|file| file.relative == ".pipebuilder/skills/project-manager/SKILL.md")
            .expect("PM skill");
        let pm_skill = std::str::from_utf8(&pm_skill.body).expect("UTF-8 PM skill");
        assert!(pm_skill.contains("--no-wait"));
        assert!(pm_skill.contains("<genehub_flow_message kind=\"run.completed\">"));
        assert!(pm_skill.contains("start a parallel implementation"));
        assert!(pm_skill.contains("Never call `session flow` on a Coder or Reviewer Session"));
        let manager_skill = rendered
            .iter()
            .find(|file| {
                file.relative == "spaces/workflow-manager/skills/workflow-manager/SKILL.md"
            })
            .expect("WorkflowManager skill");
        let manager_skill =
            std::str::from_utf8(&manager_skill.body).expect("UTF-8 WorkflowManager skill");
        assert!(manager_skill.contains("space children --workspace"));
        assert!(manager_skill.contains("does not create a Worker AgentSpace"));
        assert!(manager_skill.contains("instead of inventing an unattached"));
        let evaluator = rendered
            .iter()
            .find(|file| {
                file.relative
                    .ends_with("workflow-manager/scripts/evaluate.mjs")
            })
            .expect("WorkflowManager evaluator");
        let evaluator = std::str::from_utf8(&evaluator.body).expect("UTF-8 evaluator");
        assert!(evaluator.contains("ls-files"));
        assert!(evaluator.contains("Candidate roles have no enabled direct Worker"));
        assert!(evaluator.contains("candidate.rolesHaveAttachedWorkers"));
        assert!(rendered
            .iter()
            .all(|file| !file.body.windows(2).any(|window| window == b"{{")));
    }
}
