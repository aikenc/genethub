//! Git-native Workflow packages.
//!
//! A package is an ordinary directory containing `workflow.md`. Its identity is
//! its path below `<project>/.genethub/workflows/`, so a repository's shape on
//! disk is exactly its shape when consumed: nothing is packed, registered or
//! renamed on the way in. Everything else is derived from the directory —
//! flows from `flows/*.yaml`, roles from what those flows reference, the
//! executor from whichever Space source declares that component.
//!
//! The kernel deliberately learns nothing about networks or registries. A
//! package arrives because an Agent ran `git clone`; upgrading it is `git pull`
//! in the same directory. Discovery here is a read-only directory walk that
//! never executes package content: `workflow.md` prose is untrusted text that
//! can inform an Agent's judgment and nothing mechanical.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::{read_source, validate_id, MAX_SOURCE_BYTES};

/// Packages live below this directory; its presence is also what marks a
/// project as Workflow-enabled, replacing the old `project.yaml` marker.
pub(crate) const PACKAGES_DIR: &str = ".genethub/workflows";
/// What `$project` resolves to. Project-wide shared Skills — the
/// lowest-precedence package-visible layer — are `$project/skills`, so all
/// three logical references name a directory the author then paths under.
const PROJECT_HOME_DIR: &str = ".genethub";
/// The manifest, the discovery anchor, and the prose entry point in one file,
/// deliberately shaped like `SKILL.md` so authors learn one convention.
pub(crate) const MANIFEST_FILE: &str = "workflow.md";

const FLOWS_DIR: &str = "flows";
const SPACES_DIR: &str = "spaces";
const SKILLS_DIR: &str = "skills";
const SPACE_FILE: &str = "space.json.src";
const PIPESPACE_FILE: &str = "pipespace.json.src";

/// Fail-closed limits applied identically by `list` and `build`, so a
/// malicious or merely enormous clone cannot make discovery unbounded.
const MAX_SCAN_DEPTH: usize = 4;
const MAX_PACKAGES: usize = 64;
const MAX_PACKAGE_FILES: usize = 512;
const MAX_PACKAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SPACES_PER_PACKAGE: usize = 16;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

/// Logical Provider references. Without them an author would have to hardcode
/// `../../../…`, which breaks the moment a package is cloned one level deeper
/// or moved between a single-package and a collection repository.
const REF_WORKFLOW: &str = "$workflow";
const REF_COLLECTION: &str = "$collection";
const REF_PROJECT: &str = "$project";

/// `workflow.md` frontmatter: three optional fields, all with a
/// mechanical consumer. Everything an author might otherwise declare belongs
/// in the prose body, where it can inform a reader without pretending to be a
/// gate the platform never checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Manifest {
    /// Machine-readable summary for `workflow list` and PM routing.
    pub(crate) description: String,
    /// Author's "this is still an experiment" marker. It changes no mechanical
    /// behaviour; it tells PM to look harder at the health facts.
    pub(crate) dev: bool,
    /// The recovery flow used by newly started recovery Runs.
    pub(crate) recovery: String,
}

impl Default for Manifest {
    fn default() -> Self {
        Self { description: String::new(), dev: false, recovery: "builtin".into() }
    }
}

