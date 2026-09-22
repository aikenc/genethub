//! Everything the request handlers share.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use genehub_proto::{
    AgentSelectionPreferences, ProviderInfo, ServerFrame, Settings, SpeechCapabilities,
    SpeechRuntimeStatus,
};
use tokio::sync::{broadcast, mpsc, Mutex, RwLock};

use crate::adapter::registry::Registry;
use crate::adapter::ProviderMap;
use crate::config::{Config, MachineState, Paths, ProviderConfig};
use crate::devices::Devices;
use crate::link::SharedLink;
use crate::pty::{PtyMessage, Terminals};
use crate::remote::SharedRemote;
use crate::session::{SessionManager, Store, WorkspaceHomes};
use crate::workspace::Workspaces;

pub struct AppState {
    pub(crate) logical_connections: Arc<crate::dataplane::logical_registry::Registry>,
    pub client_debug: crate::client_debug::Broker,
    pub paths: Paths,
    pub config: Arc<RwLock<Config>>,
    pub machine: MachineState,
    /// Serializes every read-modify-write of the durable machine identity.
    /// Link and rendezvous settings share one file and must never overwrite
    /// each other's fields from independently loaded snapshots.
    machine_state_write: Mutex<()>,
    pub registry: Arc<Registry>,
    pub speech: Arc<crate::speech::SpeechBroker>,
    pub sessions: SessionManager,
    pub workflow_tasks: crate::adapter::SessionTasks,
    pub workspaces: Workspaces,
    pub project_control: crate::project_control::Broker,
    pub terminals: Arc<Terminals>,
    /// What each session's agent has left running.
    pub processes: Arc<crate::processes::Processes>,
    /// Bounded categorical facts safe for explicit feedback attachment.
    pub diagnostics: Arc<crate::diagnostics::Diagnostics>,
    pub version: String,
    /// Owner-only token used to mint loopback control proofs.
    pub token: String,
    /// Who may reach this machine from outside. The judge of that question is
    /// this list, not a relay and not a control plane.
    pub devices: Devices,
    /// This machine's relationship with a Hub. Set once, right after the state
    /// exists, because the link needs the state to serve relayed clients.
    pub link: std::sync::OnceLock<SharedLink>,
    /// The rendezvous relay this machine waits at, if any. Set alongside the
    /// link and for the same reason.
    pub remote: std::sync::OnceLock<SharedRemote>,
    /// How far the installer fetch has got, when one was asked for.
    pub updates: crate::updates::Downloader,
    /// The channel every connected client is listening on.
    ///
    /// The same one terminal output uses, which is why it is set from outside:
    /// it is created with the listener, after this state exists. Anything the
    /// machine needs to say to whoever is watching, rather than to whoever
    /// asked, goes through here.
    pub fanout: std::sync::OnceLock<broadcast::Sender<ServerFrame>>,
    /// What each provider answered when asked for its models. See `discover`.
    models: RwLock<std::collections::HashMap<String, Discovery>>,
    /// Raised when a local client asks the daemon to stop.
    ///
    /// Signals are the natural way to say this and Windows has no equivalent
    /// that reaches a windowless child, so the desktop shell there would have
    /// to kill the process and skip every bit of cleanup. Asking over the same
    /// loopback connection it already uses works the same everywhere.
    pub shutdown: Arc<tokio::sync::Notify>,
    /// Raised after a host-owned signed guest apply. The run loop returns
    /// `Exit::Reload`; sessions and child processes are dropped.
    pub reload: Arc<tokio::sync::Notify>,
}

pub type Shared = Arc<AppState>;

/// One provider's answer, and what it was asked.
#[derive(Clone)]
struct Discovery {
    /// The key, address and dialect this answer belongs to.
    question: String,
    models: Vec<String>,
    model_inputs: std::collections::BTreeMap<String, Vec<String>>,
    problem: Option<String>,
    at: std::time::Instant,
}

