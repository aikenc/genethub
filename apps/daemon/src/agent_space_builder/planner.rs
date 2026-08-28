use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::diagnostic::{fail, BuilderError, BuilderResult, Diagnostic};
use super::manifest::{valid_name, Manifest, Provider, Workspace};
use super::{read_bytes, scan_files, sha256_bytes, tree_digest};

#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub tags: Vec<String>,
    pub root: PathBuf,
    pub provider_id: String,
    pub provider_path: String,
    pub provider_subdir: String,
    pub digest: String,
    pub selected_by: String,
    pub matched_tags: Vec<String>,
    pub shadowed: Vec<ShadowedSkill>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowedSkill {
    pub provider: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Merge {
    Plain,
    Concat,
    Json,
    Toml,
}

#[derive(Debug, Clone)]
struct Contribution {
    target: String,
    content: Vec<u8>,
    source: String,
    logical_type: String,
    merge: Merge,
    executable: bool,
    semantic_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Operation {
    pub target: String,
    pub content: Vec<u8>,
    pub sources: Vec<String>,
    pub logical_type: String,
    pub operation: &'static str,
    pub executable: bool,
    pub semantic_key: String,
}

impl Operation {
    pub fn digest(&self) -> String {
        sha256_bytes(&self.content)
    }
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub root: PathBuf,
    pub manifest: Manifest,
    pub workspace: Workspace,
    pub providers: Vec<Provider>,
    pub skills: Vec<Skill>,
    pub operations: Vec<Operation>,
    pub warnings: Vec<Diagnostic>,
}

pub fn create_plan(
    root: PathBuf,
    manifest: Manifest,
    workspace: Workspace,
    providers: Vec<Provider>,
) -> BuilderResult<Plan> {
    let mut warnings = Vec::new();
    let skills = resolve_skills(&providers, &manifest, &mut warnings)?;
    let operations = Planner::new(&root, &manifest, &workspace, &skills, &mut warnings).build()?;
    Ok(Plan {
        root,
        manifest,
        workspace,
        providers,
        skills,
        operations,
        warnings,
    })
}

fn resolve_skills(
    providers: &[Provider],
    manifest: &Manifest,
    warnings: &mut Vec<Diagnostic>,
) -> BuilderResult<Vec<Skill>> {
    let mut candidates: BTreeMap<String, Vec<Skill>> = BTreeMap::new();
    for provider in providers {
        let mut directories = std::fs::read_dir(&provider.root)
            .map_err(|error| {
                BuilderError(
                    Diagnostic::error(
                        "PB005",
                        format!(
                            "reading Skill Provider {}: {error}",
                            provider.root.display()
                        ),
                    )
                    .source(provider.root.display().to_string()),
                )
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                BuilderError(Diagnostic::error(
                    "PB005",
                    format!("reading Skill Provider: {error}"),
                ))
            })?;
        directories.sort_by_key(|entry| entry.file_name());
        for entry in directories {
            let directory = entry.path();
            let metadata = std::fs::symlink_metadata(&directory).map_err(io_error)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                continue;
            }
            let skill_md = directory.join("SKILL.md");
            if !skill_md.is_file() {
                return fail(
                    Diagnostic::error(
                        "PB008",
                        format!(
                            "Skill provider child is missing SKILL.md: {}",
                            directory.display()
                        ),
                    )
                    .source(directory.display().to_string()),
                );
            }
            let metadata = parse_skill_frontmatter(&skill_md)?;
            let expected = directory
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            if metadata.name != expected || !valid_name(&metadata.name) {
                return fail(
                    Diagnostic::error(
                        "PB008",
                        format!(
                            "Skill name must match directory name: expected {expected}, got {}",
                            metadata.name
                        ),
                    )
                    .source(skill_md.display().to_string()),
                );
            }
            validate_agent_namespaces(&directory.join(".pipe-agents"), &metadata.name)?;
            candidates
                .entry(metadata.name.clone())
                .or_default()
                .push(Skill {
                    name: metadata.name,
                    tags: metadata.tags,
                    digest: tree_digest(&directory, false)?,
                    root: directory,
                    provider_id: provider.id.clone(),
                    provider_path: provider.configured_path.clone(),
                    provider_subdir: provider.subdir.clone(),
                    selected_by: String::new(),
                    matched_tags: Vec::new(),
                    shadowed: Vec::new(),
                });
        }
    }

    let mut resolved = BTreeMap::new();
    for (name, mut choices) in candidates {
        let mut winner = choices.remove(0);
        winner.shadowed = choices
            .iter()
            .map(|choice| ShadowedSkill {
                provider: choice.provider_id.clone(),
                path: format!("{}/{name}", choice.provider_path.trim_end_matches('/')),
            })
            .collect();
        if !winner.shadowed.is_empty() {
            warnings.push(
                Diagnostic::warning(
                    "PBW001",
                    format!(
                        "Skill {name} shadows {} lower-priority candidate(s)",
                        winner.shadowed.len()
                    ),
                )
                .sources(
                    winner
                        .shadowed
                        .iter()
                        .map(|candidate| candidate.path.clone()),
                ),
            );
        }
        resolved.insert(name, winner);
    }

    let local: BTreeSet<_> = resolved
        .iter()
        .filter(|(_, skill)| skill.provider_id == "space-local")
        .map(|(name, _)| name.clone())
        .collect();
    for name in &manifest.skills {
        if !resolved.contains_key(name) {
            return fail(
                Diagnostic::error("PB007", format!("Selected skill not found: {name}"))
                    .source(manifest.path.display().to_string()),
            );
        }
    }
    let explicit: BTreeSet<_> = manifest.skills.iter().cloned().collect();
    let manifest_tags: BTreeSet<_> = manifest.tags.iter().cloned().collect();
    let tagged: BTreeSet<_> = resolved
        .iter()
        .filter(|(name, skill)| {
            !local.contains(*name)
                && !explicit.contains(*name)
                && skill.tags.iter().any(|tag| manifest_tags.contains(tag))
        })
        .map(|(name, _)| name.clone())
        .collect();
    let mut order = manifest.skills.clone();
    order.extend(local.difference(&explicit).cloned());
    order.extend(tagged.iter().cloned());
    let mut selected = Vec::new();
    for name in order {
        let mut skill = resolved.remove(&name).expect("selected Skill exists");
        skill.selected_by = if explicit.contains(&name) {
            "skills"
        } else if local.contains(&name) {
            "space-local"
        } else {
            "tags"
        }
        .to_string();
        skill.matched_tags = skill
            .tags
            .iter()
            .filter(|tag| manifest_tags.contains(*tag))
            .cloned()
            .collect();
        skill.matched_tags.sort();
        selected.push(skill);
    }
    Ok(selected)
}

struct Planner<'a> {
    root: &'a Path,
    manifest: &'a Manifest,
    workspace: &'a Workspace,
    skills: &'a [Skill],
    warnings: &'a mut Vec<Diagnostic>,
    contributions: BTreeMap<String, Vec<Contribution>>,
    portable_targets: BTreeMap<String, String>,
    semantic_targets: BTreeMap<String, String>,
}

