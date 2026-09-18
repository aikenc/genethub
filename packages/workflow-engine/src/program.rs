use crate::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub struct Program {
    pub(crate) definition: Definition,
    pub(crate) nodes: BTreeMap<String, Block>,
    pub(crate) digest: String,
    pub(crate) source_paths: BTreeMap<String, String>,
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
    /// Host-side capability validation without reparsing or rewalking the graph.
    pub fn tasks(&self) -> impl Iterator<Item = (&str, &str, &[String])> {
        self.nodes.values().filter_map(|block| match &block.kind {
            BlockKind::Task {
                activity, accept, ..
            } => Some((
                self.source_paths[&block.id].as_str(),
                activity.as_str(),
                accept.as_slice(),
            )),
            _ => None,
        })
    }
}
/// Translate the retired join enum before anything reads the join policy, so a
/// Run pinned by an older host keeps the behavior it was started with and a
/// project source that still declares it keeps compiling.
fn translate_retired_joins(block: &mut Block) {
    let (complete_when, retired) = match &mut block.kind {
        BlockKind::Parallel {
            branches,
            complete_when,
            retired_failure,
        } => {
            branches.iter_mut().for_each(translate_retired_joins);
            (complete_when, retired_failure)
        }
        BlockKind::ForEach {
            body,
            complete_when,
            retired_failure,
            ..
        } => {
            translate_retired_joins(body);
            (complete_when, retired_failure)
        }
        BlockKind::Sequence { steps, .. } => {
            steps.iter_mut().for_each(translate_retired_joins);
            return;
        }
        BlockKind::If { then, r#else, .. } => {
            translate_retired_joins(then);
            if let Some(r#else) = r#else {
                translate_retired_joins(r#else);
            }
            return;
        }
        BlockKind::Choice { branches, default } => {
            branches
                .iter_mut()
                .for_each(|branch| translate_retired_joins(&mut branch.body));
            translate_retired_joins(default);
            return;
        }
        BlockKind::Loop { body, .. } => return translate_retired_joins(body),
        BlockKind::Task { .. } | BlockKind::Call { .. } | BlockKind::Break { .. } => return,
    };
    // An explicit `completeWhen` is the author's current intent and wins.
    if let (None, Some(retired)) = (&complete_when, retired.take()) {
        *complete_when = retired.translate();
    }
}
pub fn compile(mut definition: Definition) -> Result<Program> {
    translate_retired_joins(&mut definition.body);
    definition
        .procedures
        .values_mut()
        .for_each(translate_retired_joins);
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
    let mut paths = BTreeMap::new();
    fn walk(
        block: &Block,
        nodes: &mut BTreeMap<String, Block>,
        depth: usize,
        can_break: bool,
        path: &str,
        paths: &mut BTreeMap<String, String>,
    ) -> Result<()> {
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
        paths.insert(block.id.clone(), path.into());
        match &block.kind {
            BlockKind::Sequence { steps, .. } => {
                for (i, child) in steps.iter().enumerate() {
                    walk(
                        child,
                        nodes,
                        depth + 1,
                        can_break,
                        &format!("{path}/steps/{i}"),
                        paths,
                    )
                    .map_err(|e| e.located(path))?;
                }
            }
            BlockKind::Parallel { branches, .. } => {
                for (i, child) in branches.iter().enumerate() {
                    walk(
                        child,
                        nodes,
                        depth + 1,
                        false,
                        &format!("{path}/branches/{i}"),
                        paths,
                    )
                    .map_err(|e| e.located(path))?;
                }
            }
            BlockKind::If { then, r#else, .. } => {
                walk(
                    then,
                    nodes,
                    depth + 1,
                    can_break,
                    &format!("{path}/then"),
                    paths,
                )
                .map_err(|e| e.located(&format!("{path}/then")))?;
                if let Some(child) = r#else {
                    walk(
                        child,
                        nodes,
                        depth + 1,
                        can_break,
                        &format!("{path}/else"),
                        paths,
                    )
                    .map_err(|e| e.located(&format!("{path}/else")))?;
                }
            }
            BlockKind::Choice { branches, default } => {
                for (i, branch) in branches.iter().enumerate() {
                    walk(
                        &branch.body,
                        nodes,
                        depth + 1,
                        can_break,
                        &format!("{path}/branches/{i}/body"),
                        paths,
                    )
                    .map_err(|e| e.located(path))?;
                }
                walk(
                    default,
                    nodes,
                    depth + 1,
                    can_break,
                    &format!("{path}/default"),
                    paths,
                )
                .map_err(|e| e.located(path))?;
            }
            BlockKind::Loop {
                body, max_rounds, ..
            } => {
                if *max_rounds > 10_000 {
                    return Err(Error::Definition("loop round limit exceeds 10000".into()));
                }
                walk(body, nodes, depth + 1, true, &format!("{path}/body"), paths)
                    .map_err(|e| e.located(path))?;
            }
            BlockKind::ForEach {
                body,
                max_concurrency,
                initial,
                update,
                ..
            } => {
                if *max_concurrency == 0 || *max_concurrency > 64 {
                    return Err(Error::Definition(
                        "foreach requires concurrency 1..64".into(),
                    ));
                }
                if initial.is_some() != update.is_some()
                    || (initial.is_some() && *max_concurrency != 1)
                {
                    return Err(Error::Definition(
                        "foreach initial/update must be paired and serial".into(),
                    ));
                }
                walk(
                    body,
                    nodes,
                    depth + 1,
                    *max_concurrency == 1,
                    &format!("{path}/body"),
                    paths,
                )
                .map_err(|e| e.located(path))?;
            }
            BlockKind::Break { .. } if !can_break => {
                return Err(Error::invalid("WF_BREAK_SCOPE", path,
                    "break requires a lexical loop or serial foreach; it cannot cross a call or parallel boundary",
                    "Return data across call/parallel boundaries; put the break in the enclosing serial loop."));
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
            BlockKind::Call { .. } | BlockKind::Break { .. } => {}
        }
        Ok(())
    }
    walk(&definition.body, &mut nodes, 0, false, "/body", &mut paths)
        .map_err(|e| e.located("/body"))?;
    for (name, body) in &definition.procedures {
        let path = format!("/procedures/{}", pointer_token(name));
        walk(body, &mut nodes, 0, false, &path, &mut paths).map_err(|e| e.located(&path))?;
    }
    fn calls(
        block: &Block,
        definition: &Definition,
        stack: &mut Vec<String>,
        depth: usize,
        visits: &mut usize,
        paths: &BTreeMap<String, String>,
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
                    return Err(Error::invalid(
                        "WF_RECURSION",
                        &format!("{}/procedure", paths[&block.id]),
                        format!("recursive procedure {procedure}"),
                        "Use a bounded loop instead of recursion.",
                    ));
                }
                let body = definition.procedures.get(procedure).ok_or_else(|| {
                    Error::invalid(
                        "WF_PROCEDURE",
                        &format!("{}/procedure", paths[&block.id]),
                        format!("unknown procedure {procedure}"),
                        "Declare this procedure in the same definition, or correct the reference.",
                    )
                })?;
                stack.push(procedure.clone());
                calls(body, definition, stack, depth + 1, visits, paths)?;
                stack.pop();
            }
            BlockKind::Sequence { steps, .. } => {
                for c in steps {
                    calls(c, definition, stack, depth + 1, visits, paths)?;
                }
            }
            BlockKind::Parallel { branches, .. } => {
                for c in branches {
                    calls(c, definition, stack, depth + 1, visits, paths)?;
                }
            }
            BlockKind::Loop { body, .. } | BlockKind::ForEach { body, .. } => {
                calls(body, definition, stack, depth + 1, visits, paths)?
            }
            BlockKind::If { then, r#else, .. } => {
                calls(then, definition, stack, depth + 1, visits, paths)?;
                if let Some(c) = r#else {
                    calls(c, definition, stack, depth + 1, visits, paths)?;
                }
            }
            BlockKind::Choice { branches, default } => {
                for b in branches {
                    calls(&b.body, definition, stack, depth + 1, visits, paths)?;
                }
                calls(default, definition, stack, depth + 1, visits, paths)?;
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
        &paths,
    )
    .map_err(|e| e.located("/body"))?;
    for (name, body) in &definition.procedures {
        calls(
            body,
            &definition,
            &mut vec![name.clone()],
            0,
            &mut visits,
            &paths,
        )
        .map_err(|e| e.located(&format!("/procedures/{}", pointer_token(name))))?;
    }
    let mut expression_budget = 16384;
    for block in nodes.values() {
        let mut check = |expr: &Expr, field: &str, expected: Option<&str>| -> Result<()> {
            let path = format!("{}{field}", paths[&block.id]);
            expr.validate(0, &mut expression_budget)
                .map_err(|e| e.at(&path))?;
            if let Some(kind) = expected {
                expr.expect_type(kind).map_err(|e| e.at(&path))?;
            }
            Ok(())
        };
        match &block.kind {
            BlockKind::Task { input, .. } | BlockKind::Call { input, .. } => {
                check(input, "/input", None)?
            }
            BlockKind::Break { value } => check(value, "/value", None)?,
            BlockKind::Sequence {
                output: Some(output),
                ..
            } => check(output, "/output", None)?,
            BlockKind::If { condition, .. } => check(condition, "/condition", Some("boolean"))?,
            BlockKind::Choice { branches, .. } => {
                for (i, branch) in branches.iter().enumerate() {
                    check(
                        &branch.condition,
                        &format!("/branches/{i}/condition"),
                        Some("boolean"),
                    )?;
                }
            }
            BlockKind::Loop {
                condition,
                initial,
                update,
                ..
            } => {
                check(condition, "/condition", Some("boolean"))?;
                check(initial, "/initial", None)?;
                check(update, "/update", None)?;
            }
            BlockKind::Parallel { complete_when, .. } => {
                if let Some(complete_when) = complete_when {
                    check(complete_when, "/completeWhen", Some("boolean"))?;
                }
            }
            BlockKind::ForEach {
                items,
                key,
                complete_when,
                initial,
                update,
                ..
            } => {
                check(items, "/items", Some("array"))?;
                if let Some(key) = key {
                    check(key, "/key", None)?;
                }
                if let Some(complete_when) = complete_when {
                    check(complete_when, "/completeWhen", Some("boolean"))?;
                }
                if let Some(initial) = initial {
                    check(initial, "/initial", None)?;
                }
                if let Some(update) = update {
                    check(update, "/update", None)?;
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
        source_paths: paths,
    })
}
