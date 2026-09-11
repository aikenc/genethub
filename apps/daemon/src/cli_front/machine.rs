//! Pairing with another machine, and saying who may pair with this one.
//!
//! Two commands that read as opposites and are: `genet machine …` is about
//! machines this installation can reach, `genet device …` is about clients that
//! may reach this machine. Keeping the two vocabularies apart is the whole
//! reason `--machine` exists and `--device` is refused
//! (`genet-remote-execution.md` §3).

use genehub_proto::{HubStatus, InviteScope, Reply, Request};
use serde_json::json;

use super::machines::{self, PairedMachine};
use super::output::{self, CliFailure};
use super::rpc::{Pairing, Rpc};
use super::target::Selection;

/// Machines this installation can reach. Never routed: pairing and the local
/// credential store are properties of the machine the command runs on.
pub async fn machine(args: &[String]) -> i32 {
    let outcome = match args.first().map(String::as_str) {
        Some("list") => list(&args[1..]).await,
        Some("pair") => pair(&args[1..]).await,
        Some("forget") => forget(&args[1..]),
        Some("show") => show(&args[1..]),
        other => Err(unknown("machine", other, "list, pair, forget, show")),
    };
    report(&format!("machine.{}", verb(args)), outcome)
}

/// Clients that may reach a machine. Routable, so the owner of a laptop can
/// audit and revoke its devices from anywhere they are already trusted.
pub async fn device(args: &[String], selection: &Selection) -> i32 {
    let outcome = match args.first().map(String::as_str) {
        Some("list") => device_list(selection).await,
        Some("invite") => invite(&args[1..], selection).await,
        Some("revoke") => revoke(&args[1..], selection).await,
        other => Err(unknown("device", other, "list, invite, revoke")),
    };
    report(&format!("device.{}", verb(args)), outcome)
}

fn report(kind: &str, outcome: Result<serde_json::Value, CliFailure>) -> i32 {
    match outcome {
        Ok(value) => output::succeed(kind, value),
        Err(error) => output::fail(error),
    }
}

fn verb(args: &[String]) -> String {
    args.first().cloned().unwrap_or_default()
}

fn unknown(group: &str, given: Option<&str>, expected: &str) -> CliFailure {
    CliFailure::invalid_args(match given {
        Some(word) => format!("`{group} {word}` is not a command; expected one of {expected}"),
        None => format!("`{group}` needs a subcommand; expected one of {expected}"),
    })
}

async fn list(args: &[String]) -> Result<serde_json::Value, CliFailure> {
    if args == ["--reachable"] {
        return reachable().await;
    }
    if !args.is_empty() {
        return Err(CliFailure::invalid_args(
            "machine list accepts only --reachable",
        ));
    }
    let machines = machines::load()?;
    Ok(json!({
        "machines": machines.iter().map(PairedMachine::public).collect::<Vec<_>>(),
        "store": machines::file()?.display().to_string(),
    }))
}

/// Explicit opt-in discovery: self + direct credentials + this identity's Hub directory.
/// An unavailable Hub is an error, never a partial directory presented as complete.
async fn reachable() -> Result<serde_json::Value, CliFailure> {
    let paired = machines::load()?;
    let rpc = Rpc::connect().await.map_err(super::query::connect_error)?;
    let hub_status = rpc
        .call(Request::HubStatus)
        .await
        .map_err(super::query::rpc_error)?;
    let (hub_self, hub_machines) = match hub_status {
        Reply::HubStatus(HubStatus::Unpaired) => (None, Vec::new()),
        Reply::HubStatus(HubStatus::Paired { machine_id, .. }) => {
            match rpc
                .call(Request::HubMachines)
                .await
                .map_err(super::query::rpc_error)?
            {
                Reply::HubMachines(items) => (Some(machine_id), items),
                other => return Err(unexpected(other)),
            }
        }
        Reply::HubStatus(_) => {
            return Err(CliFailure::business(
                "machineDirectoryUnavailable",
                "Hub pairing is not ready; retry after it settles",
                None,
            ))
        }
        other => return Err(unexpected(other)),
    };
    let local_id = hub_self.as_deref().unwrap_or(&rpc.hello().machine_id);
    let direct = paired
        .iter()
        .map(|m| {
            json!({
                "machineId": m.machine_id, "name": m.name, "online": null, "source": "paired"
            })
        })
        .collect();
    let hub = hub_machines
        .iter()
        .map(|m| {
            json!({
                "machineId": m.id, "name": m.name, "online": m.online, "source": "hub"
            })
        })
        .collect();
    Ok(json!({"scope": "reachable", "machines": merge_directory(
        local_id, &rpc.hello().machine_name, direct, hub
    )}))
}