impl<'a> Planner<'a> {
    fn new(
        root: &'a Path,
        manifest: &'a Manifest,
        workspace: &'a Workspace,
        skills: &'a [Skill],
        warnings: &'a mut Vec<Diagnostic>,
    ) -> Self {
        Self {
            root,
            manifest,
            workspace,
            skills,
            warnings,
            contributions: BTreeMap::new(),
            portable_targets: BTreeMap::new(),
            semantic_targets: BTreeMap::new(),
        }
    }

    fn build(mut self) -> BuilderResult<Vec<Operation>> {
        let rule = workspace_rule(self.manifest, self.workspace).into_bytes();
        self.add(Contribution {
            target: ".pipebuilder/generated/workspace-rule.md".into(),
            content: rule.clone(),
            source: "core:workspace".into(),
            logical_type: "workspace-rule".into(),
            merge: Merge::Plain,
            executable: false,
            semantic_key: None,
        })?;
        for agent in &self.manifest.agents {
            self.install_common_skills(agent)?;
            self.add_workspace_projection(agent, &rule)?;
            let space_source = self.root.join(".pipebuilder/agents").join(agent);
            if space_source.exists() {
                self.scan_agent_source(agent, &space_source, &format!("space:agents/{agent}"))?;
            }
            for skill in self.skills {
                let source = skill.root.join(".pipe-agents").join(agent);
                if source.exists() {
                    self.scan_agent_source(agent, &source, &format!("skill:{}", skill.name))?;
                }
            }
        }
        self.finalize()
    }

    fn install_common_skills(&mut self, agent: &str) -> BuilderResult<()> {
        let destination = match agent {
            "codex" => ".agents/skills",
            "cursor" => ".cursor/skills",
            "codebuddy" => ".codebuddy/skills",
            "claude-code" => ".claude/skills",
            _ => unreachable!("manifest Agent was validated"),
        };
        for skill in self.skills {
            for path in scan_files(&skill.root, true)? {
                let relative = path
                    .strip_prefix(&skill.root)
                    .expect("scanned Skill file stays inside root")
                    .to_string_lossy()
                    .replace('\\', "/");
                self.add(Contribution {
                    target: format!("{destination}/{}/{relative}", skill.name),
                    content: read_bytes(&path, "PB011")?,
                    source: format!("skill:{}:{relative}", skill.name),
                    logical_type: "common-skill".into(),
                    merge: Merge::Plain,
                    executable: is_executable(&path)?,
                    semantic_key: None,
                })?;
            }
        }
        Ok(())
    }

    fn add_workspace_projection(&mut self, agent: &str, rule: &[u8]) -> BuilderResult<()> {
        let (target, logical_type, merge, content) = match agent {
            "codex" => ("AGENTS.md", "project-instructions", Merge::Concat, rule.to_vec()),
            "cursor" => (
                ".cursor/rules/pipebuilder-workspace.mdc",
                "workspace-rule",
                Merge::Plain,
                [b"---\ndescription: PipeBuilder workspace folder inventory.\nalwaysApply: true\n---\n\n".as_slice(), rule].concat(),
            ),
            "codebuddy" => (
                ".codebuddy/rules/pipebuilder-workspace.md",
                "workspace-rule",
                Merge::Plain,
                rule.to_vec(),
            ),
            "claude-code" => (
                ".claude/rules/pipebuilder-workspace.md",
                "workspace-rule",
                Merge::Plain,
                rule.to_vec(),
            ),
            _ => unreachable!(),
        };
        self.add(Contribution {
            target: target.into(),
            content,
            source: "core:workspace".into(),
            logical_type: logical_type.into(),
            merge,
            executable: false,
            semantic_key: None,
        })
    }

