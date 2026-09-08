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
use genehub_proto::{BootstrapGitPlan, BootstrapPackInfo, BootstrapPackReport, WorkspaceInfo};
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
    #[serde(default)]
    root_guidance: Vec<String>,
    #[serde(default)]
    intent_matches: Vec<String>,
    spaces: Vec<SpaceSpec>,
    #[serde(default)]
    upgrade_from: Option<UpgradeSource>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpgradeSource {
    version: u32,
    file_digests: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpaceSpec {
    name: String,
    parent: String,
    lifecycle: String,
    components: Vec<ComponentSpec>,
    #[serde(default)]
    guidance: Vec<String>,
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
    previous_digest: Option<String>,
    changed_from_previous: bool,
    target: PathBuf,
    relative: String,
    body: Vec<u8>,
}

pub(crate) struct Prepared {
    upgrading: bool,
    activation_revision: Option<u64>,
    pack: LoadedPack,
    project_workspace_id: String,
    project_root: PathBuf,
    rendered: Vec<RenderedFile>,
    git_state: crate::git::BootstrapState,
    report: BootstrapPackReport,
}

impl Prepared {
    pub(crate) fn report(&self) -> BootstrapPackReport {
        self.report.clone()
    }

    pub(crate) fn challenge_spec(
        &self,
        controller_session_id: &str,
    ) -> crate::project_control::ChallengeSpec {
        crate::project_control::ChallengeSpec {
            controller_session_id: controller_session_id.into(),
            workspace_id: self.project_workspace_id.clone(),
            canonical_root: self.project_root.display().to_string(),
            action: "project.bootstrap.apply".into(),
            pack_id: self.pack.manifest.id.clone(),
            pack_digest: self.pack.digest.clone(),
            plan_digest: self.report.plan_digest.clone(),
            expected_revision: self.report.expected_revision,
            git_head: self.git_state.head.clone(),
            status_digest: self.git_state.status_digest.clone(),
            title: format!("{}「{}」{}", if self.upgrading { "升级" } else { "将" }, self.project_root.file_name().and_then(|name| name.to_str()).unwrap_or("当前项目"), if self.upgrading { "的 PM 专家团队？" } else { "交给 PM 团队管理？" }),
            detail: format!(
                "将应用 {} v{}，{}当前目录的独立 Git，并以 {} 创建精确 bootstrap commit，再建立 PM、Executor 执行小队及 WorkflowManager/WorkflowReviewer 专家。只会提交计划列出的项目资产。\nplan: {}",
                self.pack.manifest.id,
                self.pack.manifest.version,
                if self.git_state.direct { "复用" } else { "创建" },
                self.git_state.commit_identity.display(),
                self.report.plan_digest,
            ),
        }
    }

    pub(crate) fn canonical_root(&self) -> String {
        self.project_root.display().to_string()
    }
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
                intent_matches: pack.manifest.intent_matches,
            })
        })
        .collect()
}

