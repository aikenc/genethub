//! Machines this installation has been authorized to reach.
//!
//! The exact dual of the daemon's `devices.json`, which says who may reach
//! *this* machine, and deliberately not named anything close to it: the two
//! files sit in one directory, and reading one as the other would be a
//! credential leak rather than a typo (`genet-remote-execution.md` §4.2).
//!
//! The shape mirrors `packages/workbench/src/devices/machines.ts`, because a phone
//! and a terminal that pair with the same machine are holding the same thing
//! and there is no reason for them to disagree about what it is called.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::output::CliFailure;

/// How many machines one installation will remember. Generous next to the
/// handful anyone actually pairs with, and bounded so a corrupt or hostile
/// file cannot grow without limit.
const MAX_MACHINES: usize = 64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedMachine {
    pub machine_id: String,
    pub name: String,
    pub fingerprint: String,
    /// Where this machine is met. A rendezvous URL today; a hosted-Hub ticket
    /// is fetched per connection and so is never stored here.
    pub endpoint: String,
    pub device_id: String,
    /// The long-lived secret. Never sent: both sides prove knowledge of it
    /// over fresh nonces instead.
    pub secret: String,
    pub paired_at: String,
}

impl PairedMachine {
    /// What is safe to print. `genet machine list` is the command an agent
    /// reaches for, and its output ends up in logs and transcripts.
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({
            "machineId": self.machine_id,
            "name": self.name,
            "fingerprint": self.fingerprint,
            "endpoint": endpoint_without_ticket(&self.endpoint),
            "deviceId": self.device_id,
            "pairedAt": self.paired_at,
        })
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    machines: Vec<PairedMachine>,
}

pub fn file() -> Result<PathBuf, CliFailure> {
    super::local_state()
        .map(|state| state.paths.machines_file())
        .map_err(|error| {
            CliFailure::business(
                "storeUnavailable",
                format!("locate the daemon data directory: {error}"),
                None,
            )
        })
}

pub fn load() -> Result<Vec<PairedMachine>, CliFailure> {
    let path = file()?;
    let Ok(raw) = std::fs::read_to_string(&path) else {
        // Nothing paired yet is the ordinary state of a fresh installation,
        // not a failure to report.
        return Ok(Vec::new());
    };
    serde_json::from_str::<Persisted>(&raw)
        .map(|file| file.machines)
        .map_err(|error| {
            CliFailure::business(
                "storeUnreadable",
                format!(
                    "{} is not readable as a paired-machine list ({error}); move it aside and \
                     pair again",
                    path.display()
                ),
                None,
            )
        })
}

/// Looks up a machine by exact id.
///
/// No prefix matching and no "the only one you have". A selector that
/// sometimes guesses is a selector that will eventually guess a different
/// machine than the caller meant, and the caller will not be watching.
pub fn lookup(machine_id: &str) -> Result<Option<PairedMachine>, CliFailure> {
    Ok(load()?
        .into_iter()
        .find(|machine| machine.machine_id == machine_id))
}

pub fn find(machine_id: &str) -> Result<PairedMachine, CliFailure> {
    let machines = load()?;
    machines
        .iter()
        .find(|machine| machine.machine_id == machine_id)
        .cloned()
        .ok_or_else(|| {
            CliFailure::business(
                "machineNotPaired",
                format!(
                    "{machine_id} is not a machine this installation has paired with; \
                     `genet machine list` shows the ones it has"
                ),
                Some(serde_json::json!({
                    "machineId": machine_id,
                    "paired": machines.iter().map(|m| m.machine_id.clone()).collect::<Vec<_>>(),
                })),
            )
        })
}

/// Adds or replaces a machine. Re-pairing the same machine replaces the old
/// credential rather than accumulating a second one, because two credentials
/// for one machine means revoking one of them leaves the other working and
/// nobody can tell which is which.
pub fn remember(machine: PairedMachine) -> Result<(), CliFailure> {
    let mut machines = load()?;
    machines.retain(|existing| existing.machine_id != machine.machine_id);
    machines.push(machine);
    if machines.len() > MAX_MACHINES {
        machines.remove(0);
    }
    save(&machines)
}

/// Returns whether anything was removed.
pub fn forget(machine_id: &str) -> Result<bool, CliFailure> {
    let mut machines = load()?;
    let before = machines.len();
    machines.retain(|machine| machine.machine_id != machine_id);
    if machines.len() == before {
        return Ok(false);
    }
    save(&machines)?;
    Ok(true)
}

fn save(machines: &[PairedMachine]) -> Result<(), CliFailure> {
    let path = file()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            CliFailure::business(
                "storeUnavailable",
                format!("create {}: {error}", parent.display()),
                None,
            )
        })?;
    }
    let body = serde_json::to_string_pretty(&Persisted {
        machines: machines.to_vec(),
    })
    .map_err(|error| CliFailure::business("storeUnavailable", format!("encode: {error}"), None))?;
    // 0600, the same as every other file that holds a secret.
    crate::config::save_private(&path, body.as_bytes()).map_err(|error| {
        CliFailure::business(
            "storeUnavailable",
            format!("write {}: {error:#}", path.display()),
            None,
        )
    })
}

/// Strips a rendezvous ticket from a URL before it is printed.
///
/// The ticket is single-use and short-lived, but it is still an admission, and
/// `genet machine list` output lands in agent transcripts and CI logs.
fn endpoint_without_ticket(endpoint: &str) -> String {
    match endpoint.split_once('?') {
        Some((base, _)) => format!("{base}?…"),
        None => endpoint.to_string(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_a_machine_never_prints_its_secret_or_its_ticket() {
        let machine = PairedMachine {
            machine_id: "m_1".into(),
            name: "laptop".into(),
            fingerprint: "fp".into(),
            endpoint: "wss://relay.example/forward/client?ticket=SECRET-TICKET".into(),
            device_id: "d_1".into(),
            secret: "SECRET-DEVICE-KEY".into(),
            paired_at: "2026-01-01T00:00:00Z".into(),
        };
        let printed = machine.public().to_string();
        assert!(!printed.contains("SECRET-DEVICE-KEY"), "{printed}");
        assert!(!printed.contains("SECRET-TICKET"), "{printed}");
        assert!(printed.contains("wss://relay.example/forward/client"));
        assert!(printed.contains("m_1"));
    }

    #[test]
    fn an_endpoint_without_a_query_survives_being_redacted() {
        assert_eq!(
            endpoint_without_ticket("wss://relay.example/forward/client"),
            "wss://relay.example/forward/client"
        );
    }
}