impl Discovery {
    fn still_current(&self) -> bool {
        // A list that came back is kept for as long as the process lives; a
        // failure is retried after a minute. Providers do not add models while
        // someone is looking at the picker, but keys get pasted correctly on the
        // second try.
        self.problem.is_none() || self.at.elapsed() < std::time::Duration::from_secs(60)
    }
}

/// What a provider is asked, in one string, so a change to any part of it
/// invalidates the answer without anything having to remember to.
fn question_for(id: &str, config: &ProviderConfig) -> String {
    let resolved = crate::provider::resolve(id, config);
    format!(
        "{}|{}|{}",
        resolved.base_url.unwrap_or_default(),
        resolved.dialect.as_str(),
        config.api_key.clone().unwrap_or_default(),
    )
}

async fn config_lan(config: &Arc<RwLock<Config>>) -> bool {
    config.read().await.lan_enabled
}

impl AppState {
    pub async fn build(paths: Paths) -> Result<(Shared, mpsc::Receiver<PtyMessage>)> {
        paths.ensure()?;
        let mut config = Config::load(&paths.config_file())?;
        config.ensure_workspace_catalog_generation(&paths.config_file())?;
        config.migrate_workspace_folders(&paths.config_file())?;
        config.migrate_workspace_roots(&paths.config_file())?;
        config.migrate_workspace_identities(&paths.config_file())?;
        config.refresh_workspace_catalog_facts(&paths.config_file())?;
        let machine = MachineState::load_or_create(&paths.state_file())?;
        let devices = Devices::load(paths.devices_file());

        let registry = Arc::new(Registry::new(&config.agents.custom));
        // Sessions are stored inside their workspace, so the store reaches disk
        // only through what the workspace registry has published.
        let homes = WorkspaceHomes::default();
        let store = Store::new(homes.clone());
        let diagnostics = Arc::new(crate::diagnostics::Diagnostics::new());
        // The front door owns the shared data layout; the daemon owns the
        // product Skill subtree and the exact CLI binding exposed to Agents.
        let skills_dir = crate::skills::builtin_skills_dir(&paths.root);
        let _ = crate::skills::materialize(&skills_dir);
        let front_door_cli = crate::skills::front_door_cli_from_env();
        if front_door_cli.is_none() {
            tracing::warn!(
                "GENEHUB_CLI is unavailable or not absolute; Agent sessions will not guess a channel command"
            );
        }
        let project_control = crate::project_control::Broker::new(&paths.root)?;
        let sessions = SessionManager::new_with_diagnostics(
            store,
            registry.clone(),
            config.replay_window,
            diagnostics.clone(),
        )
        .with_builtin_skills(skills_dir, front_door_cli)
        .with_project_control(project_control.clone());

        let config = Arc::new(RwLock::new(config));
        let workspaces = Workspaces::new(config.clone(), paths.config_file(), homes);
        workspaces.load().await;
        if let Some(root) = paths.default_workspace.clone() {
            // A home directory that cannot be written to is unusual but not
            // fatal: the user can still open a folder by hand, and refusing to
            // start would take that from them too.
            if let Err(error) = workspaces.ensure_default(&root).await {
                tracing::warn!(%error, "no default workspace");
            }
        }

        let processes = sessions.processes();
        let (terminals, pty_rx) = Terminals::new();
        let updates_dir = paths.updates_dir();

        let state = Arc::new(AppState {
            logical_connections: Arc::new(crate::dataplane::logical_registry::Registry::default()),
            paths,
            config,
            machine,
            machine_state_write: Mutex::new(()),
            registry,
            speech: Arc::new(crate::speech::SpeechBroker::new()),
            sessions,
            workflow_tasks: Default::default(),
            workspaces,
            project_control,
            terminals,
            processes,
            diagnostics,
            client_debug: crate::client_debug::Broker::default(),
            version: crate::version::product_version(),
            token: uuid::Uuid::new_v4().simple().to_string(),
            devices,
            link: std::sync::OnceLock::new(),
            remote: std::sync::OnceLock::new(),
            updates: crate::updates::Downloader::new(updates_dir),
            fanout: std::sync::OnceLock::new(),
            models: RwLock::new(std::collections::HashMap::new()),
            shutdown: Arc::new(tokio::sync::Notify::new()),
            reload: Arc::new(tokio::sync::Notify::new()),
        });
        Ok((state, pty_rx))
    }

