//! Read-only diagnostic projection. This is not a replacement for the snapshot.
use crate::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameView {
    pub id: u64,
    pub parent: Option<u64>,
    pub block_id: String,
    pub kind: String,
    pub round: Option<u32>,
    pub item_id: Option<String>,
    pub status: String,
}

pub fn inspect(program: &Program, state: &EngineState) -> Result<Vec<FrameView>> {
    crate::runtime::validate_state(program, state)?;
    Ok(state
        .frames
        .iter()
        .map(|(id, frame)| {
            let kind = match &program.nodes[&frame.node].kind {
                BlockKind::Task { .. } => "task",
                BlockKind::Sequence { .. } => "sequence",
                BlockKind::If { .. } => "if",
                BlockKind::Choice { .. } => "choice",
                BlockKind::Loop { .. } => "loop",
                BlockKind::Parallel { .. } => "parallel",
                BlockKind::ForEach { .. } => "forEach",
                BlockKind::Call { .. } => "call",
            };
            FrameView {
                id: *id,
                parent: frame.parent,
                block_id: frame.node.clone(),
                kind: kind.into(),
                item_id: frame
                    .parent
                    .and_then(|parent| state.frames.get(&parent))
                    .and_then(|p| match &p.cursor {
                        Cursor::ForEach { children, .. } => children
                            .iter()
                            .find(|(_, child)| **child == *id)
                            .map(|(key, _)| key.clone()),
                        _ => None,
                    }),
                round: match frame.cursor {
                    Cursor::Loop { entered, .. } => Some(entered),
                    _ => None,
                },
                status: if let Some(result) = &frame.outcome {
                    result.code.clone()
                } else if matches!(frame.cursor, Cursor::Enter) {
                    "pending".into()
                } else {
                    "running".into()
                },
            }
        })
        .collect())
}

/// Captured when a host activity is admitted, so completed iterations retain
/// their structural address even after the active frontier is compacted.
pub fn ancestry(program: &Program, state: &EngineState, frame: u64) -> Result<Vec<FrameView>> {
    let views = inspect(program, state)?;
    let mut address = Vec::new();
    let mut cursor = Some(frame);
    while let Some(id) = cursor {
        let view = views
            .iter()
            .find(|v| v.id == id)
            .ok_or_else(|| Error::State("missing activity frame".into()))?;
        address.push(view.clone());
        cursor = view.parent;
    }
    address.reverse();
    Ok(address)
}
