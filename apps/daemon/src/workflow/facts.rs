//! Read models and admission predicates. No lifecycle is stored here: the
//! program, activity identities and resource retirement remain authoritative.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Interruption {
    /// Committed journal boundary; zero exists only before save_run commits.
    pub occurrence: u64,
    pub session_id: String,
    pub attempt: u32,
    pub observed_at_ms: i64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RouteWait {
    pub occurrence: u64,
    pub since_ms: i64,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum NodePhase {
    Pending,
    #[serde(alias = "running", alias = "interrupted")]
    Active,
    Finishing,
    #[serde(
        alias = "completed",
        alias = "blocked",
        alias = "failed",
        alias = "cancelled"
    )]
    Settled,
    Unreached,
}
impl NodePhase {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Active => "active",
            Self::Finishing => "finishing",
            Self::Settled => "settled",
            Self::Unreached => "unreached",
        }
    }
}
impl NodeRecord {
    /// Old RPC vocabulary is a projection, never persisted.
    pub(super) fn status(&self) -> &'static str {
        match self.phase {
            NodePhase::Pending => "pending",
            NodePhase::Active => "running",
            NodePhase::Finishing => "finishing",
            NodePhase::Settled => "completed",
            NodePhase::Unreached => "unreached",
        }
    }
}

impl RunRecord {
    pub(super) fn route_wait(&self) -> Vec<String> {
        self.nodes
            .iter()
            .filter(|(_, node)| node.route_wait.is_some())
            .map(|(id, _)| id.clone())
            .collect()
    }
    pub(super) fn retain_routes(&mut self, keep: impl Fn(&String) -> bool) {
        for (id, node) in &mut self.nodes {
            if !keep(id) {
                node.route_wait = None;
            }
        }
    }
    pub(super) fn wait_for_route(&mut self, id: &str, reason: String) {
        if let Some(node) = self.nodes.get_mut(id) {
            node.route_wait.get_or_insert(RouteWait {
                occurrence: 0,
                since_ms: now_ms(),
                reason,
            });
        }
    }
    pub(super) fn conditions(&self) -> Vec<genehub_proto::WorkflowCondition> {
        let mut conditions = Vec::new();
        for (id, node) in &self.nodes {
            if let Some(fault) = &node.interruption {
                conditions.push(genehub_proto::WorkflowCondition {
                    code: "nodeInterrupted".into(),
                    node_id: Some(id.clone()),
                    occurrence: fault.occurrence,
                    since_ms: fault.observed_at_ms,
                    reason: fault.reason.clone(),
                });
            }
            if let Some(wait) = &node.route_wait {
                conditions.push(genehub_proto::WorkflowCondition {
                    code: "routeUnavailable".into(),
                    node_id: Some(id.clone()),
                    occurrence: wait.occurrence,
                    since_ms: wait.since_ms,
                    reason: wait.reason.clone(),
                });
            }
        }
        if let Some(stop) = &self.stop {
            conditions.push(genehub_proto::WorkflowCondition {
                code: stop.cause_code.clone(),
                node_id: None,
                occurrence: self
                    .supervision
                    .execution
                    .as_ref()
                    .and_then(|clock| clock.stop_seq)
                    .unwrap_or(0),
                since_ms: self.updated_at_ms,
                reason: stop.reason.clone(),
            });
        }
        conditions
    }
    pub(super) fn program_result(&self) -> Option<String> {
        let status = self
            .engine
            .as_ref()
            .map(|engine| match engine.status {
                workflow_engine::Status::Completed => "completed",
                workflow_engine::Status::Blocked => "failed",
                workflow_engine::Status::Cancelled => "cancelled",
                _ => "",
            })
            .unwrap_or_else(|| match self.legacy_program_status.as_deref() {
                Some("completed" | "awaitingPm") => "completed",
                Some("blocked" | "failed") => "failed",
                Some("cancelled") => "cancelled",
                _ => "",
            });
        (!status.is_empty()).then(|| status.into())
    }
    /// Compatibility label for old RPC readers, never an independently saved
    /// state. In particular, interruption does not change the program status.
    pub(super) fn status(&self) -> &str {
        if self.retired_at_ms.is_none() {
            if let Some(stop) = &self.stop {
                return if stop.target == "cancelled" {
                    "cancelling"
                } else {
                    "stopping"
                };
            }
        }
        // An invalid pure snapshot remains evidence. A host abort with
        // confirmed retirement still closes the execution, without inventing
        // a successful program result or permitting that snapshot to resume.
        if self.retired_at_ms.is_some() {
            if let Some(stop) = &self.stop {
                if self.program_result().is_none() {
                    return if stop.target == "cancelled" {
                        "cancelled"
                    } else {
                        "blocked"
                    };
                }
            }
        }
        match self.engine.as_ref().map(|engine| &engine.status) {
            Some(workflow_engine::Status::Running) => "running",
            Some(workflow_engine::Status::Stopping) => "stopping",
            Some(workflow_engine::Status::Cancelling) => "cancelling",
            Some(workflow_engine::Status::Completed) => "completed",
            Some(workflow_engine::Status::Blocked) => "blocked",
            Some(workflow_engine::Status::Cancelled) => "cancelled",
            None => self.legacy_program_status.as_deref().unwrap_or("blocked"),
        }
    }

    pub(super) fn phase(&self) -> &'static str {
        let terminal = matches!(
            self.status(),
            "completed" | "blocked" | "failed" | "cancelled" | "awaitingPm"
        );
        let active = self
            .nodes
            .values()
            .any(|node| matches!(node.status(), "running" | "finishing" | "interrupted"));
        if terminal
            && !active
            && self.retired_at_ms.is_some()
            && self
                .stop
                .as_ref()
                .is_none_or(|stop| stop.cleanup_error.is_none())
        {
            "closed"
        } else if self.stop.is_some()
            || terminal
            || matches!(self.status(), "stopping" | "cancelling")
        {
            "closing"
        } else {
            "open"
        }
    }

    pub(super) fn program_open(&self) -> bool {
        self.phase() == "open"
    }
    pub(super) fn unfinished(&self) -> bool {
        self.phase() != "closed"
    }
    pub(super) fn interrupted(&self) -> bool {
        self.nodes.values().any(|node| node.interruption.is_some())
    }
    pub(super) fn disposition_since(&self) -> Option<i64> {
        self.nodes
            .values()
            .flat_map(|node| {
                node.interruption
                    .as_ref()
                    .map(|fault| fault.observed_at_ms)
                    .into_iter()
                    .chain(node.route_wait.as_ref().map(|wait| wait.since_ms))
            })
            .min()
    }
    pub(super) fn interruption_seq(&self) -> Option<u64> {
        self.nodes
            .values()
            .flat_map(|node| {
                node.interruption
                    .as_ref()
                    .map(|fault| fault.occurrence)
                    .into_iter()
                    .chain(node.route_wait.as_ref().map(|wait| wait.occurrence))
            })
            .filter(|seq| *seq > 0)
            .max()
    }
    pub(super) fn completion_admissible(&self, node: &NodeRecord, session: &str) -> bool {
        self.program_open()
            && node.status() == "running"
            && node.interruption.is_none()
            && node.session_id.as_deref() == Some(session)
    }
    pub(super) fn executing(&self) -> bool {
        self.nodes.iter().any(|(id, node)| {
            matches!(node.status(), "running" | "finishing")
                && node.interruption.is_none()
                && !self.supervision.waiting_requests.iter().any(|wait| {
                    wait.node_id == *id
                        && node.session_id.as_deref() == Some(wait.session_id.as_str())
                })
        })
    }
}
