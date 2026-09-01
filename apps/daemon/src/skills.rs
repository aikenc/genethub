//! GeneHub built-in Skills: materialize product-owned files and inject one catalog
//! into every Agent session.
//!
//! Third-party Agents do not need a native Skill loader. They receive
//! `{name, description, path}` and read the file when a task matches.

use std::path::{Path, PathBuf};

const MAX_NAME_LENGTH: usize = 64;
const MAX_DESCRIPTION_LENGTH: usize = 1024;

struct BuiltinFile {
    relative_path: &'static str,
    contents: &'static [u8],
}

include!(concat!(env!("OUT_DIR"), "/builtin_skills.rs"));

pub const ENTRYPOINT_MANIFEST: &str = ".entrypoints";
pub const PROJECT_MANAGER_ENTRYPOINT_MANIFEST: &str = ".entrypoints-project-manager";
const PROJECT_MANAGER_SKILL_PREFIX: &str = "genehub-pm-";
const PROJECT_MANAGER_AVAILABILITY_GUIDANCE: &str = r#"<project_manager_availability>
WorkSession 运行期间，PM Session 必须随时可响应用户指导。创建或继续受管 WorkSession 时，只能顶层调用 GeneHub CLI 并使用 `--no-wait`。禁止套用 timeout、pipe、后台任务或其他等待结构，也禁止 sleep、计时器、轮询和为了监控而反复执行 `session get`。成功的 `agent run --work-package` 会原子绑定 WorkSession、推进包状态并占用 Agent Space；不要再执行一次包转换来绑定 Session。派发当前全部 Ready 包并记录立即状态后，简短报告并结束 PM turn。daemon Supervisor 负责退避检查并只在事实变化时唤醒；新用户消息始终优先。
存在内置 `genehub` 工具时，所有 GeneHub CLI 操作都优先使用它而不是 `bash`。把已知的确定性命令合并到一个 `genehub.commands` 批次，不要用模型回合执行 `--help`、搜索产品源码或逐条状态探测。批次仍经过相同 daemon 鉴权，并在首个失败命令停止。
</project_manager_availability>"#;
const WORK_SESSION_RESULT_GUIDANCE: &str = r#"<managed_work_result>
这是受管 WorkSession。GeneHub 只依据持久证据推进 WorkPackage，不依据乐观叙述。只有任务真正结算时，才在最终响应的最后一个非空行放置唯一机器标记，不使用 Markdown 代码围栏：
GENEHUB_WORK_RESULT {"status":"candidate-ready","summary":"测试通过，指定 worktree 已提交且干净"}
实现只有在工作与测试完成、变更全部提交到指定分支且 worktree 干净时才能使用 `candidate-ready`。独立评审只有检查精确绑定候选后才能使用 `review-pass` 或 `review-fail`。通过形态为 `GENEHUB_WORK_RESULT {"status":"review-pass","summary":"精确候选的全部门禁通过"}`。失败形态为 `GENEHUB_WORK_RESULT {"status":"review-fail","summary":"仍有验收缺陷","findings":[{"severity":"blocking|high|medium|low","title":"...","acceptanceImpact":"...","recommendedAction":"...","estimatedRequests":1}]}`。`findings` 必须是对象数组；每项都含 severity、title、acceptanceImpact、recommendedAction，estimatedRequests 可选。Reviewer 报告技术证据和影响，不做产品或预算取舍。只有无法安全继续时使用 `blocked`。checkpoint 或仍需继续时不要输出标记。commit/tree、租约、评审和 Git 绑定由 Coordinator 推导，不要在标记中编造。
任务要求的人类可读报告可以放在标记之前，但不能替代协议。`GENEHUB_WORK_RESULT` 必须保持最后一个非空行，之后不得有文字。实现状态只允许 `candidate-ready`/`blocked`，评审只允许 `review-pass`/`review-fail`/`blocked`；`candidate` 和 `failed` 不是协议状态。
</managed_work_result>"#;