pub(crate) async fn prepare(
    state: &Shared,
    project_workspace_id: &str,
    pack_id: &str,
    agent_id: &str,
    model_id: Option<&str>,
) -> Result<Prepared> {
    let project = state.workspaces.project_entry(project_workspace_id).await?;
    let pack = load(pack_id)?;
    let registration = state.workspaces.agent_space(project_workspace_id).await?;
    let upgrading = pack.manifest.upgrade_from.as_ref().is_some_and(|previous| {
        registration
            .bootstrap_pack
            .as_ref()
            .is_some_and(|installed| {
                installed.id == pack_id && installed.version == previous.version
            })
    });
    let mut rendered = render(&pack, &project.root, agent_id, model_id)?;
    if upgrading {
        rendered.retain(|file| file.changed_from_previous);
    }
    let activation_revision = if upgrading {
        if !crate::workflow::project_active_run_ids(
            &state.paths.root,
            project_workspace_id,
            &project.root,
        )?
        .is_empty()
        {
            bail!("activeRunConflict: finish the project's Runs before upgrading its expert Pack");
        }
        let runtime = crate::workflow::RuntimeStore::new(
            &state.paths.root,
            project_workspace_id,
            &project.root,
        )?;
        let status = crate::workflow::inspect(&project.root, &runtime)?;
        if status.source_changed || status.candidate_error.is_some() {
            bail!("inactiveCandidateConflict: preserve and resolve the current inactive Candidate before Pack upgrade");
        }
        Some(status.activation_revision)
    } else {
        None
    };
    let files_present = rendered.iter().all(|file| file.target.is_file());
    let receipt_current = receipt_matches(&project.root, &pack);
    let team_current = if receipt_current {
        installed_team_current(state, project_workspace_id, &project.root, &pack).await
    } else {
        false
    };
    let current = files_present && receipt_current && team_current;
    let files = rendered
        .iter()
        .map(|file| file.relative.clone())
        .collect::<Vec<_>>();
    if !current {
        preflight_targets(&project.root, &rendered, upgrading)?;
    }
    let git_state = crate::git::bootstrap_state(&project.root).await?;
    if git_state.direct && !git_state.changes.is_empty() {
        bail!(
            "dirtyGit: commit or clean these project changes before PM takeover: {}",
            git_state.changes.join(", ")
        );
    }
    if !git_state.direct && !git_state.changes.is_empty() {
        bail!(
            "nonEmptyNonGit: PM takeover only initializes an empty ordinary folder; move or commit these entries first: {}",
            git_state.changes.join(", ")
        );
    }
    let runtime_path = state
        .paths
        .root
        .join("workflow-runtime")
        .join(project_workspace_id);
    if !current && !upgrading && runtime_path.exists() {
        bail!(
            "packConflict: this Workspace already has daemon workflow runtime state; archive or migrate it before PM takeover"
        );
    }
    let expected_revision = state
        .workspaces
        .agent_space(project_workspace_id)
        .await?
        .revision;
    let mut plan_digest = plan_digest(
        &pack,
        project_workspace_id,
        &project.root,
        expected_revision,
        &git_state,
        &files,
        agent_id,
        model_id,
    );
    if let Some(revision) = activation_revision {
        plan_digest = format!(
            "sha256:{:x}",
            Sha256::digest(format!("{plan_digest}:activation:{revision}"))
        );
    }
    let report = BootstrapPackReport {
        schema: REPORT_SCHEMA.into(),
        status: "planned".into(),
        pack_id: pack.manifest.id.clone(),
        pack_version: pack.manifest.version,
        pack_digest: pack.digest.clone(),
        project_workspace_id: project_workspace_id.into(),
        entry_skill: pack.manifest.entry_skill.clone(),
        files,
        spaces: Vec::new(),
        current,
        plan_digest,
        expected_revision,
        git: BootstrapGitPlan {
            mode: if git_state.direct { "reuse" } else { "create" }.into(),
            head: git_state.head.clone(),
            status_digest: git_state.status_digest.clone(),
            commit_identity: git_state.commit_identity.display(),
        },
        approval: None,
        bootstrap_commit: None,
        project_control_bound: false,
    };
    Ok(Prepared {
        upgrading,
        activation_revision,
        pack,
        project_workspace_id: project_workspace_id.into(),
        project_root: project.root,
        rendered,
        git_state,
        report,
    })
}

pub(crate) async fn apply(
    state: &Shared,
    prepared: Prepared,
    controller_session_id: &str,
) -> Result<BootstrapPackReport> {
    apply_inner(state, prepared, controller_session_id, None).await
}