    fn scan_agent_source(
        &mut self,
        agent: &str,
        source_root: &Path,
        source_id: &str,
    ) -> BuilderResult<()> {
        let metadata = std::fs::symlink_metadata(source_root).map_err(io_error)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return fail(
                Diagnostic::error("PB009", "Agent source root must be a real directory")
                    .source(source_root.display().to_string()),
            );
        }
        for path in scan_files(source_root, false)? {
            let relative = path
                .strip_prefix(source_root)
                .expect("scanned Agent source stays in root")
                .to_string_lossy()
                .replace('\\', "/");
            let (target, logical_type, merge) = classify_agent_path(agent, &relative, &path)?;
            let content = read_bytes(&path, "PB009")?;
            let semantic_key = semantic_key(agent, &relative);
            if let Some(key) = semantic_key.as_ref() {
                if let Some(existing) = self.semantic_targets.get(key) {
                    if existing != &target {
                        return fail(
                            Diagnostic::error(
                                "PB010",
                                format!("Conflicting Agent semantic key {key}"),
                            )
                            .source(format!("{source_id}:{relative}"))
                            .target(target)
                            .semantic_key(key.clone()),
                        );
                    }
                }
                self.semantic_targets.insert(key.clone(), target.clone());
            }
            if merge == Merge::Json {
                let value = parse_json(&content, &path)?;
                lint_secrets(&value, &format!("{source_id}:{relative}"), "")?;
                validate_agent_json(&logical_type, &value, &path)?;
            } else if merge == Merge::Toml {
                let value = parse_toml(&content, &path)?;
                let json = serde_json::to_value(&value)
                    .map_err(|error| BuilderError(Diagnostic::error("PB009", error.to_string())))?;
                lint_secrets(&json, &format!("{source_id}:{relative}"), "")?;
                if logical_type == "codex-config" {
                    lint_codex_config(&value, &format!("{source_id}:{relative}"))?;
                }
            }
            if agent == "claude-code" && relative.starts_with(".claude/commands/") {
                self.warnings.push(
                    Diagnostic::warning(
                        "PBW002",
                        format!(
                            "Claude Code custom command is a compatibility surface; prefer a Skill: {relative}"
                        ),
                    )
                    .source(format!("{source_id}:{relative}"))
                    .target(target.clone()),
                );
            }
            self.add(Contribution {
                target,
                content,
                source: format!("{source_id}:{relative}"),
                logical_type,
                merge,
                executable: is_executable(&path)?,
                semantic_key,
            })?;
        }
        Ok(())
    }

    fn add(&mut self, mut contribution: Contribution) -> BuilderResult<()> {
        contribution.target = normalize_target(&contribution.target)?;
        let portable = contribution.target.to_lowercase();
        if let Some(existing) = self.portable_targets.get(&portable) {
            if existing != &contribution.target {
                return fail(
                    Diagnostic::error(
                        "PB010",
                        format!(
                            "Portable target path collision: {existing} vs {}",
                            contribution.target
                        ),
                    )
                    .target(contribution.target),
                );
            }
        }
        self.portable_targets
            .insert(portable, contribution.target.clone());
        self.contributions
            .entry(contribution.target.clone())
            .or_default()
            .push(contribution);
        Ok(())
    }

    fn finalize(self) -> BuilderResult<Vec<Operation>> {
        let mut operations = Vec::new();
        for (target, contributions) in self.contributions {
            let merge = contributions[0].merge;
            if contributions.iter().any(|item| item.merge != merge) {
                return fail(
                    Diagnostic::error("PB010", format!("Incompatible contributions for {target}"))
                        .sources(contributions.iter().map(|item| item.source.clone()))
                        .target(target),
                );
            }
            let (content, operation) = match merge {
                Merge::Plain => {
                    let digests: BTreeSet<_> = contributions
                        .iter()
                        .map(|item| sha256_bytes(&item.content))
                        .collect();
                    if digests.len() != 1 {
                        return fail(
                            Diagnostic::error(
                                "PB010",
                                format!("Conflicting generated target: {target}"),
                            )
                            .sources(contributions.iter().map(|item| item.source.clone()))
                            .target(target),
                        );
                    }
                    (
                        contributions[0].content.clone(),
                        if contributions[0].source.starts_with("core:") {
                            "render"
                        } else {
                            "copy"
                        },
                    )
                }
                Merge::Concat => (
                    render_instructions(&contributions, &target)?,
                    "merge-document",
                ),
                Merge::Json => {
                    let mut merged = serde_json::Value::Object(Default::default());
                    for contribution in &contributions {
                        let value =
                            parse_json(&contribution.content, Path::new(&contribution.source))?;
                        merged =
                            semantic_merge_json(merged, value, &target, &contribution.source, "")?;
                    }
                    let mut content = serde_json::to_vec_pretty(&merged).map_err(|error| {
                        BuilderError(Diagnostic::error("PB009", error.to_string()))
                    })?;
                    content.push(b'\n');
                    (content, "merge-document")
                }
                Merge::Toml => {
                    let mut merged = toml::Value::Table(Default::default());
                    for contribution in &contributions {
                        let value =
                            parse_toml(&contribution.content, Path::new(&contribution.source))?;
                        merged =
                            semantic_merge_toml(merged, value, &target, &contribution.source, "")?;
                    }
                    let mut content = toml::to_string_pretty(&merged)
                        .map_err(|error| {
                            BuilderError(Diagnostic::error("PB009", error.to_string()))
                        })?
                        .into_bytes();
                    if !content.ends_with(b"\n") {
                        content.push(b'\n');
                    }
                    (content, "merge-document")
                }
            };
            operations.push(Operation {
                target: target.clone(),
                content,
                sources: contributions
                    .iter()
                    .map(|item| item.source.clone())
                    .collect(),
                logical_type: contributions[0].logical_type.clone(),
                operation,
                executable: contributions.iter().any(|item| item.executable),
                semantic_key: contributions
                    .iter()
                    .find_map(|item| item.semantic_key.clone())
                    .unwrap_or_else(|| format!("target:{}", target.to_lowercase())),
            });
        }
        Ok(operations)
    }
}

