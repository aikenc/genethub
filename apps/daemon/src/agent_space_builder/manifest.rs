use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use super::diagnostic::{fail, BuilderError, BuilderResult, Diagnostic};
use super::{is_symlink, read_json, tree_digest};

pub const SPACE_SCHEMA: &str = "pipespace.v1";
pub const AGENTS: [&str; 4] = ["codex", "cursor", "codebuddy", "claude-code"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema: String,
    pub name: String,
    #[serde(rename = "description")]
    pub _description: Option<String>,
    pub agents: Vec<String>,
    pub skills: Vec<String>,
    pub tags: Vec<String>,
    pub skill_providers: Vec<ProviderSpec>,
    #[serde(default)]
    pub children: Children,
    #[serde(skip)]
    pub path: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Children {
    #[serde(default = "default_scan_depth")]
    pub scan_depth: u32,
}

impl Default for Children {
    fn default() -> Self {
        Self {
            scan_depth: default_scan_depth(),
        }
    }
}

fn default_scan_depth() -> u32 {
    3
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ProviderSpec {
    #[serde(rename_all = "camelCase")]
    Folder {
        path: String,
        #[serde(default = "dot")]
        subdir: String,
        #[serde(default)]
        command: Option<serde_json::Value>,
        #[serde(default)]
        build: Option<serde_json::Value>,
    },
    #[serde(rename_all = "camelCase")]
    Git {
        #[serde(flatten)]
        _unsupported: serde_json::Map<String, serde_json::Value>,
    },
}

fn dot() -> String {
    ".".to_string()
}

#[derive(Debug, Clone)]
pub struct WorkspaceFolder {
    pub name: String,
    pub path: String,
    pub resolved: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Workspace {
    pub path: PathBuf,
    pub folders: Vec<WorkspaceFolder>,
}

#[derive(Debug, Clone)]
pub struct Provider {
    pub id: String,
    pub root: PathBuf,
    pub configured_path: String,
    pub subdir: String,
    pub priority: usize,
    pub digest: String,
    pub has_command: bool,
    pub has_build: bool,
}

pub fn load_manifest(root: &Path) -> BuilderResult<Manifest> {
    let path = root.join("pipespace.json");
    if is_symlink(&path) {
        return fail(
            Diagnostic::error("PB011", "pipespace.json must not be a symlink")
                .source(path.display().to_string()),
        );
    }
    let raw: serde_json::Value = read_json(&path, "PB001", "manifest")?;
    validate_provider_specs(&raw, &path)?;
    let mut manifest: Manifest = serde_json::from_value(raw).map_err(|error| {
        BuilderError(
            Diagnostic::error("PB001", format!("Invalid manifest JSON: {error}"))
                .source(path.display().to_string()),
        )
    })?;
    manifest.path = path.clone();
    if manifest.schema != SPACE_SCHEMA {
        return fail(
            Diagnostic::error("PB001", format!("manifest.schema must be {SPACE_SCHEMA}"))
                .source(path.display().to_string()),
        );
    }
    if !valid_name(&manifest.name) {
        return fail(
            Diagnostic::error("PB002", "manifest.name must match ^[a-z][a-z0-9-]*$")
                .source(path.display().to_string()),
        );
    }
    if manifest.agents.is_empty() {
        return fail(
            Diagnostic::error("PB001", "manifest.agents must not be empty")
                .source(path.display().to_string()),
        );
    }
    unique_nonempty("agents", &manifest.agents, &path)?;
    if let Some(agent) = manifest
        .agents
        .iter()
        .find(|agent| !AGENTS.contains(&agent.as_str()))
    {
        return fail(
            Diagnostic::error("PB001", format!("Unknown agent: {agent}"))
                .source(path.display().to_string()),
        );
    }
    unique_nonempty("skills", &manifest.skills, &path)?;
    unique_nonempty("tags", &manifest.tags, &path)?;
    if let Some(skill) = manifest.skills.iter().find(|skill| !valid_name(skill)) {
        return fail(
            Diagnostic::error("PB001", format!("Invalid skill name in manifest: {skill}"))
                .source(path.display().to_string()),
        );
    }
    if manifest.children.scan_depth > 32 {
        return fail(
            Diagnostic::error(
                "PB001",
                "manifest.children.scanDepth must be an integer from 0 to 32",
            )
            .source(path.display().to_string()),
        );
    }
    Ok(manifest)
}

fn validate_provider_specs(raw: &serde_json::Value, path: &Path) -> BuilderResult<()> {
    let Some(providers) = raw
        .as_object()
        .and_then(|object| object.get("skillProviders"))
        .and_then(serde_json::Value::as_array)
    else {
        // The typed manifest parser emits the canonical missing/wrong-type
        // diagnostic after this shape-only pass.
        return Ok(());
    };
    for (index, provider) in providers.iter().enumerate() {
        let Some(provider) = provider.as_object() else {
            return fail(
                Diagnostic::error(
                    "PB001",
                    format!("skillProviders[{index}] must be an object with a type"),
                )
                .source(path.display().to_string()),
            );
        };
        let Some(kind) = provider.get("type").and_then(serde_json::Value::as_str) else {
            return fail(
                Diagnostic::error(
                    "PB001",
                    format!("skillProviders[{index}] must be an object with a type"),
                )
                .source(path.display().to_string()),
            );
        };
        let allowed: &[&str] = match kind {
            "folder" => &["type", "path", "subdir", "command", "build"],
            "git" => &["type", "url", "branch", "tag", "subdir", "command", "build"],
            other => {
                return fail(
                    Diagnostic::error("PB006", format!("Unsupported provider type: {other}"))
                        .source(path.display().to_string()),
                );
            }
        };
        if provider.keys().any(|key| !allowed.contains(&key.as_str())) {
            return fail(
                Diagnostic::error(
                    "PB001",
                    format!("skillProviders[{index}] contains unsupported fields"),
                )
                .source(path.display().to_string()),
            );
        }
        if kind == "folder"
            && !provider
                .get("path")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.trim().is_empty() && !Path::new(value).is_absolute())
        {
            return fail(
                Diagnostic::error(
                    "PB001",
                    format!("skillProviders[{index}].path must be a non-empty relative string"),
                )
                .source(path.display().to_string()),
            );
        }
        if kind == "git" {
            let has_selector = usize::from(provider.contains_key("branch"))
                + usize::from(provider.contains_key("tag"));
            if !provider
                .get("url")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
                || has_selector != 1
            {
                return fail(
                    Diagnostic::error(
                        "PB001",
                        format!(
                            "skillProviders[{index}] git requires url and exactly one of branch or tag"
                        ),
                    )
                    .source(path.display().to_string()),
                );
            }
        }
        if let Some(subdir) = provider.get("subdir") {
            let valid = subdir
                .as_str()
                .is_some_and(|value| safe_posix_relative(value, true));
            if !valid {
                return fail(
                    Diagnostic::error(
                        "PB001",
                        format!(
                            "skillProviders[{index}].subdir must be a safe relative POSIX path"
                        ),
                    )
                    .source(path.display().to_string()),
                );
            }
        }
        validate_provider_command(provider.get("command"), index, path)?;
        validate_provider_build(provider.get("build"), index, path)?;
        if provider.contains_key("command") && provider.contains_key("build") {
            return fail(
                Diagnostic::error(
                    "PB001",
                    format!("skillProviders[{index}] cannot declare both command and build"),
                )
                .source(path.display().to_string()),
            );
        }
    }
    Ok(())
}

fn validate_provider_command(
    value: Option<&serde_json::Value>,
    index: usize,
    path: &Path,
) -> BuilderResult<()> {
    let Some(value) = value else { return Ok(()) };
    let Some(command) = value.as_object() else {
        return invalid_provider_field(index, "command accepts cwd and required args", path);
    };
    if !command.contains_key("args")
        || command
            .keys()
            .any(|key| !matches!(key.as_str(), "cwd" | "args"))
        || command.get("cwd").is_some_and(|cwd| {
            !cwd.as_str()
                .is_some_and(|value| safe_posix_relative(value, true))
        })
        || !valid_arguments(command.get("args"))
    {
        return invalid_provider_field(index, "command accepts safe cwd and required args", path);
    }
    Ok(())
}

fn validate_provider_build(
    value: Option<&serde_json::Value>,
    index: usize,
    path: &Path,
) -> BuilderResult<()> {
    let Some(value) = value else { return Ok(()) };
    let Some(build) = value.as_object() else {
        return invalid_provider_field(index, "build accepts exactly args and output", path);
    };
    if build.len() != 2
        || !build.contains_key("args")
        || !valid_arguments(build.get("args"))
        || !build
            .get("output")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| value != "." && safe_posix_relative(value, false))
    {
        return invalid_provider_field(index, "build accepts exactly args and safe output", path);
    }
    Ok(())
}

fn invalid_provider_field<T>(index: usize, message: &str, path: &Path) -> BuilderResult<T> {
    fail(
        Diagnostic::error("PB001", format!("skillProviders[{index}].{message}"))
            .source(path.display().to_string()),
    )
}

fn valid_arguments(value: Option<&serde_json::Value>) -> bool {
    value
        .and_then(serde_json::Value::as_array)
        .is_some_and(|arguments| {
            !arguments.is_empty()
                && arguments.iter().all(|argument| {
                    argument.as_str().is_some_and(|argument| {
                        !argument.is_empty() && !argument.chars().any(char::is_control)
                    })
                })
        })
}

fn safe_posix_relative(value: &str, allow_dot: bool) -> bool {
    !value.trim().is_empty()
        && !Path::new(value).is_absolute()
        && !value.contains('\\')
        && (allow_dot || value != ".")
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != ".." && (allow_dot || part != "."))
}