async fn apply_inner(
    state: &Shared,
    prepared: Prepared,
    controller_session_id: &str,
    failure_stage: Option<&str>,
) -> Result<BootstrapPackReport> {
    let Prepared {
        upgrading,
        activation_revision,
        pack,
        project_workspace_id,
        project_root,
        rendered,
        git_state,
        report: planned,
    } = prepared;
    if planned.current {
        let spaces = installed_spaces(state, &project_root, &pack.manifest.id).await;
        let commit = receipt_commit(&project_root, &pack.manifest.id);
        return Ok(finish_report(
            planned,
            "current",
            spaces,
            commit,
            state
                .project_control
                .is_bound(&project_workspace_id, controller_session_id),
        ));
    }

    let file_snapshot = snapshot_paths(&project_root)?;
    let replaced_files = if upgrading {
        upgrade_file_checkpoint(&project_root, &rendered, &pack)?
    } else {
        BTreeMap::new()
    };
    let runtime_checkpoint_store = crate::workflow::RuntimeStore::new(
        &state.paths.root,
        &project_workspace_id,
        &project_root,
    )?;
    let activation_checkpoint = if upgrading {
        crate::workflow::activation_checkpoint(&runtime_checkpoint_store)?
    } else {
        None
    };
    let config_snapshot = state.workspaces.config_snapshot().await;
    let binding_snapshot = state
        .project_control
        .binding_snapshot(&project_workspace_id)?;
    let runtime_path = state
        .paths
        .root
        .join("workflow-runtime")
        .join(&project_workspace_id);
    let runtime_existed = runtime_path.exists();
    save_transaction(
        state,
        &project_workspace_id,
        &planned.plan_digest,
        "applying",
        false,
        false,
        None,
    )?;
    let created_git = !git_state.direct;
    let mut created_commit = None;
    let mut upgraded_activation_digest = None;
    let transaction: Result<(Vec<WorkspaceInfo>, String)> = async {
        if created_git {
            crate::git::init(&project_root).await?;
            // Refresh the catalogue fact without changing the Workspace identity.
            state.workspaces.open(&project_root, None).await?;
        }
        inject_test_failure(failure_stage, "git")?;
        for file in &rendered {
            if upgrading && file.target.exists() && fs::read(&file.target)? != file.body {
                let expected = file.previous_digest.as_deref().ok_or_else(|| {
                    anyhow!(
                        "upgradeConflict: new Pack path already exists: {}",
                        file.relative
                    )
                })?;
                if format!("sha256:{:x}", Sha256::digest(fs::read(&file.target)?)) != expected {
                    bail!(
                        "upgradeConflict: project customization changed after planning: {}",
                        file.relative
                    );
                }
                crate::config::save_private(&file.target, &file.body)?;
            } else {
                write_new_or_same(&project_root, file)?;
            }
        }
        crate::workflow::ensure_source_visible(&project_root.join(".genethub"))?;
        inject_test_failure(failure_stage, "assets")?;

        build_space(&project_root, &project_root)?;
        inject_test_failure(failure_stage, "project-builder")?;
        let mut by_name = BTreeMap::new();
        for space in &pack.manifest.spaces {
            let root = project_root.join("spaces").join(&space.name);
            let verified = build_space(&project_root, &root)?;
            let workspace = state
                .workspaces
                .open(&verified.workspace_path, None)
                .await?;
            by_name.insert(space.name.clone(), workspace);
        }
        inject_test_failure(failure_stage, "team-builder")?;

        let pack_entry = || crate::config::AgentSpacePackEntry {
            id: pack.manifest.id.clone(),
            version: pack.manifest.version,
            digest: pack.digest.clone(),
        };
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
            guidance: pack.manifest.root_guidance.clone(),
            pack: Some(pack_entry()),
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
                guidance: space.guidance.clone(),
                pack: Some(pack_entry()),
            });
        }
        if upgrading {
            for desired in &mut registrations {
                let current = state.workspaces.agent_space(&desired.workspace_id).await?;
                if current.revision > 0 {
                    desired.lifecycle = current.lifecycle;
                }
            }
        }
        let configured = state
            .workspaces
            .apply_bootstrap_space_plan(
                &project_workspace_id,
                planned.expected_revision,
                &registrations,
            )
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
        inject_test_failure(failure_stage, "registry")?;

        let runtime = crate::workflow::RuntimeStore::new(
            &state.paths.root,
            &project_workspace_id,
            &project_root,
        )?;
        if let Some(revision) = activation_revision {
            upgraded_activation_digest =
                crate::workflow::activate_project(&project_root, &runtime, None, revision)
                    .map_err(|error| anyhow!("activationFailed: {error:#}"))?
                    .active_digest;
        } else {
            crate::workflow::activate_bootstrap_source(
                &project_root,
                &runtime,
                pack.digest.clone(),
            )
            .map_err(|error| anyhow!("activationFailed: {error:#}"))?;
        }
        inject_test_failure(failure_stage, "activation")?;
        state.project_control.bind(
            &project_workspace_id,
            controller_session_id,
            &pack.manifest.id,
            &pack.digest,
        )?;
        inject_test_failure(failure_stage, "binding")?;

        let commit_paths = crate::git::bootstrap_paths(&project_root).await?;
        validate_commit_paths(&commit_paths)?;
        let bootstrap_commit = crate::git::bootstrap_commit(
            &project_root,
            "chore: bootstrap game delivery workflow",
            &commit_paths,
            &git_state.commit_identity,
        )
        .await?;
        created_commit = Some(bootstrap_commit.clone());
        inject_test_failure(failure_stage, "commit")?;
        save_receipt(&project_root, &pack, &spaces, &bootstrap_commit)?;
        inject_test_failure(failure_stage, "receipt")?;
        save_transaction(
            state,
            &project_workspace_id,
            &planned.plan_digest,
            "completed",
            true,
            false,
            None,
        )?;
        Ok((spaces, bootstrap_commit))
    }
    .await;

    let (spaces, bootstrap_commit) = match transaction {
        Ok(success) => success,
        Err(error) => {
            let mut rollback_errors = Vec::new();
            if !created_git {
                if let Err(rollback) = crate::git::rollback_bootstrap_git(
                    &project_root,
                    git_state.head.as_deref(),
                    created_commit.as_deref(),
                )
                .await
                {
                    rollback_errors.push(format!("git: {rollback:#}"));
                }
            }
            if let Err(rollback) = state
                .workspaces
                .restore_config_snapshot(config_snapshot)
                .await
            {
                rollback_errors.push(format!("workspace registry: {rollback:#}"));
            }
            if let Err(rollback) = state
                .project_control
                .restore_binding_snapshot(&project_workspace_id, binding_snapshot.as_deref())
            {
                rollback_errors.push(format!("project binding: {rollback:#}"));
            }
            if !runtime_existed && runtime_path.exists() {
                if let Err(rollback) = fs::remove_dir_all(&runtime_path) {
                    rollback_errors.push(format!("workflow runtime: {rollback}"));
                }
            }
            if let Err(rollback) = rollback_files(&project_root, &file_snapshot, created_git) {
                rollback_errors.push(format!("project files: {rollback:#}"));
            }
            for (relative, bytes) in &replaced_files {
                if let Err(error) = crate::config::save_private(&project_root.join(relative), bytes)
                {
                    rollback_errors.push(format!("restore {}: {error:#}", relative.display()));
                }
            }
            if upgrading {
                if let Err(error) = crate::workflow::restore_activation_checkpoint(
                    &runtime_checkpoint_store,
                    activation_checkpoint.as_deref(),
                    upgraded_activation_digest.as_deref(),
                ) {
                    rollback_errors.push(format!("restore activation: {error:#}"));
                }
            }
            let rolled_back = rollback_errors.is_empty();
            let rollback_detail = if rolled_back {
                None
            } else {
                Some(rollback_errors.join("; "))
            };
            save_transaction(
                state,
                &project_workspace_id,
                &planned.plan_digest,
                "failed",
                true,
                rolled_back,
                Some(&format!("{error:#}")),
            )?;
            return Err(if let Some(rollback) = rollback_detail {
                anyhow!(
                    "rollbackIncomplete: bootstrap failed: {error:#}; rollback failed: {rollback}"
                )
            } else {
                anyhow!("bootstrapFailed: {error:#}; changes were rolled back")
            });
        }
    };

    Ok(finish_report(
        planned,
        "applied",
        spaces,
        Some(bootstrap_commit),
        true,
    ))
}

