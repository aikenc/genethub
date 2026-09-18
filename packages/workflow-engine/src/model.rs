use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct Block {
    pub id: String,
    #[serde(flatten)]
    pub kind: BlockKind,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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
        /// Defaults to the named child results. Evaluated only on normal completion.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<Expr>,
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
        /// Every branch has already started, so this can only cut short a group
        /// whose verdict is already negative. See `ForEach::complete_when`.
        #[serde(
            default,
            rename = "completeWhen",
            skip_serializing_if = "Option::is_none"
        )]
        complete_when: Option<Expr>,
        #[serde(default, rename = "failure", skip_serializing)]
        retired_failure: Option<RetiredJoin>,
    },
    ForEach {
        items: Expr,
        /// Optional stable item key; otherwise the frozen array index is used.
        #[serde(default)]
        key: Option<Expr>,
        #[serde(rename = "maxConcurrency")]
        max_concurrency: usize,
        body: Box<Block>,
        /// Join policy as data instead of a fixed enum. Evaluated against the
        /// results that have already arrived; when it holds, no further item is
        /// started and the group settles once its in-flight items return. If
        /// those arrived results already contain a failure the group can no
        /// longer succeed, so the execution stops instead of paying for work
        /// that cannot change the verdict. Absent means every item runs.
        #[serde(
            default,
            rename = "completeWhen",
            skip_serializing_if = "Option::is_none"
        )]
        complete_when: Option<Expr>,
        #[serde(default, rename = "failure", skip_serializing)]
        retired_failure: Option<RetiredJoin>,
        /// Optional serial fold. Uses the same local vars/update convention as loop.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        initial: Option<Expr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        update: Option<Expr>,
    },
    /// Exits the nearest lexical loop or serial forEach, returning this value.
    Break { value: Expr },
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
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Branch {
    pub condition: Expr,
    pub body: Block,
}
/// The join policy this engine used before `completeWhen`. Definitions pinned
/// inside a Run by an older host still carry it, and so do project sources that
/// have not been migrated, so it is accepted as input, translated once while
/// compiling and never written back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum RetiredJoin {
    Collect,
    FailFast,
}
impl RetiredJoin {
    /// `failFast` stopped a group as soon as a failure arrived, which is exactly
    /// what this expression says about the arrived results.
    pub(crate) fn translate(self) -> Option<Expr> {
        match self {
            Self::Collect => None,
            Self::FailFast => Some(Expr::Not {
                value: Box::new(Expr::Eq {
                    left: Box::new(Expr::Ref {
                        path: "/group/failed".into(),
                    }),
                    right: Box::new(Expr::Literal {
                        value: Value::from(0),
                    }),
                }),
            }),
        }
    }
}
/// References use JSON Pointer into {input, vars, results, item}. No I/O or code.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Expr {
    Literal {
        value: Value,
    },
    Ref {
        path: String,
    },
    Exists {
        path: String,
    },
    Object {
        fields: BTreeMap<String, Expr>,
    },
    /// Object entries in ascending key order; at most 4096 items.
    Entries {
        value: Box<Expr>,
    },
    Eq {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Lt {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Add {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Append {
        array: Box<Expr>,
        value: Box<Expr>,
    },
    Contains {
        array: Box<Expr>,
        value: Box<Expr>,
    },
    Not {
        value: Box<Expr>,
    },
    All {
        values: Vec<Expr>,
    },
    Any {
        values: Vec<Expr>,
    },
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
    /// Internal control, separate from activity outcome codes. Never set by a Worker.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) breaking: bool,
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
        /// `completeWhen` already held: start no further item.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        sealed: bool,
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
