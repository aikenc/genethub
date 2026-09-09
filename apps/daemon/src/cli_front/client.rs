//! Explicit instance targeting. Session capabilities are returned only to the
//! requesting CLI; never infer a client from the current workspace or device.
use super::{
    output::{self, CliFailure},
    target::Selection,
};
use genehub_proto::{ClientDebugAction as A, ClientDebugRequest as R, Reply, Request};

pub async fn run(args: &[String], selection: &Selection) -> i32 {
    match execute(args, selection).await {
        Ok(value) => output::succeed("client.debug", value),
        Err(e) => output::fail(e),
    }
}
async fn execute(args: &[String], selection: &Selection) -> Result<serde_json::Value, CliFailure> {
    let request = parse(args)?;
    let rpc = super::query::connect_selected(selection).await?;
    match rpc
        .call(Request::ClientDebug(request))
        .await
        .map_err(super::query::rpc_error)?
    {
        Reply::ClientDebug(response) => {
            Ok(serde_json::to_value(response.value).expect("serializable debug response"))
        }
        other => Err(super::query::unexpected_reply("client debug", &other)),
    }
}
fn parse(args: &[String]) -> Result<R, CliFailure> {
    let help="client list | attach <clientId> --label <operator> | status/result/inspect/eval/act/events/screenshot/reload/revoke <clientId> --session <capability>; eval --script <javascript>; act --selector <css> [--value <text>]; result --command <commandId>; --machine selects the debug coordinator";
    if args == ["list"] {
        return Ok(R::List);
    }
    let verb = args.first().map(String::as_str).unwrap_or("");
    let client_id = args
        .get(1)
        .filter(|v| !v.starts_with('-'))
        .ok_or_else(|| CliFailure::invalid_args(help))?
        .clone();
    let mut flags = std::collections::HashMap::new();
    let allowed: &[&str] = match verb {
        "attach" => &["--label"],
        "eval" => &["--session", "--script"],
        "act" => &["--session", "--selector", "--value"],
        "result" => &["--session", "--command"],
        "status" | "inspect" | "events" | "screenshot" | "reload" | "revoke" => &["--session"],
        _ => return Err(CliFailure::invalid_args(help)),
    };
    for pair in args[2..].chunks(2) {
        if pair.len() != 2
            || !allowed.contains(&pair[0].as_str())
            || flags.insert(pair[0].as_str(), pair[1].clone()).is_some()
        {
            return Err(CliFailure::invalid_args(help));
        }
    }
    let required = |name: &str| {
        flags
            .get(name)
            .filter(|s| !s.is_empty())
            .cloned()
            .ok_or_else(|| CliFailure::invalid_args(format!("{name} is required; {help}")))
    };
    if verb == "attach" {
        return Ok(R::Attach {
            client_id,
            label: required("--label")?,
        });
    }
    let session = required("--session")?;
    Ok(match verb {
        "status" => R::Status { client_id, session },
        "result" => R::Result {
            client_id,
            session,
            command_id: required("--command")?,
        },
        "revoke" => R::Revoke {
            client_id,
            key: session,
        },
        _ => R::Execute {
            client_id,
            session,
            action: match verb {
                "inspect" => A::Inspect,
                "screenshot" => A::Screenshot,
                "events" => A::Events,
                "reload" => A::Reload,
                "eval" => A::Eval {
                    script: required("--script")?,
                },
                "act" => A::Act {
                    selector: required("--selector")?,
                    value: flags.get("--value").cloned(),
                },
                _ => unreachable!(),
            },
        },
    })
}