    pub(crate) async fn mutate_machine_state<T>(
        &self,
        mutate: impl FnOnce(&mut MachineState) -> Result<T>,
    ) -> Result<T> {
        let _guard = self.machine_state_write.lock().await;
        let path = self.paths.state_file();
        let mut machine = MachineState::load(&path)?;
        let result = mutate(&mut machine)?;
        machine.save(&path)?;
        Ok(result)
    }

    /// Providers as everything downstream should see them: address filled in,
    /// models known.
    ///
    /// Resolved here rather than by each adapter and by the agent, because that
    /// is how a DeepSeek key ended up at OpenAI — three places deciding what a
    /// missing address means, one of them by falling back to a vendor URL. What
    /// comes out of here either has an address or has no models, and an adapter
    /// never has to guess.
    pub async fn providers(&self) -> ProviderMap {
        let stored = self.config.read().await.agents.providers.clone();
        let discovered = self.discover(&stored).await;
        stored
            .into_iter()
            .map(|(id, config)| {
                let resolved = crate::provider::resolve(&id, &config);
                let credential_problem =
                    if config.api_key.as_deref().is_some_and(|key| !key.is_empty()) {
                        resolved
                            .base_url
                            .as_deref()
                            .and_then(|url| crate::provider::validate_credential_url(url).err())
                            .map(|error| format!("{error:#}"))
                    } else {
                        None
                    };
                let credential_valid = credential_problem.is_none();
                let models = if credential_problem.is_some() {
                    Vec::new()
                } else if config.models.is_empty() {
                    discovered
                        .get(&id)
                        .map(|found| found.models.clone())
                        .unwrap_or_default()
                } else {
                    config.models.clone()
                };
                let mut model_inputs = discovered
                    .get(&id)
                    .map(|found| found.model_inputs.clone())
                    .unwrap_or_default();
                model_inputs.extend(config.model_inputs.clone());
                let problem = if credential_problem.is_some() {
                    credential_problem
                } else if config.models.is_empty() {
                    discovered.get(&id).and_then(|found| found.problem.clone())
                } else {
                    None
                };
                (
                    id,
                    ProviderConfig {
                        base_url: credential_valid.then_some(resolved.base_url).flatten(),
                        label: Some(resolved.label),
                        dialect: Some(resolved.dialect.as_str().to_string()),
                        models,
                        model_inputs,
                        problem,
                        ..config
                    },
                )
            })
            .collect()
    }

    pub async fn settings(&self) -> Settings {
        let (stored, speech, agent_preferences) = {
            let config = self.config.read().await;
            (
                config.agents.providers.clone(),
                config.speech.clone(),
                config.agent_preferences.clone(),
            )
        };
        let discovered = self.discover(&stored).await;
        Settings {
            providers: stored
                .iter()
                .map(|(id, provider)| {
                    let resolved = crate::provider::resolve(id, provider);
                    let found = discovered.get(id);
                    ProviderInfo {
                        id: id.clone(),
                        has_api_key: provider
                            .api_key
                            .as_deref()
                            .is_some_and(|key| !key.is_empty()),
                        base_url: resolved.base_url,
                        label: resolved.label,
                        dialect: resolved.dialect.as_str().to_string(),
                        custom: resolved.custom,
                        models: if provider.models.is_empty() {
                            found.map(|f| f.models.clone()).unwrap_or_default()
                        } else {
                            provider.models.clone()
                        },
                        model_inputs: Some({
                            let mut inputs =
                                found.map(|f| f.model_inputs.clone()).unwrap_or_default();
                            inputs.extend(provider.model_inputs.clone());
                            inputs
                        }),
                        problem: if provider.models.is_empty() {
                            found.and_then(|f| f.problem.clone())
                        } else {
                            None
                        },
                    }
                })
                .collect(),
            lan_enabled: config_lan(&self.config).await,
            speech: Some(crate::speech::settings(&speech)),
            agent_preferences,
        }
    }