fn workspace_rule(manifest: &Manifest, workspace: &Workspace) -> String {
    let mut lines = vec![
        "# PipeBuilder Workspace".to_string(),
        String::new(),
        format!("PipeSpace: `{}`", manifest.name),
        format!(
            "Workspace: `{}`",
            workspace
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
        ),
        String::new(),
        "## Folders (declared order)".to_string(),
        String::new(),
    ];
    for folder in &workspace.folders {
        let topology = if folder.path == "." {
            "same directory as PipeSpace"
        } else {
            "directory-decoupled"
        };
        lines.push(format!(
            "- `{}`: `{}` ({topology})",
            folder.name, folder.path
        ));
    }
    lines.extend([
        String::new(),
        "Folder order does not imply primary/reference, writable/read-only, validation, or commit boundaries.".into(),
        "The .code-workspace file is the source of truth; this file is a generated projection.".into(),
        "PipeBuilder platform targets and generated state are build outputs; do not edit them directly.".into(),
        "Edit `.pipebuilder/agents`, `.pipebuilder/skills`, or the selected Skill's `.pipe-agents` source, then run `pipebuilder build` and `pipebuilder verify`.".into(),
        "If a write is denied or output drifts, use `pipebuilder explain` to locate the source and continue; this is not a Human blocker.".into(),
        String::new(),
    ]);
    lines.join("\n")
}

fn classify_agent_path(
    agent: &str,
    relative: &str,
    source: &Path,
) -> BuilderResult<(String, String, Merge)> {
    let result = match agent {
        "codex" if relative == "AGENTS.md" => {
            Some((relative, "project-instructions", Merge::Concat))
        }
        "codex" if relative == ".codex/config.toml" => {
            Some((relative, "codex-config", Merge::Toml))
        }
        "codex" if relative == ".codex/hooks.json" => Some((relative, "codex-hooks", Merge::Json)),
        "codex" if relative.starts_with(".codex/rules/") && relative.ends_with(".rules") => {
            Some((relative, "codex-rule", Merge::Plain))
        }
        "codex" if relative.starts_with(".codex/hooks/") => {
            Some((relative, "codex-hook-file", Merge::Plain))
        }
        "cursor" if relative.starts_with(".cursor/rules/") && relative.ends_with(".mdc") => {
            Some((relative, "cursor-rule", Merge::Plain))
        }
        "cursor" if relative.starts_with(".cursor/commands/") && relative.ends_with(".md") => {
            Some((relative, "cursor-command", Merge::Plain))
        }
        "codebuddy"
            if relative.starts_with(".codebuddy/commands/") && relative.ends_with(".md") =>
        {
            Some((relative, "codebuddy-command", Merge::Plain))
        }
        "codebuddy" if relative.starts_with(".codebuddy/agents/") && relative.ends_with(".md") => {
            Some((relative, "codebuddy-agent", Merge::Plain))
        }
        "codebuddy" if relative == ".codebuddy/settings.json" => {
            Some((relative, "codebuddy-settings", Merge::Json))
        }
        "codebuddy" if relative == ".codebuddy/mcp.json" => {
            Some((relative, "codebuddy-mcp", Merge::Json))
        }
        "codebuddy" if relative.starts_with(".codebuddy/hooks/") => {
            Some((relative, "codebuddy-hook-file", Merge::Plain))
        }
        "claude-code" if relative == "CLAUDE.md" => {
            Some((relative, "project-instructions", Merge::Concat))
        }
        "claude-code" if relative.starts_with(".claude/rules/") && relative.ends_with(".md") => {
            Some((relative, "claude-rule", Merge::Plain))
        }
        "claude-code" if relative.starts_with(".claude/commands/") && relative.ends_with(".md") => {
            Some((relative, "claude-command", Merge::Plain))
        }
        "claude-code" if relative.starts_with(".claude/agents/") && relative.ends_with(".md") => {
            Some((relative, "claude-agent", Merge::Plain))
        }
        "claude-code" if relative == ".claude/settings.json" => {
            Some((relative, "claude-settings", Merge::Json))
        }
        "claude-code" if relative == ".mcp.json" => Some((relative, "claude-mcp", Merge::Json)),
        "claude-code" if relative.starts_with(".claude/hooks/") => {
            Some((relative, "claude-hook-file", Merge::Plain))
        }
        _ => None,
    };
    let Some((target, logical_type, merge)) = result else {
        return fail(
            Diagnostic::error(
                "PB009",
                format!("Unsupported {agent} native artifact: {relative}"),
            )
            .source(source.display().to_string()),
        );
    };
    Ok((target.to_string(), logical_type.to_string(), merge))
}