/// Product-owned Skill catalog selected for one durable session role.
/// Project and Agent Space Skills remain workspace inputs rather than being
/// copied into this product profile.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SkillProfile {
    #[default]
    Common,
    ProjectManager,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub file_path: PathBuf,
    pub disable_model_invocation: bool,
}

/// `<data-dir>/builtin-skills` — product-owned files, isolated from project or
/// user Skill directories.
pub fn builtin_skills_dir(data_root: &Path) -> PathBuf {
    data_root.join("builtin-skills")
}

/// Runtime channel binding supplied by the launcher. A bare command name is
/// not a binding: it could resolve to another installed channel via PATH.
pub fn front_door_cli_from_env() -> Option<PathBuf> {
    normalize_front_door_cli(std::env::var_os("GENEHUB_CLI"))
}

fn normalize_front_door_cli(value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    value
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

/// Write built-in Skill files so Agents can `read` a real path.
pub fn materialize(root: &Path) -> Option<PathBuf> {
    for file in BUILTIN_FILES {
        let target = root.join(file.relative_path);
        if std::fs::read(&target).ok().as_deref() == Some(file.contents) {
            continue;
        }
        let parent = target.parent()?;
        if let Err(error) = std::fs::create_dir_all(parent) {
            tracing::warn!(
                path = %file.relative_path,
                %error,
                "could not create built-in skill directory"
            );
            return None;
        }
        if let Err(error) = install_file(&target, file.contents) {
            tracing::warn!(
                path = %file.relative_path,
                %error,
                "could not install built-in skill file"
            );
            return None;
        }
    }
    let common = BUILTIN_ENTRYPOINTS
        .iter()
        .copied()
        .filter(|entrypoint| !is_project_manager_skill(entrypoint));
    if !install_entrypoint_manifest(root, ENTRYPOINT_MANIFEST, common) {
        return None;
    }
    if !install_entrypoint_manifest(
        root,
        PROJECT_MANAGER_ENTRYPOINT_MANIFEST,
        BUILTIN_ENTRYPOINTS.iter().copied(),
    ) {
        return None;
    }
    Some(root.to_path_buf())
}

fn install_entrypoint_manifest(
    root: &Path,
    name: &str,
    entrypoints: impl IntoIterator<Item = &'static str>,
) -> bool {
    let mut body = entrypoints.into_iter().collect::<Vec<_>>().join("\n");
    body.push('\n');
    let manifest = root.join(name);
    if std::fs::read(&manifest).ok().as_deref() == Some(body.as_bytes()) {
        return true;
    }
    if let Err(error) = install_file(&manifest, body.as_bytes()) {
        tracing::warn!(manifest = name, %error, "could not install built-in Skill entrypoint manifest");
        return false;
    }
    true
}

fn is_project_manager_skill(entrypoint: &str) -> bool {
    entrypoint
        .split('/')
        .next()
        .is_some_and(|name| name.starts_with(PROJECT_MANAGER_SKILL_PREFIX))
}

fn install_file(target: &Path, contents: &[u8]) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::other("built-in Skill file has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("builtin");
    // The daemon may be a WASI guest and therefore has no process id of its
    // own. The host pid is the product-wide process identity used for locks
    // and is safe for this atomic materialization name as well.
    let temporary = parent.join(format!(".{file_name}.{}.tmp", crate::host_pid::current()));
    std::fs::write(&temporary, contents)?;
    let installed = std::fs::rename(&temporary, target).or_else(|first_error| {
        if target.exists() {
            std::fs::remove_file(target)?;
            std::fs::rename(&temporary, target)
        } else {
            Err(first_error)
        }
    });
    if installed.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    installed
}

/// Load exactly the product-owned Skill entrypoints compiled into this daemon.
/// Unknown files in the data directory are never promoted into Agent context.
pub fn load(skills_root: &Path) -> Vec<Skill> {
    load_for_profile(skills_root, SkillProfile::Common)
}

pub fn load_for_profile(skills_root: &Path, profile: SkillProfile) -> Vec<Skill> {
    let mut skills = Vec::new();
    if materialize(skills_root).is_some() {
        for entrypoint in BUILTIN_ENTRYPOINTS {
            if profile == SkillProfile::Common && is_project_manager_skill(entrypoint) {
                continue;
            }
            if let Some(skill) = parse_skill_file(&skills_root.join(entrypoint)) {
                skills.push(skill);
            }
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// Artifact-link rules plus the Skill catalog, or just the rules when
/// this daemon has no skills directory.
pub fn session_guidance(
    skills_root: Option<&Path>,
    front_door_cli: Option<&Path>,
    profile: SkillProfile,
) -> String {
    let mut sections = vec![crate::session::artifact_links::guidance().to_string()];
    if profile == SkillProfile::ProjectManager {
        sections.push(PROJECT_MANAGER_AVAILABILITY_GUIDANCE.to_string());
    }
    if let Some(root) = skills_root {
        let catalog = format_catalog(&load_for_profile(root, profile), front_door_cli);
        if !catalog.is_empty() {
            sections.push(catalog);
        }
    }
    sections.join("\n\n")
}

pub fn work_session_result_guidance() -> &'static str {
    WORK_SESSION_RESULT_GUIDANCE
}

pub fn format_catalog(skills: &[Skill], front_door_cli: Option<&Path>) -> String {
    let visible: Vec<&Skill> = skills
        .iter()
        .filter(|skill| !skill.disable_model_invocation)
        .collect();
    if visible.is_empty() {
        return String::new();
    }

    let mut lines = vec![
        "GeneHub 以普通文件提供以下内置 Skill。任务匹配某个 Skill 的描述时，读取对应文件并遵循它；不要编造 Skill 名称、Session id 或通道命令。".to_string(),
        String::new(),
        match front_door_cli {
            Some(path) => format!(
                "<genehub_cli>{}</genehub_cli>",
                escape_xml(&path.to_string_lossy())
            ),
            None => "<genehub_cli unavailable=\"true\" />".to_string(),
        },
        "必须使用上面给出的 GeneHub CLI 精确路径；该路径也通过 GENEHUB_CLI 提供给 Agent。若不可用就停止，不要猜测 genet、genet-dev、genet-beta 或其他命令。".to_string(),
        String::new(),
        "<available_skills>".to_string(),
    ];
    for skill in visible {
        lines.push("  <skill>".to_string());
        lines.push(format!("    <name>{}</name>", escape_xml(&skill.name)));
        lines.push(format!(
            "    <description>{}</description>",
            escape_xml(&skill.description)
        ));
        lines.push(format!(
            "    <location>{}</location>",
            escape_xml(&skill.file_path.to_string_lossy())
        ));
        lines.push("  </skill>".to_string());
    }
    lines.push("</available_skills>".to_string());
    lines.join("\n")
}

fn parse_skill_file(path: &Path) -> Option<Skill> {
    let raw = std::fs::read_to_string(path).ok()?;
    let frontmatter = parse_frontmatter(&raw);
    let fallback_name = path
        .parent()
        .and_then(|parent| parent.file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = frontmatter
        .iter()
        .find(|(key, _)| key == "name")
        .map(|(_, value)| value.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_name);
    let description = frontmatter
        .iter()
        .find(|(key, _)| key == "description")
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    if name.is_empty() || name.len() > MAX_NAME_LENGTH {
        return None;
    }
    if description.trim().is_empty() || description.len() > MAX_DESCRIPTION_LENGTH {
        return None;
    }
    let disable_model_invocation = frontmatter
        .iter()
        .find(|(key, _)| key == "disable-model-invocation")
        .map(|(_, value)| value == "true")
        .unwrap_or(false);
    Some(Skill {
        name,
        description,
        file_path: path.to_path_buf(),
        disable_model_invocation,
    })
}

fn parse_frontmatter(raw: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("---") {
        return pairs;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        pairs.push((key.trim().to_string(), value.to_string()));
    }
    pairs
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "genet-daemon-skills-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_skill(dir: &Path, name: &str, body: &str) -> PathBuf {
        let skill_dir = dir.join(name);
        std::fs::create_dir_all(&skill_dir).unwrap();
        let path = skill_dir.join("SKILL.md");
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn session_history_is_materialized_under_the_daemon_skills_dir() {
        let root = temp_dir("builtin");
        let skills = load(&root);
        let skill = skills
            .iter()
            .find(|skill| skill.name == "genehub-session-history")
            .expect("built-in skill");
        assert!(skill.file_path.starts_with(&root));
        let body = std::fs::read_to_string(&skill.file_path).unwrap();
        assert!(body.contains("schema session.inspect"));
        assert!(body.contains("--through-round"));
        assert!(!body.contains("session inspect \"$GENEHUB_SESSION_ID\""));
    }

    #[test]
    fn unknown_data_dir_skill_is_not_in_the_genehub_catalog() {
        let root = temp_dir("unknown");
        write_skill(
            &root,
            "project-overlay",
            "---\nname: project-overlay\ndescription: Must stay outside the product catalog\n---\n",
        );
        let skills = load(&root);
        assert!(!skills.iter().any(|skill| skill.name == "project-overlay"));
    }

    #[test]
    fn catalog_lists_name_description_and_path() {
        let skills = vec![Skill {
            name: "demo".into(),
            description: "Handle <PDFs> & more".into(),
            file_path: PathBuf::from("/data/skills/demo/SKILL.md"),
            disable_model_invocation: false,
        }];
        let catalog = format_catalog(&skills, Some(Path::new("/opt/genehub/genet-dev")));
        assert!(catalog.contains("<available_skills>"));
        assert!(catalog.contains("<genehub_cli>/opt/genehub/genet-dev</genehub_cli>"));
        assert!(catalog.contains("<name>demo</name>"));
        assert!(catalog.contains("&lt;PDFs&gt; &amp; more"));
        assert!(catalog.contains("<location>/data/skills/demo/SKILL.md</location>"));
    }

    #[test]
    fn session_guidance_keeps_artifact_rules_and_appends_the_catalog() {
        let root = temp_dir("guidance");
        let prompt = session_guidance(
            Some(&root),
            Some(Path::new("/opt/genehub/genet-beta")),
            SkillProfile::Common,
        );
        assert!(prompt.contains("index.html"));
        assert!(prompt.contains("genehub-session-history"));
        assert!(prompt.contains("genehub-html-preview"));
        assert!(prompt.contains("genehub-speech-runtime"));
        assert!(prompt.contains("/opt/genehub/genet-beta"));
        assert!(prompt.contains("<available_skills>"));
    }

    #[test]
    fn session_guidance_without_a_root_is_artifact_rules_only() {
        let prompt = session_guidance(
            None,
            Some(Path::new("/opt/genehub/genet")),
            SkillProfile::Common,
        );
        assert!(prompt.contains("index.html"));
        assert!(!prompt.contains("available_skills"));
    }

    #[test]
    fn missing_cli_binding_is_explicit_and_never_guessed() {
        let root = temp_dir("no-cli");
        let prompt = session_guidance(Some(&root), None, SkillProfile::Common);
        assert!(prompt.contains("<genehub_cli unavailable=\"true\" />"));
    }

    #[test]
    fn channel_front_doors_must_be_absolute_and_are_never_renamed() {
        // Absolute paths are platform-shaped: Unix takes /opt/..., Windows
        // needs a drive letter. The contract is "absolute survives verbatim,
        // bare names are rejected", not one OS's path syntax.
        let paths: [&str; 3] = if cfg!(windows) {
            [
                r"C:\opt\genehub\dev\genet-dev.exe",
                r"C:\opt\genehub\beta\genet-beta.exe",
                r"C:\opt\genehub\stable\genet.exe",
            ]
        } else {
            [
                "/opt/genehub/dev/genet-dev",
                "/opt/genehub/beta/genet-beta",
                "/opt/genehub/stable/genet",
            ]
        };
        for path in paths {
            assert_eq!(
                normalize_front_door_cli(Some(path.into())),
                Some(PathBuf::from(path))
            );
        }
        assert_eq!(normalize_front_door_cli(Some("genet-dev".into())), None);
        assert_eq!(normalize_front_door_cli(Some("genet".into())), None);
        assert_eq!(normalize_front_door_cli(None), None);
    }
}
