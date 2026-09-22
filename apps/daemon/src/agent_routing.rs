//! Machine-global Agent/model routing by AND-match tags and live cost.
//!
//! This module deliberately returns a concrete route without storing it. Every
//! caller reads `Config::agent_preferences` again at dispatch time, so a Human
//! cost edit affects the very next turn or Workflow activity.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{anyhow, Result};
use genehub_proto::{
    AgentCostLevel, AgentInfo, AgentModelProfile, AgentSelectionPreferences, ModelInfo, ProbeState,
    SessionAgentTarget, SessionSummary, TimelineItem,
};

use crate::adapter::{registry::Registry, ProviderMap};
use crate::state::Shared;

pub const TAG_MAX: &str = "Max";
pub const TAG_PRO: &str = "Pro";
pub const TAG_FLUSH: &str = "Flush";
pub const TAG_VIDEO: &str = "视频理解";
pub const TAG_IMAGE: &str = "图片理解";
pub const BUILTIN_TAGS: [&str; 5] = [TAG_MAX, TAG_PRO, TAG_FLUSH, TAG_VIDEO, TAG_IMAGE];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedAgentRoute {
    pub agent_id: String,
    pub model_id: Option<String>,
    pub effort_id: Option<String>,
    pub mode_id: Option<String>,
    pub runtime_values: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
struct Candidate {
    route: ResolvedAgentRoute,
    tags: Vec<String>,
    cost: AgentCostLevel,
}

pub(crate) fn is_builtin_tag(tag: &str) -> bool {
    BUILTIN_TAGS
        .iter()
        .any(|candidate| tags_equal(candidate, tag))
}

pub(crate) fn normalize_tags(tags: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }
        let display = BUILTIN_TAGS
            .iter()
            .find(|candidate| tags_equal(candidate, trimmed))
            .copied()
            .unwrap_or(trimmed)
            .to_string();
        if seen.insert(tag_key(&display)) {
            normalized.push(display);
        }
    }
    normalized
}

/// Validates the Human-authored AND contract at the daemon boundary. UI
/// limits are affordances, not authority: remote and older clients must meet
/// the same one-to-four, unique, bounded tag contract.
pub(crate) fn validate_selected_tags(tags: Vec<String>) -> Result<Vec<String>> {
    validate_tag_shape(&tags, 1, 4)?;
    let normalized = normalize_tags(tags.iter().cloned());
    if normalized.len() != tags.len() {
        anyhow::bail!("agentTagInvalid: 标签不能重复");
    }
    Ok(normalized)
}

/// Media requirements are daemon-owned vocabulary. A client may announce
/// media before the first message is persisted, but cannot smuggle a custom
/// routing constraint through the `mediaTags` field.
pub(crate) fn validate_media_tags(tags: Vec<String>) -> Result<Vec<String>> {
    validate_tag_shape(&tags, 0, 2)?;
    let normalized = normalize_tags(tags.iter().cloned());
    if normalized.len() != tags.len()
        || normalized
            .iter()
            .any(|tag| !tags_equal(tag, TAG_IMAGE) && !tags_equal(tag, TAG_VIDEO))
    {
        anyhow::bail!("agentTagInvalid: mediaTags 只能包含图片理解或视频理解且不能重复");
    }
    Ok(normalized)
}

fn validate_tag_shape(tags: &[String], minimum: usize, maximum: usize) -> Result<()> {
    if tags.len() < minimum || tags.len() > maximum {
        anyhow::bail!("agentTagInvalid: 标签数量必须在 {minimum}..={maximum} 之间");
    }
    if tags.iter().any(|tag| {
        let trimmed = tag.trim();
        trimmed.is_empty() || trimmed.chars().count() > 40 || trimmed.chars().any(char::is_control)
    }) {
        anyhow::bail!("agentTagInvalid: 标签不能为空、不能包含控制字符且不能超过 40 个字符");
    }
    Ok(())
}

