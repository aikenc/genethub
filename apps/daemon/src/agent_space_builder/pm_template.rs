use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::diagnostic::{BuilderError, BuilderResult, Diagnostic};
use super::{is_symlink, BuildGuard};

pub const PM_SPACE_TEMPLATE_VERSION: &str = "3";
pub const PM_SPACE_NAME: &str = "pm";
const PM_SPACE_TEMPLATE_SCHEMA: &str = "genehub-pm-space-template.v1";

const TEMPLATE_FILES: &[(&str, &str)] = &[
    (
        "pipespace.json",
        include_str!("assets/pm-space/pipespace.json"),
    ),
    (
        "pm.code-workspace",
        include_str!("assets/pm-space/pm.code-workspace"),
    ),
    ("role.json", include_str!("assets/pm-space/role.json")),
    (
        "skills/project-workflow/SKILL.md",
        include_str!("assets/pm-space/skills/project-workflow/SKILL.md"),
    ),
    (
        "skills/project-workflow/catalog.yaml",
        include_str!("assets/pm-space/skills/project-workflow/catalog.yaml"),
    ),
    (
        "skills/project-workflow/dcg/feature.yaml",
        include_str!("assets/pm-space/skills/project-workflow/dcg/feature.yaml"),
    ),
    (
        "skills/project-workflow/dcg/bugfix.yaml",
        include_str!("assets/pm-space/skills/project-workflow/dcg/bugfix.yaml"),
    ),
    (
        "skills/project-workflow/dcg/migration.yaml",
        include_str!("assets/pm-space/skills/project-workflow/dcg/migration.yaml"),
    ),
    (
        "skills/project-workflow/prompts/intake.md",
        include_str!("assets/pm-space/skills/project-workflow/prompts/intake.md"),
    ),
    (
        "skills/project-workflow/prompts/plan.md",
        include_str!("assets/pm-space/skills/project-workflow/prompts/plan.md"),
    ),
    (
        "skills/project-workflow/prompts/implement.md",
        include_str!("assets/pm-space/skills/project-workflow/prompts/implement.md"),
    ),
    (
        "skills/project-workflow/prompts/diagnose.md",
        include_str!("assets/pm-space/skills/project-workflow/prompts/diagnose.md"),
    ),
    (
        "skills/project-workflow/prompts/review.md",
        include_str!("assets/pm-space/skills/project-workflow/prompts/review.md"),
    ),
    (
        "skills/project-workflow/prompts/triage-review.md",
        include_str!("assets/pm-space/skills/project-workflow/prompts/triage-review.md"),
    ),
    (
        "skills/project-workflow/prompts/repair-space.md",
        include_str!("assets/pm-space/skills/project-workflow/prompts/repair-space.md"),
    ),
    (
        "skills/project-workflow/evaluations/smoke.yaml",
        include_str!("assets/pm-space/skills/project-workflow/evaluations/smoke.yaml"),
    ),
    (
        "template.json",
        include_str!("assets/pm-space/template.json"),
    ),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PmSpaceTemplateValues {
    pub project_name: String,
    pub locale: String,
    pub recommended_workflow: String,
}

impl PmSpaceTemplateValues {
    pub fn new(
        project_name: impl Into<String>,
        locale: impl Into<String>,
        recommended_workflow: impl Into<String>,
    ) -> BuilderResult<Self> {
        let values = Self {
            project_name: project_name.into(),
            locale: locale.into(),
            recommended_workflow: recommended_workflow.into(),
        };
        values.validate()?;
        Ok(values)
    }

    fn validate(&self) -> BuilderResult<()> {
        validate_value("GENEHUB_PROJECT_NAME", &self.project_name, 120, true)?;
        validate_value("GENEHUB_LOCALE", &self.locale, 32, false)?;
        validate_value(
            "GENEHUB_RECOMMENDED_WORKFLOW",
            &self.recommended_workflow,
            64,
            false,
        )?;
        Ok(())
    }

    fn replacements(&self) -> BTreeMap<&'static str, String> {
        BTreeMap::from([
            ("GENEHUB_PROJECT_NAME", self.project_name.clone()),
            ("GENEHUB_PM_SPACE_NAME", PM_SPACE_NAME.to_string()),
            (
                "GENEHUB_RECOMMENDED_WORKFLOW",
                self.recommended_workflow.clone(),
            ),
            ("GENEHUB_LOCALE", self.locale.clone()),
            (
                "GENEHUB_TEMPLATE_VERSION",
                PM_SPACE_TEMPLATE_VERSION.to_string(),
            ),
            ("GENEHUB_TEMPLATE_DIGEST", pm_space_template_digest()),
        ])
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmSpaceTemplateReport {
    pub template_version: &'static str,
    pub template_digest: String,
    pub root: String,
    pub created: Vec<String>,
    pub validated: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmSpaceTemplateStatus {
    pub installed_version: String,
    pub installed_digest: String,
    pub available_version: &'static str,
    pub available_digest: String,
    pub upgrade_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmSpaceTemplateCandidateReport {
    pub id: String,
    pub target: &'static str,
    pub root: String,
    pub template_version: &'static str,
    pub template_digest: String,
    pub files: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PmSpaceTemplateMarker {
    schema: String,
    version: String,
    #[serde(default)]
    content_digest: String,
}

pub fn pm_space_template_digest() -> String {
    let mut digest = Sha256::new();
    for (relative, template) in TEMPLATE_FILES {
        if *relative == "template.json" {
            continue;
        }
        digest.update((relative.len() as u64).to_le_bytes());
        digest.update(relative.as_bytes());
        digest.update((template.len() as u64).to_le_bytes());
        digest.update(template.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

pub fn pm_space_template_paths() -> Vec<&'static str> {
    TEMPLATE_FILES
        .iter()
        .map(|(relative, _)| *relative)
        .collect()
}

/// Reads the scaffold baseline without treating it as the identity of the
/// active project-owned Workflow. A project may legitimately customize its
/// graph and prompts after bootstrap; an available template update is an
/// explicit migration opportunity, never a reason to make that project
/// unopenable.
pub fn pm_space_template_status(root: &Path) -> BuilderResult<Option<PmSpaceTemplateStatus>> {
    let marker_path = root.join("template.json");
    if is_symlink(&marker_path) {
        return Err(BuilderError(
            Diagnostic::error("PB011", "PM Space template marker must not be a symlink")
                .source(marker_path.display().to_string()),
        ));
    }
    let bytes = match std::fs::read(&marker_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    let marker: PmSpaceTemplateMarker = serde_json::from_slice(&bytes).map_err(|error| {
        BuilderError(
            Diagnostic::error(
                "PB001",
                format!("PM Space template marker is invalid JSON: {error}"),
            )
            .source(marker_path.display().to_string()),
        )
    })?;
    if marker.schema != PM_SPACE_TEMPLATE_SCHEMA {
        return Err(BuilderError(
            Diagnostic::error(
                "PB001",
                format!("unsupported PM Space template schema: {}", marker.schema),
            )
            .source(marker_path.display().to_string()),
        ));
    }
    let available_digest = pm_space_template_digest();
    let upgrade_available =
        marker.version != PM_SPACE_TEMPLATE_VERSION || marker.content_digest != available_digest;
    Ok(Some(PmSpaceTemplateStatus {
        installed_version: marker.version,
        installed_digest: marker.content_digest,
        available_version: PM_SPACE_TEMPLATE_VERSION,
        available_digest,
        upgrade_available,
    }))
}

/// Returns whether a PM Space must be bootstrapped without ever rewriting an
/// existing project-owned Workflow. Incompatible templates need an explicit,
/// reviewed migration because those files may contain project customizations.
pub fn pm_space_requires_bootstrap(root: &Path) -> BuilderResult<bool> {
    Ok(pm_space_template_status(root)?.is_none())
}

/// Materializes the current built-in PM scaffold as an inert, reviewable
/// bundle. Nothing active is overwritten here. The project may merge its own
/// Workflow customizations into the candidate before proposing `target=bundle`.
pub fn render_pm_space_template_candidate(
    project_root: &Path,
    id: &str,
) -> BuilderResult<PmSpaceTemplateCandidateReport> {
    validate_candidate_id(id)?;
    let project_root = project_root.canonicalize().map_err(io_error)?;
    let pm_root = project_root.join("spaces/pm");
    if !pm_root.is_dir() || is_symlink(&pm_root) {
        return Err(BuilderError(
            Diagnostic::error("PB011", "PM Space root must be a real directory")
                .source(pm_root.display().to_string()),
        ));
    }
    let values = existing_template_values(&project_root, &pm_root)?;
    let candidate_root = pm_root
        // Candidate bundles are project-owned governance evidence, not active
        // Skill Provider input. Keeping them below project-workflow/ makes the
        // Builder recursively project an inert bundle into `.agents/`, where
        // workspace files can collide with the Builder's own output boundary.
        .join("workflow-candidates")
        .join(id)
        .join("bundle");
    if candidate_root.exists() || is_symlink(&candidate_root) {
        return Err(BuilderError(
            Diagnostic::error(
                "PB017",
                "同名模板迁移候选已存在；请换用新的候选 ID，系统不会覆盖待评审内容",
            )
            .source(candidate_root.display().to_string()),
        ));
    }
    let _guard = BuildGuard::acquire(&pm_root)?;
    let replacements = values.replacements();
    let mut files = Vec::new();
    for (relative, template) in TEMPLATE_FILES {
        validate_relative_path(relative)?;
        let target = candidate_root.join(relative);
        let parent = target.parent().ok_or_else(|| {
            BuilderError(Diagnostic::error(
                "PB011",
                "template candidate target has no parent",
            ))
        })?;
        std::fs::create_dir_all(parent).map_err(io_error)?;
        let body = render_template(relative, template, &replacements)?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(io_error)?;
        file.write_all(body.as_bytes()).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        files.push((*relative).to_string());
    }
    Ok(PmSpaceTemplateCandidateReport {
        id: id.to_string(),
        target: "bundle",
        root: candidate_root.display().to_string(),
        template_version: PM_SPACE_TEMPLATE_VERSION,
        template_digest: pm_space_template_digest(),
        files,
    })
}

fn existing_template_values(
    project_root: &Path,
    pm_root: &Path,
) -> BuilderResult<PmSpaceTemplateValues> {
    let project_name = project_root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("GeneHub Project")
        .to_string();
    let role: serde_json::Value =
        serde_json::from_slice(&std::fs::read(pm_root.join("role.json")).map_err(io_error)?)
            .map_err(|error| {
                BuilderError(Diagnostic::error(
                    "PB001",
                    format!("PM Space role.json is invalid: {error}"),
                ))
            })?;
    let locale = role
        .get("locale")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("zh-CN")
        .to_string();
    let catalog: serde_yaml::Value = serde_yaml::from_slice(
        &std::fs::read(pm_root.join("skills/project-workflow/catalog.yaml")).map_err(io_error)?,
    )
    .map_err(|error| {
        BuilderError(Diagnostic::error(
            "PB001",
            format!("PM Workflow catalog is invalid: {error}"),
        ))
    })?;
    let recommended = catalog
        .get("recommendedSessionWorkflow")
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or("feature")
        .to_string();
    PmSpaceTemplateValues::new(project_name, locale, recommended)
}

fn validate_candidate_id(id: &str) -> BuilderResult<()> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && !id.ends_with('-')
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err(BuilderError(Diagnostic::error(
            "PB001",
            "模板迁移候选 ID 必须是 1–64 位 kebab-case",
        )))
    }
}

pub fn render_pm_space(
    project_root: &Path,
    values: &PmSpaceTemplateValues,
) -> BuilderResult<PmSpaceTemplateReport> {
    values.validate()?;
    let project_root = project_root.canonicalize().map_err(|error| {
        BuilderError(Diagnostic::error(
            "PB011",
            format!("PM project root is unavailable: {error}"),
        ))
    })?;
    let spaces = project_root.join("spaces");
    std::fs::create_dir_all(&spaces).map_err(io_error)?;
    let spaces = spaces.canonicalize().map_err(io_error)?;
    let root = spaces.join(PM_SPACE_NAME);
    if is_symlink(&root) || (root.exists() && !root.is_dir()) {
        return Err(BuilderError(
            Diagnostic::error("PB011", "PM Space root must be a real directory")
                .source(root.display().to_string()),
        ));
    }
    std::fs::create_dir_all(&root).map_err(io_error)?;
    let root = root.canonicalize().map_err(io_error)?;
    if root.parent() != Some(spaces.as_path()) {
        return Err(BuilderError(
            Diagnostic::error("PB011", "PM Space root escaped project spaces/")
                .source(root.display().to_string()),
        ));
    }

    let _guard = BuildGuard::acquire(&root)?;
    let replacements = values.replacements();
    let mut created = Vec::new();
    let mut validated = Vec::new();
    for (relative, template) in TEMPLATE_FILES {
        validate_relative_path(relative)?;
        let body = render_template(relative, template, &replacements)?;
        let target = root.join(relative);
        if is_symlink(&target) {
            return Err(BuilderError(
                Diagnostic::error("PB011", "PM Space template target must not be a symlink")
                    .source(target.display().to_string()),
            ));
        }
        match std::fs::read(&target) {
            Ok(existing) if existing == body.as_bytes() => {
                validated.push((*relative).to_string());
            }
            Ok(_) => {
                return Err(BuilderError(
                    Diagnostic::error(
                        "PB017",
                        "existing PM Space source differs from the selected template",
                    )
                    .source(target.display().to_string()),
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let parent = target.parent().ok_or_else(|| {
                    BuilderError(Diagnostic::error("PB011", "template target has no parent"))
                })?;
                std::fs::create_dir_all(parent).map_err(io_error)?;
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .map_err(io_error)?;
                file.write_all(body.as_bytes()).map_err(io_error)?;
                file.sync_all().map_err(io_error)?;
                created.push((*relative).to_string());
            }
            Err(error) => return Err(io_error(error)),
        }
    }

    Ok(PmSpaceTemplateReport {
        template_version: PM_SPACE_TEMPLATE_VERSION,
        template_digest: pm_space_template_digest(),
        root: root.display().to_string(),
        created,
        validated,
    })
}

fn render_template(
    relative: &str,
    template: &str,
    replacements: &BTreeMap<&str, String>,
) -> BuilderResult<String> {
    let mut rendered = template.to_string();
    for (name, value) in replacements {
        rendered = rendered.replace(&format!("{{{{{name}}}}}"), value);
    }
    if rendered.contains("{{GENEHUB_") {
        return Err(BuilderError(
            Diagnostic::error("PB001", "PM Space template contains an unknown variable")
                .source(relative.to_string()),
        ));
    }
    Ok(rendered)
}

fn validate_value(name: &str, value: &str, max: usize, allow_spaces: bool) -> BuilderResult<()> {
    let valid = !value.trim().is_empty()
        && value.len() <= max
        && !value.chars().any(char::is_control)
        && !value.contains(['/', '\\'])
        && value.chars().all(|character| {
            character.is_alphanumeric()
                || matches!(character, '-' | '_' | '.')
                || (allow_spaces && character.is_whitespace())
        });
    if valid {
        Ok(())
    } else {
        Err(BuilderError(Diagnostic::error(
            "PB001",
            format!("invalid PM Space template value for {name}"),
        )))
    }
}

fn validate_relative_path(relative: &str) -> BuilderResult<()> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(BuilderError(Diagnostic::error(
            "PB011",
            "PM Space template target escaped its Space",
        )));
    }
    Ok(())
}

fn io_error(error: std::io::Error) -> BuilderError {
    BuilderError(Diagnostic::error("PB001", format!("I/O error: {error}")))
}