    /// Replaces tag/cost routing as one machine-level value. Keeping this
    /// beside provider and speech settings means every workspace and client on
    /// the machine sees the same profiles and last runtime choices.
    pub async fn set_agent_preferences(
        &self,
        preferences: AgentSelectionPreferences,
    ) -> Result<Settings> {
        validate_agent_preferences(&preferences)?;
        {
            let mut config = self.config.write().await;
            config.agent_preferences = Some(preferences);
            config.save(&self.paths.config_file())?;
        }
        crate::config::restrict_to_owner(&self.paths.config_file())?;
        Ok(self.settings().await)
    }

    pub async fn speech_capabilities(&self) -> SpeechCapabilities {
        let config = self.config.read().await.speech.clone();
        self.speech.capabilities(&config).await
    }

    pub async fn probe_speech_runtime(&self) -> SpeechRuntimeStatus {
        let config = self.config.read().await.speech.clone();
        self.speech.probe(&config).await
    }

    pub async fn configure_speech_runtime(
        &self,
        command: Option<String>,
        args: Vec<String>,
    ) -> Result<SpeechCapabilities> {
        let runtime = match command {
            Some(command) => Some(self.speech.validate_registration(command, args).await?),
            None if args.is_empty() => None,
            None => anyhow::bail!("移除 runtime 时不能提供参数"),
        };
        {
            let mut config = self.config.write().await;
            if runtime.is_some() {
                // A successfully probed real adapter becomes active
                // immediately; the user can still re-enable the Stub later.
                config.speech.stub_enabled = false;
            }
            config.speech.runtime = runtime;
            config.save(&self.paths.config_file())?;
        }
        crate::config::restrict_to_owner(&self.paths.config_file())?;
        Ok(self.speech_capabilities().await)
    }

    pub async fn set_qwen3_speech(
        &self,
        stub_enabled: Option<bool>,
        context_enabled: bool,
        pinned_terms: Vec<String>,
        language_hints: Vec<String>,
        collect_corrections: bool,
        workspace_id: Option<String>,
    ) -> Result<Settings> {
        let (pinned_terms, language_hints) =
            crate::speech::validate_settings(pinned_terms, language_hints)?;
        if collect_corrections && workspace_id.is_none() {
            anyhow::bail!("开启纠正收集时必须选择一个工作区");
        }
        if let Some(workspace_id) = workspace_id.as_deref() {
            self.workspaces.get(workspace_id).await?;
        }
        {
            let mut config = self.config.write().await;
            if let Some(stub_enabled) = stub_enabled {
                config.speech.stub_enabled = stub_enabled;
            }
            config.speech.context_enabled = context_enabled;
            config.speech.pinned_terms = pinned_terms;
            config.speech.language_hints = language_hints;
            // Old releases had one machine-wide switch. Clearing it prevents a
            // previously saved true value from acting as a wildcard after this
            // project-scoped migration.
            config.speech.collect_corrections = false;
            if let Some(workspace_id) = workspace_id {
                config
                    .speech
                    .correction_workspaces
                    .retain(|configured| configured != &workspace_id);
                if collect_corrections {
                    config.speech.correction_workspaces.push(workspace_id);
                    config.speech.correction_workspaces.sort();
                    config.speech.correction_workspaces.dedup();
                }
            }
            config.save(&self.paths.config_file())?;
        }
        crate::config::restrict_to_owner(&self.paths.config_file())?;
        Ok(self.settings().await)
    }

