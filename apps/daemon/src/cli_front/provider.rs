//! The public configuration entry. Credentials are never CLI arguments.
use super::{
    output::{self, CliFailure},
    target::Selection,
};
use genehub_proto::{ProviderDraft, ProviderOperationCommand, Reply, Request};
use serde_json::json;

pub async fn run(args: &[String], selection: &Selection) -> i32 {
    match execute(args, selection).await {
        Ok((kind, data)) => output::succeed(kind, data),
        Err(error) => output::fail(error),
    }
}

async fn execute(
    args: &[String],
    selection: &Selection,
) -> Result<(&'static str, serde_json::Value), CliFailure> {
    let request = parse(args)?;
    let rpc = super::query::connect_selected(selection).await?;
    let reply = rpc.call(request).await.map_err(super::query::rpc_error)?;
    match reply {
        Reply::Providers(providers) => Ok(("provider.list", json!({"providers":providers}))),
        Reply::ProviderOperation(receipt) => Ok((
            match args.first().map(String::as_str) {
                Some("configure") => "provider.configure",
                Some("verify") => "provider.verify",
                _ => "provider.get",
            },
            json!({"operation":receipt}),
        )),
        other => Err(super::query::unexpected_reply(
            "provider metadata or operation",
            &other,
        )),
    }
}

fn parse(args: &[String]) -> Result<Request, CliFailure> {
    if matches!(args, [verb] if verb == "list") {
        return Ok(Request::ProviderList);
    }
    let [verb, id, rest @ ..] = args else {
        return Err(usage());
    };
    if !matches!(verb.as_str(), "configure" | "get" | "verify") {
        return Err(usage());
    }
    let mut flags = std::collections::BTreeMap::new();
    let mut models = Vec::new();
    let allowed: &[&str] = if verb == "configure" {
        &[
            "--session",
            "--action",
            "--base-url",
            "--dialect",
            "--label",
            "--model",
        ]
    } else {
        &["--session"]
    };
    let mut i = 0;
    while i < rest.len() {
        let name = &rest[i];
        if !allowed.contains(&name.as_str()) {
            return Err(CliFailure::invalid_args(format!(
                "unsupported provider option {name}; enter credentials through the workbench"
            )));
        }
        let value = rest
            .get(i + 1)
            .filter(|v| !v.is_empty() && !v.starts_with("--"))
            .ok_or_else(|| CliFailure::invalid_args(format!("{name} needs a value")))?
            .clone();
        if name == "--model" {
            models.push(value);
        } else if flags.insert(name.as_str(), value).is_some() {
            return Err(CliFailure::invalid_args(format!(
                "{name} may appear only once"
            )));
        }
        i += 2;
    }
    let mut required = |name| {
        flags
            .remove(name)
            .ok_or_else(|| CliFailure::invalid_args(format!("missing {name}")))
    };
    let session_id = required("--session")?;
    let operation = if verb == "configure" {
        ProviderOperationCommand::Prepare {
            action_id: required("--action")?,
            draft: ProviderDraft {
                provider_id: id.clone(),
                base_url: required("--base-url")?,
                dialect: required("--dialect")?,
                label: required("--label")?,
                models,
            },
        }
    } else if verb == "verify" {
        ProviderOperationCommand::Verify {
            action_id: id.clone(),
        }
    } else {
        ProviderOperationCommand::Get {
            action_id: id.clone(),
        }
    };
    Ok(Request::ProviderOperation {
        session_id,
        operation,
    })
}
fn usage() -> CliFailure {
    CliFailure::invalid_args("provider list | configure <id> --session <id> --action <stable-id> --base-url <url> --dialect <openai|anthropic> --label <name> [--model <id>] | get <action-id> --session <id> | verify <action-id> --session <id>")
}