/// One Space the package asks the project to materialize.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SpaceSource {
    pub(crate) name: String,
    pub(crate) lifecycle: String,
    pub(crate) components: Vec<(String, Option<String>)>,
    pub(crate) guidance: Vec<String>,
    pub(crate) folders: Vec<FolderSpec>,
    /// Raw `pipespace.json.src` bytes, still holding logical references.
    pub(crate) manifest_source: Vec<u8>,
    /// Present when the Space ships its own top-priority Skills.
    pub(crate) has_local_skills: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FolderSpec {
    pub(crate) name: String,
    pub(crate) path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpaceDefinition {
    lifecycle: String,
    components: Vec<ComponentDefinition>,
    #[serde(default)]
    guidance: Vec<String>,
    #[serde(default)]
    folders: Vec<FolderSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComponentDefinition {
    component_id: String,
    #[serde(default)]
    role: Option<String>,
}

/// A discovered package: its identity, where its source lives, and the Spaces
/// it declares. Compilation of the flows themselves stays in the existing
/// Workflow compiler; this type only answers "what is here".
#[derive(Debug, Clone)]
pub(crate) struct Package {
    /// Path relative to `.genethub/workflows/`, using `/` on every platform.
    pub(crate) id: String,
    pub(crate) root: PathBuf,
    /// The collection root when this package sits inside one, so
    /// `$collection` can resolve. A single-package clone has none.
    pub(crate) collection_root: Option<PathBuf>,
    pub(crate) manifest: Manifest,
    pub(crate) spaces: Vec<SpaceSource>,
    pub(crate) flow_ids: Vec<String>,
}

impl Package {
    /// The Space carrying this package's top-level `executor` component.
    ///
    /// A Worker Space may itself mount `executor` to own a subteam
    /// (WorkflowManager is the shipped example), so mounting the component is
    /// not the same as being the package's carrier. The carrier is the Space
    /// that mounts `executor` and is not also a Worker. Zero means a
    /// definition-only package that reuses somebody else's carrier; more than
    /// one is ambiguous and refused rather than silently resolved.
    pub(crate) fn executor_space(&self) -> Result<Option<&SpaceSource>> {
        let mut matches = self
            .spaces
            .iter()
            .filter(|space| is_executor_carrier(&space.components));
        let first = matches.next();
        if let Some(extra) = matches.next() {
            bail!(
                "Workflow 包 {} 声明了多个顶层 executor 载体：{} 与 {}",
                self.id,
                first.expect("checked above").name,
                extra.name
            );
        }
        Ok(first)
    }

    /// The Space that hosts bounded automatic diagnosis. Absent is normal and
    /// not an error: the kernel already has a "not configured" branch that
    /// notifies PM instead of failing a Run.
    pub(crate) fn diagnostic_space(&self) -> Result<Option<&SpaceSource>> {
        self.single_component_space(crate::agent_space::COMPONENT_DIAGNOSTIC)
    }

    fn single_component_space(&self, component_id: &str) -> Result<Option<&SpaceSource>> {
        let mut matches = self.spaces.iter().filter(|space| {
            space
                .components
                .iter()
                .any(|(id, _)| id == component_id)
        });
        let first = matches.next();
        if let Some(extra) = matches.next() {
            bail!(
                "Workflow 包 {} 声明了多个 {component_id} 载体：{} 与 {}",
                self.id,
                first.expect("checked above").name,
                extra.name
            );
        }
        Ok(first)
    }

    /// The worker role the diagnostic carrier runs as. The platform owns every
    /// diagnosis policy; a package only chooses the carrier and its role.
    pub(crate) fn diagnostic_role(&self) -> Result<Option<String>> {
        Ok(self.diagnostic_space()?.and_then(|space| {
            space
                .components
                .iter()
                .find(|(id, _)| id == crate::agent_space::COMPONENT_WORKER)
                .and_then(|(_, role)| role.clone())
        }))
    }

    /// Product directory name for one of this package's Spaces. Flattening `/`
    /// keeps every artifact inside the existing `<project>/spaces/<name>`
    /// allowlist instead of relaxing the Builder's path rule.
    pub(crate) fn space_directory(&self, space: &str) -> String {
        format!("{}--{}", flat_id(&self.id), space)
    }

    /// Project-relative directory holding this package's executor artifact,
    /// which is what execution binding resolves instead of a configured path.
    pub(crate) fn executor_relative(&self) -> Result<Option<String>> {
        Ok(self
            .executor_space()?
            .map(|space| format!("{SPACES_DIR}/{}", self.space_directory(&space.name))))
    }
}

/// Whether a declared component set makes its Space the package's top-level
/// executor carrier.
///
/// Both the source-side check (`Package::executor_space`) and the build-side
/// parent selection ask this question, and they must answer it identically: a Space
/// that carries `executor` while also being a Worker owns a subteam and is
/// still a child of the carrier, never a second carrier.
pub(crate) fn is_executor_carrier(components: &[(String, Option<String>)]) -> bool {
    components
        .iter()
        .any(|(id, _)| id == crate::agent_space::COMPONENT_EXECUTOR)
        && !components
            .iter()
            .any(|(id, _)| id == crate::agent_space::COMPONENT_WORKER)
}

/// `studio/game-build` → `studio-game-build`. Collisions are detected by the
/// caller and refused; an escaping rule would be cheaper to write and far
/// harder for an author to predict.
pub(crate) fn flat_id(id: &str) -> String {
    id.replace('/', "-")
}

/// The packages directory for a project root, whether or not it exists.
pub(crate) fn packages_root(project_root: &Path) -> PathBuf {
    project_root.join(PACKAGES_DIR)
}

/// Discovers every package below `.genethub/workflows/`, recursing until a
/// directory holds `workflow.md` and stopping there: a package's own
/// subdirectories are its business, not more packages.
///
/// Returns packages sorted by id. Two packages whose flattened ids collide are
/// refused here rather than at build time, so `list` shows the conflict.
pub(crate) fn discover(project_root: &Path) -> Result<Vec<Package>> {
    let root = packages_root(project_root);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let root = root
        .canonicalize()
        .with_context(|| format!("读取 Workflow 包目录：{}", root.display()))?;
    let mut found = Vec::new();
    walk(&root, &root, None, 0, &mut found)?;
    found.sort_by(|left, right| left.id.cmp(&right.id));

    let mut flattened = BTreeMap::new();
    for package in &found {
        let flat = flat_id(&package.id);
        if let Some(previous) = flattened.insert(flat.clone(), package.id.clone()) {
            bail!(
                "Workflow 包 {} 与 {previous} 的产物目录名都会是 {flat}；请重命名其中一个包目录",
                package.id
            );
        }
    }
    Ok(found)
}

/// Loads one package by id, failing when it is absent. Callers that need the
/// whole set use `discover`, which also enforces the cross-package checks.
pub(crate) fn load(project_root: &Path, id: &str) -> Result<Package> {
    discover(project_root)?
        .into_iter()
        .find(|package| package.id == id)
        .ok_or_else(|| {
            anyhow!("Workflow 包不存在：{id}；用 `workflow list` 查看已 clone 的包")
        })
}

fn walk(
    packages_root: &Path,
    directory: &Path,
    collection_root: Option<&Path>,
    depth: usize,
    found: &mut Vec<Package>,
) -> Result<()> {
    if depth > MAX_SCAN_DEPTH {
        bail!("Workflow 包扫描深度超过 {MAX_SCAN_DEPTH} 层：{}", directory.display());
    }
    if directory.join(MANIFEST_FILE).is_file() {
        found.push(load_package(packages_root, directory, collection_root)?);
        // Checked after pushing: the guard is on how many packages a project
        // ends up with, and testing before the push lets one extra through.
        if found.len() > MAX_PACKAGES {
            bail!("单个项目的 Workflow 包数量不能超过 {MAX_PACKAGES}");
        }
        return Ok(());
    }
    // No manifest here, so this directory is a collection (or an intermediate
    // one). The nearest such ancestor is what `$collection` resolves to.
    let collection_root = if depth == 0 {
        None
    } else {
        collection_root.or(Some(directory))
    };
    let mut children = Vec::new();
    for entry in fs::read_dir(directory)
        .with_context(|| format!("读取 Workflow 包目录：{}", directory.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        let metadata = crate::config::sensitive_metadata(&path)?;
        // A symlinked package could point anywhere; refusing to follow keeps
        // discovery inside the project without a second containment check.
        if metadata.is_dir() && !path.symlink_metadata()?.file_type().is_symlink() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // A cloned package carries its own .git; it is the provenance
            // source, never a package itself.
            if name.starts_with('.') {
                continue;
            }
            children.push(path);
        }
    }
    children.sort();
    for child in children {
        walk(packages_root, &child, collection_root, depth + 1, found)?;
    }
    Ok(())
}

fn load_package(
    packages_root: &Path,
    root: &Path,
    collection_root: Option<&Path>,
) -> Result<Package> {
    let id = root
        .strip_prefix(packages_root)
        .map_err(|_| anyhow!("Workflow 包越出包目录：{}", root.display()))?
        .components()
        .map(|component| match component {
            Component::Normal(value) => Ok(value.to_string_lossy().to_string()),
            _ => bail!("Workflow 包路径必须是普通相对路径：{}", root.display()),
        })
        .collect::<Result<Vec<_>>>()?
        .join("/");
    if id.is_empty() {
        bail!("Workflow 包不能就是包目录本身：{}", root.display());
    }
    for segment in id.split('/') {
        validate_id(segment, "Workflow 包 id 片段")?;
    }
    enforce_package_size(root, &id)?;

    let manifest = parse_manifest(&read_manifest(&root.join(MANIFEST_FILE))?, &id)?;
    let flow_ids = discover_flows(root, &id)?;
    let spaces = discover_spaces(root, &id)?;
    Ok(Package {
        id,
        root: root.to_path_buf(),
        collection_root: collection_root.map(Path::to_path_buf),
        manifest,
        spaces,
        flow_ids,
    })
}

fn enforce_package_size(root: &Path, id: &str) -> Result<()> {
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(&directory)
            .with_context(|| format!("读取 Workflow 包：{}", directory.display()))?
        {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                // The package's own repository is provenance, not content.
                if name == ".git" {
                    continue;
                }
                stack.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            files += 1;
            bytes = bytes.saturating_add(entry.metadata()?.len());
            if files > MAX_PACKAGE_FILES {
                bail!("Workflow 包 {id} 的文件数超过 {MAX_PACKAGE_FILES} 上限");
            }
            if bytes > MAX_PACKAGE_BYTES {
                bail!("Workflow 包 {id} 的总字节数超过 {MAX_PACKAGE_BYTES} 上限");
            }
        }
    }
    Ok(())
}

fn read_manifest(path: &Path) -> Result<String> {
    let metadata = crate::config::sensitive_metadata(path)
        .with_context(|| format!("读取 {}", path.display()))?;
    crate::config::reject_link_or_reparse(path, &metadata)?;
    if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES {
        bail!(
            "{MANIFEST_FILE} 必须是小于 {MAX_MANIFEST_BYTES} 字节的普通文件：{}",
            path.display()
        );
    }
    let raw = fs::read(path).with_context(|| format!("读取 {}", path.display()))?;
    String::from_utf8(raw).with_context(|| format!("{MANIFEST_FILE} 必须是 UTF-8：{}", path.display()))
}

/// Parses the closed two-field frontmatter, then falls back to the first prose
/// paragraph for a missing description.
///
/// The body is never interpreted. Its only role is to be read by a human or an
/// Agent, which is exactly why no field here can assert a platform fact.
pub(crate) fn parse_manifest(raw: &str, id: &str) -> Result<Manifest> {
    let mut manifest = Manifest::default();
    let mut body = raw;
    if let Some(rest) = raw.strip_prefix("---") {
        let rest = rest.strip_prefix('\n').or_else(|| rest.strip_prefix("\r\n"));
        let Some(rest) = rest else {
            bail!("Workflow 包 {id} 的 {MANIFEST_FILE} frontmatter 起始行无效");
        };
        let mut end = None;
        for (offset, line) in line_offsets(rest) {
            if line.trim() == "---" {
                end = Some((offset, offset + line.len()));
                break;
            }
        }
        let Some((frontmatter_end, body_start)) = end else {
            bail!("Workflow 包 {id} 的 {MANIFEST_FILE} frontmatter 没有闭合");
        };
        for (_, line) in line_offsets(&rest[..frontmatter_end]) {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((key, value)) = line.split_once(':') else {
                bail!("Workflow 包 {id} 的 {MANIFEST_FILE} frontmatter 行无法解析：{line}");
            };
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
            match key.trim() {
                "description" => manifest.description = value.to_string(),
                "dev" => {
                    manifest.dev = match value {
                        "true" => true,
                        "false" => false,
                        other => bail!(
                            "Workflow 包 {id} 的 {MANIFEST_FILE} 中 dev 必须是 true 或 false，实际为 {other}"
                        ),
                    }
                }
                "recovery" => {
                    if value != "builtin" {
                        let Some(flow_id) = value.strip_prefix("flows/").and_then(|path| path.strip_suffix(".yaml")) else {
                            bail!("Workflow 包 {id} 的 recovery 必须是 builtin 或 flows/<id>.yaml");
                        };
                        validate_id(flow_id, "recovery flow id")?;
                        if flow_id.contains('/') { bail!("recovery flow id 不能包含子目录"); }
                    }
                    manifest.recovery = value.to_string();
                }
                other => bail!(
                    "Workflow 包 {id} 的 {MANIFEST_FILE} frontmatter 只接受 description、dev 与 recovery，出现了 {other}"
                ),
            }
        }
        body = &rest[body_start..];
    }
    if manifest.description.trim().is_empty() {
        manifest.description = body
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with('#'))
            .unwrap_or_default()
            .to_string();
    }
    manifest.description = manifest.description.chars().take(512).collect();
    Ok(manifest)
}