/// A test-only seam kept as data instead of an environment switch: production
/// callers always pass `None`, so an installed daemon has no hidden failpoint.
fn inject_test_failure(requested: Option<&str>, stage: &str) -> Result<()> {
    if requested == Some(stage) {
        bail!("testFault:{stage}");
    }
    Ok(())
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
    if manifest
        .upgrade_from
        .as_ref()
        .is_some_and(|source| source.version == 0 || source.version >= manifest.version)
    {
        bail!("invalid Bootstrap Pack upgrade source: {pack_id}");
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
        .map(str::to_string)
        .unwrap_or_else(|| {
            let mut digest = Sha256::new();
            digest.update(project_root.to_string_lossy().as_bytes());
            format!("pm-project-{:x}", digest.finalize())[..27].to_string()
        });
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
        let mut relative = relative.replace("__PROJECT_SPACE_NAME__", &project_name);
        if let Some(stripped) = relative.strip_suffix(".tmpl") {
            relative = stripped.to_string();
        }
        safe_relative(&relative)?;
        let raw = std::str::from_utf8(file.contents)
            .with_context(|| format!("Bootstrap Pack text is not UTF-8: {inside}"))?;
        let body = raw
            .replace("{{PROJECT_SPACE_NAME}}", &project_name)
            .replace("{{AGENT_ID}}", &agent_yaml)
            .replace("{{MODEL_ID_YAML}}", &model_yaml)
            .into_bytes();
        if body.windows(2).any(|window| window == b"{{") {
            bail!("Bootstrap Pack has an unresolved template token: {inside}");
        }
        let previous_digest = pack
            .manifest
            .upgrade_from
            .as_ref()
            .and_then(|previous| previous.file_digests.get(inside))
            .cloned();
        let source_digest = format!("sha256:{:x}", Sha256::digest(file.contents));
        let changed_from_previous = previous_digest.as_deref() != Some(source_digest.as_str());
        rendered.push(RenderedFile {
            previous_digest,
            changed_from_previous,
            target: project_root.join(&relative),
            relative,
            body,
        });
    }
    rendered.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(rendered)
}

