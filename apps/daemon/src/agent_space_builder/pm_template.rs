use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use super::diagnostic::{BuilderError, BuilderResult, Diagnostic};
use super::{is_symlink, BuildGuard};

pub const PM_SPACE_TEMPLATE_VERSION: &str = "2";
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
        "skills/project-workflow/prompts/integrate.md",
        include_str!("assets/pm-space/skills/project-workflow/prompts/integrate.md"),
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

    fn replacements(&self) -> BTreeMap<&'static str, &str> {
        BTreeMap::from([
            ("GENEHUB_PROJECT_NAME", self.project_name.as_str()),
            ("GENEHUB_PM_SPACE_NAME", PM_SPACE_NAME),
            (
                "GENEHUB_RECOMMENDED_WORKFLOW",
                self.recommended_workflow.as_str(),
            ),
            ("GENEHUB_LOCALE", self.locale.as_str()),
            ("GENEHUB_TEMPLATE_VERSION", PM_SPACE_TEMPLATE_VERSION),
        ])
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmSpaceTemplateReport {
    pub template_version: &'static str,
    pub root: String,
    pub created: Vec<String>,
    pub validated: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct PmSpaceTemplateMarker {
    schema: String,
    version: String,
}

/// Returns whether a PM Space must be bootstrapped without ever rewriting an
/// existing project-owned Workflow. Incompatible templates need an explicit,
/// reviewed migration because those files may contain project customizations.
pub fn pm_space_requires_bootstrap(root: &Path) -> BuilderResult<bool> {
    let marker_path = root.join("template.json");
    if is_symlink(&marker_path) {
        return Err(BuilderError(
            Diagnostic::error("PB011", "PM Space template marker must not be a symlink")
                .source(marker_path.display().to_string()),
        ));
    }
    let bytes = match std::fs::read(&marker_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
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
    if marker.version != PM_SPACE_TEMPLATE_VERSION {
        return Err(BuilderError(
            Diagnostic::error(
                "PB017",
                format!(
                    "PM Space template version {} is incompatible with current version {}; automatic overwrite is refused because the project Workflow may be customized. Preserve the PM Space Git history and migrate its Workflow package explicitly",
                    marker.version, PM_SPACE_TEMPLATE_VERSION
                ),
            )
            .source(marker_path.display().to_string()),
        ));
    }
    Ok(false)
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
        root: root.display().to_string(),
        created,
        validated,
    })
}

fn render_template(
    relative: &str,
    template: &str,
    replacements: &BTreeMap<&str, &str>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_is_idempotent_and_uses_only_bounded_values() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let values = PmSpaceTemplateValues::new("星港防线", "zh-CN", "feature").unwrap();

        let first = render_pm_space(&project, &values).unwrap();
        assert_eq!(first.template_version, "2");
        assert_eq!(first.created.len(), TEMPLATE_FILES.len());
        assert!(first.validated.is_empty());
        let repeated = render_pm_space(&project, &values).unwrap();
        assert!(repeated.created.is_empty());
        assert_eq!(repeated.validated.len(), TEMPLATE_FILES.len());

        let root = project.join("spaces/pm");
        assert!(!pm_space_requires_bootstrap(&root).unwrap());
        let marker: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("template.json")).unwrap()).unwrap();
        assert_eq!(marker["version"], "2");
        let manifest = std::fs::read_to_string(root.join("pipespace.json")).unwrap();
        assert!(manifest.contains("星港防线"));
        assert!(!manifest.contains("{{GENEHUB_"));
        assert!(root
            .join("skills/project-workflow/dcg/feature.yaml")
            .is_file());
        let workflow_skill =
            std::fs::read_to_string(root.join("skills/project-workflow/SKILL.md")).unwrap();
        assert!(workflow_skill.contains("不要重复当前节点的 `space.matchTags`"));
        assert!(workflow_skill.contains("只有包级能力会固化为"));
        let diagnose_prompt =
            std::fs::read_to_string(root.join("skills/project-workflow/prompts/diagnose.md"))
                .unwrap();
        assert!(diagnose_prompt.contains("第一次结论也必须返回 worktree 的精确 HEAD commit/tree"));
    }

    #[test]
    fn template_rejects_path_values_and_existing_drift() {
        assert!(PmSpaceTemplateValues::new("../project", "zh-CN", "feature").is_err());
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let values = PmSpaceTemplateValues::new("project", "zh-CN", "feature").unwrap();
        render_pm_space(&project, &values).unwrap();
        std::fs::write(project.join("spaces/pm/role.json"), "drift\n").unwrap();
        let error = render_pm_space(&project, &values).unwrap_err();
        assert_eq!(error.0.code, "PB017");
    }

    #[test]
    fn incompatible_template_requires_explicit_migration() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("spaces/pm");
        std::fs::create_dir_all(&root).unwrap();
        assert!(pm_space_requires_bootstrap(&root).unwrap());
        std::fs::write(
            root.join("template.json"),
            r#"{"schema":"genehub-pm-space-template.v1","version":"1"}"#,
        )
        .unwrap();
        let error = pm_space_requires_bootstrap(&root).unwrap_err();
        assert_eq!(error.0.code, "PB017");
        assert!(error.0.message.contains("automatic overwrite is refused"));
    }
}