fn semantic_key(agent: &str, relative: &str) -> Option<String> {
    let stem = Path::new(relative).file_stem()?.to_str()?.to_lowercase();
    match agent {
        "cursor" if relative.starts_with(".cursor/commands/") => {
            Some(format!("cursor:command:{stem}"))
        }
        "codebuddy" if relative.starts_with(".codebuddy/commands/") => {
            Some(format!("codebuddy:command:{stem}"))
        }
        "codebuddy" if relative.starts_with(".codebuddy/agents/") => {
            Some(format!("codebuddy:agent:{stem}"))
        }
        "claude-code" if relative.starts_with(".claude/commands/") => {
            Some(format!("claude-code:command:{stem}"))
        }
        "claude-code" if relative.starts_with(".claude/agents/") => {
            Some(format!("claude-code:agent:{stem}"))
        }
        _ => None,
    }
}

pub(super) fn normalize_target(value: &str) -> BuilderResult<String> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return fail(
            Diagnostic::error("PB011", format!("Unsafe generated target: {value}")).target(value),
        );
    }
    let normalized = value.replace('\\', "/");
    if normalized == "pipespace.json"
        || normalized.ends_with(".code-workspace")
        || normalized.starts_with(".pipebuilder/agents/")
        || normalized.starts_with(".pipebuilder/skills/")
    {
        return fail(
            Diagnostic::error(
                "PB011",
                format!("Generated target points to human-owned Builder input: {normalized}"),
            )
            .target(normalized),
        );
    }
    let mut reserved: BTreeSet<String> = ["con", "prn", "aux", "nul"]
        .into_iter()
        .map(str::to_string)
        .collect();
    reserved.extend((1..=9).flat_map(|index| [format!("com{index}"), format!("lpt{index}")]));
    for part in normalized.split('/') {
        let portable = part.trim_end_matches([' ', '.']);
        let stem = portable
            .split('.')
            .next()
            .unwrap_or_default()
            .to_lowercase();
        if part.is_empty()
            || portable != part
            || reserved.contains(&stem)
            || part
                .chars()
                .any(|character| character.is_control() || "<>:\"|?*\\".contains(character))
        {
            return fail(
                Diagnostic::error(
                    "PB011",
                    format!("Generated target is not portable: {normalized}"),
                )
                .target(normalized),
            );
        }
    }
    Ok(normalized)
}

fn render_instructions(contributions: &[Contribution], target: &str) -> BuilderResult<Vec<u8>> {
    let mut output = vec![
        "<!-- Generated by PipeBuilder. Edit .pipebuilder/agents or Skill .pipe-agents sources. -->".to_string(),
        String::new(),
    ];
    let mut seen = BTreeSet::new();
    for contribution in contributions {
        if !seen.insert(sha256_bytes(&contribution.content)) {
            continue;
        }
        let body = std::str::from_utf8(&contribution.content).map_err(|_| {
            BuilderError(
                Diagnostic::error("PB009", format!("{target} source must be UTF-8"))
                    .source(contribution.source.clone())
                    .target(target),
            )
        })?;
        let body = body.trim();
        if !body.is_empty() {
            output.push(format!("<!-- source: {} -->", contribution.source));
            output.push(body.to_string());
            output.push(String::new());
        }
    }
    Ok(format!("{}\n", output.join("\n").trim_end()).into_bytes())
}

fn parse_json(content: &[u8], source: &Path) -> BuilderResult<serde_json::Value> {
    let value: serde_json::Value = serde_json::from_slice(content).map_err(|error| {
        BuilderError(
            Diagnostic::error("PB009", format!("Invalid JSON Agent source: {error}"))
                .source(source.display().to_string()),
        )
    })?;
    if !value.is_object() {
        return fail(
            Diagnostic::error("PB009", "Agent JSON document must contain an object")
                .source(source.display().to_string()),
        );
    }
    Ok(value)
}

fn parse_toml(content: &[u8], source: &Path) -> BuilderResult<toml::Value> {
    let text = std::str::from_utf8(content).map_err(|_| {
        BuilderError(
            Diagnostic::error("PB009", "TOML Agent source must be UTF-8")
                .source(source.display().to_string()),
        )
    })?;
    text.parse::<toml::Value>().map_err(|error| {
        BuilderError(
            Diagnostic::error("PB009", format!("Invalid TOML Agent source: {error}"))
                .source(source.display().to_string()),
        )
    })
}