    /// Asks every configured provider for its models, once per set of details.
    ///
    /// Cached against the key, address and dialect it was asked with, so editing
    /// any of them asks again and nothing else does. That is also why there is no
    /// "refresh" button and no expiry to tune: the answer only changes when the
    /// question does, or when the provider adds a model — and for that, restart.
    ///
    /// A failure is cached too, for a minute. Otherwise a rejected key means
    /// every settings page load and every session start pays a timeout again.
    async fn discover(&self, stored: &ProviderMap) -> std::collections::HashMap<String, Discovery> {
        let mut asking = Vec::new();
        {
            let cache = self.models.read().await;
            for (id, config) in stored {
                if !config.models.is_empty() {
                    continue;
                }
                let question = question_for(id, config);
                match cache.get(id) {
                    Some(found) if found.question == question && found.still_current() => {}
                    _ => asking.push((id.clone(), config.clone(), question)),
                }
            }
        }

        // Concurrently: a page with three keys on it should wait as long as the
        // slowest provider, not as long as all of them added up.
        let answers = futures_util::future::join_all(asking.into_iter().map(
            |(id, config, question)| async move {
                let answer = crate::provider::list_models(&id, &config).await;
                let discovery = match answer {
                    Ok(listed) => Discovery {
                        question,
                        models: listed.iter().map(|model| model.id.clone()).collect(),
                        model_inputs: listed
                            .into_iter()
                            .map(|model| (model.id, model.input_modalities))
                            .collect(),
                        problem: None,
                        at: std::time::Instant::now(),
                    },
                    Err(error) => Discovery {
                        question,
                        models: Vec::new(),
                        model_inputs: Default::default(),
                        problem: Some(format!("{error:#}")),
                        at: std::time::Instant::now(),
                    },
                };
                (id, discovery)
            },
        ))
        .await;

        let mut cache = self.models.write().await;
        for (id, discovery) in answers {
            cache.insert(id, discovery);
        }
        cache.clone()
    }

    /// Stores a provider credential and persists it.
    ///
    /// An empty key clears the entry rather than storing a blank one: a stored
    /// empty string would read as "configured" everywhere and fail only at the
    /// moment the user runs a task.
    pub async fn set_provider(
        &self,
        provider_id: &str,
        api_key: Option<String>,
        base_url: Option<String>,
        label: Option<String>,
        dialect: Option<String>,
        models: Option<Vec<String>>,
        model_inputs: Option<std::collections::BTreeMap<String, Vec<String>>>,
    ) -> Result<Settings> {
        {
            let mut config = self.config.write().await;
            let mut entry = config
                .agents
                .providers
                .get(provider_id)
                .cloned()
                .unwrap_or_default();
            if let Some(key) = api_key {
                entry.api_key = (!key.is_empty()).then_some(key);
            }
            if let Some(url) = base_url {
                entry.base_url = (!url.is_empty()).then_some(url);
            }
            if let Some(label) = label {
                entry.label = (!label.is_empty()).then_some(label);
            }
            if let Some(dialect) = dialect {
                entry.dialect = (!dialect.is_empty()).then_some(dialect);
            }
            if let Some(models) = models {
                entry.models = models.into_iter().filter(|m| !m.is_empty()).collect();
            }
            if let Some(model_inputs) = model_inputs {
                for (model, inputs) in model_inputs {
                    if model.trim().is_empty()
                        || inputs
                            .iter()
                            .any(|input| input != "image" && input != "video")
                    {
                        anyhow::bail!("模型输入能力只接受 image 和 video");
                    }
                    entry.model_inputs.insert(model, inputs);
                }
            }
            if crate::provider::resolve(provider_id, &entry).dialect
                == crate::provider::Dialect::Anthropic
                && entry
                    .model_inputs
                    .values()
                    .any(|inputs| inputs.iter().any(|input| input == "video"))
            {
                anyhow::bail!("Anthropic Messages API 不支持原生视频输入");
            }
            if entry.api_key.as_deref().is_some_and(|key| !key.is_empty()) {
                if let Some(url) = crate::provider::resolve(provider_id, &entry).base_url {
                    crate::provider::validate_credential_url(&url)?;
                }
            }
            config
                .agents
                .providers
                .insert(provider_id.to_string(), entry);
            config.save(&self.paths.config_file())?;
        }
        crate::config::restrict_to_owner(&self.paths.config_file())?;
        // The settings that come back are asked again with the new details,
        // which is what puts the models on screen right after saving a key.
        Ok(self.settings().await)
    }

