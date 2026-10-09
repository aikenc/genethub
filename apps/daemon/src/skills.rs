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
    let raw = value.filter(|value| !value.is_empty())?;
    crate::guest_paths::inbound_absolute(PathBuf::from(raw))
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
    let mut entrypoints = BUILTIN_ENTRYPOINTS.join("\n");
    entrypoints.push('\n');
    let manifest = root.join(ENTRYPOINT_MANIFEST);
    if std::fs::read(&manifest).ok().as_deref() != Some(entrypoints.as_bytes()) {
        if let Err(error) = install_file(&manifest, entrypoints.as_bytes()) {
            tracing::warn!(%error, "could not install built-in Skill entrypoint manifest");
            return None;
        }
    }
    Some(root.to_path_buf())
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
    let mut skills = Vec::new();
    if materialize(skills_root).is_some() {
        for entrypoint in BUILTIN_ENTRYPOINTS {
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
///
/// `host_form_paths` spells the embedded paths for a native agent (the only
/// kind that opens them on the host filesystem); the built-in agent's
/// component child shares this daemon's preopen namespace and passes false.
pub fn session_guidance(
    skills_root: Option<&Path>,
    front_door_cli: Option<&Path>,
    host_form_paths: bool,
) -> String {
    let mut artifact = crate::session::artifact_links::guidance().to_string();
    // §6.3, fb_IXUzjtBuA4wt: an agent ended its own host with `ps | grep | kill`.
    artifact.push_str("\n\nProcess safety: $GENEHUB_AGENT_PID is this Agent's process and $GENEHUB_HOST_PID the GeneHub daemon. Before ending any process, exclude these pids and their ancestors; find the target by its pid file or listening port rather than a broad `ps | grep | kill` or `pkill -f`, since a pattern can match this Agent's own command line.");
    if front_door_cli.is_some() {
        artifact.push_str("\n\nGeneHub conversation interactions: for a non-secret input box or choices in this conversation, use the native request_user_input tool if available, or the platform CLI: \"$GENEHUB_CLI\" session ask \"$GENEHUB_SESSION_ID\" --request-id <stable-question-id> --question <prompt> --choice <label> --choice <label>. Text input is enabled by default. This saves the question and stops the current execution; do not poll or wait for the answer. The Human answer resumes a new execution in the same Session. Reuse an id only for the identical question. An HTML preview page does not submit conversation answers. Do not request API keys, device codes or credentials here. For GeneHub model providers, use provider list and provider configure with --session $GENEHUB_SESSION_ID, --action <stable-id>, --base-url, --dialect and --label; use --model for gateways without discovery. This creates a workbench configuration card and stops the execution. The Human enters credentials directly to the daemon, then the original Session resumes. Use provider get and provider verify to inspect the durable receipt, never read config.json or modify unrelated Claude/Codex settings. context.authority reports actual permissions; a sessionController can prepare the operation without Settings. Confirm availability through the bound CLI's capabilities/schema; never invent a missing command. Read-only Workflow child sessions use the existing Workflow Human exit instead.");
    }
    let Some(root) = skills_root else {
        return artifact;
    };
    let catalog = format_catalog(&load(root), front_door_cli, host_form_paths);
    if catalog.is_empty() {
        artifact
    } else {
        format!("{artifact}\n\n{catalog}")
    }
}

/// Proposal §6.4 for the Skills this daemon catalogs, across every Agent: a
/// prompt naming one gets a pointer to its file, once per session (`already`
/// carries the names reminded so far). The catalog alone leaves reading to
/// the model, which skipped a Skill its imported history named eight times.
/// Names match as whole tokens in their own case, so the product name in
/// prose or in a path does not trigger the `genehub` Skill.
pub fn mention_reminder(
    skills_root: &Path,
    text: &str,
    already: &mut std::collections::HashSet<String>,
    host_form_paths: bool,
) -> Option<String> {
    let tokens: std::collections::HashSet<&str> = text
        .split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_'))
        .filter(|token| !token.is_empty())
        .collect();
    let notes: Vec<String> = load(skills_root)
        .into_iter()
        .filter(|skill| !skill.disable_model_invocation && tokens.contains(skill.name.as_str()))
        .filter(|skill| already.insert(skill.name.clone()))
        .map(|skill| {
            let path = skill.file_path.to_string_lossy();
            let path = if host_form_paths {
                crate::guest_paths::host_form(&path).into_owned()
            } else {
                path.into_owned()
            };
            format!(
                "<skill_reminder name=\"{}\">This request names the GeneHub Skill `{}`. If you have not read `{}` in this session, read it before acting and follow it.</skill_reminder>",
                escape_xml(&skill.name),
                escape_xml(&skill.name),
                escape_xml(&path)
            )
        })
        .collect();
    (!notes.is_empty()).then(|| notes.join("\n"))
}

pub fn format_catalog(
    skills: &[Skill],
    front_door_cli: Option<&Path>,
    host_form_paths: bool,
) -> String {
    let visible: Vec<&Skill> = skills
        .iter()
        .filter(|skill| !skill.disable_model_invocation)
        .collect();
    if visible.is_empty() {
        return String::new();
    }

    // One path as the payload's consumer must spell it.
    let spelled = |path: &Path| -> String {
        if host_form_paths {
            crate::guest_paths::host_form(&path.to_string_lossy()).into_owned()
        } else {
            path.to_string_lossy().into_owned()
        }
    };

    let mut lines = vec![
        "GeneHub provides these built-in Skills as ordinary files. When a task matches a skill description, read that file and follow it. Do not invent skill names, session ids, or channel commands.".to_string(),
        String::new(),
        match front_door_cli {
            Some(path) => format!("<genehub_cli>{}</genehub_cli>", escape_xml(&spelled(path))),
            None => "<genehub_cli unavailable=\"true\" />".to_string(),
        },
        "Use exactly the GeneHub CLI path above. It is also exported to the Agent as GENEHUB_CLI. If unavailable, stop instead of guessing genet, genet-dev, genet-beta, or another command.".to_string(),
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
            escape_xml(&spelled(&skill.file_path))
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
    fn introspect_is_materialized_under_the_daemon_skills_dir() {
        let root = temp_dir("builtin");
        let skills = load(&root);
        let skill = skills
            .iter()
            .find(|skill| skill.name == "genehub-introspect")
            .expect("built-in skill");
        assert!(skill.file_path.starts_with(&root));
        let body = std::fs::read_to_string(&skill.file_path).unwrap();
        assert!(body.contains("schema session.inspect"));
        assert!(body.contains("--through-round"));
        assert!(!body.contains("session inspect \"$GENEHUB_SESSION_ID\""));
    }

    #[test]
    fn a_prompt_naming_a_built_in_skill_points_at_its_file_once() {
        let root = temp_dir("mention");
        let mut already = std::collections::HashSet::new();
        let reminder = mention_reminder(
            &root,
            "按 genehub-preview 的要求做个看板",
            &mut already,
            false,
        )
        .expect("a reminder");
        assert!(reminder.contains("genehub-preview/SKILL.md"), "{reminder}");
        assert!(
            !reminder.contains("Asset Preview"),
            "the body stays out of the prompt"
        );
        assert!(mention_reminder(&root, "genehub-preview 再来", &mut already, false).is_none());
        // The product name in prose or a path is not the `genehub` Skill.
        for text in [
            "GeneHub 的预览",
            "~/.local/share/GeneHub-beta/builtin-skills",
        ] {
            assert!(
                mention_reminder(&root, text, &mut already, false).is_none(),
                "{text}"
            );
        }
    }

    #[test]
    fn all_product_built_ins_and_references_are_materialized() {
        let root = temp_dir("all-builtins");
        let skills = load(&root);
        for file in BUILTIN_FILES {
            assert_eq!(
                std::fs::read(root.join(file.relative_path)).unwrap(),
                file.contents
            );
        }
        let entrypoints = std::fs::read_to_string(root.join(ENTRYPOINT_MANIFEST)).unwrap();
        assert_eq!(entrypoints.lines().collect::<Vec<_>>(), BUILTIN_ENTRYPOINTS);
        let mut names: Vec<&str> = skills.iter().map(|skill| skill.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                "genehub",
                "genehub-introspect",
                "genehub-preview",
                "pm-project-bootstrap",
                "project-manager",
            ],
            "the product catalog is exactly these five Skills; capability detail belongs in references"
        );
        // Capabilities folded into the hub stay reachable as references, not Skills.
        let hub = skills
            .iter()
            .find(|skill| skill.name == "genehub")
            .expect("hub built-in");
        let hub_dir = hub.file_path.parent().unwrap();
        for reference in [
            "multi-machine.md",
            "daemon.md",
            "daemon-restart.md",
            "client-debug.md",
            "client-debug-commands.md",
            "speech-runtime.md",
            "speech-models.md",
            "speech-runtime-contract.md",
        ] {
            assert!(
                hub_dir.join("references").join(reference).is_file(),
                "genehub reference {reference} is missing"
            );
        }
        let preview = skills
            .iter()
            .find(|skill| skill.name == "genehub-preview")
            .expect("preview built-in");
        let preview_dir = preview.file_path.parent().unwrap();
        for reference in ["static.md", "live-service.md", "getting-started.md"] {
            assert!(preview_dir.join("references").join(reference).is_file());
        }
        assert!(preview_dir.join("assets/python-adapter/app.py").is_file());
    }

    #[test]
    fn the_hub_routes_multi_machine_work_and_gates_disruptive_actions() {
        let root = temp_dir("hub-routing");
        let skills = load(&root);
        let hub = skills
            .iter()
            .find(|skill| skill.name == "genehub")
            .expect("hub built-in");
        let body = std::fs::read_to_string(&hub.file_path).unwrap();
        for needle in [
            "references/multi-machine.md",
            "references/daemon-restart.md",
            "references/client-debug.md",
            "references/speech-runtime.md",
            "genehub-preview",
            "genehub-introspect",
            "machineNotPaired",
            "--machine",
        ] {
            assert!(body.contains(needle), "the hub no longer mentions {needle}");
        }
        for trigger in [
            "--machine",
            "shell",
            "daemon",
            "联调",
            "语音识别",
            "genehub-preview",
            "genehub-introspect",
        ] {
            assert!(
                hub.description.contains(trigger),
                "the hub description lost its trigger {trigger}: it is the only text every session sees"
            );
        }
        let multi = std::fs::read_to_string(
            hub.file_path
                .parent()
                .unwrap()
                .join("references/multi-machine.md"),
        )
        .unwrap();
        assert!(multi.contains("machineNotPaired"));
        assert!(multi.contains("--cwd"));
        assert!(multi.contains("不带 `--grant` 的邀请是不受限设备"));
    }

    #[test]
    fn every_relative_markdown_link_in_the_built_ins_resolves() {
        let root = temp_dir("link-integrity");
        let _ = load(&root);
        let mut checked = 0;
        for file in BUILTIN_FILES {
            // Authored Skill text only; bundled third-party packages ship their own READMEs.
            let authored = file.relative_path.ends_with("/SKILL.md")
                || file.relative_path.contains("/references/");
            if !authored || !file.relative_path.ends_with(".md") {
                continue;
            }
            let text = String::from_utf8_lossy(file.contents);
            let base = Path::new(file.relative_path).parent().unwrap();
            let mut fenced = false;
            for line in text.lines() {
                if line.trim_start().starts_with("```") {
                    fenced = !fenced;
                    continue;
                }
                if fenced {
                    continue;
                }
                let mut from = 0;
                while let Some(offset) = line[from..].find("](") {
                    let open = from + offset;
                    let after = &line[open + 2..];
                    let Some(close) = after.find(')') else { break };
                    from = open + 2 + close;
                    // A link example inside an inline code span is prose, not a link.
                    if line[..open].matches('`').count() % 2 == 1 {
                        continue;
                    }
                    let target = after[..close].split('#').next().unwrap_or("");
                    if target.is_empty() || target.contains("://") || target.starts_with("mailto:")
                    {
                        continue;
                    }
                    // Repository-relative links only make sense in docs, never in an installed Skill.
                    assert!(
                        !target.starts_with("../../"),
                        "{} links outside the installed Skill tree: {target}",
                        file.relative_path
                    );
                    assert!(
                        root.join(base).join(target).exists(),
                        "{} has a dangling link: {target}",
                        file.relative_path
                    );
                    checked += 1;
                }
            }
        }
        assert!(
            checked > 10,
            "link check saw too few links ({checked}); the scan is broken"
        );
    }

    #[test]
    fn pm_bootstrap_uses_the_session_bound_human_approval_request() {
        let root = temp_dir("pm-bootstrap-interaction");
        let skills = load(&root);
        let skill = skills
            .iter()
            .find(|skill| skill.name == "pm-project-bootstrap")
            .expect("PM bootstrap built-in");
        let body = std::fs::read_to_string(&skill.file_path).unwrap();

        assert!(body.contains("space approval request --challenge <challengeId>"));
        assert!(body.contains("only submits a durable approval request"));
        assert!(body.contains("authenticated Human answers"));
        assert!(body.contains("ordinary chat"));
        assert!(body.contains("stops this Agent turn"));
        assert!(body.contains("command success is not approval"));
        assert!(body.contains("stable action ID"));
        assert!(!body.contains("Keep this command attached"));
        assert!(!body.contains("request_user_input"));
        assert!(!body.contains("AskQuestion"));
    }

    #[test]
    fn project_manager_treats_flush_as_an_intelligence_tier() {
        let root = temp_dir("pm-tiers");
        let skills = load(&root);
        let skill = skills
            .iter()
            .find(|skill| skill.name == "project-manager")
            .expect("PM built-in");
        let body = std::fs::read_to_string(&skill.file_path).unwrap();
        assert!(body.contains("Platform model tiers"));
        assert!(body.contains("routing tags, not model ids"));
        assert!(body.contains("workflowTagRouteUnavailable"));
        assert!(body.contains("The tag is spelled Flash"));
        assert!(body.contains("Flush is not accepted"));
        assert!(body.contains("--workflow workflow-improvement"));
        assert!(body.contains("preserving existing media tags"));
    }

    #[test]
    fn workflow_manager_keeps_intelligence_tiers_on_role_tags() {
        let body = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join(
                "workflow-packages/game-delivery/spaces/workflow-manager/skills/workflow-manager/SKILL.md",
            ),
        )
        .unwrap();
        assert!(body.contains("platform intelligence-tier tags"));
        assert!(body.contains("change only the intelligence tag"));
        assert!(body.contains("Do not pin `agentId` or `modelId`"));
        assert!(body.contains("`Flush` is not a tag"));
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
        let catalog = format_catalog(&skills, Some(Path::new("/opt/genehub/genet-dev")), false);
        assert!(catalog.contains("<available_skills>"));
        assert!(catalog.contains("<genehub_cli>/opt/genehub/genet-dev</genehub_cli>"));
        assert!(catalog.contains("<name>demo</name>"));
        assert!(catalog.contains("&lt;PDFs&gt; &amp; more"));
        assert!(catalog.contains("<location>/data/skills/demo/SKILL.md</location>"));
        assert!(catalog.contains("Do not invent skill names"));
    }

    #[test]
    fn the_host_form_flag_reaches_both_embedded_paths() {
        // The guest→host translation itself is gated to a wasm build on a
        // Windows host, so natively host_form is the identity; this pins that
        // the flag flows to <genehub_cli> and every <location> alike.
        let skills = vec![Skill {
            name: "demo".into(),
            description: "demo".into(),
            file_path: PathBuf::from("/e/data/skills/demo/SKILL.md"),
            disable_model_invocation: false,
        }];
        let cli = Path::new("/e/opt/genehub/genet-beta");
        let catalog = format_catalog(&skills, Some(cli), true);
        let spelled =
            |path: &Path| crate::guest_paths::host_form(&path.to_string_lossy()).into_owned();
        assert!(catalog.contains(&format!("<genehub_cli>{}</genehub_cli>", spelled(cli))));
        assert!(catalog.contains(&format!(
            "<location>{}</location>",
            spelled(&skills[0].file_path)
        )));
    }

    #[test]
    fn session_guidance_keeps_artifact_rules_and_appends_the_catalog() {
        let root = temp_dir("guidance");
        let prompt = session_guidance(
            Some(&root),
            Some(Path::new("/opt/genehub/genet-beta")),
            false,
        );
        assert!(prompt.contains("index.html"));
        assert!(prompt.contains("genehub-introspect"));
        assert!(prompt.contains("genehub-preview"));
        assert!(prompt.contains("--machine"));
        assert!(!prompt.contains("genehub-speech-runtime"));
        assert!(!prompt.contains("genehub-html-preview"));
        assert!(prompt.contains("/opt/genehub/genet-beta"));
        assert!(prompt.contains("<available_skills>"));
    }

    #[test]
    fn session_guidance_without_a_root_is_artifact_rules_only() {
        let prompt = session_guidance(None, Some(Path::new("/opt/genehub/genet")), false);
        assert!(prompt.contains("index.html"));
        assert!(!prompt.contains("available_skills"));
    }

    #[test]
    fn missing_cli_binding_is_explicit_and_never_guessed() {
        let root = temp_dir("no-cli");
        let prompt = session_guidance(Some(&root), None, false);
        assert!(prompt.contains("<genehub_cli unavailable=\"true\" />"));
        assert!(prompt.contains("stop instead of guessing"));
    }

    #[test]
    fn channel_front_doors_must_be_absolute_and_are_never_renamed() {
        // Production daemon is wasm: Windows `C:\` / `\\?\C:\` are rewritten
        // by inbound_absolute (see guest_paths). Bare channel names stay
        // rejected so a PATH hit cannot pick another install.
        #[cfg(not(windows))]
        let paths = [
            "/opt/genehub/dev/genet-dev",
            "/opt/genehub/beta/genet-beta",
            "/opt/genehub/stable/genet",
        ];
        #[cfg(windows)]
        let paths = [
            r"C:\GeneHub\dev\genet-dev.exe",
            r"C:\GeneHub\beta\genet-beta.exe",
            r"C:\GeneHub\stable\genet.exe",
        ];
        for path in paths {
            assert_eq!(
                normalize_front_door_cli(Some(path.into())),
                Some(PathBuf::from(path))
            );
        }
        assert_eq!(normalize_front_door_cli(Some("genet-dev".into())), None);
        assert_eq!(normalize_front_door_cli(Some("genet".into())), None);
        assert_eq!(normalize_front_door_cli(Some("genet-beta".into())), None);
        assert_eq!(normalize_front_door_cli(None), None);
    }
}