pub fn load_workspace(
    project_root: &Path,
    root: &Path,
    manifest: &Manifest,
) -> BuilderResult<Workspace> {
    let path = root.join(format!("{}.code-workspace", manifest.name));
    if !path.is_file() || is_symlink(&path) {
        return fail(
            Diagnostic::error("PB003", format!("workspace not found: {}", path.display()))
                .source(path.display().to_string()),
        );
    }
    let raw: serde_json::Value = read_json(&path, "PB004", "workspace")?;
    let folders = raw
        .as_object()
        .and_then(|object| object.get("folders"))
        .and_then(serde_json::Value::as_array)
        .filter(|folders| !folders.is_empty())
        .ok_or_else(|| {
            BuilderError(
                Diagnostic::error("PB004", "workspace.folders must be a non-empty array")
                    .source(path.display().to_string()),
            )
        })?;
    let mut output = Vec::with_capacity(folders.len());
    let mut names = BTreeSet::new();
    let mut resolved_paths = BTreeSet::new();
    for (index, item) in folders.iter().enumerate() {
        let item = item.as_object().ok_or_else(|| {
            BuilderError(
                Diagnostic::error(
                    "PB004",
                    format!("workspace.folders[{index}] must be an object"),
                )
                .source(path.display().to_string()),
            )
        })?;
        let configured = item
            .get("path")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty() && !Path::new(value).is_absolute())
            .ok_or_else(|| {
                BuilderError(
                    Diagnostic::error(
                        "PB004",
                        format!(
                            "workspace.folders[{index}].path must be a non-empty relative path"
                        ),
                    )
                    .source(path.display().to_string()),
                )
            })?;
        let resolved = root.join(configured).canonicalize().map_err(|error| {
            BuilderError(
                Diagnostic::error(
                    "PB004",
                    format!("Workspace folder does not exist: {configured}: {error}"),
                )
                .source(path.display().to_string()),
            )
        })?;
        if !resolved.is_dir() || !resolved.starts_with(project_root) {
            return fail(
                Diagnostic::error(
                    "PB011",
                    format!("Workspace folder escapes the local PM project: {configured}"),
                )
                .source(path.display().to_string()),
            );
        }
        let name = match item.get("name") {
            Some(value) => value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
                .ok_or_else(|| {
                    BuilderError(
                        Diagnostic::error(
                            "PB004",
                            format!("workspace.folders[{index}].name must be non-empty"),
                        )
                        .source(path.display().to_string()),
                    )
                })?,
            None => resolved
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .ok_or_else(|| {
                    BuilderError(Diagnostic::error(
                        "PB004",
                        format!("could not derive workspace folder name: {configured}"),
                    ))
                })?,
        };
        if !names.insert(name.clone()) {
            return fail(
                Diagnostic::error("PB004", format!("Duplicate workspace folder name: {name}"))
                    .source(path.display().to_string()),
            );
        }
        if !resolved_paths.insert(resolved.clone()) {
            return fail(
                Diagnostic::error(
                    "PB004",
                    format!("Duplicate resolved workspace folder path: {configured}"),
                )
                .source(path.display().to_string()),
            );
        }
        output.push(WorkspaceFolder {
            name,
            path: portable_path(configured),
            resolved,
        });
    }
    if output.first().map(|folder| folder.resolved.as_path()) != Some(root) {
        return fail(
            Diagnostic::error(
                "PB004",
                "an Agent Space workspace must declare its own root as the first folder",
            )
            .source(path.display().to_string()),
        );
    }
    Ok(Workspace {
        path,
        folders: output,
    })
}