    /// Drops a provider entirely. Only ones the user added: removing `deepseek`
    /// would leave a row that comes back on the next start, which reads as a bug.
    pub async fn forget_provider(&self, provider_id: &str) -> Result<Settings> {
        {
            let mut config = self.config.write().await;
            let Some(entry) = config.agents.providers.get(provider_id) else {
                return Ok(self.settings().await);
            };
            if !crate::provider::resolve(provider_id, entry).custom {
                return Err(anyhow::anyhow!("{provider_id} 是内置的，只能清空它的 Key"));
            }
            config.agents.providers.remove(provider_id);
            config.save(&self.paths.config_file())?;
        }
        self.models.write().await.remove(provider_id);
        Ok(self.settings().await)
    }

    /// Publishes the loopback address and token for same-machine clients.
    ///
    /// A file rather than a fixed port because the port is chosen at startup,
    /// and a fixed one collides the moment a second instance or another app
    /// wants it.
    pub fn publish_endpoint(&self, port: u16) -> Result<PathBuf> {
        let path = self.paths.endpoint_file();
        let body = serde_json::json!({
            "port": port,
            "token": self.token,
            "machineId": self.machine.machine_id,
            "fingerprint": self.machine.fingerprint(),
            "pid": crate::host_pid::current(),
        });
        crate::config::save_private(&path, serde_json::to_string_pretty(&body)?.as_bytes())?;
        Ok(path)
    }

    /// Says something to every client that happens to be connected.
    ///
    /// Dropped silently when nobody is listening, which is the ordinary case for
    /// a daemon nobody has open. What this carries is a state the client can ask
    /// for again (`update.downloadState`), so a missed frame costs a stale
    /// screen until the next one, never a lost fact.
    pub fn push(&self, frame: ServerFrame) {
        if let Some(fanout) = self.fanout.get() {
            let _ = fanout.send(frame);
        }
    }
}

fn validate_agent_preferences(preferences: &AgentSelectionPreferences) -> Result<()> {
    if preferences.runtimes.len() > 64 {
        anyhow::bail!("最多记住 64 个 Agent 的运行设置");
    }
    for (agent_id, runtime) in &preferences.runtimes {
        validate_id("Agent", agent_id, 128)?;
        if let Some(effort_id) = &runtime.effort_id {
            validate_id("思考强度", effort_id, 128)?;
        }
        if let Some(mode_id) = &runtime.mode_id {
            validate_id("权限", mode_id, 128)?;
        }
        if runtime.runtime_values.len() > 16 {
            anyhow::bail!("一个 Agent 最多记住 16 个运行参数");
        }
        for (axis_id, value_id) in &runtime.runtime_values {
            validate_id("运行参数", axis_id, 128)?;
            validate_id("运行参数值", value_id, 128)?;
        }
    }
    if preferences.model_profiles.len() > 512 {
        anyhow::bail!("最多保存 512 组 Agent 与模型画像");
    }
    validate_tag_groups(preferences)?;
    let mut profiles = std::collections::BTreeSet::new();
    for profile in &preferences.model_profiles {
        validate_id("Agent", &profile.agent_id, 128)?;
        if let Some(model_id) = &profile.model_id {
            validate_id("模型", model_id, 512)?;
        }
        validate_tags(&profile.tags, true)?;
        validate_tag_group_selection(&profile.tags, preferences)?;
        if !profiles.insert((&profile.agent_id, &profile.model_id)) {
            anyhow::bail!("不能重复保存同一个 Agent 与模型画像");
        }
    }
    validate_tags(&preferences.selected_tags, false)?;
    validate_tag_group_selection(&preferences.selected_tags, preferences)?;
    Ok(())
}

