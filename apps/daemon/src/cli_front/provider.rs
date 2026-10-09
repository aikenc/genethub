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
    let mut capabilities =
        std::collections::BTreeMap::<String, genehub_proto::ModelCapabilities>::new();
    let allowed: &[&str] = if verb == "configure" {
        &[
            "--session",
            "--action",
            "--base-url",
            "--dialect",
            "--label",
            "--model",
            "--capability",
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
        } else if name == "--capability" {
            let (model, caps) = parse_capability(&value)?;
            capabilities.entry(model).or_default().overlay(&caps);
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
                model_capabilities: (!capabilities.is_empty()).then_some(capabilities),
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
/// `<model>:<field>=<value>`, e.g. `claude-opus-5-5:thinking=adaptive`. The
/// model id may itself contain `:` (OpenRouter's `:free`), so the field is
/// whatever follows the last `:` before the `=`.
fn parse_capability(spec: &str) -> Result<(String, genehub_proto::ModelCapabilities), CliFailure> {
    let invalid = |why: &str| {
        CliFailure::invalid_args(format!(
            "--capability {spec}: {why}; expected <model>:<thinking|context-window|max-tokens|reasoning|efforts|inputs>=<value>"
        ))
    };
    let (head, value) = spec.split_once('=').ok_or_else(|| invalid("missing ="))?;
    let (model, field) = head
        .rsplit_once(':')
        .ok_or_else(|| invalid("missing <model>:"))?;
    if model.is_empty() {
        return Err(invalid("empty model"));
    }
    let number = || value.parse::<u64>().map_err(|_| invalid("not a number"));
    let list = || -> Vec<String> {
        value
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty() && *item != "text")
            .map(str::to_string)
            .collect()
    };
    let mut caps = genehub_proto::ModelCapabilities::default();
    match field {
        "thinking" => caps.thinking = Some(value.to_string()),
        "context-window" | "contextWindow" => caps.context_window = Some(number()?),
        "max-tokens" | "maxTokens" => caps.max_tokens = Some(number()?),
        "reasoning" => caps.reasoning = Some(value.parse().map_err(|_| invalid("not true/false"))?),
        "efforts" => caps.efforts = Some(list()),
        "inputs" => caps.inputs = Some(list()),
        _ => return Err(invalid("unknown field")),
    }
    Ok((model.to_string(), caps))
}

fn usage() -> CliFailure {
    CliFailure::invalid_args("provider list | configure <id> --session <id> --action <stable-id> --base-url <url> --dialect <openai|anthropic> --label <name> [--model <id>] [--capability <model>:<field>=<value>] | get <action-id> --session <id> | verify <action-id> --session <id>")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn capability_flags_become_one_entry_per_model() {
        let request = parse(&args(&[
            "configure",
            "aiclick",
            "--session",
            "s",
            "--action",
            "a",
            "--base-url",
            "https://gateway.example",
            "--dialect",
            "anthropic",
            "--label",
            "AI",
            "--capability",
            "claude-opus-5-5:thinking=adaptive",
            "--capability",
            "claude-opus-5-5:context-window=200000",
            "--capability",
            "vendor/model:free:inputs=text,image",
        ]))
        .unwrap();
        let Request::ProviderOperation {
            operation: ProviderOperationCommand::Prepare { draft, .. },
            ..
        } = request
        else {
            panic!("not a prepare");
        };
        let caps = draft.model_capabilities.unwrap();
        assert_eq!(
            caps["claude-opus-5-5"].thinking.as_deref(),
            Some("adaptive")
        );
        assert_eq!(caps["claude-opus-5-5"].context_window, Some(200_000));
        assert_eq!(
            caps["vendor/model:free"].inputs,
            Some(vec!["image".to_string()])
        );
    }

    #[test]
    fn a_malformed_capability_is_an_argument_error() {
        for bad in [
            "opus",
            "opus:thinking",
            "opus:colour=red",
            "opus:max-tokens=lots",
            ":thinking=none",
        ] {
            assert!(parse_capability(bad).is_err(), "{bad} accepted");
        }
    }
}
