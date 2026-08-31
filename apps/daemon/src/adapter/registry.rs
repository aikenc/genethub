//! Which agents exist on this machine, and what they can do.

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use genehub_proto::{
    AgentInfo, AgentSetup, ApiKeyGuide, ApiKeyKind, EnvVarGuide, GuidePlatform, InstallMethod,
    LoginGuide, ProbeState,
};
use tokio::sync::RwLock;

use super::acp::{AcpAdapter, AuthStatusProbe};
use super::claude::ClaudeAdapter;
use super::codex::CodexAdapter;
use super::genet::GenetAdapter;
use super::opencode::OpenCodeAdapter;
use super::{ProviderMap, SharedAdapter};
use crate::config::CustomAgent;

pub struct Registry {
    adapters: Vec<SharedAdapter>,
    cache: RwLock<Option<Vec<AgentInfo>>>,
    /// Versions, remembered once asked: the binary cannot change under a
    /// running daemon, but `--version` costs a process spawn and the setup
    /// wizard polls `refresh` while the user is signing in.
    versions: RwLock<BTreeMap<String, Option<String>>>,
}

fn cursor_command() -> Vec<String> {
    [
        "cursor-agent",
        "--force",
        "--sandbox",
        "disabled",
        "--trust",
        "--approve-mcps",
        "acp",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// Cursor's official setup, from docs.cursor.com/cli and `cursor-agent
/// --help`: the install script is Unix-only (its docs name no Windows
/// command), sign-in is a browser flow, and `status --format json` answers
/// `isAuthenticated` for the badge.
fn cursor_setup() -> AgentSetup {
    AgentSetup {
        install: vec![InstallMethod {
            label: "官方安装脚本".into(),
            platforms: vec![GuidePlatform::Macos, GuidePlatform::Linux],
            command: "curl https://cursor.com/install -fsS | bash".into(),
        }],
        login: Some(LoginGuide {
            command: "cursor-agent login".into(),
            opens_browser: true,
            hint: "浏览器会打开 Cursor 账号登录页，完成后这里会自动识别。".into(),
        }),
        api_key: Some(ApiKeyGuide {
            kind: ApiKeyKind::Environment,
            command: None,
            env_vars: vec![EnvVarGuide {
                name: "CURSOR_API_KEY".into(),
                purpose: "在 Cursor 网页后台生成的 API Key".into(),
            }],
            key_url: None,
            hint: "环境变量要重启 GeneHub 后才对这里启动的 Cursor 生效；订阅用户用上面的登录即可。"
                .into(),
        }),
        docs_url: Some("https://docs.cursor.com/cli".into()),
    }
}

fn cursor_auth_probe() -> AuthStatusProbe {
    AuthStatusProbe {
        args: ["status", "--format", "json"]
            .into_iter()
            .map(str::to_string)
            .collect(),
        json_field: "isAuthenticated".into(),
    }
}

/// The OS this daemon — and therefore every agent it probes and every
/// terminal it opens — runs on. Sent to clients so the wizard can offer the
/// install command that can actually execute here.
fn host_platform() -> GuidePlatform {
    if cfg!(windows) {
        GuidePlatform::Windows
    } else if cfg!(target_os = "macos") {
        GuidePlatform::Macos
    } else {
        GuidePlatform::Linux
    }
}

impl Registry {
    /// Builds the adapter set: the built-ins, plus whatever the user declared.
    pub fn new(custom: &BTreeMap<String, CustomAgent>) -> Self {
        let mut adapters: Vec<SharedAdapter> = vec![
            Arc::new(GenetAdapter::discover()),
            Arc::new(OpenCodeAdapter),
            // Claude Code is spoken natively (`adapter::claude`): its own
            // `stream-json` stdio protocol, not the `claude-agent-acp`
            // wrapper. Going native buys back per-tool permission control
            // that ACP does not expose to a client; see that module's doc
            // comment for the reverse-engineered protocol notes.
            Arc::new(ClaudeAdapter::default()),
            // Codex likewise (`adapter::codex`): its own `app-server`
            // JSON-RPC, not `codex-acp`. Which also removes an install step
            // nobody could guess at — this entry used to report "not
            // installed" to anyone who had `codex` but not the bridge.
            Arc::new(CodexAdapter::default()),
            // Cursor, spoken as ACP (`cursor-agent acp`): the protocol its CLI
            // publishes for exactly this kind of embedding. Launch flags give
            // the CLI maximum authority; any residual ACP permission request
            // becomes a durable stopped interaction in the session manager.
            Arc::new(
                AcpAdapter::new("cursor", "Cursor", cursor_command())
                    .with_setup(cursor_setup())
                    .with_auth_status(cursor_auth_probe()),
            ),
            // A generic ACP entry so any other ACP-speaking CLI on PATH works
            // with no configuration at all.
            Arc::new(AcpAdapter::new(
                "acp",
                "ACP agent",
                vec!["acp-agent".into()],
            )),
        ];

        for (id, agent) in custom {
            match agent.extends.as_str() {
                "acp" => adapters.push(Arc::new(AcpAdapter::new(
                    format!("acp:{id}"),
                    agent.label.clone().unwrap_or_else(|| id.clone()),
                    agent.command.clone(),
                ))),
                other => {
                    tracing::warn!("ignoring custom agent '{id}': unknown base adapter '{other}'");
                }
            }
        }

        Registry {
            adapters,
            cache: RwLock::new(None),
            versions: RwLock::new(BTreeMap::new()),
        }
    }

    pub fn get(&self, id: &str) -> Option<SharedAdapter> {
        self.adapters
            .iter()
            .find(|adapter| adapter.id() == id)
            .cloned()
    }

    pub fn require(&self, id: &str) -> Result<SharedAdapter> {
        self.get(id)
            .ok_or_else(|| anyhow!("no adapter registered for '{id}'"))
    }

    /// Probes every adapter and caches the result.
    ///
    /// Probing spawns processes, so the agent picker must not do it on every
    /// open; `refresh` exists for when the user installs something.
    pub async fn list(&self, providers: &ProviderMap) -> Vec<AgentInfo> {
        if let Some(cached) = self.cache.read().await.clone() {
            return cached;
        }
        self.refresh(providers).await
    }

    pub async fn refresh(&self, providers: &ProviderMap) -> Vec<AgentInfo> {
        let mut infos = Vec::new();
        for adapter in &self.adapters {
            let probe = adapter.probe().await;
            // Cataloguing an absent agent would spawn a process that is not
            // there; skip straight to an empty catalog. Version and sign-in
            // questions are skipped for the same reason.
            let catalog = if matches!(probe, ProbeState::Ready) {
                adapter.catalog(providers).await
            } else {
                Default::default()
            };
            // Sign-in is asked even of an absent binary: every adapter answers
            // Unknown for one without spawning anything, and the built-in
            // agent's NotApplicable is true whether or not it is on disk.
            let auth = adapter.auth().await;
            let version = if matches!(probe, ProbeState::NotInstalled) {
                None
            } else {
                self.version_of(adapter.as_ref()).await
            };
            infos.push(AgentInfo {
                id: adapter.id().to_string(),
                label: adapter.label().to_string(),
                probe,
                capabilities: adapter.capabilities(),
                catalog,
                builtin: adapter.builtin(),
                platform: host_platform(),
                version,
                auth,
                setup: adapter.setup(),
            });
        }
        *self.cache.write().await = Some(infos.clone());
        infos
    }

    /// The version an adapter reported, asked at most once per daemon run: the
    /// binary cannot change under us, but the question costs a process spawn
    /// and `refresh` is polled while the setup wizard is open.
    async fn version_of(&self, adapter: &dyn super::AgentAdapter) -> Option<String> {
        if let Some(known) = self.versions.read().await.get(adapter.id()) {
            return known.clone();
        }
        let asked = adapter.version().await;
        self.versions
            .write()
            .await
            .insert(adapter.id().to_string(), asked.clone());
        asked
    }

    /// Agents the user can actually pick right now.
    pub async fn available(&self, providers: &ProviderMap) -> Vec<AgentInfo> {
        self.list(providers)
            .await
            .into_iter()
            .filter(|agent| matches!(agent.probe, ProbeState::Ready))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use genehub_proto::AuthState;

    use super::*;

    #[tokio::test]
    async fn the_built_in_agent_is_always_registered_and_marked_builtin() {
        let registry = Registry::new(&BTreeMap::new());
        let genet = registry.get("genet").expect("the built-in agent");
        assert!(genet.builtin());
        assert!(!registry.get("opencode").unwrap().builtin());
    }

    /// Both are registered by default so users never have to hand-write a
    /// config entry just to reach a CLI this common
    /// (`docs/architecture.md` §3), and both are spoken natively: the only
    /// thing either one needs installed is itself. Registering Codex through
    /// the ACP wrapper used to mean telling someone who had `codex` that Codex
    /// was not installed, because a bridge package was missing.
    #[tokio::test]
    async fn claude_and_codex_are_registered_out_of_the_box() {
        let registry = Registry::new(&BTreeMap::new());
        let claude = registry.get("claude").expect("claude is registered");
        assert!(!claude.builtin());
        assert_eq!(claude.label(), "Claude Code");
        // Native, not the ACP wrapper: real per-tool permission control.
        assert!(claude.capabilities().permissions);
        assert!(claude.capabilities().resume);
        let codex = registry.get("codex").expect("codex is registered");
        assert!(!codex.builtin());
        assert_eq!(codex.label(), "Codex");
        assert!(codex.capabilities().permissions);
        // Three separate pickers, all of them real: this CLI takes the model,
        // the thinking level and the approval policy on every turn.
        assert!(codex.capabilities().set_model);
        assert!(codex.capabilities().set_effort);
        assert!(codex.capabilities().set_mode);
        assert!(codex.capabilities().resume);
        assert!(codex.capabilities().attachments);
        assert!(codex.capabilities().fork);
    }

    /// Cursor ships in the default set too (`docs/desktop-client.md` promises
    /// the picker detects a locally installed Cursor CLI), spoken as ACP rather
    /// than through a hand-written config entry.
    #[tokio::test]
    async fn cursor_is_registered_out_of_the_box() {
        let registry = Registry::new(&BTreeMap::new());
        let cursor = registry.get("cursor").expect("cursor is registered");
        assert!(!cursor.builtin());
        assert_eq!(cursor.label(), "Cursor");
        // Mode switching and pasted images both come through ACP. Residual
        // permission requests are supported as durable stopped interactions.
        assert!(cursor.capabilities().permissions);
        assert!(cursor.capabilities().set_model);
        assert!(cursor.capabilities().set_mode);
        assert!(cursor.capabilities().attachments);
        // Probing is honest either way: ready when `cursor-agent` is on PATH,
        // not installed when it is not — never an error the picker chokes on.
        assert!(matches!(
            cursor.probe().await,
            ProbeState::Ready | ProbeState::NotInstalled
        ));
    }

    #[test]
    fn cursor_cli_is_launched_with_maximum_authority() {
        assert_eq!(
            cursor_command(),
            [
                "cursor-agent",
                "--force",
                "--sandbox",
                "disabled",
                "--trust",
                "--approve-mcps",
                "acp",
            ]
        );
    }

    #[tokio::test]
    async fn a_custom_acp_agent_is_registered_without_code_changes() {
        let mut custom = BTreeMap::new();
        custom.insert(
            "goose".to_string(),
            CustomAgent {
                extends: "acp".into(),
                command: vec!["goose".into(), "acp".into()],
                label: Some("Goose".into()),
            },
        );
        let registry = Registry::new(&custom);
        let agent = registry.get("acp:goose").expect("the custom agent");
        assert_eq!(agent.label(), "Goose");
    }

    #[tokio::test]
    async fn a_custom_agent_on_an_unknown_base_is_skipped_not_fatal() {
        let mut custom = BTreeMap::new();
        custom.insert(
            "weird".to_string(),
            CustomAgent {
                extends: "telepathy".into(),
                command: vec!["weird".into()],
                label: None,
            },
        );
        let registry = Registry::new(&custom);
        assert!(registry.get("acp:weird").is_none());
        assert!(registry.get("genet").is_some(), "the rest still load");
    }

    /// An agent that is not installed must disappear from the picker rather
    /// than appear and fail on click (`docs/testing.md` §4.2).
    #[tokio::test]
    async fn agents_that_are_not_installed_are_filtered_out_of_the_picker() {
        let registry = Registry::new(&BTreeMap::new());
        let providers = ProviderMap::new();
        let all = registry.refresh(&providers).await;
        let available = registry.available(&providers).await;

        assert!(all.iter().any(|a| a.id == "opencode"));
        for agent in &available {
            assert!(matches!(agent.probe, ProbeState::Ready));
        }
        assert!(available.len() <= all.len());
    }

    #[tokio::test]
    async fn requiring_an_unknown_adapter_is_an_error_not_a_panic() {
        let registry = Registry::new(&BTreeMap::new());
        assert!(registry.require("nope").is_err());
    }

    /// Every agent carries the guide the wizard renders from, and the platform
    /// the commands must run on. The built-in agent points at the provider
    /// form; the CLI entries point at their own official flows.
    #[tokio::test]
    async fn every_agent_carries_a_setup_guide_and_the_host_platform() {
        let registry = Registry::new(&BTreeMap::new());
        let infos = registry.refresh(&ProviderMap::new()).await;

        let expected = if cfg!(windows) {
            GuidePlatform::Windows
        } else if cfg!(target_os = "macos") {
            GuidePlatform::Macos
        } else {
            GuidePlatform::Linux
        };
        for info in &infos {
            assert_eq!(info.platform, expected, "{} reports the wrong OS", info.id);
        }

        let genet = infos.iter().find(|a| a.id == "genet").expect("genet");
        assert_eq!(genet.auth, AuthState::NotApplicable);
        assert!(
            genet.setup.install.is_empty(),
            "the built-in agent ships installed"
        );
        assert_eq!(
            genet.setup.api_key.as_ref().map(|guide| guide.kind),
            Some(ApiKeyKind::BuiltinProvider)
        );

        let claude = infos.iter().find(|a| a.id == "claude").expect("claude");
        assert!(
            claude
                .setup
                .install
                .iter()
                .any(|method| method.command.contains("https://claude.ai/install.sh")),
            "Claude's official install script is missing"
        );
        assert_eq!(
            claude
                .setup
                .login
                .as_ref()
                .map(|login| login.command.as_str()),
            Some("claude auth login")
        );

        let codex = infos.iter().find(|a| a.id == "codex").expect("codex");
        assert_eq!(
            codex
                .setup
                .api_key
                .as_ref()
                .and_then(|guide| guide.command.as_deref()),
            Some("codex login --with-api-key")
        );

        let cursor = infos.iter().find(|a| a.id == "cursor").expect("cursor");
        assert_eq!(
            cursor
                .setup
                .login
                .as_ref()
                .map(|login| login.command.as_str()),
            Some("cursor-agent login")
        );

        // A declared ACP agent with no guide data gets an empty profile: the
        // wizard falls back to its own documentation rather than invent steps.
        let mut custom = BTreeMap::new();
        custom.insert(
            "goose".to_string(),
            CustomAgent {
                extends: "acp".into(),
                command: vec!["goose".into(), "acp".into()],
                label: None,
            },
        );
        let registry = Registry::new(&custom);
        let goose = registry
            .refresh(&ProviderMap::new())
            .await
            .into_iter()
            .find(|a| a.id == "acp:goose")
            .expect("the custom agent");
        assert_eq!(goose.setup, AgentSetup::default());
        // An absent binary answers Unknown cheaply — nothing is spawned to ask.
        assert_eq!(goose.auth, AuthState::Unknown);
    }

    /// Cursor's guide is checked against its own docs: the Unix-only install
    /// script, the browser login, and the status command the badge reads.
    #[test]
    fn cursor_setup_matches_its_own_documentation() {
        let setup = cursor_setup();
        assert_eq!(
            setup.install[0].command,
            "curl https://cursor.com/install -fsS | bash"
        );
        assert!(
            !setup.install[0].platforms.contains(&GuidePlatform::Windows),
            "cursor.com/install is a Unix script; Windows gets the docs link"
        );
        assert!(setup.login.as_ref().unwrap().opens_browser);
        let probe = cursor_auth_probe();
        assert_eq!(probe.json_field, "isAuthenticated");
        assert_eq!(probe.args, ["status", "--format", "json"]);
    }
}