pub(crate) fn media_tags_for_mimes<'a>(mimes: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut image = false;
    let mut video = false;
    for mime in mimes {
        image |= mime.to_ascii_lowercase().starts_with("image/");
        video |= mime.to_ascii_lowercase().starts_with("video/");
    }
    [
        image.then(|| TAG_IMAGE.to_string()),
        video.then(|| TAG_VIDEO.to_string()),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// Derives mandatory media tags from portable visible history. This runs on
/// the daemon so routed Forks cannot lose media requirements through a stale
/// or malicious client-side preview.
pub(crate) fn media_tags_for_timeline(items: &[TimelineItem]) -> Vec<String> {
    media_tags_for_mimes(items.iter().flat_map(|item| {
        match item {
            TimelineItem::UserMessage { attachments, .. } => attachments
                .iter()
                .map(|attachment| attachment.mime.as_str())
                .collect::<Vec<_>>(),
            TimelineItem::ToolCall { images, .. } => images
                .iter()
                .map(|image| image.mime.as_str())
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        }
    }))
}

/// Selects the cheapest live Agent/model whose tags contain every requirement.
/// Cost ties use opaque ids only to make the result deterministic; this is not
/// a Human-editable priority order.
pub(crate) fn select_tag_route(
    preferences: &AgentSelectionPreferences,
    required_tags: &[String],
    agents: &[AgentInfo],
    registry: &Registry,
    evidence_only: bool,
) -> Result<ResolvedAgentRoute> {
    let required = normalize_tags(required_tags.iter().cloned());
    let mut candidates = Vec::new();
    for agent in agents {
        if !matches!(agent.probe, ProbeState::Ready) {
            continue;
        }
        if evidence_only
            && registry
                .get(&agent.id)
                .is_none_or(|adapter| !adapter.supports_evidence_scope())
        {
            continue;
        }

        if agent.catalog.models.is_empty() {
            if can_start_without_model_catalog(&agent.id) {
                candidates.push(candidate_for(preferences, agent, None));
            }
        } else {
            let configured_for_agent = preferences
                .model_profiles
                .iter()
                .any(|profile| profile.agent_id == agent.id);
            let configured: BTreeSet<&str> = preferences
                .model_profiles
                .iter()
                .filter(|profile| profile.agent_id == agent.id)
                .filter_map(|profile| profile.model_id.as_deref())
                .filter(|model_id| {
                    agent
                        .catalog
                        .models
                        .iter()
                        .any(|model| model.id == *model_id && !is_auto_model(model))
                })
                .collect();
            candidates.extend(
                agent
                    .catalog
                    .models
                    .iter()
                    .filter(|model| !is_auto_model(model))
                    .filter(|model| !configured_for_agent || configured.contains(model.id.as_str()))
                    .take(if configured_for_agent { usize::MAX } else { 3 })
                    .map(|model| candidate_for(preferences, agent, Some(model))),
            );
        }
    }

    candidates.retain(|candidate| {
        required.iter().all(|required| {
            candidate
                .tags
                .iter()
                .any(|offered| tags_equal(offered, required))
        })
    });
    candidates.sort_by(|left, right| {
        cost_rank(left.cost)
            .cmp(&cost_rank(right.cost))
            .then_with(|| left.route.agent_id.cmp(&right.route.agent_id))
            .then_with(|| left.route.model_id.cmp(&right.route.model_id))
    });
    candidates
        .into_iter()
        .next()
        .map(|candidate| candidate.route)
        .ok_or_else(|| {
            let label = if required.is_empty() {
                "任意标签".to_string()
            } else {
                required.join(" + ")
            };
            anyhow!(
                "agentTagRouteUnavailable: 没有可用的 Agent 与模型同时匹配「{label}」；请由人类检查安装、登录或机器全局 Agent 配置"
            )
        })
}

fn is_auto_model(model: &ModelInfo) -> bool {
    [model.id.as_str(), model.label.as_str()]
        .into_iter()
        .any(|value| {
            value
                .split(|character: char| !character.is_ascii_alphanumeric())
                .any(|part| part.eq_ignore_ascii_case("auto"))
        })
}

/// Resolves against the current catalog and a fresh read of the global costs.
/// Agent probes spawn subprocesses, so routing reuses the registry catalog
/// populated by startup or an explicit `agent.refresh`; only the Human-edited
/// cost/tag configuration is deliberately never cached. The returned
/// ProviderMap is the same snapshot used for cataloguing and can be handed
/// directly to Session migration.
pub(crate) async fn resolve_live_route(
    state: &Shared,
    required_tags: &[String],
    evidence_only: bool,
) -> Result<(ResolvedAgentRoute, ProviderMap)> {
    let providers = state.providers().await;
    let agents = state.registry.list(&providers).await;
    // Read after catalog lookup: a cost changed while the catalog was being
    // obtained must affect this dispatch, not the next one.
    let preferences = state
        .config
        .read()
        .await
        .agent_preferences
        .clone()
        .unwrap_or_default();
    validate_exclusive_tags(required_tags, &preferences)?;
    let route = select_tag_route(
        &preferences,
        required_tags,
        &agents,
        state.registry.as_ref(),
        evidence_only,
    )?;
    Ok((route, providers))
}

fn validate_exclusive_tags(tags: &[String], preferences: &AgentSelectionPreferences) -> Result<()> {
    let mut claimed = BTreeSet::new();
    for tag in normalize_tags(tags.iter().cloned()) {
        let key = tag_key(&tag);
        let group = if [tag_key(TAG_MAX), tag_key(TAG_PRO), tag_key(TAG_FLUSH)].contains(&key) {
            Some("builtin-intelligence")
        } else {
            preferences.tag_groups.iter().find_map(|group| {
                group
                    .tags
                    .iter()
                    .any(|member| tags_equal(member, &tag))
                    .then_some(group.id.as_str())
            })
        };
        if let Some(group) = group {
            if !claimed.insert(group) {
                anyhow::bail!("agentTagInvalid: 同一个标签组只能选择一个标签");
            }
        }
    }
    Ok(())
}

/// Re-evaluates one ordinary Session and migrates it in place if the cheapest
/// matching route changed. `selected_tags = None` retains its Human choices;
/// media requirements are always unioned and can never be removed.
pub(crate) async fn route_session(
    state: &Shared,
    session_id: &str,
    selected_tags: Option<Vec<String>>,
    incoming_media_tags: Vec<String>,
) -> Result<SessionSummary> {
    let (routing_enabled, stored_tags, stored_media) =
        state.sessions.routing_requirements(session_id).await?;
    // `session.create` remains the concrete-route compatibility API used by
    // native/controlled Agents. Do not silently retarget such a Session on an
    // ordinary turn. `session.createRouted`, a routed Fork, or an explicit
    // `session.route` opts the conversation into this router; media then adds
    // mandatory tags only inside that routed conversation.
    if selected_tags.is_none() && !routing_enabled {
        return state.sessions.summary(session_id).await;
    }
    let routing_tags = normalize_tags(selected_tags.unwrap_or(stored_tags));
    let media_tags = normalize_tags(stored_media.into_iter().chain(incoming_media_tags));
    let required = normalize_tags(routing_tags.iter().chain(media_tags.iter()).cloned());
    let (route, providers) = resolve_live_route(state, &required, false).await?;
    state
        .sessions
        .switch_agent_routed(
            session_id,
            SessionAgentTarget {
                agent_id: route.agent_id,
                model_id: route.model_id,
                mode_id: route.mode_id,
                effort_id: route.effort_id,
                runtime_values: route.runtime_values,
            },
            &providers,
            routing_tags,
            media_tags,
        )
        .await
}

fn candidate_for(
    preferences: &AgentSelectionPreferences,
    agent: &AgentInfo,
    model: Option<&ModelInfo>,
) -> Candidate {
    let inferred = inferred_profile(agent, model);
    let saved = preferences.model_profiles.iter().find(|profile| {
        profile.agent_id == agent.id
            && profile.model_id.as_deref() == model.map(|model| model.id.as_str())
    });
    let tags = saved
        .filter(|profile| !profile.tags.is_empty())
        .map(|profile| normalize_tags(profile.tags.clone()))
        .unwrap_or(inferred.tags);
    let cost = saved
        .and_then(|profile| profile.cost)
        .or(inferred.cost)
        .unwrap_or_default();
    let remembered = preferences.runtimes.get(&agent.id);
    let efforts = model
        .map(|model| model.efforts.as_slice())
        .unwrap_or_default();
    let effort_id = remembered
        .and_then(|runtime| runtime.effort_id.as_ref())
        .filter(|effort| efforts.contains(effort))
        .cloned()
        .or_else(|| default_effort(efforts));
    let mode_id = remembered
        .and_then(|runtime| runtime.mode_id.as_ref())
        .filter(|mode| {
            agent
                .catalog
                .modes
                .iter()
                .any(|candidate| &candidate.id == *mode)
        })
        .cloned()
        .or_else(|| unrestricted_mode(agent))
        .or_else(|| {
            agent
                .catalog
                .default_mode
                .as_ref()
                .filter(|mode| {
                    agent
                        .catalog
                        .modes
                        .iter()
                        .any(|candidate| &candidate.id == *mode)
                })
                .cloned()
        })
        .or_else(|| agent.catalog.modes.first().map(|mode| mode.id.clone()));
    let runtime_values = agent
        .catalog
        .runtime_axes
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|axis| {
            let remembered = remembered
                .and_then(|runtime| runtime.runtime_values.get(&axis.id))
                .filter(|value| axis.values.iter().any(|candidate| &candidate.id == *value))
                .cloned();
            remembered
                .or_else(|| {
                    axis.default_value
                        .as_ref()
                        .filter(|value| axis.values.iter().any(|candidate| &candidate.id == *value))
                        .cloned()
                })
                .or_else(|| axis.values.first().map(|value| value.id.clone()))
                .map(|value| (axis.id.clone(), value))
        })
        .collect();

    Candidate {
        route: ResolvedAgentRoute {
            agent_id: agent.id.clone(),
            model_id: model.map(|model| model.id.clone()),
            effort_id,
            mode_id,
            runtime_values,
        },
        tags,
        cost,
    }
}

