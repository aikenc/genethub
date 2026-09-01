//! PM-only Agent Space Builder commands.

use std::path::{Component, PathBuf};

use serde_json::json;

use crate::agent_space_builder::{self, Command};
use crate::pm_domain::project::{ProjectLifecycle, ProjectPhase};

use super::output::{self, CliFailure};
use super::pm_project::Context;

pub async fn run(args: &[String]) -> i32 {
    match execute(args).await {
        Ok(data) => output::succeed("agent-space.builder", data),
        Err(error) => output::fail(error),
    }
}

async fn execute(args: &[String]) -> Result<serde_json::Value, CliFailure> {
    let parsed = Args::parse(args)?;
    let context = Context::load().await?;
    let project = context.project().await?;
    require_git_ready(project.phase)?;
    let root = space_root(&context.root, &parsed.space)?;

    if parsed.mutates() {
        if project.lifecycle != ProjectLifecycle::Active {
            return Err(CliFailure::business(
                "pmProjectNotActive",
                "Agent Space writes require an active PM project lifecycle",
                Some(json!({"lifecycle": project.lifecycle})),
            ));
        }
        if matches!(parsed.command, Command::Clean)
            && project.agent_spaces.values().any(|space| {
                space.name == parsed.space
                    || space.source_path.canonicalize().ok().as_ref()
                        == root.canonicalize().ok().as_ref()
            })
        {
            return Err(CliFailure::business(
                "registeredAgentSpaceProtected",
                "a registered Agent Space cannot be cleaned or deleted in the MVP",
                Some(json!({"space": parsed.space})),
            ));
        }
    }

    let command_name = parsed.command_name();
    agent_space_builder::run(
        &context.root,
        &root,
        parsed.command,
        parsed.require_no_post_commands,
    )
    .map(|report| json!({"report": report}))
    .map_err(|error| builder_rejected(command_name, &root, error))
}

fn require_git_ready(phase: ProjectPhase) -> Result<(), CliFailure> {
    if matches!(
        phase,
        ProjectPhase::GitReady
            | ProjectPhase::TopologyVerified
            | ProjectPhase::WorkspacesRegistered
            | ProjectPhase::Active
    ) {
        Ok(())
    } else {
        Err(CliFailure::business(
            "pmProjectNotGitReady",
            "Agent Space planning starts only after the PM project reaches git-ready",
            Some(json!({"phase": phase})),
        ))
    }
}

fn space_root(project_root: &std::path::Path, value: &str) -> Result<PathBuf, CliFailure> {
    let path = std::path::Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err(CliFailure::invalid_args(
            "<space> must be one exact Agent Space directory name under project spaces/",
        ));
    }
    Ok(project_root.join("spaces").join(path))
}

fn builder_rejected(
    command: &'static str,
    root: &std::path::Path,
    error: agent_space_builder::BuilderError,
) -> CliFailure {
    let diagnostic = error.0;
    CliFailure::business(
        "agentSpaceBuilderRejected",
        format!("{}: {}", diagnostic.code, diagnostic.message),
        Some(json!({
            "report": {
                "schema": agent_space_builder::REPORT_SCHEMA,
                "builderVersion": agent_space_builder::VERSION,
                "command": command,
                "status": "error",
                "pipespaceRoot": root,
                "diagnostics": [diagnostic],
                "summary": {},
            }
        })),
    )
}

#[derive(Debug)]
struct Args {
    command: Command,
    space: String,
    require_no_post_commands: bool,
}

impl Args {
    fn parse(args: &[String]) -> Result<Self, CliFailure> {
        let Some(verb) = args.first().map(String::as_str) else {
            return Err(Self::usage());
        };
        let mut space = None;
        let mut dry_run = false;
        let mut require_no_post_commands = false;
        for argument in &args[1..] {
            match argument.as_str() {
                "--dry-run" if verb == "build" && !dry_run => dry_run = true,
                "--require-no-post-commands" if verb == "build" && !require_no_post_commands => {
                    require_no_post_commands = true
                }
                value if value.starts_with('-') => {
                    return Err(CliFailure::invalid_args(format!(
                        "unknown or duplicate Agent Space option: {value}"
                    )))
                }
                value if space.is_none() => space = Some(value.to_string()),
                _ => return Err(Self::usage()),
            }
        }
        let space = space.ok_or_else(Self::usage)?;
        let command = match verb {
            "init" => Command::Init,
            "check" => Command::Check,
            "explain" => Command::Explain,
            "build" => Command::Build { dry_run },
            "verify" => Command::Verify,
            "clean" => Command::Clean,
            _ => return Err(Self::usage()),
        };
        if verb != "build" && (dry_run || require_no_post_commands) {
            return Err(Self::usage());
        }
        Ok(Self {
            command,
            space,
            require_no_post_commands,
        })
    }

    fn usage() -> CliFailure {
        CliFailure::invalid_args(
            "usage: genet agent-space init|check|explain|verify|clean <space> | build <space> [--dry-run] [--require-no-post-commands]",
        )
    }

    fn mutates(&self) -> bool {
        matches!(
            self.command,
            Command::Init | Command::Build { dry_run: false } | Command::Clean
        )
    }

    fn command_name(&self) -> &'static str {
        match self.command {
            Command::Init => "init",
            Command::Check => "check",
            Command::Explain => "explain",
            Command::Build { dry_run: true } => "build --dry-run",
            Command::Build { dry_run: false } => "build",
            Command::Verify => "verify",
            Command::Clean => "clean",
        }
    }
}
