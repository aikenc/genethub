use crate::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub struct Program {
    pub(crate) definition: Definition,
    pub(crate) nodes: BTreeMap<String, Block>,
    pub(crate) digest: String,
}
impl Program {
    pub fn definition(&self) -> &Definition {
        &self.definition
    }
    pub fn digest(&self) -> &str {
        &self.digest
    }
    pub fn activities(&self) -> BTreeSet<String> {
        self.nodes
            .values()
            .filter_map(|n| match &n.kind {
                BlockKind::Task { activity, .. } => Some(activity.clone()),
                _ => None,
            })
            .collect()
    }
}
pub fn compile(definition: Definition) -> Result<Program> {
    if definition.limits.max_concurrency == 0
        || definition.limits.max_concurrency > 64
        || definition.limits.max_frames == 0
        || definition.limits.max_frames > 4096
        || definition.limits.max_operations > 100_000
    {
        return Err(Error::Definition("limits exceed engine bounds".into()));
    }
    if definition
        .timeout_ms
        .is_some_and(|ms| ms > 7 * 24 * 60 * 60 * 1000)
    {
        return Err(Error::Definition(
            "workflow timeout exceeds seven days".into(),
        ));
    }
    let mut nodes = BTreeMap::new();
    fn walk(block: &Block, nodes: &mut BTreeMap<String, Block>, depth: usize) -> Result<()> {
        if depth > 32 || nodes.len() >= 1024 {
            return Err(Error::Definition(
                "structure exceeds size/depth bounds".into(),
            ));
        }
        if block.id.is_empty()
            || block.id.len() > 128
            || !block
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        {
            return Err(Error::Definition(format!("invalid block id {}", block.id)));
        }
        if nodes.insert(block.id.clone(), block.clone()).is_some() {
            return Err(Error::Definition(format!("duplicate block {}", block.id)));
        }
        match &block.kind {
            BlockKind::Sequence { steps } => {
                for child in steps {
                    walk(child, nodes, depth + 1)?;
                }
            }
            BlockKind::Parallel { branches, .. } => {
                for child in branches {
                    walk(child, nodes, depth + 1)?;
                }
            }
            BlockKind::If { then, r#else, .. } => {
                walk(then, nodes, depth + 1)?;
                if let Some(child) = r#else {
                    walk(child, nodes, depth + 1)?;
                }
            }
            BlockKind::Choice { branches, default } => {
                for branch in branches {
                    walk(&branch.body, nodes, depth + 1)?;
                }
                walk(default, nodes, depth + 1)?;
            }
            BlockKind::Loop {
                body, max_rounds, ..
            } => {
                if *max_rounds > 10_000 {
                    return Err(Error::Definition("loop round limit exceeds 10000".into()));
                }
                walk(body, nodes, depth + 1)?;
            }
            BlockKind::ForEach {
                body,
                max_concurrency,
                ..
            } => {
                if *max_concurrency == 0 || *max_concurrency > 64 {
                    return Err(Error::Definition(
                        "foreach requires concurrency 1..64".into(),
                    ));
                }
                walk(body, nodes, depth + 1)?;
            }
            BlockKind::Task {
                activity, accept, ..
            } => {
                if activity.is_empty() || activity.len() > 128 || accept.is_empty() {
                    return Err(Error::Definition(
                        "task requires activity and accepted outcomes".into(),
                    ));
                }
            }
            BlockKind::Call { .. } => {}
        }
        Ok(())
    }
    walk(&definition.body, &mut nodes, 0)?;
    for body in definition.procedures.values() {
        walk(body, &mut nodes, 0)?;
    }
    fn calls(
        block: &Block,
        definition: &Definition,
        stack: &mut Vec<String>,
        depth: usize,
        visits: &mut usize,
    ) -> Result<()> {
        *visits += 1;
        if *visits > 16384 {
            return Err(Error::Definition(
                "expanded call structure exceeds 16384 blocks".into(),
            ));
        }
        if depth > 32 {
            return Err(Error::Definition("expanded call depth exceeds 32".into()));
        }
        match &block.kind {
            BlockKind::Call { procedure, .. } => {
                if stack.contains(procedure) {
                    return Err(Error::Definition(format!(
                        "recursive procedure {procedure}"
                    )));
                }
                let body = definition
                    .procedures
                    .get(procedure)
                    .ok_or_else(|| Error::Definition(format!("unknown procedure {procedure}")))?;
                stack.push(procedure.clone());
                calls(body, definition, stack, depth + 1, visits)?;
                stack.pop();
            }
            BlockKind::Sequence { steps } => {
                for c in steps {
                    calls(c, definition, stack, depth + 1, visits)?;
                }
            }
            BlockKind::Parallel { branches, .. } => {
                for c in branches {
                    calls(c, definition, stack, depth + 1, visits)?;
                }
            }
            BlockKind::Loop { body, .. } | BlockKind::ForEach { body, .. } => {
                calls(body, definition, stack, depth + 1, visits)?
            }
            BlockKind::If { then, r#else, .. } => {
                calls(then, definition, stack, depth + 1, visits)?;
                if let Some(c) = r#else {
                    calls(c, definition, stack, depth + 1, visits)?;
                }
            }
            BlockKind::Choice { branches, default } => {
                for b in branches {
                    calls(&b.body, definition, stack, depth + 1, visits)?;
                }
                calls(default, definition, stack, depth + 1, visits)?;
            }
            _ => {}
        }
        Ok(())
    }
    let mut visits = 0;
    calls(
        &definition.body,
        &definition,
        &mut Vec::new(),
        0,
        &mut visits,
    )?;
    for (name, body) in &definition.procedures {
        calls(body, &definition, &mut vec![name.clone()], 0, &mut visits)?;
    }
    let mut expression_budget = 16384;
    for block in nodes.values() {
        let mut check = |expr: &Expr| expr.validate(0, &mut expression_budget);
        match &block.kind {
            BlockKind::Task { input, .. } | BlockKind::Call { input, .. } => check(input)?,
            BlockKind::If { condition, .. } => check(condition)?,
            BlockKind::Choice { branches, .. } => {
                for branch in branches {
                    check(&branch.condition)?;
                }
            }
            BlockKind::Loop {
                condition,
                initial,
                update,
                ..
            } => {
                check(condition)?;
                check(initial)?;
                check(update)?;
            }
            BlockKind::ForEach { items, key, .. } => {
                check(items)?;
                if let Some(key) = key {
                    check(key)?;
                }
            }
            _ => {}
        }
    }
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&definition)?)
    );
    Ok(Program {
        definition,
        nodes,
        digest,
    })
}