fn preflight_targets(
    project_root: &Path,
    rendered: &[RenderedFile],
    upgrading: bool,
) -> Result<()> {
    for file in rendered {
        if let Ok(metadata) = crate::config::sensitive_metadata(&file.target) {
            crate::config::reject_link_or_reparse(&file.target, &metadata)?;
            let content = if metadata.is_file() {
                fs::read(&file.target)?
            } else {
                Vec::new()
            };
            let matches_previous = upgrading
                && file.previous_digest.as_deref()
                    == Some(format!("sha256:{:x}", Sha256::digest(&content)).as_str());
            if !metadata.is_file() || (content != file.body && !matches_previous) {
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
            "builderVerifyFailed: AgentSpaceBuilder rejected {}: {error}",
            space_root.display()
        )
    })?;
    crate::agent_space_builder::verify_space(project_root, space_root).map_err(|error| {
        anyhow!(
            "builderVerifyFailed: AgentSpaceBuilder could not verify {}: {error}",
            space_root.display()
        )
    })
}

fn component_pair(component: &ComponentSpec) -> (String, Option<String>) {
    (component.component_id.clone(), component.role.clone())
}

fn save_receipt(
    root: &Path,
    pack: &LoadedPack,
    spaces: &[WorkspaceInfo],
    bootstrap_commit: &str,
) -> Result<()> {
    let path = root
        .join(".genethub/bootstrap-packs")
        .join(format!("{}.json", pack.manifest.id));
    let receipt = serde_json::json!({
        "schema": "genehub.bootstrap-pack.receipt.v1",
        "packId": pack.manifest.id,
        "packVersion": pack.manifest.version,
        "packDigest": pack.digest,
        "bootstrapCommit": bootstrap_commit,
        "entrySkill": pack.manifest.entry_skill,
        "spaces": spaces.iter().map(|space| serde_json::json!({
            "workspaceId": space.id,
            "name": space.name,
        })).collect::<Vec<_>>(),
        "appliedAtMs": chrono::Utc::now().timestamp_millis(),
    });
    crate::config::save_private(&path, &serde_json::to_vec_pretty(&receipt)?)
}