pub(crate) fn inferred_profile(agent: &AgentInfo, model: Option<&ModelInfo>) -> AgentModelProfile {
    let identity = format!(
        "{} {} {} {}",
        agent.id,
        agent.label,
        model.map(|model| model.id.as_str()).unwrap_or_default(),
        model.map(|model| model.label.as_str()).unwrap_or_default(),
    )
    .to_ascii_lowercase();
    let flush = identity.contains("flush") || identity.contains("flash");
    let mut tags = vec![if identity.contains("max") {
        TAG_MAX.to_string()
    } else if identity.contains("pro") {
        TAG_PRO.to_string()
    } else {
        TAG_FLUSH.to_string()
    }];
    if agent.capabilities.attachments {
        let modalities = model.and_then(|model| model.input_modalities.as_deref());
        if modalities.is_some_and(|values| values.iter().any(|value| value == "image")) {
            tags.push(TAG_IMAGE.to_string());
        }
        if modalities.is_some_and(|values| values.iter().any(|value| value == "video")) {
            tags.push(TAG_VIDEO.to_string());
        }
    }
    AgentModelProfile {
        agent_id: agent.id.clone(),
        model_id: model.map(|model| model.id.clone()),
        tags,
        cost: Some(if flush {
            AgentCostLevel::Low
        } else {
            AgentCostLevel::Medium
        }),
    }
}