pub fn load_providers(
    project_root: &Path,
    root: &Path,
    manifest: &Manifest,
) -> BuilderResult<Vec<Provider>> {
    let mut specs: Vec<(bool, ProviderSpec)> = manifest
        .skill_providers
        .iter()
        .cloned()
        .map(|spec| (false, spec))
        .collect();
    let local = root.join(".pipebuilder/skills");
    if local.exists() || is_symlink(&local) {
        specs.insert(
            0,
            (
                true,
                ProviderSpec::Folder {
                    path: ".pipebuilder/skills".into(),
                    subdir: ".".into(),
                    command: None,
                    build: None,
                },
            ),
        );
    }
    let mut providers = Vec::new();
    let mut roots = BTreeSet::new();
    for (priority, (space_local, spec)) in specs.into_iter().enumerate() {
        let ProviderSpec::Folder {
            path,
            subdir,
            command,
            build,
        } = spec
        else {
            return fail(Diagnostic::error(
                "PB006",
                "Git Skill Providers are outside the local-only Agent Space MVP",
            ));
        };
        if path.trim().is_empty() || Path::new(&path).is_absolute() {
            return fail(Diagnostic::error(
                "PB001",
                format!("Folder Provider path must be a non-empty relative path: {path}"),
            ));
        }
        validate_relative_subdir(&subdir)?;
        let source = root.join(&path).canonicalize().map_err(|error| {
            BuilderError(
                Diagnostic::error(
                    "PB005",
                    format!("Skill provider directory not found: {path}: {error}"),
                )
                .source(path.clone()),
            )
        })?;
        let provider_root = source.join(&subdir).canonicalize().map_err(|error| {
            BuilderError(
                Diagnostic::error(
                    "PB005",
                    format!("Skill provider subdirectory not found: {path}/{subdir}: {error}"),
                )
                .source(path.clone()),
            )
        })?;
        if !provider_root.is_dir() || !provider_root.starts_with(project_root) {
            return fail(
                Diagnostic::error(
                    "PB011",
                    format!("Skill Provider escapes the local PM project: {path}"),
                )
                .source(path),
            );
        }
        for generated in [".agents", ".codex", ".cursor", ".codebuddy", ".claude"] {
            let generated = root.join(generated);
            if provider_root == generated || provider_root.starts_with(&generated) {
                return fail(Diagnostic::error(
                    "PB011",
                    "Skill Provider cannot be inside a generated Agent target",
                ));
            }
        }
        if !roots.insert(provider_root.clone()) {
            return fail(Diagnostic::error(
                "PB001",
                "Folder Providers resolve to the same directory",
            ));
        }
        providers.push(Provider {
            id: if space_local {
                "space-local".into()
            } else {
                format!("folder:{path}")
            },
            digest: tree_digest(&provider_root, false)?,
            root: provider_root,
            configured_path: path,
            subdir,
            priority,
            has_command: command.is_some(),
            has_build: build.is_some(),
        });
    }
    Ok(providers)
}

fn unique_nonempty(label: &str, values: &[String], source: &Path) -> BuilderResult<()> {
    let mut unique = BTreeSet::new();
    if values
        .iter()
        .any(|value| value.is_empty() || !unique.insert(value))
    {
        return fail(
            Diagnostic::error(
                "PB001",
                format!("manifest.{label} must contain unique non-empty strings"),
            )
            .source(source.display().to_string()),
        );
    }
    Ok(())
}

pub fn valid_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn validate_relative_subdir(value: &str) -> BuilderResult<()> {
    let path = Path::new(value);
    if value.trim().is_empty()
        || path.is_absolute()
        || value.contains('\\')
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::RootDir))
    {
        return fail(Diagnostic::error(
            "PB001",
            "Provider subdir must be a safe relative POSIX path",
        ));
    }
    Ok(())
}

fn portable_path(value: &str) -> String {
    value.replace('\\', "/")
}