fn semantic_merge_json(
    left: serde_json::Value,
    right: serde_json::Value,
    target: &str,
    source: &str,
    key: &str,
) -> BuilderResult<serde_json::Value> {
    if left == right {
        return Ok(left);
    }
    match (left, right) {
        (serde_json::Value::Object(mut left), serde_json::Value::Object(right)) => {
            for (child_key, child) in right {
                let path = if key.is_empty() {
                    child_key.clone()
                } else {
                    format!("{key}.{child_key}")
                };
                if let Some(existing) = left.remove(&child_key) {
                    left.insert(
                        child_key,
                        semantic_merge_json(existing, child, target, source, &path)?,
                    );
                } else {
                    left.insert(child_key, child);
                }
            }
            Ok(serde_json::Value::Object(left))
        }
        (serde_json::Value::Array(mut left), serde_json::Value::Array(right)) => {
            for item in right {
                if !left.contains(&item) {
                    left.push(item);
                }
            }
            Ok(serde_json::Value::Array(left))
        }
        _ => fail(
            Diagnostic::error(
                "PB010",
                format!(
                    "Semantic conflict in {target} at {}",
                    if key.is_empty() { "<root>" } else { key }
                ),
            )
            .source(source)
            .target(target)
            .semantic_key(if key.is_empty() { "<root>" } else { key }),
        ),
    }
}

fn semantic_merge_toml(
    left: toml::Value,
    right: toml::Value,
    target: &str,
    source: &str,
    key: &str,
) -> BuilderResult<toml::Value> {
    if left == right {
        return Ok(left);
    }
    match (left, right) {
        (toml::Value::Table(mut left), toml::Value::Table(right)) => {
            for (child_key, child) in right {
                let path = if key.is_empty() {
                    child_key.clone()
                } else {
                    format!("{key}.{child_key}")
                };
                if let Some(existing) = left.remove(&child_key) {
                    left.insert(
                        child_key,
                        semantic_merge_toml(existing, child, target, source, &path)?,
                    );
                } else {
                    left.insert(child_key, child);
                }
            }
            Ok(toml::Value::Table(left))
        }
        (toml::Value::Array(mut left), toml::Value::Array(right)) => {
            for item in right {
                if !left.contains(&item) {
                    left.push(item);
                }
            }
            Ok(toml::Value::Array(left))
        }
        _ => fail(
            Diagnostic::error(
                "PB010",
                format!(
                    "Semantic conflict in {target} at {}",
                    if key.is_empty() { "<root>" } else { key }
                ),
            )
            .source(source)
            .target(target)
            .semantic_key(if key.is_empty() { "<root>" } else { key }),
        ),
    }
}