fn validate_tag_groups(preferences: &AgentSelectionPreferences) -> Result<()> {
    if preferences.tag_groups.len() > 32 {
        anyhow::bail!("最多配置 32 个标签组");
    }
    let builtins = ["max", "pro", "flush", "视频理解", "图片理解"];
    let mut ids = std::collections::BTreeSet::new();
    let mut grouped_tags = std::collections::BTreeSet::new();
    for group in &preferences.tag_groups {
        validate_id("标签组", &group.id, 64)?;
        validate_id("标签组名称", &group.label, 40)?;
        if group.id.trim().eq_ignore_ascii_case("builtin-intelligence") {
            anyhow::bail!("自定义标签组不能使用内置标签组标识");
        }
        if !ids.insert(group.id.trim().to_lowercase()) {
            anyhow::bail!("标签组标识不能重复");
        }
        if group.tags.len() > 64 {
            anyhow::bail!("一个标签组最多包含 64 个标签");
        }
        validate_tags(&group.tags, false)?;
        for tag in &group.tags {
            let key = tag.trim().to_lowercase();
            if builtins.contains(&key.as_str()) {
                anyhow::bail!("内置标签不能加入自定义标签组");
            }
            if !grouped_tags.insert(key) {
                anyhow::bail!("同一个标签只能属于一个标签组");
            }
        }
    }
    Ok(())
}

fn validate_tag_group_selection(
    tags: &[String],
    preferences: &AgentSelectionPreferences,
) -> Result<()> {
    let mut claimed = std::collections::BTreeSet::new();
    for tag in tags {
        let key = tag.trim().to_lowercase();
        let group = if ["max", "pro", "flush"].contains(&key.as_str()) {
            Some("builtin-intelligence")
        } else {
            preferences.tag_groups.iter().find_map(|group| {
                group
                    .tags
                    .iter()
                    .any(|member| member.trim().eq_ignore_ascii_case(tag.trim()))
                    .then_some(group.id.as_str())
            })
        };
        if let Some(group) = group {
            if !claimed.insert(group) {
                anyhow::bail!("同一个标签组只能选择一个标签");
            }
        }
    }
    Ok(())
}

fn validate_tags(tags: &[String], required: bool) -> Result<()> {
    if required && tags.is_empty() {
        anyhow::bail!("每组 Agent 与模型至少需要 1 个标签");
    }
    if tags.len() > 4 {
        anyhow::bail!("最多选择 4 个标签");
    }
    let mut seen = std::collections::BTreeSet::new();
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() || tag.chars().count() > 40 || tag.chars().any(char::is_control) {
            anyhow::bail!("标签不能为空、不能包含控制字符且不能超过 40 个字符");
        }
        if !seen.insert(tag.to_lowercase()) {
            anyhow::bail!("同一组设置不能重复标签");
        }
    }
    Ok(())
}

fn validate_id(label: &str, value: &str, max_chars: usize) -> Result<()> {
    if value.trim().is_empty() || value.chars().count() > max_chars {
        anyhow::bail!("{label} 标识不能为空且不能超过 {max_chars} 个字符");
    }
    Ok(())
}

#[cfg(test)]
mod machine_state_tests {
    use super::*;
    use crate::config::{Enrollment, Rendezvous};

    #[test]
    fn tag_settings_enforce_profile_identity_and_tag_bounds() {
        let profile =
            |agent: &str, model: &str, tags: Vec<&str>| genehub_proto::AgentModelProfile {
                agent_id: agent.into(),
                model_id: Some(model.into()),
                tags: tags.into_iter().map(str::to_string).collect(),
                cost: Some(genehub_proto::AgentCostLevel::Medium),
            };
        let mut preferences = AgentSelectionPreferences::default();
        preferences.model_profiles = vec![profile(
            "codex",
            "model",
            vec!["Max", "图片理解", "视频理解", "私有"],
        )];
        validate_agent_preferences(&preferences).expect("four distinct tags are valid");

        preferences.model_profiles[0].tags.push("第五个".into());
        let too_many = validate_agent_preferences(&preferences)
            .expect_err("a fifth tag must be rejected")
            .to_string();
        assert!(too_many.contains("最多选择 4"), "{too_many}");

        preferences.model_profiles = vec![
            profile("codex", "model", vec!["Flush"]),
            profile("codex", "model", vec!["Pro"]),
        ];
        let duplicate = validate_agent_preferences(&preferences)
            .expect_err("the same exact profile cannot be saved twice")
            .to_string();
        assert!(duplicate.contains("不能重复"), "{duplicate}");
    }

