use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use genehub_proto::{
    SpeechContextOmissions, SpeechContextPack, SpeechContextSource, SpeechContextTerm,
    TimelineItem, MAX_SPEECH_CONTEXT_BYTES, MAX_SPEECH_PROMPT_CHARS,
};
use ignore::WalkBuilder;
use sha2::{Digest, Sha256};

use crate::state::Shared;

const COMPILER_VERSION: &str = "qwen3-context-v1";
const MAX_PINNED: usize = 50;
const MAX_AUTOMATIC: usize = 150;
const MAX_WALKED_ENTRIES: usize = 2_000;
const MAX_MESSAGE_CHARS: usize = 400;
const MAX_PROJECT_CONTEXT_CHARS: usize = 2_000;
const MAX_CONTEXT_FILE_BYTES: u64 = 16 * 1024;

pub async fn compile(
    state: &Shared,
    workspace_id: &str,
    session_id: Option<&str>,
    draft: Option<&str>,
) -> Result<SpeechContextPack> {
    let workspace = state.workspaces.get(workspace_id).await?;
    let speech = state.config.read().await.speech.clone();

    let mut omitted = SpeechContextOmissions::default();
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    for term in speech.pinned_terms.iter().take(MAX_PINNED) {
        push_term(
            &mut terms,
            &mut seen,
            term,
            1.0,
            SpeechContextSource::Pinned,
        );
    }
    omitted.pinned_terms = speech.pinned_terms.len().saturating_sub(terms.len()) as u32;

    let mut project_context = String::new();
    let mut recent_messages = Vec::new();
    if speech.context_enabled {
        if let Some(session_id) = session_id {
            let snapshot = state.sessions.snapshot(session_id).await?;
            if snapshot.summary.workspace_id != workspace_id {
                anyhow::bail!("session is not a member of this workspace");
            }
            let available = snapshot
                .items
                .iter()
                .filter_map(context_message)
                .collect::<Vec<_>>();
            let start = available.len().saturating_sub(8);
            omitted.messages = start as u32;
            recent_messages.extend(available.into_iter().skip(start));
        }

        let roots = workspace
            .folders
            .iter()
            .map(|folder| folder.root.clone())
            .collect::<Vec<_>>();
        let workspace_name = workspace.name.clone();
        let folder_names = workspace
            .folders
            .iter()
            .map(|folder| folder.name.clone())
            .collect::<Vec<_>>();
        let discovered = tokio::task::spawn_blocking(move || {
            discover_project_context(&workspace_name, &folder_names, &roots)
        })
        .await
        .context("joining Qwen3 project-context scan")?;

        match discovered {
            Ok(discovered) => {
                project_context = discovered.context;
                omitted.project_context_truncated = discovered.context_truncated;
                omitted.project_index_unavailable = discovered.index_unavailable;
                for candidate in discovered.terms {
                    if terms.len() >= MAX_PINNED + MAX_AUTOMATIC {
                        omitted.automatic_terms += 1;
                        continue;
                    }
                    if seen.insert(candidate.text.to_lowercase()) {
                        terms.push(candidate);
                    }
                }
            }
            Err(error) => {
                tracing::debug!(%error, "Qwen3 project context is unavailable");
                omitted.project_index_unavailable = true;
            }
        }
    }

    let draft = draft.and_then(normalize_message);
    let mut pack = SpeechContextPack {
        snapshot_id: String::new(),
        prompt: build_prompt(&project_context, &terms, &recent_messages, draft.as_deref()),
        terms,
        language_hints: speech.language_hints,
        compiler_version: COMPILER_VERSION.to_string(),
        omitted,
    };
    fit_budget(
        &mut pack,
        &project_context,
        &recent_messages,
        draft.as_deref(),
    )?;
    pack.snapshot_id = snapshot_id(&pack)?;
    Ok(pack)
}

fn context_message(item: &TimelineItem) -> Option<String> {
    let (role, text) = match item {
        TimelineItem::UserMessage { text, .. } => ("用户", text),
        TimelineItem::AssistantMessage { text, .. } => ("Agent", text),
        _ => return None,
    };
    Some(format!("{role}：{}", normalize_message(text)?))
}

fn normalize_message(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(MAX_MESSAGE_CHARS).collect())
}

fn build_prompt(
    project_context: &str,
    terms: &[SpeechContextTerm],
    recent_messages: &[String],
    draft: Option<&str>,
) -> String {
    let mut sections = Vec::new();
    if !project_context.is_empty() {
        sections.push(format!("项目背景：\n{project_context}"));
    }
    if !terms.is_empty() {
        sections.push(format!(
            "专业术语（保持原拼写）：\n{}",
            terms
                .iter()
                .map(|term| term.text.as_str())
                .collect::<Vec<_>>()
                .join("、")
        ));
    }
    if !recent_messages.is_empty() {
        sections.push(format!("最近对话：\n{}", recent_messages.join("\n")));
    }
    if let Some(draft) = draft {
        sections.push(format!("当前输入草稿：\n{draft}"));
    }
    sections
        .join("\n\n")
        .chars()
        .take(MAX_SPEECH_PROMPT_CHARS)
        .collect()
}