fn merge_directory(
    local_id: &str,
    local_name: &str,
    direct: Vec<serde_json::Value>,
    hub: Vec<serde_json::Value>,
) -> Vec<serde_json::Value> {
    let mut entries = std::collections::BTreeMap::new();
    entries.insert(
        local_id.to_string(),
        json!({
            "machineId": local_id, "name": local_name, "online": true, "source": "local"
        }),
    );
    // Hub display names are current; direct credential names may predate a rename.
    for entry in direct.into_iter().chain(hub) {
        entries.insert(
            entry["machineId"].as_str().expect("machine id").to_string(),
            entry,
        );
    }
    entries
        .into_iter()
        .map(|(id, mut entry)| {
            entry["local"] = json!(id == local_id);
            if id == local_id {
                entry["online"] = json!(true);
            }
            entry
        })
        .collect()
}

fn show(args: &[String]) -> Result<serde_json::Value, CliFailure> {
    let id = args
        .first()
        .ok_or_else(|| CliFailure::invalid_args("machine show needs a machine id"))?;
    Ok(machines::find(id)?.public())
}

fn forget(args: &[String]) -> Result<serde_json::Value, CliFailure> {
    let id = args
        .first()
        .ok_or_else(|| CliFailure::invalid_args("machine forget needs a machine id"))?;
    let removed = machines::forget(id)?;
    // Forgetting is one-sided on purpose, and saying so matters: the other
    // machine still lists this device as authorized until someone revokes it
    // there, and a caller who believes otherwise has a false sense of having
    // cleaned up.
    Ok(json!({
        "machineId": id,
        "forgotten": removed,
        "note": "this only drops the local credential; run `genet device revoke` \
                 on that machine to withdraw the authorization",
    }))
}

async fn pair(args: &[String]) -> Result<serde_json::Value, CliFailure> {
    let mut code = None;
    let mut endpoint = None;
    let mut name = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--endpoint" => {
                endpoint = Some(value_after(args, &mut index, "--endpoint")?);
            }
            "--name" => {
                name = Some(value_after(args, &mut index, "--name")?);
            }
            other if other.starts_with('-') => {
                return Err(CliFailure::invalid_args(format!(
                    "machine pair does not take {other}"
                )))
            }
            other if code.is_none() => code = Some(other.to_string()),
            other => {
                return Err(CliFailure::invalid_args(format!(
                    "machine pair takes one pairing code; it also got {other}"
                )))
            }
        }
        index += 1;
    }

    let code = code.ok_or_else(|| {
        CliFailure::invalid_args(
            "machine pair needs the pairing code from `genet device invite` on the other machine",
        )
    })?;
    let endpoint = endpoint.ok_or_else(|| {
        CliFailure::invalid_args(
            "machine pair needs --endpoint, the rendezvous URL printed beside the pairing code",
        )
    })?;
    let name = name.unwrap_or_else(default_device_name);

    let (invite_id, invite_secret) = code
        .split_once('.')
        .map(|(id, secret)| (id.to_string(), secret.to_string()))
        .ok_or_else(|| {
            CliFailure::invalid_args("that pairing code is not in the form the machine issues")
        })?;

    let pairing = Pairing::open(&endpoint, &invite_id, &invite_secret)
        .await
        .map_err(|error| {
            CliFailure::business(
                "pairingRefused",
                format!("{}: {error}", redacted(&endpoint)),
                Some(json!({"endpoint": redacted(&endpoint)})),
            )
        })?;

    let credential = pairing.claim(&invite_id, &name).await.map_err(|error| {
        CliFailure::business(
            "pairingRefused",
            format!("the machine refused the claim: {error}"),
            None,
        )
    })?;

    let machine = PairedMachine {
        machine_id: credential.machine_id.clone(),
        name: if credential.machine_name.is_empty() {
            credential.machine_id.clone()
        } else {
            credential.machine_name.clone()
        },
        fingerprint: credential.fingerprint.clone(),
        endpoint: endpoint.clone(),
        device_id: credential.device_id.clone(),
        secret: credential.secret.clone(),
        paired_at: chrono::Utc::now().to_rfc3339(),
    };
    machines::remember(machine.clone())?;
    Ok(json!({
        "machine": machine.public(),
        "deviceName": name,
        "storedIn": machines::file()?.display().to_string(),
    }))
}

async fn device_list(selection: &Selection) -> Result<serde_json::Value, CliFailure> {
    let rpc = connect(selection).await?;
    match rpc.call(Request::DeviceList).await {
        Ok(Reply::Devices { devices, remote }) => Ok(json!({
            "devices": devices,
            "remote": remote,
        })),
        Ok(other) => Err(unexpected(other)),
        Err(error) => Err(remote_failure(error)),
    }
}

