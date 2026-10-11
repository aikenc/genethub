//! `genet hook list`: what a project's timer hooks are and how they last ran.
//!
//! There is deliberately nothing else. A hook is a file in
//! `<project>/.genethub/hooks/`: writing it is `echo > file`, removing it is
//! `rm`, and the daemon reads the directory fresh every time, so a verb that
//! wrote or deleted would only be a second way to do what the filesystem
//! already does. What a script cannot see by looking at the files is how a hook
//! last ran and whether a file is broken, and that is all this prints.

use genehub_proto::{Reply, Request};
use serde_json::json;

use super::output::{self, CliFailure};
use super::query;
use super::target::Selection;
use super::workflow::resolve_workspace;

const USAGE: &str = "usage: genet hook list [--workspace <id>]";

pub async fn hook(args: &[String], selection: &Selection) -> i32 {
    if selection.machine.is_some() {
        return output::fail(CliFailure::invalid_args(
            "hook 命令只在当前机器执行，不能使用 --machine",
        ));
    }
    let workspace = match parse(args) {
        Ok(workspace) => workspace,
        Err(error) => return output::fail(error),
    };
    match list(selection, workspace).await {
        Ok(value) => output::succeed("hook.list", value),
        Err(error) => output::fail(error),
    }
}

/// `list` is the only verb and the default one, so the bare `genet hook` works.
fn parse(args: &[String]) -> Result<Option<String>, CliFailure> {
    let mut rest = args;
    match rest.first().map(String::as_str) {
        Some("list") => rest = &rest[1..],
        Some(flag) if flag.starts_with('-') => {}
        Some(other) => {
            return Err(CliFailure::invalid_args(format!(
                "`hook {other}` is not a command; the only one is list. Hooks are files in .genethub/hooks/: write or delete the file. {USAGE}"
            )))
        }
        None => {}
    }
    match rest {
        [] => Ok(None),
        [flag, value] if flag == "--workspace" && !value.trim().is_empty() => {
            Ok(Some(value.clone()))
        }
        _ => Err(CliFailure::invalid_args(USAGE)),
    }
}

async fn list(
    selection: &Selection,
    workspace: Option<String>,
) -> Result<serde_json::Value, CliFailure> {
    let rpc = query::connect_selected(selection).await?;
    let workspace_id = resolve_workspace(&rpc, workspace).await?;
    match rpc
        .call(Request::HookList { workspace_id })
        .await
        .map_err(query::rpc_error)?
    {
        Reply::Hooks(list) => Ok(json!(list)),
        other => Err(query::unexpected_reply("hooks", &other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|word| word.to_string()).collect()
    }

    #[test]
    fn list_is_the_only_verb_and_the_default() {
        assert_eq!(parse(&words(&[])).unwrap(), None);
        assert_eq!(parse(&words(&["list"])).unwrap(), None);
        assert_eq!(
            parse(&words(&["list", "--workspace", "w_1"])).unwrap(),
            Some("w_1".into())
        );
        assert_eq!(
            parse(&words(&["--workspace", "w_1"])).unwrap(),
            Some("w_1".into())
        );
    }

    #[test]
    fn anything_else_is_refused_and_says_to_use_the_files() {
        for bad in [
            &["set", "x"][..],
            &["rm", "x"],
            &["list", "extra"],
            &["list", "--workspace"],
            &["list", "--workspace", " "],
            &["list", "--bogus", "1"],
        ] {
            let error = parse(&words(bad)).unwrap_err();
            assert_eq!(error.code, "invalidArgs", "{bad:?}");
        }
        let error = parse(&words(&["rm", "x"])).unwrap_err();
        assert!(
            error.message.contains(".genethub/hooks"),
            "a caller who reached for `hook rm` is told where hooks are: {}",
            error.message
        );
    }
}