fn lint_secrets(value: &serde_json::Value, source: &str, key: &str) -> BuilderResult<()> {
    match value {
        serde_json::Value::Object(object) => {
            for (child_key, child) in object {
                let path = if key.is_empty() {
                    child_key.clone()
                } else {
                    format!("{key}.{child_key}")
                };
                let normalized = child_key.to_lowercase().replace('-', "_");
                let secret_key = [
                    "api_key",
                    "apikey",
                    "secret",
                    "token",
                    "password",
                    "credential",
                    "private_key",
                ]
                .iter()
                .any(|needle| normalized.contains(needle));
                if secret_key {
                    if let Some(value) = child.as_str().filter(|value| !value.trim().is_empty()) {
                        let value = value.trim();
                        if !value.starts_with('$')
                            && !value.starts_with("env:")
                            && !value.starts_with("keyring:")
                            && !value.starts_with("credential-helper:")
                        {
                            return fail(
                                Diagnostic::error(
                                    "PB011",
                                    format!("Secret literal is forbidden at {path}"),
                                )
                                .source(source)
                                .semantic_key(path),
                            );
                        }
                    }
                }
                lint_secrets(child, source, &path)?;
            }
        }
        serde_json::Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                lint_secrets(child, source, &format!("{key}[{index}]"))?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_agent_json(
    logical_type: &str,
    value: &serde_json::Value,
    source: &Path,
) -> BuilderResult<()> {
    let object = value.as_object().expect("parse_json returns an object");
    if matches!(logical_type, "codex-hooks")
        && !object
            .get("hooks")
            .is_some_and(serde_json::Value::is_object)
    {
        return fail(
            Diagnostic::error("PB009", "Hook document must contain a hooks object")
                .source(source.display().to_string()),
        );
    }
    if matches!(logical_type, "codebuddy-mcp" | "claude-mcp")
        && !object
            .get("mcpServers")
            .is_some_and(serde_json::Value::is_object)
    {
        return fail(
            Diagnostic::error("PB009", "MCP document must contain an mcpServers object")
                .source(source.display().to_string()),
        );
    }
    if logical_type == "claude-settings" && contains_string(value, "bypassPermissions") {
        return fail(
            Diagnostic::error(
                "PB011",
                "Claude project settings must not enable bypassPermissions",
            )
            .source(source.display().to_string())
            .semantic_key("permissions.defaultMode"),
        );
    }
    Ok(())
}

fn contains_string(value: &serde_json::Value, expected: &str) -> bool {
    match value {
        serde_json::Value::String(value) => value == expected,
        serde_json::Value::Array(values) => {
            values.iter().any(|value| contains_string(value, expected))
        }
        serde_json::Value::Object(values) => values
            .values()
            .any(|value| contains_string(value, expected)),
        _ => false,
    }
}

fn lint_codex_config(value: &toml::Value, source: &str) -> BuilderResult<()> {
    const FORBIDDEN: [&str; 11] = [
        "model",
        "model_provider",
        "model_providers",
        "notify",
        "profile",
        "profiles",
        "telemetry",
        "analytics",
        "history",
        "forced_login_method",
        "chatgpt_base_url",
    ];
    let Some(table) = value.as_table() else {
        return Ok(());
    };
    if let Some(key) = FORBIDDEN.iter().find(|key| table.contains_key(**key)) {
        return fail(
            Diagnostic::error(
                "PB011",
                format!("Codex project config contains user/machine-level key: {key}"),
            )
            .source(source)
            .semantic_key(*key),
        );
    }
    Ok(())
}

#[derive(Debug)]
struct SkillMetadata {
    name: String,
    tags: Vec<String>,
}

fn parse_skill_frontmatter(path: &Path) -> BuilderResult<SkillMetadata> {
    let text = std::fs::read_to_string(path).map_err(|error| {
        BuilderError(
            Diagnostic::error("PB008", format!("Skill must be UTF-8: {error}"))
                .source(path.display().to_string()),
        )
    })?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let lines = text.lines().collect::<Vec<_>>();
    if lines.first().map(|line| line.trim()) != Some("---") {
        return fail(
            Diagnostic::error("PB008", "SKILL.md is missing YAML frontmatter")
                .source(path.display().to_string()),
        );
    }
    let end = lines
        .iter()
        .enumerate()
        .skip(1)
        .find_map(|(index, line)| (line.trim() == "---").then_some(index))
        .ok_or_else(|| {
            BuilderError(
                Diagnostic::error("PB008", "SKILL.md frontmatter is not closed")
                    .source(path.display().to_string()),
            )
        })?;

    let mut fields = Vec::new();
    let mut index = 1;
    while index < end {
        let raw = lines[index];
        index += 1;
        let stripped = raw.trim();
        if stripped.is_empty() || stripped.starts_with('#') {
            continue;
        }
        if raw.chars().next().is_some_and(char::is_whitespace) || !raw.contains(':') {
            return fail(
                Diagnostic::error(
                    "PB008",
                    format!("Unsupported SKILL.md frontmatter syntax: {stripped}"),
                )
                .source(path.display().to_string()),
            );
        }
        let (key, raw_value) = raw.split_once(':').expect("contains colon");
        let key = key.trim();
        if key.is_empty() {
            return fail(
                Diagnostic::error("PB008", "Empty SKILL.md frontmatter key")
                    .source(path.display().to_string()),
            );
        }
        let mut body = Vec::new();
        while index < end {
            let candidate = lines[index];
            if !candidate.trim().is_empty()
                && !candidate.chars().next().is_some_and(char::is_whitespace)
                && !candidate.trim_start().starts_with('#')
            {
                break;
            }
            body.push(candidate);
            index += 1;
        }
        fields.push((key.to_string(), raw_value.trim().to_string(), body));
    }

    let mut seen = BTreeSet::new();
    let mut name = None;
    let mut description = None;
    let mut tags = None;
    for (key, value, body) in fields {
        if !seen.insert(key.clone()) {
            return fail(
                Diagnostic::error(
                    "PB008",
                    format!("Duplicate SKILL.md frontmatter key: {key}"),
                )
                .source(path.display().to_string()),
            );
        }
        match key.as_str() {
            "tags" => {
                let parsed = if value.is_empty() {
                    parse_yaml_list_body(&body, path)?
                } else if value.starts_with('[') {
                    parse_yaml_inline_list(&value, path)?
                } else {
                    return fail(
                        Diagnostic::error("PB008", "Skill tags must be a YAML list")
                            .source(path.display().to_string()),
                    );
                };
                tags = Some(parsed);
            }
            "name" | "description" => {
                let parsed = if value.starts_with('|') || value.starts_with('>') {
                    parse_yaml_block_scalar(&value, &body, path, &key)?
                } else {
                    if body
                        .iter()
                        .any(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
                    {
                        return fail(
                            Diagnostic::error("PB008", format!("{key} must be a scalar"))
                                .source(path.display().to_string()),
                        );
                    }
                    yaml_scalar(&value)
                };
                if key == "name" {
                    name = Some(parsed);
                } else {
                    description = Some(parsed);
                }
            }
            _ => {}
        };
    }
    let name = name.filter(|value| !value.is_empty()).ok_or_else(|| {
        BuilderError(
            Diagnostic::error("PB008", "Skill frontmatter needs name")
                .source(path.display().to_string()),
        )
    })?;
    let _description = description
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            BuilderError(
                Diagnostic::error("PB008", "Skill description must be non-empty")
                    .source(path.display().to_string()),
            )
        })?;
    let tags = tags.unwrap_or_default();
    let mut unique = BTreeSet::new();
    if tags.iter().any(|tag| tag.is_empty() || !unique.insert(tag)) {
        return fail(
            Diagnostic::error("PB008", "Skill tags must be unique non-empty strings")
                .source(path.display().to_string()),
        );
    }
    Ok(SkillMetadata { name, tags })
}

fn yaml_scalar(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        serde_json::from_str::<String>(value)
            .unwrap_or_else(|_| value[1..value.len() - 1].to_string())
    } else if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        value[1..value.len() - 1].replace("''", "'")
    } else {
        value.to_string()
    }
}

