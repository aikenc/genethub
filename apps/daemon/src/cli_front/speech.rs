//! Machine-local registration and inspection of the community speech adapter.
//! Model installation stays outside GeneHub; these commands give the built-in
//! Agent a deterministic, shell-free way to connect and verify it.

use genehub_proto::{Reply, Request};

use super::output::{self, CliFailure};
use super::target::Selection;

pub async fn speech(args: &[String], selection: &Selection) -> i32 {
    let outcome = execute(args, selection).await;
    match outcome {
        Ok((kind, value)) => output::succeed(kind, value),
        Err(error) => output::fail(error),
    }
}

async fn execute(
    args: &[String],
    selection: &Selection,
) -> Result<(&'static str, serde_json::Value), CliFailure> {
    let command = parse(args)?;
    let rpc = super::query::connect_selected(selection).await?;
    match command {
        SpeechCommand::Status => {
            let reply = rpc
                .call(Request::SpeechCapabilities)
                .await
                .map_err(super::query::rpc_error)?;
            capabilities(reply).map(|value| ("speech.runtime.status", value))
        }
        SpeechCommand::Probe => {
            let reply = rpc
                .call(Request::SpeechRuntimeProbe)
                .await
                .map_err(super::query::rpc_error)?;
            match reply {
                Reply::SpeechRuntimeStatus(status) => Ok((
                    "speech.runtime.probe",
                    serde_json::to_value(status).expect("serializable speech status"),
                )),
                other => Err(super::query::unexpected_reply(
                    "speech runtime status",
                    &other,
                )),
            }
        }
        SpeechCommand::Unregister => {
            let reply = rpc
                .call(Request::SpeechRuntimeConfigure {
                    command: None,
                    args: Vec::new(),
                })
                .await
                .map_err(super::query::rpc_error)?;
            capabilities(reply).map(|value| ("speech.runtime.unregister", value))
        }
        SpeechCommand::Register {
            command,
            args: runtime_args,
        } => {
            let reply = rpc
                .call(Request::SpeechRuntimeConfigure {
                    command: Some(command),
                    args: runtime_args,
                })
                .await
                .map_err(super::query::rpc_error)?;
            capabilities(reply).map(|value| ("speech.runtime.register", value))
        }
    }
}

enum SpeechCommand {
    Status,
    Probe,
    Register { command: String, args: Vec<String> },
    Unregister,
}

fn parse(args: &[String]) -> Result<SpeechCommand, CliFailure> {
    match args {
        [group, verb] if group == "runtime" && verb == "status" => Ok(SpeechCommand::Status),
        [group, verb] if group == "runtime" && verb == "probe" => Ok(SpeechCommand::Probe),
        [group, verb] if group == "runtime" && verb == "unregister" => {
            Ok(SpeechCommand::Unregister)
        }
        [group, verb, rest @ ..] if group == "runtime" && verb == "register" => {
            let (command, args) = parse_register(rest)?;
            Ok(SpeechCommand::Register { command, args })
        }
        _ => Err(CliFailure::invalid_args(
            "expected `speech runtime status`, `probe`, `register --command <absolute-path> [--arg <value>...]`, or `unregister`",
        )),
    }
}

fn parse_register(args: &[String]) -> Result<(String, Vec<String>), CliFailure> {
    let mut command = None;
    let mut runtime_args = Vec::new();
    let mut index = 0usize;
    while index < args.len() {
        let flag = args[index].as_str();
        if flag != "--command" && flag != "--arg" {
            return Err(CliFailure::invalid_args(format!(
                "speech runtime register does not take {flag}"
            )));
        }
        let value = args.get(index + 1).ok_or_else(|| {
            CliFailure::invalid_args(format!("{flag} needs a value; none followed it"))
        })?;
        if value.is_empty() {
            return Err(CliFailure::invalid_args(format!(
                "{flag} needs a non-empty value"
            )));
        }
        if flag == "--command" {
            if command.replace(value.clone()).is_some() {
                return Err(CliFailure::invalid_args(
                    "--command may be supplied only once",
                ));
            }
        } else {
            runtime_args.push(value.clone());
        }
        index += 2;
    }
    let command = command.ok_or_else(|| {
        CliFailure::invalid_args("speech runtime register needs --command <absolute-path>")
    })?;
    Ok((command, runtime_args))
}

fn capabilities(reply: Reply) -> Result<serde_json::Value, CliFailure> {
    match reply {
        Reply::SpeechCapabilities(capabilities) => {
            Ok(serde_json::to_value(capabilities).expect("serializable speech capabilities"))
        }
        other => Err(super::query::unexpected_reply(
            "speech capabilities",
            &other,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_preserves_repeated_runtime_arguments() {
        let (command, args) = parse_register(&[
            "--command".into(),
            "/opt/speech/adapter".into(),
            "--arg".into(),
            "--model".into(),
            "--arg".into(),
            "Qwen/Qwen3-ASR-1.7B".into(),
        ])
        .unwrap();
        assert_eq!(command, "/opt/speech/adapter");
        assert_eq!(args, ["--model", "Qwen/Qwen3-ASR-1.7B"]);
    }

    #[test]
    fn register_requires_one_command() {
        assert!(parse_register(&[]).is_err());
        assert!(parse_register(&[
            "--command".into(),
            "/one".into(),
            "--command".into(),
            "/two".into(),
        ])
        .is_err());
    }
}