fn default_effort(efforts: &[String]) -> Option<String> {
    if efforts.iter().any(|effort| effort == "high") {
        return Some("high".into());
    }
    if efforts.is_empty() {
        return None;
    }
    efforts
        .get(((efforts.len() * 2) / 3).min(efforts.len() - 1))
        .cloned()
}

fn unrestricted_mode(agent: &AgentInfo) -> Option<String> {
    if !agent.capabilities.permissions {
        return None;
    }
    let known = match agent.id.as_str() {
        "codex" | "acp:codex" | "acp:codex-acp" => &["full-access"][..],
        "claude" | "tclaude" | "acp:claude" | "acp:claude-code" => &["bypassPermissions"][..],
        _ => &[][..],
    };
    known
        .iter()
        .find_map(|id| {
            agent
                .catalog
                .modes
                .iter()
                .find(|mode| mode.id.eq_ignore_ascii_case(id))
        })
        .or_else(|| {
            agent.catalog.modes.iter().find(|mode| {
                let id = mode.id.to_ascii_lowercase();
                let label = mode.label.to_ascii_lowercase();
                matches!(
                    id.as_str(),
                    "full-access" | "full_access" | "unrestricted" | "bypasspermissions"
                ) || label.contains("full access")
                    || label.contains("unrestricted")
                    || mode.label.contains("完全")
                    || mode.label.contains("全开")
            })
        })
        .map(|mode| mode.id.clone())
}