    #[test]
    fn tag_settings_enforce_builtin_and_custom_group_exclusivity() {
        let profile = |tags: Vec<&str>| genehub_proto::AgentModelProfile {
            agent_id: "codex".into(),
            model_id: Some("model".into()),
            tags: tags.into_iter().map(str::to_string).collect(),
            cost: Some(genehub_proto::AgentCostLevel::Medium),
        };
        let mut preferences = AgentSelectionPreferences {
            model_profiles: vec![profile(vec!["Max", "Pro"])],
            ..Default::default()
        };
        let builtin = validate_agent_preferences(&preferences)
            .expect_err("Max and Pro belong to one exclusive group")
            .to_string();
        assert!(builtin.contains("只能选择一个"), "{builtin}");

        preferences.tag_groups = vec![genehub_proto::AgentTagGroup {
            id: "quality".into(),
            label: "质量".into(),
            tags: vec!["审慎".into(), "快速".into()],
        }];
        preferences.model_profiles = vec![profile(vec!["Flush", "审慎", "快速"])];
        let custom = validate_agent_preferences(&preferences)
            .expect_err("a custom group is exclusive too")
            .to_string();
        assert!(custom.contains("只能选择一个"), "{custom}");

        preferences.tag_groups = vec![genehub_proto::AgentTagGroup {
            id: "builtin-intelligence".into(),
            label: "冲突".into(),
            tags: vec!["自定义".into()],
        }];
        preferences.model_profiles.clear();
        let reserved = validate_agent_preferences(&preferences)
            .expect_err("the built-in group id is reserved")
            .to_string();
        assert!(reserved.contains("内置标签组标识"), "{reserved}");
    }

    #[tokio::test]
    async fn independent_machine_state_updates_merge_instead_of_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().to_path_buf());
        let state_path = paths.state_file();
        let (state, _) = AppState::build(paths).await.unwrap();
        let enrollment = Enrollment {
            hub_url: "https://hub.example".into(),
            machine_id: "mch_test".into(),
            daemon_id: "dmn_test".into(),
            secret: "secret".into(),
            workspace_catalog_generation: Some("wcg_test".into()),
        };
        let rendezvous = Rendezvous {
            relay_url: "https://self-hosted.example".into(),
            join_token: Some("join".into()),
        };

        let (hub, remote) = tokio::join!(
            state.mutate_machine_state(|machine| {
                machine.enrollment = Some(enrollment);
                Ok(())
            }),
            state.mutate_machine_state(|machine| {
                machine.rendezvous = Some(rendezvous);
                Ok(())
            }),
        );
        hub.unwrap();
        remote.unwrap();
        let persisted = MachineState::load(&state_path).unwrap();
        assert!(persisted.enrollment.is_some());
        assert!(persisted.rendezvous.is_some());
    }

    #[tokio::test]
    async fn storing_a_provider_cannot_send_its_key_over_non_loopback_http() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _) = AppState::build(Paths::new(dir.path())).await.unwrap();

        let result = state
            .set_provider(
                "private",
                Some("sk-secret".into()),
                Some("http://192.168.1.20:8080/v1".into()),
                None,
                None,
                Some(vec!["model".into()]),
                None,
            )
            .await;
        assert!(result.is_err());
        assert!(!state
            .config
            .read()
            .await
            .agents
            .providers
            .contains_key("private"));
    }

    #[tokio::test]
    async fn an_unsafe_provider_from_legacy_config_never_reaches_an_agent() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path());
        paths.ensure().unwrap();
        let mut config = Config::default();
        config.agents.providers.insert(
            "private".into(),
            ProviderConfig {
                api_key: Some("sk-secret".into()),
                base_url: Some("http://192.168.1.20:8080/v1".into()),
                models: vec!["model".into()],
                ..Default::default()
            },
        );
        config.save(&paths.config_file()).unwrap();
        let (state, _) = AppState::build(paths).await.unwrap();

        let provider = state.providers().await.remove("private").unwrap();
        assert!(provider.base_url.is_none());
        assert!(provider.models.is_empty());
        assert!(provider.problem.as_deref().unwrap().contains("https"));
    }
}