fn parse_yaml_inline_list(value: &str, path: &Path) -> BuilderResult<Vec<String>> {
    match serde_json::from_str::<serde_json::Value>(value) {
        Ok(serde_json::Value::Array(values)) => {
            return values
                .into_iter()
                .map(|value| {
                    value.as_str().map(str::to_string).ok_or_else(|| {
                        BuilderError(
                            Diagnostic::error(
                                "PB008",
                                "Skill tags must be an array of non-empty strings",
                            )
                            .source(path.display().to_string()),
                        )
                    })
                })
                .collect();
        }
        Ok(_) => {
            return fail(
                Diagnostic::error("PB008", "Invalid inline list for tags")
                    .source(path.display().to_string()),
            );
        }
        Err(_) => {}
    }
    if !value.ends_with(']') {
        return fail(
            Diagnostic::error("PB008", "Invalid inline list for tags")
                .source(path.display().to_string()),
        );
    }
    Ok(value[1..value.len() - 1]
        .split(',')
        .map(yaml_scalar)
        .filter(|value| !value.is_empty())
        .collect())
}

fn parse_yaml_list_body(body: &[&str], path: &Path) -> BuilderResult<Vec<String>> {
    let mut values = Vec::new();
    for raw in body {
        let nested = raw.trim();
        if nested.is_empty() || nested.starts_with('#') {
            continue;
        }
        let Some(value) = nested.strip_prefix("- ") else {
            return fail(
                Diagnostic::error("PB008", "Skill tags must be a YAML list")
                    .source(path.display().to_string()),
            );
        };
        values.push(yaml_scalar(value));
    }
    Ok(values)
}

fn parse_yaml_block_scalar(
    marker: &str,
    body: &[&str],
    path: &Path,
    key: &str,
) -> BuilderResult<String> {
    let suffix = &marker[1..];
    let valid = suffix.is_empty()
        || (suffix.len() == 1
            && suffix
                .bytes()
                .all(|byte| matches!(byte, b'+' | b'-' | b'1'..=b'9')))
        || (suffix.len() == 2
            && suffix.bytes().any(|byte| matches!(byte, b'+' | b'-'))
            && suffix.bytes().any(|byte| matches!(byte, b'1'..=b'9')));
    if !valid {
        return fail(
            Diagnostic::error("PB008", format!("Invalid block scalar marker for {key}"))
                .source(path.display().to_string()),
        );
    }
    let indentation = body
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);
    let values = body
        .iter()
        .map(|line| {
            if line.trim().is_empty() {
                ""
            } else {
                line.get(indentation..).unwrap_or("")
            }
        })
        .collect::<Vec<_>>();
    let mut output = if marker.starts_with('|') {
        values.join("\n")
    } else {
        let mut folded = String::new();
        for value in values {
            if value.is_empty() {
                folded.push('\n');
            } else if !folded.is_empty() && !folded.ends_with('\n') {
                folded.push(' ');
                folded.push_str(value);
            } else {
                folded.push_str(value);
            }
        }
        folded
    };
    while output.ends_with('\n') {
        output.pop();
    }
    if !marker.ends_with('-') {
        output.push('\n');
    }
    Ok(output)
}

fn validate_agent_namespaces(root: &Path, skill: &str) -> BuilderResult<()> {
    if !root.exists() {
        return Ok(());
    }
    let metadata = std::fs::symlink_metadata(root).map_err(io_error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return fail(
            Diagnostic::error(
                "PB009",
                format!("Skill {skill} .pipe-agents must be a real directory"),
            )
            .source(root.display().to_string()),
        );
    }
    for entry in std::fs::read_dir(root).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let name = entry.file_name().to_string_lossy().to_string();
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(io_error)?;
        if !super::manifest::AGENTS.contains(&name.as_str())
            || !metadata.is_dir()
            || metadata.file_type().is_symlink()
        {
            return fail(
                Diagnostic::error(
                    "PB009",
                    format!("Unknown or unsafe Agent namespace: {name}"),
                )
                .source(entry.path().display().to_string()),
            );
        }
    }
    Ok(())
}

pub(super) fn is_executable(path: &Path) -> BuilderResult<bool> {
    let metadata = std::fs::metadata(path).map_err(io_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(metadata.permissions().mode() & 0o100 != 0)
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        Ok(false)
    }
}

fn io_error(error: std::io::Error) -> BuilderError {
    BuilderError(Diagnostic::error(
        "PB011",
        format!("Filesystem error: {error}"),
    ))
}