fn can_start_without_model_catalog(agent_id: &str) -> bool {
    agent_id != "genet"
}

fn cost_rank(cost: AgentCostLevel) -> u8 {
    match cost {
        AgentCostLevel::VeryLow => 0,
        AgentCostLevel::Low => 1,
        AgentCostLevel::Medium => 2,
        AgentCostLevel::High => 3,
        AgentCostLevel::VeryHigh => 4,
    }
}

fn tag_key(tag: &str) -> String {
    tag.trim().to_lowercase()
}

fn tags_equal(left: &str, right: &str) -> bool {
    tag_key(left) == tag_key(right)
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::{
        Attachment, Capabilities, Catalog, ModelInfo, ToolCallDetail, ToolImage, ToolKind,
        ToolStatus,
    };

    fn agent(id: &str, model: &str, modalities: Option<Vec<&str>>) -> AgentInfo {
        AgentInfo {
            id: id.into(),
            label: id.into(),
            probe: ProbeState::Ready,
            capabilities: Capabilities {
                attachments: true,
                ..Default::default()
            },
            catalog: Catalog {
                models: vec![ModelInfo {
                    id: model.into(),
                    label: model.into(),
                    context_window: None,
                    reasoning: true,
                    efforts: vec!["medium".into(), "high".into()],
                    input_modalities: modalities
                        .map(|items| items.into_iter().map(str::to_string).collect()),
                }],
                ..Default::default()
            },
            builtin: true,
        }
    }

    #[test]
    fn inference_treats_unknown_media_as_unsupported_and_flash_as_flush() {
        let unknown = agent("third-party", "flash-pro", None);
        let profile = inferred_profile(&unknown, unknown.catalog.models.first());
        assert_eq!(profile.cost, Some(AgentCostLevel::Low));
        assert!(profile.tags.contains(&TAG_PRO.to_string()));
        assert!(!profile.tags.contains(&TAG_IMAGE.to_string()));
        assert!(!profile.tags.contains(&TAG_VIDEO.to_string()));
    }

    #[test]
    fn all_required_tags_must_match() {
        let candidate = agent("built-in", "model-max", Some(vec!["image"]));
        let registry = Registry::of(Vec::new());
        let route = select_tag_route(
            &AgentSelectionPreferences::default(),
            &[TAG_MAX.into(), TAG_IMAGE.into()],
            std::slice::from_ref(&candidate),
            &registry,
            false,
        )
        .expect("both inferred tags match");
        assert_eq!(route.model_id.as_deref(), Some("model-max"));
        assert!(select_tag_route(
            &AgentSelectionPreferences::default(),
            &[TAG_MAX.into(), TAG_VIDEO.into()],
            &[candidate],
            &registry,
            false,
        )
        .is_err());
    }

    #[test]
    fn only_first_three_non_auto_models_are_default_until_an_exact_model_is_configured() {
        let mut candidate = agent("codex", "provider/auto", None);
        candidate.catalog.models = ["provider/auto", "m1", "m2", "m3", "m4-max"]
            .into_iter()
            .map(|id| ModelInfo {
                id: id.into(),
                label: if id == "provider/auto" {
                    "Auto Select".into()
                } else {
                    id.into()
                },
                context_window: None,
                reasoning: true,
                efforts: Vec::new(),
                input_modalities: None,
            })
            .collect();
        let registry = Registry::of(Vec::new());

        assert!(select_tag_route(
            &AgentSelectionPreferences::default(),
            &[TAG_MAX.into()],
            std::slice::from_ref(&candidate),
            &registry,
            false,
        )
        .is_err());

        let preferences = AgentSelectionPreferences {
            model_profiles: vec![AgentModelProfile {
                agent_id: "codex".into(),
                model_id: Some("m4-max".into()),
                tags: vec![TAG_MAX.into()],
                cost: Some(AgentCostLevel::Medium),
            }],
            ..Default::default()
        };
        let route = select_tag_route(
            &preferences,
            &[TAG_MAX.into()],
            std::slice::from_ref(&candidate),
            &registry,
            false,
        )
        .expect("explicitly added fourth model is eligible");
        assert_eq!(route.model_id.as_deref(), Some("m4-max"));

        candidate
            .catalog
            .models
            .retain(|model| model.id != "m4-max");
        assert!(
            select_tag_route(
                &preferences,
                &[TAG_FLUSH.into()],
                &[candidate],
                &registry,
                false,
            )
            .is_err(),
            "a stale configured row must not enable unconfigured defaults"
        );
    }

    #[test]
    fn routed_request_tags_are_bounded_and_media_vocabulary_is_closed() {
        assert_eq!(
            validate_selected_tags(vec![" max ".into(), "私有".into()]).unwrap(),
            vec![TAG_MAX.to_string(), "私有".to_string()]
        );
        assert!(validate_selected_tags(Vec::new()).is_err());
        assert!(validate_selected_tags(vec!["Flush".into(), "flush".into()]).is_err());
        assert!(validate_selected_tags(vec!["x".repeat(41)]).is_err());
        assert_eq!(
            validate_media_tags(vec![TAG_VIDEO.into(), TAG_IMAGE.into()]).unwrap(),
            vec![TAG_VIDEO.to_string(), TAG_IMAGE.to_string()]
        );
        assert!(validate_media_tags(vec!["私有".into()]).is_err());
    }

    #[test]
    fn portable_history_adds_image_and_video_requirements() {
        let items = vec![TimelineItem::UserMessage {
            id: "u1".into(),
            text: "看看这些".into(),
            attachments: vec![
                Attachment {
                    name: "frame.png".into(),
                    mime: "image/png".into(),
                    path: None,
                    data_base64: None,
                },
                Attachment {
                    name: "clip.mp4".into(),
                    mime: "video/mp4".into(),
                    path: None,
                    data_base64: None,
                },
            ],
        }];
        assert_eq!(
            media_tags_for_timeline(&items),
            vec![TAG_IMAGE.to_string(), TAG_VIDEO.to_string()]
        );
    }

    #[test]
    fn produced_images_are_also_history_requirements() {
        let items = vec![TimelineItem::ToolCall {
            id: "tool-1".into(),
            name: "Read".into(),
            status: ToolStatus::Ok,
            detail: ToolCallDetail::Overview {
                tool_kind: ToolKind::Read,
                overview: "frame.png".into(),
                input: "frame.png".into(),
                output: String::new(),
            },
            images: vec![ToolImage {
                alt: "frame".into(),
                mime: "image/png".into(),
                data_base64: None,
                thumb: None,
                path: Some("frame.png".into()),
            }],
            started_at_ms: None,
            finished_at_ms: None,
        }];
        assert_eq!(media_tags_for_timeline(&items), vec![TAG_IMAGE.to_string()]);
    }
}