struct DiscoveredContext {
    terms: Vec<SpeechContextTerm>,
    context: String,
    context_truncated: bool,
    index_unavailable: bool,
}

fn discover_project_context(
    workspace_name: &str,
    folder_names: &[String],
    roots: &[PathBuf],
) -> Result<DiscoveredContext> {
    let mut ranked = BTreeMap::<String, (String, f32, SpeechContextSource)>::new();
    add_name_terms(
        &mut ranked,
        workspace_name,
        0.90,
        SpeechContextSource::Workspace,
    );
    for name in folder_names {
        add_name_terms(&mut ranked, name, 0.85, SpeechContextSource::Workspace);
    }

    let mut project_context = String::new();
    let mut context_truncated = false;
    for root in roots {
        let config = root.join(".genethub").join("speech");
        for (file, source, score) in [
            (
                config.join("terms.txt"),
                SpeechContextSource::ProjectConfig,
                0.98,
            ),
            (
                config.join("learned-terms.txt"),
                SpeechContextSource::Correction,
                0.99,
            ),
        ] {
            for term in read_term_file(&file)? {
                add_ranked_term(&mut ranked, &term, score, source);
            }
        }
        if project_context.is_empty() {
            if let Some((value, truncated)) = read_bounded_text(&config.join("context.md"))? {
                project_context = value;
                context_truncated = truncated;
            }
        }
    }

    let mut walked = 0usize;
    let mut index_unavailable = false;
    for root in roots {
        let index_root = root.clone();
        let mut builder = WalkBuilder::new(root);
        builder
            .hidden(false)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .parents(true)
            .filter_entry(move |entry| {
                let relative = entry
                    .path()
                    .strip_prefix(&index_root)
                    .unwrap_or(entry.path());
                project_index_entry(relative)
            });
        let walker = builder.build();
        for entry in walker {
            if walked >= MAX_WALKED_ENTRIES {
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    index_unavailable = true;
                    continue;
                }
            };
            if entry.depth() == 0 {
                continue;
            }
            walked += 1;
            if let Some(name) = entry.path().file_stem().and_then(|name| name.to_str()) {
                add_name_terms(
                    &mut ranked,
                    name,
                    if entry.file_type().is_some_and(|kind| kind.is_dir()) {
                        0.55
                    } else {
                        0.65
                    },
                    SpeechContextSource::ProjectFile,
                );
            }
        }
    }

    let mut terms = ranked
        .into_values()
        .map(|(text, score, source)| SpeechContextTerm {
            text,
            source,
            score,
        })
        .collect::<Vec<_>>();
    terms.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.text.cmp(&right.text))
    });
    Ok(DiscoveredContext {
        terms,
        context: project_context,
        context_truncated,
        index_unavailable,
    })
}

fn read_term_file(path: &Path) -> Result<Vec<String>> {
    let Some((text, _)) = read_bounded_text(path)? else {
        return Ok(Vec::new());
    };
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .take(MAX_AUTOMATIC)
        .map(str::to_string)
        .collect())
}

fn read_bounded_text(path: &Path) -> Result<Option<(String, bool)>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("inspecting {}", path.display())),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_CONTEXT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let byte_truncated = bytes.len() as u64 > MAX_CONTEXT_FILE_BYTES;
    bytes.truncate(MAX_CONTEXT_FILE_BYTES as usize);
    let valid_bytes = match std::str::from_utf8(&bytes) {
        Ok(_) => bytes.len(),
        Err(error) if byte_truncated && error.error_len().is_none() => error.valid_up_to(),
        Err(error) => return Err(error).context("Qwen3 context file is not UTF-8"),
    };
    bytes.truncate(valid_bytes);
    let text = String::from_utf8(bytes).expect("validated UTF-8 prefix");
    let char_truncated = text.chars().count() > MAX_PROJECT_CONTEXT_CHARS;
    Ok(Some((
        text.chars()
            .take(MAX_PROJECT_CONTEXT_CHARS)
            .collect::<String>()
            .trim()
            .to_string(),
        byte_truncated || char_truncated,
    )))
}

fn push_term(
    terms: &mut Vec<SpeechContextTerm>,
    seen: &mut HashSet<String>,
    raw: &str,
    score: f32,
    source: SpeechContextSource,
) {
    let Some(text) = normalize_term(raw) else {
        return;
    };
    if seen.insert(text.to_lowercase()) {
        terms.push(SpeechContextTerm {
            text,
            source,
            score,
        });
    }
}

fn add_ranked_term(
    ranked: &mut BTreeMap<String, (String, f32, SpeechContextSource)>,
    raw: &str,
    score: f32,
    source: SpeechContextSource,
) {
    let Some(term) = normalize_term(raw) else {
        return;
    };
    let key = term.to_lowercase();
    match ranked.get(&key) {
        Some((_, previous, _)) if *previous >= score => {}
        _ => {
            ranked.insert(key, (term, score, source));
        }
    }
}