fn finish_report(
    mut report: BootstrapPackReport,
    status: &str,
    spaces: Vec<WorkspaceInfo>,
    bootstrap_commit: Option<String>,
    project_control_bound: bool,
) -> BootstrapPackReport {
    report.status = status.into();
    report.spaces = spaces;
    report.current = true;
    report.approval = None;
    report.bootstrap_commit = bootstrap_commit;
    report.project_control_bound = project_control_bound;
    report
}

#[allow(clippy::too_many_arguments)]
fn plan_digest(
    pack: &LoadedPack,
    workspace_id: &str,
    root: &Path,
    expected_revision: u64,
    git: &crate::git::BootstrapState,
    files: &[String],
    agent_id: &str,
    model_id: Option<&str>,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"genehub.bootstrap-plan.v1\0");
    for value in [
        pack.manifest.id.as_str(),
        pack.digest.as_str(),
        workspace_id,
        root.to_string_lossy().as_ref(),
        git.status_digest.as_str(),
        git.head.as_deref().unwrap_or("unborn"),
        git.commit_identity.display().as_str(),
        agent_id,
        model_id.unwrap_or(""),
    ] {
        digest.update((value.len() as u64).to_le_bytes());
        digest.update(value.as_bytes());
    }
    digest.update(expected_revision.to_le_bytes());
    for file in files {
        digest.update((file.len() as u64).to_le_bytes());
        digest.update(file.as_bytes());
    }
    format!("sha256:{:x}", digest.finalize())
}

async fn installed_spaces(state: &Shared, root: &Path, pack_id: &str) -> Vec<WorkspaceInfo> {
    let ids = receipt_space_bindings(root, pack_id)
        .into_iter()
        .map(|(_, id)| id)
        .collect::<BTreeSet<_>>();
    state
        .workspaces
        .list()
        .await
        .into_iter()
        .filter(|workspace| ids.contains(&workspace.id))
        .collect()
}

async fn installed_team_current(
    state: &Shared,
    project_workspace_id: &str,
    root: &Path,
    pack: &LoadedPack,
) -> bool {
    let workspaces = state.workspaces.list().await;
    let by_id = workspaces
        .iter()
        .map(|workspace| (workspace.id.as_str(), workspace))
        .collect::<BTreeMap<_, _>>();
    let bindings = receipt_space_bindings(root, &pack.manifest.id)
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    if bindings.len() != pack.manifest.spaces.len() {
        return false;
    }
    let Some(project) = by_id.get(project_workspace_id).copied() else {
        return false;
    };
    let Some(project_space) = project.agent_space.as_ref() else {
        return false;
    };
    if project_space.parent_workspace_id.is_some()
        || project_space
            .health
            .as_ref()
            .map(|health| health.status.as_str())
            != Some("healthy")
        || !required_components_present(&project_space.components, &pack.manifest.root_components)
        || project_space
            .bootstrap_pack
            .as_ref()
            .map(|identity| identity.digest.as_str())
            != Some(pack.digest.as_str())
    {
        return false;
    }

    for desired in &pack.manifest.spaces {
        let Some(workspace_id) = bindings.get(desired.name.as_str()) else {
            return false;
        };
        let Some(workspace) = by_id.get(workspace_id.as_str()).copied() else {
            return false;
        };
        let Some(space) = workspace.agent_space.as_ref() else {
            return false;
        };
        let expected_parent = if desired.parent == "$project" {
            project_workspace_id
        } else {
            let Some(parent) = bindings.get(desired.parent.as_str()) else {
                return false;
            };
            parent
        };
        if space.parent_workspace_id.as_deref() != Some(expected_parent)
            || space.health.as_ref().map(|health| health.status.as_str()) != Some("healthy")
            || !required_components_present(&space.components, &desired.components)
            || space
                .bootstrap_pack
                .as_ref()
                .map(|identity| identity.digest.as_str())
                != Some(pack.digest.as_str())
        {
            return false;
        }
    }
    true
}

fn required_components_present(
    installed: &[genehub_proto::AgentComponentInfo],
    required: &[ComponentSpec],
) -> bool {
    required.iter().all(|expected| {
        installed.iter().any(|component| {
            component.enabled
                && component.component_id == expected.component_id
                && component.role == expected.role
        })
    })
}