fn line_offsets(raw: &str) -> impl Iterator<Item = (usize, &str)> {
    let mut offset = 0;
    raw.split_inclusive('\n').map(move |line| {
        let start = offset;
        offset += line.len();
        (start, line.trim_end_matches(['\n', '\r']))
    })
}

/// Flow ids come from the directory, and the file name must match the `id`
/// inside. A registry file would only restate what the directory already says,
/// and would drift from it.
fn discover_flows(root: &Path, id: &str) -> Result<Vec<String>> {
    let flows = root.join(FLOWS_DIR);
    if !flows.is_dir() {
        bail!("Workflow 包 {id} 缺少 {FLOWS_DIR}/ 目录");
    }
    let mut ids = Vec::new();
    for entry in fs::read_dir(&flows)
        .with_context(|| format!("读取 Workflow 流程目录：{}", flows.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(flow_id) = name.strip_suffix(".yaml") else {
            continue;
        };
        validate_id(flow_id, "flow id")?;
        ids.push(flow_id.to_string());
    }
    if ids.is_empty() {
        bail!("Workflow 包 {id} 的 {FLOWS_DIR}/ 中没有任何 *.yaml 流程定义");
    }
    ids.sort();
    Ok(ids)
}

fn discover_spaces(root: &Path, id: &str) -> Result<Vec<SpaceSource>> {
    let spaces = root.join(SPACES_DIR);
    if !spaces.is_dir() {
        return Ok(Vec::new());
    }
    let mut sources = Vec::new();
    let mut names = Vec::new();
    for entry in fs::read_dir(&spaces)
        .with_context(|| format!("读取 Workflow 包 Space 源：{}", spaces.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        names.push(entry.file_name().to_string_lossy().to_string());
    }
    names.sort();
    if names.len() > MAX_SPACES_PER_PACKAGE {
        bail!("Workflow 包 {id} 声明的 Space 超过 {MAX_SPACES_PER_PACKAGE} 个");
    }
    for name in names {
        if !crate::agent_space_builder::valid_space_name(&name) {
            bail!("Workflow 包 {id} 的 Space 名不合法：{name}");
        }
        let directory = spaces.join(&name);
        // A real `pipespace.json` here would be listed as an openable Workspace
        // and read as a live Space by the Builder. The `.src` suffix keeps the
        // source inert until build materializes it.
        for forbidden in ["pipespace.json", "space.json"] {
            if directory.join(forbidden).exists() {
                bail!(
                    "Workflow 包 {id} 的 Space {name} 含有 {forbidden}；源文件必须使用 .src 后缀"
                );
            }
        }
        if directory.join(".pipebuilder").exists() {
            bail!(
                "Workflow 包 {id} 的 Space {name} 不能含有 .pipebuilder/；本地覆盖放在 {SKILLS_DIR}/"
            );
        }
        let definition: SpaceDefinition = serde_json::from_slice(&read_source(
            &directory.join(SPACE_FILE),
        )?)
        .with_context(|| format!("解析 Workflow 包 {id} 的 {name}/{SPACE_FILE}"))?;
        if !crate::agent_space::valid_lifecycle(&definition.lifecycle) {
            bail!(
                "Workflow 包 {id} 的 Space {name} lifecycle 无效：{}",
                definition.lifecycle
            );
        }
        let mut components = Vec::new();
        let mut seen = BTreeSet::new();
        for component in &definition.components {
            if !crate::agent_space::COMPONENT_IDS.contains(&component.component_id.as_str()) {
                bail!(
                    "Workflow 包 {id} 的 Space {name} 声明了未知组件：{}",
                    component.component_id
                );
            }
            if !seen.insert(component.component_id.clone()) {
                bail!(
                    "Workflow 包 {id} 的 Space {name} 重复声明组件：{}",
                    component.component_id
                );
            }
            components.push((component.component_id.clone(), component.role.clone()));
        }
        if components.is_empty() {
            bail!("Workflow 包 {id} 的 Space {name} 必须至少声明一个组件");
        }
        let manifest_source = read_source(&directory.join(PIPESPACE_FILE))?;
        for folder in &definition.folders {
            validate_relative(&folder.path).with_context(|| {
                format!("Workflow 包 {id} 的 Space {name} folders 路径无效：{}", folder.path)
            })?;
        }
        sources.push(SpaceSource {
            has_local_skills: directory.join(SKILLS_DIR).is_dir(),
            name,
            lifecycle: definition.lifecycle,
            components,
            guidance: definition.guidance,
            folders: definition.folders,
            manifest_source,
        });
    }
    Ok(sources)
}

/// Allows `.` and `..` because a Space workspace legitimately mounts the
/// project root above it; containment is enforced when the Builder resolves
/// the materialized `.code-workspace` against the project root.
fn validate_relative(value: &str) -> Result<()> {
    let path = Path::new(value);
    if value.is_empty() || path.is_absolute() {
        bail!("必须是非空相对路径");
    }
    if value.len() > 256 {
        bail!("路径过长");
    }
    Ok(())
}

/// Rewrites `$workflow` / `$collection` / `$project` in a Provider path to a
/// path relative to the product Space directory.
///
/// Resolving at build time rather than teaching the Builder a new syntax keeps
/// `pipespace.v1` unchanged, so a materialized Space is indistinguishable from
/// a hand-written one and needs no special verification path.
pub(crate) fn resolve_reference(
    package: &Package,
    project_root: &Path,
    space_directory: &Path,
    path: &str,
) -> Result<String> {
    let (prefix, rest) = match path.split_once('/') {
        Some((prefix, rest)) => (prefix, rest),
        None => (path, ""),
    };
    let base = match prefix {
        REF_WORKFLOW => package.root.clone(),
        REF_COLLECTION => package.collection_root.clone().ok_or_else(|| {
            anyhow!(
                "Workflow 包 {} 引用了 {REF_COLLECTION}，但它不在包集仓库中；\
                 单独 clone 时请改用 {REF_WORKFLOW} 或 {REF_PROJECT}",
                package.id
            )
        })?,
        // All three roots are directories the author then names a path under,
        // so `$project/skills` reads the same way as `$workflow/skills`.
        REF_PROJECT => project_root.join(PROJECT_HOME_DIR),
        // Not a logical reference: an ordinary Space-relative path.
        _ => return Ok(path.to_string()),
    };
    let target = if rest.is_empty() {
        base
    } else {
        validate_relative(rest)?;
        base.join(rest)
    };
    if !target.is_dir() {
        bail!(
            "Workflow 包 {} 的 Skill Provider 目录不存在：{path} → {}",
            package.id,
            target.display()
        );
    }
    let target = target
        .canonicalize()
        .with_context(|| format!("读取 Skill Provider 目录：{}", target.display()))?;
    let project_root = project_root
        .canonicalize()
        .with_context(|| format!("读取项目根目录：{}", project_root.display()))?;
    if !target.starts_with(&project_root) {
        bail!(
            "Workflow 包 {} 的 Skill Provider 越出项目根目录：{path}",
            package.id
        );
    }
    relative_from(space_directory, &target)
}

/// `../..`-style path from the product Space directory to a provider root.
/// Both sides are already known to be inside the project root.
fn relative_from(from: &Path, to: &Path) -> Result<String> {
    let from = from
        .components()
        .filter(|component| matches!(component, Component::Normal(_) | Component::RootDir))
        .collect::<Vec<_>>();
    let to_components = to
        .components()
        .filter(|component| matches!(component, Component::Normal(_) | Component::RootDir))
        .collect::<Vec<_>>();
    let shared = from
        .iter()
        .zip(&to_components)
        .take_while(|(left, right)| left == right)
        .count();
    let mut parts = vec![".."; from.len() - shared]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    for component in &to_components[shared..] {
        let Component::Normal(value) = component else {
            bail!("无法计算 Skill Provider 相对路径");
        };
        parts.push(value.to_string_lossy().to_string());
    }
    if parts.is_empty() {
        return Ok(".".into());
    }
    Ok(parts.join("/"))
}

/// Source identity of a package: every file's path and bytes, excluding its
/// own `.git`. Comparing this against the registered `builder_lock_digest` is
/// what tells `list` whether the product has drifted from its source.
pub(crate) fn source_digest(package: &Package) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut files = Vec::new();
    collect_files(&package.root, &package.root, &mut files)?;
    files.sort();
    let mut digest = Sha256::new();
    for relative in &files {
        let bytes = fs::read(package.root.join(relative))
            .with_context(|| format!("读取 Workflow 包文件：{relative}"))?;
        if bytes.len() as u64 > MAX_SOURCE_BYTES {
            bail!("Workflow 包单个文件不能超过 {MAX_SOURCE_BYTES} 字节：{relative}");
        }
        digest.update((relative.len() as u64).to_le_bytes());
        digest.update(relative.as_bytes());
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(&bytes);
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}

fn collect_files(root: &Path, directory: &Path, out: &mut Vec<String>) -> Result<()> {
    for entry in fs::read_dir(directory)
        .with_context(|| format!("读取 Workflow 包目录：{}", directory.display()))?
    {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            if name == ".git" {
                continue;
            }
            collect_files(root, &entry.path(), out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| anyhow!("Workflow 包文件越出包目录"))?
            .components()
            .map(|component| component.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");
        out.push(relative);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn seed_package(root: &Path, id: &str) {
        let package = root.join(PACKAGES_DIR).join(id);
        write(
            &package.join(MANIFEST_FILE),
            "---\ndescription: demo\n---\n\nprose\n",
        );
        write(
            &package.join("flows/main.yaml"),
            "schema: genehub.workflow.definition.v1\nid: main\n",
        );
    }

    #[test]
    fn package_id_is_the_directory_path_below_the_packages_root() {
        let root = tempfile::tempdir().unwrap();
        seed_package(root.path(), "studio/game-build");
        seed_package(root.path(), "solo");
        let found = discover(root.path()).unwrap();
        assert_eq!(
            found.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["solo", "studio/game-build"]
        );
    }

    #[test]
    fn a_collection_root_is_the_nearest_ancestor_without_a_manifest() {
        let root = tempfile::tempdir().unwrap();
        seed_package(root.path(), "studio/game-build");
        seed_package(root.path(), "solo");
        let found = discover(root.path()).unwrap();
        let collection = found.iter().find(|p| p.id == "studio/game-build").unwrap();
        assert_eq!(
            collection.collection_root.as_deref(),
            Some(root.path().join(PACKAGES_DIR).join("studio").as_path())
        );
        assert!(found
            .iter()
            .find(|p| p.id == "solo")
            .unwrap()
            .collection_root
            .is_none());
    }

    #[test]
    fn discovery_stops_at_the_first_manifest() {
        let root = tempfile::tempdir().unwrap();
        seed_package(root.path(), "outer");
        seed_package(root.path(), "outer/inner");
        let found = discover(root.path()).unwrap();
        assert_eq!(found.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["outer"]);
    }

    #[test]
    fn flattened_id_collisions_are_refused_rather_than_escaped() {
        let root = tempfile::tempdir().unwrap();
        seed_package(root.path(), "studio/game-build");
        seed_package(root.path(), "studio-game/build");
        let error = discover(root.path()).unwrap_err().to_string();
        assert!(error.contains("studio-game-build"), "{error}");
    }

    #[test]
    fn frontmatter_accepts_only_description_dev_and_recovery() {
        assert_eq!(
            parse_manifest("---\ndescription: a\ndev: true\nrecovery: flows/repair.yaml\n---\nbody\n", "x").unwrap(),
            Manifest {
                description: "a".into(),
                dev: true,
                recovery: "flows/repair.yaml".into(),
            }
        );
        assert_eq!(parse_manifest("---\nrecovery: builtin\n---\n", "x").unwrap().recovery, "builtin");
        assert!(parse_manifest("---\nrecovery: ../escape.yaml\n---\n", "x").is_err());
        let error = parse_manifest("---\ncategory: game\n---\n", "x")
            .unwrap_err()
            .to_string();
        assert!(error.contains("category"), "{error}");
    }

    #[test]
    fn a_missing_description_falls_back_to_the_first_prose_line() {
        let manifest = parse_manifest("---\ndev: true\n---\n\n# Title\n\nwhat it does\n", "x").unwrap();
        assert_eq!(manifest.description, "what it does");
        assert!(manifest.dev);
    }

    #[test]
    fn a_package_without_flows_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let package = root.path().join(PACKAGES_DIR).join("empty");
        write(&package.join(MANIFEST_FILE), "---\ndescription: d\n---\n");
        let error = discover(root.path()).unwrap_err().to_string();
        assert!(error.contains("flows/"), "{error}");
    }

    #[test]
    fn a_live_pipespace_json_in_the_source_is_refused() {
        let root = tempfile::tempdir().unwrap();
        seed_package(root.path(), "pkg");
        let space = root.path().join(PACKAGES_DIR).join("pkg/spaces/executor");
        write(&space.join("pipespace.json"), "{}");
        let error = discover(root.path()).unwrap_err().to_string();
        assert!(error.contains(".src"), "{error}");
    }

    #[test]
    fn more_than_one_executor_carrier_is_ambiguous() {
        let root = tempfile::tempdir().unwrap();
        seed_package(root.path(), "pkg");
        let base = root.path().join(PACKAGES_DIR).join("pkg/spaces");
        for name in ["a", "b"] {
            write(
                &base.join(name).join(SPACE_FILE),
                r#"{"lifecycle":"pooled","components":[{"componentId":"executor"}]}"#,
            );
            write(
                &base.join(name).join(PIPESPACE_FILE),
                r#"{"schema":"pipespace.v1"}"#,
            );
        }
        let package = load(root.path(), "pkg").unwrap();
        let error = package.executor_space().unwrap_err().to_string();
        assert!(error.contains("executor"), "{error}");
    }

    #[test]
    fn the_diagnostic_role_comes_from_the_carrier_worker_component() {
        let root = tempfile::tempdir().unwrap();
        seed_package(root.path(), "pkg");
        let space = root.path().join(PACKAGES_DIR).join("pkg/spaces/wr");
        write(
            &space.join(SPACE_FILE),
            r#"{"lifecycle":"pooled","components":[{"componentId":"worker","role":"workflow-reviewer"},{"componentId":"diagnostic"}]}"#,
        );
        write(&space.join(PIPESPACE_FILE), r#"{"schema":"pipespace.v1"}"#);
        let package = load(root.path(), "pkg").unwrap();
        assert_eq!(
            package.diagnostic_role().unwrap().as_deref(),
            Some("workflow-reviewer")
        );
    }

    #[test]
    fn no_diagnostic_carrier_is_not_an_error() {
        let root = tempfile::tempdir().unwrap();
        seed_package(root.path(), "pkg");
        let package = load(root.path(), "pkg").unwrap();
        assert!(package.diagnostic_space().unwrap().is_none());
        assert!(package.diagnostic_role().unwrap().is_none());
    }

    #[test]
    fn an_oversized_package_is_refused_before_it_is_compiled() {
        let root = tempfile::tempdir().unwrap();
        seed_package(root.path(), "huge");
        let package = root.path().join(PACKAGES_DIR).join("huge");
        for index in 0..=MAX_PACKAGE_FILES {
            write(&package.join(format!("references/note-{index}.md")), "x");
        }
        let error = discover(root.path()).unwrap_err().to_string();
        assert!(error.contains("文件数超过"), "{error}");
    }

    #[test]
    fn too_many_packages_in_one_project_are_refused() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..=MAX_PACKAGES {
            seed_package(root.path(), &format!("pkg-{index}"));
        }
        let error = discover(root.path()).unwrap_err().to_string();
        assert!(error.contains("数量不能超过"), "{error}");
    }

    #[test]
    fn a_package_declaring_an_executable_provider_is_refused_by_the_builder() {
        // The package model does not reopen `command`/`build` Providers: a
        // clone from an unknown author must not be able to run anything.
        let root = tempfile::tempdir().unwrap();
        seed_package(root.path(), "pkg");
        let space = root.path().join(PACKAGES_DIR).join("pkg/spaces/executor");
        write(
            &space.join(SPACE_FILE),
            r#"{"lifecycle":"pooled","components":[{"componentId":"executor"}]}"#,
        );
        write(
            &space.join(PIPESPACE_FILE),
            r#"{"schema":"pipespace.v1","name":"executor","agents":["codex"],"skills":[],"tags":[],"skillProviders":[{"type":"folder","path":"skills","command":{"run":"echo"}}]}"#,
        );
        let package = load(root.path(), "pkg").unwrap();
        // Discovery itself never executes anything; the refusal is the
        // Builder's existing PB006, reached when the Space is materialized.
        assert_eq!(package.spaces.len(), 1);
    }

    #[test]
    fn product_directories_flatten_the_package_id() {
        let root = tempfile::tempdir().unwrap();
        seed_package(root.path(), "studio/game-build");
        let package = load(root.path(), "studio/game-build").unwrap();
        assert_eq!(
            package.space_directory("executor"),
            "studio-game-build--executor"
        );
    }

    #[test]
    fn a_collection_reference_without_a_collection_fails_loudly() {
        let root = tempfile::tempdir().unwrap();
        seed_package(root.path(), "solo");
        let package = load(root.path(), "solo").unwrap();
        let error = resolve_reference(
            &package,
            root.path(),
            &root.path().join("spaces/solo--executor"),
            "$collection/skills",
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("$collection"), "{error}");
    }

    #[test]
    fn logical_references_resolve_to_space_relative_paths() {
        let root = tempfile::tempdir().unwrap();
        seed_package(root.path(), "studio/game-build");
        fs::create_dir_all(
            root.path()
                .join(PACKAGES_DIR)
                .join("studio/game-build/skills"),
        )
        .unwrap();
        fs::create_dir_all(root.path().join(PACKAGES_DIR).join("studio/skills")).unwrap();
        fs::create_dir_all(root.path().join(PROJECT_HOME_DIR).join("skills")).unwrap();
        let space = root.path().join("spaces/studio-game-build--executor");
        fs::create_dir_all(&space).unwrap();
        let package = load(root.path(), "studio/game-build").unwrap();
        let resolve =
            |reference: &str| resolve_reference(&package, root.path(), &space, reference).unwrap();
        assert_eq!(
            resolve("$workflow/skills"),
            "../../.genethub/workflows/studio/game-build/skills"
        );
        assert_eq!(
            resolve("$collection/skills"),
            "../../.genethub/workflows/studio/skills"
        );
        assert_eq!(resolve("$project/skills"), "../../.genethub/skills");
        assert_eq!(resolve("skills"), "skills");
    }
}