fn add_name_terms(
    ranked: &mut BTreeMap<String, (String, f32, SpeechContextSource)>,
    raw: &str,
    score: f32,
    source: SpeechContextSource,
) {
    let mut values = vec![raw.to_string()];
    values.extend(
        raw.split(|character: char| {
            !character.is_alphanumeric() && character != '-' && character != '_'
        })
        .map(str::to_string),
    );
    values.extend(raw.split(['-', '_']).map(str::to_string));
    for value in values {
        add_ranked_term(ranked, &value, score, source);
    }
}

fn normalize_term(term: &str) -> Option<String> {
    let term = term.trim().trim_matches(['.', '-', '_']);
    let chars = term.chars().count();
    if !(2..=64).contains(&chars)
        || term.chars().any(char::is_control)
        || COMMON_TERMS.contains(&term.to_ascii_lowercase().as_str())
    {
        return None;
    }
    Some(term.to_string())
}

fn project_index_entry(relative: &Path) -> bool {
    !relative.components().any(|component| {
        let name = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        name == ".genethub"
            || name.starts_with(".env")
            || matches!(name.as_str(), ".git" | ".ssh" | ".aws" | ".gnupg")
            || name.contains("secret")
            || name.contains("credential")
            || name.contains("private_key")
            || name.ends_with(".pem")
            || name.ends_with(".key")
    })
}

fn fit_budget(
    pack: &mut SpeechContextPack,
    project_context: &str,
    recent_messages: &[String],
    draft: Option<&str>,
) -> Result<()> {
    while serde_json::to_vec(pack)?.len() > MAX_SPEECH_CONTEXT_BYTES {
        if let Some(position) = pack
            .terms
            .iter()
            .rposition(|term| term.source != SpeechContextSource::Pinned)
        {
            pack.terms.remove(position);
            pack.omitted.automatic_terms += 1;
            pack.prompt = build_prompt(project_context, &pack.terms, recent_messages, draft);
        } else if !pack.prompt.is_empty() {
            pack.prompt = pack
                .prompt
                .chars()
                .take(pack.prompt.chars().count().saturating_sub(200))
                .collect();
            pack.omitted.project_context_truncated = true;
        } else {
            anyhow::bail!("pinned Qwen3 speech context exceeds its byte budget");
        }
    }
    Ok(())
}

fn snapshot_id(pack: &SpeechContextPack) -> Result<String> {
    let digest = Sha256::digest(serde_json::to_vec(pack)?);
    Ok(format!("sc_{:x}", digest)[..27].to_string())
}

const COMMON_TERMS: &[&str] = &[
    "src",
    "lib",
    "main",
    "test",
    "tests",
    "docs",
    "readme",
    "index",
    "package",
    "target",
    "node_modules",
    "public",
    "assets",
    "config",
    "json",
    "toml",
    "yaml",
    "lock",
    "debug",
    "release",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_files_and_genethub_configuration_are_bounded_and_secret_safe() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("GeneHubFabric.rs"), "").unwrap();
        std::fs::write(dir.path().join("private_key.pem"), "").unwrap();
        let config = dir.path().join(".genethub/speech");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(
            config.join("terms.txt"),
            "PipeSpace\n# comment\nQwen3-ASR\n",
        )
        .unwrap();
        std::fs::write(config.join("context.md"), "这是 GeneHub Agent 项目。").unwrap();
        std::fs::write(config.join("preferences.jsonl"), "{}\n").unwrap();

        let result = discover_project_context("GeneHub", &[], &[dir.path().into()]).unwrap();
        assert!(result.terms.iter().any(|term| term.text == "GeneHubFabric"));
        assert!(result.terms.iter().any(|term| term.text == "PipeSpace"));
        assert!(!result
            .terms
            .iter()
            .any(|term| term.text.contains("private_key")));
        assert!(!result.terms.iter().any(|term| term.text == "preferences"));
        assert_eq!(result.context, "这是 GeneHub Agent 项目。");
    }

    #[test]
    fn bounded_context_keeps_a_valid_utf8_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("context.md");
        std::fs::write(&path, "界".repeat(6_000)).unwrap();

        let (text, truncated) = read_bounded_text(&path).unwrap().unwrap();

        assert!(truncated);
        assert_eq!(text.chars().count(), MAX_PROJECT_CONTEXT_CHARS);
        assert!(text.chars().all(|character| character == '界'));
    }

    #[test]
    fn qwen3_prompt_combines_background_terms_recent_context_and_draft() {
        let terms = vec![SpeechContextTerm {
            text: "GeneHub".into(),
            source: SpeechContextSource::Pinned,
            score: 1.0,
        }];
        let prompt = build_prompt(
            "本项目实现内置 Agent。",
            &terms,
            &["用户：修改语音输入".into()],
            Some("请继续"),
        );
        assert!(prompt.contains("项目背景"));
        assert!(prompt.contains("GeneHub"));
        assert!(prompt.contains("最近对话"));
        assert!(prompt.contains("当前输入草稿"));
        assert!(prompt.chars().count() <= MAX_SPEECH_PROMPT_CHARS);
    }
}