fn receipt_space_bindings(root: &Path, pack_id: &str) -> Vec<(String, String)> {
    let path = root
        .join(".genethub/bootstrap-packs")
        .join(format!("{pack_id}.json"));
    let Some(value) = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    else {
        return Vec::new();
    };
    value
        .get("spaces")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|space| {
            Some((
                space.get("name")?.as_str()?.to_string(),
                space.get("workspaceId")?.as_str()?.to_string(),
            ))
        })
        .collect()
}

fn receipt_commit(root: &Path, pack_id: &str) -> Option<String> {
    let path = root
        .join(".genethub/bootstrap-packs")
        .join(format!("{pack_id}.json"));
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    value
        .get("bootstrapCommit")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn receipt_matches(root: &Path, pack: &LoadedPack) -> bool {
    let path = root
        .join(".genethub/bootstrap-packs")
        .join(format!("{}.json", pack.manifest.id));
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    value.get("packDigest").and_then(serde_json::Value::as_str) == Some(pack.digest.as_str())
        && value
            .get("bootstrapCommit")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|commit| !commit.is_empty())
}

fn validate_commit_paths(paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        bail!("Bootstrap produced no project files to commit");
    }
    for path in paths {
        let allowed = path == "pipespace.json"
            || path == "role.json"
            || path == "AGENTS.md"
            || path.ends_with(".code-workspace")
            || path == ".genethub/.gitignore"
            || path.starts_with(".genethub/workflow/")
            || path.starts_with(".pipebuilder/")
            || path.starts_with(".agents/")
            || path.starts_with(".cursor/")
            || path.starts_with(".codebuddy/")
            || path.starts_with(".claude/")
            || path.starts_with("spaces/");
        if !allowed {
            bail!("Bootstrap refused to stage an undeclared path: {path}");
        }
    }
    Ok(())
}

fn upgrade_file_checkpoint(
    root: &Path,
    rendered: &[RenderedFile],
    pack: &LoadedPack,
) -> Result<BTreeMap<PathBuf, Vec<u8>>> {
    let mut paths = rendered
        .iter()
        .map(|file| PathBuf::from(&file.relative))
        .collect::<BTreeSet<_>>();
    for space in std::iter::once(PathBuf::new()).chain(
        pack.manifest
            .spaces
            .iter()
            .map(|space| PathBuf::from("spaces").join(&space.name)),
    ) {
        let lock = space.join(".pipebuilder/lock.json");
        if let Ok(bytes) = fs::read(root.join(&lock)) {
            let value: serde_json::Value = serde_json::from_slice(&bytes)?;
            for artifact in value
                .get("artifacts")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(target) = artifact.get("target").and_then(serde_json::Value::as_str) {
                    safe_relative(target)?;
                    paths.insert(space.join(target));
                }
            }
            paths.insert(lock);
        }
    }
    paths.insert(PathBuf::from(format!(
        ".genethub/bootstrap-packs/{}.json",
        pack.manifest.id
    )));
    let mut out = BTreeMap::new();
    let mut total = 0;
    for relative in paths {
        let target = root.join(&relative);
        if !target.exists() {
            continue;
        }
        crate::config::reject_link_or_reparse(&target, &fs::symlink_metadata(&target)?)?;
        let bytes = fs::read(&target)?;
        total += bytes.len();
        if total > MAX_PACK_BYTES * 4 {
            bail!("upgrade checkpoint exceeds the bounded Pack transaction");
        }
        out.insert(relative, bytes);
    }
    Ok(out)
}

fn snapshot_paths(root: &Path) -> Result<BTreeSet<PathBuf>> {
    fn visit(root: &Path, current: &Path, found: &mut BTreeSet<PathBuf>) -> Result<()> {
        for entry in fs::read_dir(current)? {
            let entry = entry?;
            let path = entry.path();
            let relative = path.strip_prefix(root)?.to_path_buf();
            if relative == Path::new(".git")
                || relative.starts_with(".git")
                || relative.starts_with(".genethub/sessions")
                || relative.starts_with(".genethub/artifacts")
                || relative.starts_with(".genethub/components")
            {
                continue;
            }
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                bail!(
                    "Bootstrap project tree contains a symbolic link: {}",
                    relative.display()
                );
            }
            found.insert(relative);
            if metadata.is_dir() {
                visit(root, &path, found)?;
            }
        }
        Ok(())
    }
    let mut found = BTreeSet::new();
    visit(root, root, &mut found)?;
    Ok(found)
}