async fn invite(args: &[String], selection: &Selection) -> Result<serde_json::Value, CliFailure> {
    let mut grants: Option<Vec<String>> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--grant" => {
                let value = value_after(args, &mut index, "--grant")?;
                grants
                    .get_or_insert_with(Vec::new)
                    .extend(value.split(',').map(|part| part.trim().to_string()));
            }
            other => {
                return Err(CliFailure::invalid_args(format!(
                    "device invite does not take {other}"
                )))
            }
        }
        index += 1;
    }

    let rpc = connect(selection).await?;
    // No `--grant` means an unrestricted device, which is what pairing has
    // always produced. Naming any grant means naming all of them: a flag that
    // silently added to a default would make `--grant read` hand out more than
    // it says.
    let scope = grants.map(|grants| InviteScope { grants });
    match rpc.call(Request::DeviceInvite(scope)).await {
        Ok(Reply::Invite(invite)) => Ok(json!({
            "code": invite.code,
            "expiresAt": invite.expires_at,
            "endpoint": invite.rendezvous_url,
            "next": match invite.rendezvous_url.as_deref() {
                Some(url) => format!(
                    "on the other machine: genet machine pair {} --endpoint {url}",
                    invite.code
                ),
                None => "this machine is not reachable from outside yet; run \
                         `genet hub …` or attach it to a relay before pairing"
                    .to_string(),
            },
        })),
        Ok(other) => Err(unexpected(other)),
        Err(error) => Err(remote_failure(error)),
    }
}

async fn revoke(args: &[String], selection: &Selection) -> Result<serde_json::Value, CliFailure> {
    let device_id = args
        .first()
        .ok_or_else(|| CliFailure::invalid_args("device revoke needs a device id"))?;
    let rpc = connect(selection).await?;
    match rpc
        .call(Request::DeviceRevoke {
            device_id: device_id.clone(),
        })
        .await
    {
        Ok(_) => Ok(json!({"deviceId": device_id, "revoked": true})),
        Err(error) => Err(remote_failure(error)),
    }
}

/// Local, or the machine named by `--machine`.
async fn connect(selection: &Selection) -> Result<Rpc, CliFailure> {
    match &selection.machine {
        Some(machine_id) => {
            let machine = machines::find(machine_id)?;
            Rpc::connect_remote(&machine)
                .await
                .map_err(super::query::connect_error)
        }
        None => Rpc::connect().await.map_err(super::query::connect_error),
    }
}

fn unexpected(reply: Reply) -> CliFailure {
    CliFailure::protocol(format!("unexpected reply: {reply:?}"))
}

fn remote_failure(error: super::rpc::RpcError) -> CliFailure {
    super::query::rpc_error(error)
}

fn value_after(args: &[String], index: &mut usize, flag: &str) -> Result<String, CliFailure> {
    let value = args
        .get(*index + 1)
        .ok_or_else(|| CliFailure::invalid_args(format!("{flag} needs a value")))?;
    if value.trim().is_empty() {
        return Err(CliFailure::invalid_args(format!(
            "{flag} needs a non-empty value"
        )));
    }
    *index += 1;
    Ok(value.clone())
}

/// What this installation calls itself when it pairs.
///
/// The hostname, because the list this ends up in is read by a person deciding
/// what to revoke, and "the CLI" on six lines helps nobody.
fn default_device_name() -> String {
    let host = std::env::var("HOSTNAME")
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| "unknown host".into());
    format!("{host} (genet CLI)")
}

fn redacted(endpoint: &str) -> String {
    match endpoint.split_once('?') {
        Some((base, _)) => format!("{base}?…"),
        None => endpoint.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reachable_directory_deduplicates_ids_but_preserves_name_collisions() {
        let rows = merge_directory(
            "self",
            "old",
            vec![json!({"machineId":"remote", "name":"stale", "source":"paired", "online":null})],
            vec![
                json!({"machineId":"self", "name":"genethub-server-beta", "source":"hub", "online":false}),
                json!({"machineId":"remote", "name":"genethub-server-beta", "source":"hub", "online":true}),
            ],
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.iter()
                .filter(|r| r["name"] == "genethub-server-beta")
                .count(),
            2
        );
        let local = rows.iter().find(|r| r["machineId"] == "self").unwrap();
        assert_eq!(local["local"], true);
        assert_eq!(local["online"], true);
        assert!(!rows.iter().any(|r| r.get("secret").is_some()));
    }

    #[test]
    fn unpaired_local_installation_still_has_a_local_target() {
        let rows = merge_directory("self", "genethub-server-beta", vec![], vec![]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["local"], true);
    }

    #[test]
    fn a_pairing_error_never_echoes_the_ticket_that_reached_the_machine() {
        let endpoint = "wss://relay.example/forward/client?ticket=SECRET";
        assert_eq!(redacted(endpoint), "wss://relay.example/forward/client?…");
        assert!(!redacted(endpoint).contains("SECRET"));
    }

    #[test]
    fn a_device_names_itself_after_the_machine_a_person_would_recognise() {
        let name = default_device_name();
        assert!(name.contains("genet CLI"), "{name}");
        assert!(!name.is_empty());
    }
}
