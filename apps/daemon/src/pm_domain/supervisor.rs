use serde::{Deserialize, Serialize};

const BACKOFF_MS: [i64; 4] = [30_000, 60_000, 120_000, 300_000];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SupervisorMode {
    Idle,
    Active,
    WaitingUser,
    Terminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WakeDispatchOutcome {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorState {
    pub mode: SupervisorMode,
    pub observation_digest: Option<String>,
    pub backoff_step: usize,
    pub next_check_at_ms: Option<i64>,
    pub last_event_at_ms: Option<i64>,
    /// A changed WorkSession fact has not yet been handed to the PM session.
    /// Persisting this bit prevents a daemon restart or a busy PM turn from
    /// losing the wakeup.
    #[serde(default)]
    pub wake_pending: bool,
    /// The exact PM adapter turn currently handling `wake_pending`.
    ///
    /// A successful handoff is not an acknowledgement: the daemon can reload
    /// after the prompt reached the PM but before the PM reconciled the
    /// project.  Keeping the turn id lets the next daemon acknowledge only a
    /// completed PM round and retry interrupted/failed ones.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_turn_id: Option<String>,
    /// Consecutive PM wake turns that reached the model and failed.
    ///
    /// This is deliberately separate from the quiet-session sampling backoff:
    /// a provider refusal must not turn the two-second daemon sampler into an
    /// upstream retry storm.
    #[serde(default)]
    pub wake_retry_step: usize,
    /// Earliest time a failed PM wake may be dispatched again. Interrupted
    /// turns (for example, an in-place daemon reload) remain immediately
    /// recoverable and do not set this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_retry_at_ms: Option<i64>,
}

impl SupervisorState {
    pub fn idle() -> Self {
        Self {
            mode: SupervisorMode::Idle,
            observation_digest: None,
            backoff_step: 0,
            next_check_at_ms: None,
            last_event_at_ms: None,
            wake_pending: false,
            wake_turn_id: None,
            wake_retry_step: 0,
            wake_retry_at_ms: None,
        }
    }

    pub fn baseline(&mut self, digest: String, now_ms: i64) {
        self.mode = SupervisorMode::Active;
        self.observation_digest = Some(digest);
        self.backoff_step = 0;
        self.next_check_at_ms = Some(now_ms.saturating_add(BACKOFF_MS[0]));
        self.last_event_at_ms = Some(now_ms);
        // Establishing supervision is not itself a WorkSession event. An
        // immediate wake here can race the user's next PM turn and consume its
        // model/tool response. Actionable but quiet graph state is revisited
        // only after the first bounded check; later observation changes still
        // create an immediate durable wake.
        self.wake_pending = false;
        self.wake_turn_id = None;
        self.reset_wake_retry();
    }

    pub fn due(&self, now_ms: i64) -> bool {
        self.next_check_at_ms.is_some_and(|next| next <= now_ms)
    }

    pub fn acknowledge_wake(&mut self) {
        self.wake_pending = false;
        self.wake_turn_id = None;
        self.reset_wake_retry();
    }

    pub fn mark_wake_dispatched(&mut self, turn_id: String) {
        if self.wake_pending {
            self.wake_turn_id = Some(turn_id);
            self.wake_retry_at_ms = None;
        }
    }

    pub fn release_interrupted_wake_dispatch(&mut self) {
        self.wake_turn_id = None;
        self.wake_retry_at_ms = None;
    }

    pub fn defer_failed_wake_dispatch(&mut self, now_ms: i64) {
        self.wake_turn_id = None;
        let step = self.wake_retry_step.min(BACKOFF_MS.len() - 1);
        self.wake_retry_at_ms = Some(now_ms.saturating_add(BACKOFF_MS[step]));
        self.wake_retry_step = (step + 1).min(BACKOFF_MS.len() - 1);
    }

    pub fn wake_ready(&self, now_ms: i64) -> bool {
        self.wake_pending
            && (self.wake_turn_id.is_some()
                || self
                    .wake_retry_at_ms
                    .is_none_or(|retry_at| retry_at <= now_ms))
    }

    pub fn request_quiet_wake(&mut self, now_ms: i64) {
        if self.mode == SupervisorMode::Active && !self.wake_pending {
            self.wake_pending = true;
            self.wake_turn_id = None;
            self.reset_wake_retry();
            self.last_event_at_ms = Some(now_ms);
        }
    }

    pub fn observe(
        &mut self,
        digest: String,
        active_work: bool,
        waiting_user: bool,
        terminal: bool,
        now_ms: i64,
    ) -> bool {
        let changed = self.observation_digest.as_deref() != Some(digest.as_str());
        self.observation_digest = Some(digest);
        if terminal {
            self.mode = SupervisorMode::Terminal;
            self.backoff_step = 0;
            self.next_check_at_ms = None;
            self.wake_pending = false;
            self.wake_turn_id = None;
            self.reset_wake_retry();
            return changed;
        }
        if waiting_user {
            self.mode = SupervisorMode::WaitingUser;
            self.backoff_step = 0;
            self.next_check_at_ms = None;
            self.wake_pending = false;
            self.wake_turn_id = None;
            self.reset_wake_retry();
            return changed;
        }
        if !active_work {
            self.mode = SupervisorMode::Idle;
            self.backoff_step = 0;
            self.next_check_at_ms = None;
            self.wake_pending = false;
            self.wake_turn_id = None;
            self.reset_wake_retry();
            return changed;
        }
        self.mode = SupervisorMode::Active;
        if changed {
            self.backoff_step = 0;
            self.last_event_at_ms = Some(now_ms);
            self.wake_pending = true;
            self.wake_turn_id = None;
            self.reset_wake_retry();
        } else {
            self.backoff_step = (self.backoff_step + 1).min(BACKOFF_MS.len() - 1);
        }
        self.next_check_at_ms = Some(now_ms.saturating_add(BACKOFF_MS[self.backoff_step]));
        changed
    }

    fn reset_wake_retry(&mut self) {
        self.wake_retry_step = 0;
        self.wake_retry_at_ms = None;
    }
}