fn rollback_files(root: &Path, before: &BTreeSet<PathBuf>, created_git: bool) -> Result<()> {
    let after = snapshot_paths(root)?;
    let mut created = after.difference(before).cloned().collect::<Vec<_>>();
    created.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for relative in created {
        let path = root.join(&relative);
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_file() {
            fs::remove_file(&path)?;
        } else if metadata.is_dir() && fs::read_dir(&path)?.next().is_none() {
            fs::remove_dir(&path)?;
        }
    }
    if created_git {
        let git = root.join(".git");
        if git.is_dir() {
            fs::remove_dir_all(git)?;
        }
    }
    Ok(())
}

fn save_transaction(
    state: &Shared,
    workspace_id: &str,
    plan_digest: &str,
    status: &str,
    changed: bool,
    rolled_back: bool,
    error: Option<&str>,
) -> Result<()> {
    let path = state
        .paths
        .root
        .join("project-control/transactions")
        .join(format!("{workspace_id}.json"));
    crate::config::save_private(
        &path,
        &serde_json::to_vec_pretty(&serde_json::json!({
            "schema": "genehub.bootstrap-transaction.v1",
            "workspaceId": workspace_id,
            "planDigest": plan_digest,
            "status": status,
            "changed": changed,
            "rolledBack": rolled_back,
            "error": error,
            "updatedAtMs": chrono::Utc::now().timestamp_millis(),
        }))?,
    )
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
        assert_eq!(pack.manifest.spaces.len(), 5);
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

    #[tokio::test]
    async fn every_bootstrap_stage_compensates_to_the_same_empty_project() {
        for stage in [
            "git",
            "assets",
            "project-builder",
            "team-builder",
            "registry",
            "activation",
            "binding",
            "commit",
            "receipt",
        ] {
            let temp = tempfile::tempdir().expect("temporary root");
            let project = temp.path().join("fault-project");
            fs::create_dir(&project).expect("empty project");
            let data = temp.path().join("daemon-data");
            let (state, _pty) = crate::AppState::build(crate::config::Paths::new(&data))
                .await
                .expect("daemon state");
            let workspace = state
                .workspaces
                .open(&project, None)
                .await
                .expect("ordinary Workspace");
            let prepared = prepare(&state, &workspace.id, "game-delivery-v1", "genet", None)
                .await
                .expect("Bootstrap plan");

            let error = apply_inner(&state, prepared, "s_pm", Some(stage))
                .await
                .expect_err("injected stage must fail");
            assert!(
                format!("{error:#}").contains("changes were rolled back"),
                "stage {stage} did not report complete compensation: {error:#}"
            );
            assert!(
                fs::read_dir(&project)
                    .expect("project remains readable")
                    .next()
                    .is_none(),
                "stage {stage} left visible project files: {:?}",
                snapshot_paths(&project).expect("snapshot")
            );
            assert_eq!(
                state
                    .workspaces
                    .agent_space(&workspace.id)
                    .await
                    .expect("registration")
                    .revision,
                0,
                "stage {stage} published a partial AgentSpace tree"
            );
            assert!(
                !state.project_control.is_bound(&workspace.id, "s_pm"),
                "stage {stage} retained project authority"
            );
            assert!(
                !data.join("workflow-runtime").join(&workspace.id).exists(),
                "stage {stage} retained an active DCG runtime"
            );
            let journal: serde_json::Value = serde_json::from_slice(
                &fs::read(
                    data.join("project-control/transactions")
                        .join(format!("{}.json", workspace.id)),
                )
                .expect("failure journal"),
            )
            .expect("journal JSON");
            assert_eq!(journal["status"], "failed");
            assert_eq!(journal["rolledBack"], true);
        }
    }
}
