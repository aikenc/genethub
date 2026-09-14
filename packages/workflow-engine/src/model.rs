use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Definition {
    /// Absolute elapsed-time limit, including user waits, fixed when started.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    pub body: Block,
    #[serde(default)]
    pub procedures: BTreeMap<String, Block>,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub limits: Limits,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub max_operations: u64,
    pub max_concurrency: usize,
    pub max_frames: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_operations: 256,
            max_concurrency: 8,
            max_frames: 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
    pub id: String,
    #[serde(flatten)]
    pub kind: BlockKind,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum BlockKind {
    Task {
        activity: String,
        #[serde(default, rename = "timeoutMs")]
        timeout_ms: Option<u64>,
        #[serde(default = "context_expr")]
        input: Expr,
        #[serde(default = "accepted_outcomes")]
        accept: Vec<String>,
    },
    Sequence {
        steps: Vec<Block>,
    },
    If {
        condition: Expr,
        then: Box<Block>,
        #[serde(default)]
        r#else: Option<Box<Block>>,
    },
    Choice {
        branches: Vec<Branch>,
        default: Box<Block>,
    },
    Loop {
        condition: Expr,
        #[serde(rename = "maxRounds")]
        max_rounds: u32,
        #[serde(default)]
        initial: Expr,
        body: Box<Block>,
        #[serde(default = "vars_expr")]
        update: Expr,
    },
    Parallel {
        branches: Vec<Block>,
        #[serde(default)]
        failure: FailurePolicy,
    },
    ForEach {
        items: Expr,
        /// Optional stable item key; otherwise the frozen array index is used.
        #[serde(default)]
        key: Option<Expr>,
        #[serde(rename = "maxConcurrency")]
        max_concurrency: usize,
        body: Box<Block>,
        #[serde(default)]
        failure: FailurePolicy,
    },
    Call {
        procedure: String,
        #[serde(default = "context_expr")]
        input: Expr,
    },
}
fn accepted_outcomes() -> Vec<String> {
    vec!["completed".into()]
}
fn context_expr() -> Expr {
    Expr::Ref { path: "".into() }
}
fn vars_expr() -> Expr {
    Expr::Ref {
        path: "/vars".into(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Branch {
    pub condition: Expr,
    pub body: Block,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FailurePolicy {
    #[default]
    Collect,
    FailFast,
}

/// References use JSON Pointer into {input, vars, results, item}. No I/O or code.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Expr {
    Literal { value: Value },
    Ref { path: String },
    Exists { path: String },
    Object { fields: BTreeMap<String, Expr> },
    Eq { left: Box<Expr>, right: Box<Expr> },
    Lt { left: Box<Expr>, right: Box<Expr> },
    Not { value: Box<Expr> },
    All { values: Vec<Expr> },
    Any { values: Vec<Expr> },
}
impl Default for Expr {
    fn default() -> Self {
        Self::Literal { value: Value::Null }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Running,
    Stopping,
    Completed,
    Blocked,
    Cancelling,
    Cancelled,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineState {
    pub format_version: u32,
    pub definition_digest: String,
    pub execution_id: String,
    pub revision: u64,
    pub logical_time_ms: u64,
    pub deadline_ms: Option<u64>,
    pub next_id: u64,
    pub operations_started: u64,
    pub control_steps: u64,
    pub status: Status,
    pub root: u64,
    pub frames: BTreeMap<u64, Frame>,
    pub operations: BTreeMap<String, Operation>,
    pub outcome: Option<Outcome>,
    pub needs_drive: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Frame {
    pub node: String,
    pub parent: Option<u64>,
    pub context: Value,
    pub cursor: Cursor,
    pub outcome: Option<Outcome>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase", deny_unknown_fields)]
pub enum Cursor {
    Enter,
    Task {
        operation: String,
    },
    Sequence {
        next: usize,
        child: Option<u64>,
    },
    Selected {
        child: u64,
    },
    Loop {
        entered: u32,
        child: Option<u64>,
    },
    Parallel {
        children: BTreeMap<String, u64>,
        results: BTreeMap<String, Outcome>,
    },
    ForEach {
        items: Vec<Value>,
        keys: Vec<String>,
        next: usize,
        children: BTreeMap<String, u64>,
        results: BTreeMap<String, Outcome>,
    },
    Done,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Outcome {
    pub code: String,
    pub value: Value,
    pub success: bool,
}
impl Outcome {
    pub fn completed(value: Value) -> Self {
        Self {
            code: "completed".into(),
            value,
            success: true,
        }
    }
    pub fn failed(code: &str, detail: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            value: Value::String(detail.into()),
            success: false,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationPhase {
    Requested,
    Running,
    Waiting,
    Cancelling,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation {
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub deadline_ms: Option<u64>,
    pub id: String,
    pub frame: u64,
    pub activity: String,
    pub input: Value,
    pub phase: OperationPhase,
    pub update_seq: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Event {
    Drive,
    Cancel {
        reason: String,
    },
    /// The host cannot safely continue (for example an unconfirmed activity).
    Abort {
        reason: String,
    },
    ActivityUpdate {
        id: String,
        #[serde(rename = "updateSeq")]
        update_seq: u64,
        update: ActivityUpdate,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ActivityUpdate {
    Accepted,
    Waiting,
    /// The host has verified the result and retired the execution/resources.
    Settled {
        outcome: Outcome,
    },
}
#[derive(Debug, Clone)]
pub struct Input {
    pub expected_revision: u64,
    pub now_ms: u64,
    pub event: Event,
}
#[derive(Debug, Clone)]
pub struct StartRequest {
    pub execution_id: String,
    pub input: Value,
    pub now_ms: u64,
    pub deadline_ms: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub frame: u64,
    pub parent: Option<u64>,
    pub node: String,
    pub event: String,
    pub detail: Value,
}
#[derive(Debug, Clone)]
pub struct Transition {
    pub state: EngineState,
    pub history: Vec<HistoryEntry>,
}
#[derive(Debug, Clone)]
pub struct PendingWork {
    pub operations: Vec<Operation>,
    pub wake_at_ms: Option<u64>,
    pub needs_drive: bool,
}
