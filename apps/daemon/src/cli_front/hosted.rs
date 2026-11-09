//! Calls to a machine reached through the hosted Hub.
//!
//! Every Hub ticket is a new route the Hub counts against this machine, and it
//! allows only so many in a window. A team timer that reads another machine
//! every few seconds would spend that allowance in minutes if each call dialled
//! again, and then every machine-to-machine call from here fails until the
//! window rolls over. So a command reuses the last connection to the same
//! machine while its carrier is up and it was used recently; the route behind
//! it stays authorized far longer than either bound.
//!
//! A ticket is spent even when the connection it buys then fails, which is
//! what happens while the target or its relay is coming back. A caller that
//! retries in a tight loop would empty the allowance during that gap, so a
//! failure after a ticket was issued is answered again for a short while
//! instead of buying another one. Both the failure and its repeats carry
//! `retryAfterMs`, and a repeat says plainly that it did not connect.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use genehub_proto::{ErrorCode, HubTicket, ProtocolError, Reply, Request};
use serde_json::json;
use tokio::sync::Mutex;

use super::output::CliFailure;
use super::query::{connect_error, remote_connect_error, rpc_error};
use super::rpc::{ConnectError, Refusal, Rpc};
use super::rpc_wire;

const IDLE: Duration = Duration::from_secs(90);
const MAX_AGE: Duration = Duration::from_secs(600);
const SWEEP_EVERY: Duration = Duration::from_secs(30);
const HOLD_FAILURE: Duration = Duration::from_secs(10);

struct Link {
    remote: Arc<rpc_wire::Rpc>,
    opened: Instant,
    used: Instant,
}

impl Link {
    fn usable(&self, now: Instant) -> bool {
        self.remote.is_open()
            && now.duration_since(self.used) < IDLE
            && now.duration_since(self.opened) < MAX_AGE
    }
}

/// One slot per caller and machine. The caller is part of the key because the
/// local daemon decides per caller whether it may fetch a ticket at all, and a
/// reused connection must not let one caller ride on another's admission.
type Slot = Arc<Mutex<Held>>;

#[derive(Default)]
struct Held {
    link: Option<Link>,
    failed: Option<(Instant, CliFailure)>,
}

impl Held {
    fn idle(&self, now: Instant) -> bool {
        self.link.as_ref().is_none_or(|link| !link.usable(now))
            && self
                .failed
                .as_ref()
                .is_none_or(|(at, _)| now.duration_since(*at) >= HOLD_FAILURE)
    }
}

#[derive(Default)]
struct Pool {
    slots: HashMap<String, Slot>,
    sweeping: bool,
}

fn pool() -> &'static StdMutex<Pool> {
    static POOL: OnceLock<StdMutex<Pool>> = OnceLock::new();
    POOL.get_or_init(Default::default)
}

fn slot(key: &str) -> Slot {
    let mut pool = pool()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    pool.slots.entry(key.to_string()).or_default().clone()
}

/// A connection for commands that only make calls and open their own streams.
pub async fn shared(machine_id: &str) -> Result<Rpc, CliFailure> {
    let key = format!("{:?}\0{machine_id}", super::caller_principal());
    let slot = slot(&key);
    // Held across the dial so concurrent commands to one machine wait for the
    // first connection instead of each spending a ticket on their own.
    let mut held = slot.lock().await;
    let now = Instant::now();
    if let Some(link) = held.link.as_mut().filter(|link| link.usable(now)) {
        link.used = now;
        return Ok(Rpc::shared(link.remote.clone()));
    }
    held.link = None;
    if let Some((at, failure)) = &held.failed {
        let waited = now.duration_since(*at);
        if waited < HOLD_FAILURE {
            return Err(held_back(
                machine_id,
                failure,
                waited,
                HOLD_FAILURE - waited,
            ));
        }
    }
    held.failed = None;
    let outcome = dial(machine_id).await;
    let now = Instant::now();
    let result = match outcome {
        Ok(remote) => {
            held.link = Some(Link {
                remote: remote.clone(),
                opened: now,
                used: now,
            });
            Ok(Rpc::shared(remote))
        }
        Err(Failed { failure, spent }) if spent => {
            held.failed = Some((now, failure.clone()));
            // Retrying sooner only gets this same failure back.
            Err(noted(
                failure,
                [("retryAfterMs", json!(HOLD_FAILURE.as_millis() as u64))],
            ))
        }
        Err(Failed { failure, .. }) => Err(failure),
    };
    drop(held);
    keep_swept();
    result
}

/// The earlier failure, said again without dialling. It must read as exactly
/// that: a caller who takes it for a fresh attempt concludes the machine is
/// still down, or worse, that its pairing broke and tears it down.
fn held_back(
    machine_id: &str,
    failure: &CliFailure,
    waited: Duration,
    left: Duration,
) -> CliFailure {
    let mut failure = failure.clone();
    let after = left.as_millis() as u64;
    let after_s = after.div_ceil(1000);
    let ago_s = waited.as_secs();
    let then = if failure.retryable {
        format!("retry in {after_s}s and the call will really connect again")
    } else {
        format!("a call after {after_s}s will really connect again")
    };
    failure.message = format!(
        "not reconnected: {machine_id} failed {ago_s}s ago and this call did not dial again, \
         to spare the Hub's route allowance; {then}. The earlier failure was: {}",
        failure.message
    );
    noted(
        failure,
        [
            ("retryAfterMs", json!(after)),
            ("reconnected", json!(false)),
            ("failedMsAgo", json!(waited.as_millis() as u64)),
        ],
    )
}

fn noted<const N: usize>(
    mut failure: CliFailure,
    notes: [(&str, serde_json::Value); N],
) -> CliFailure {
    let mut details = match failure.details.take() {
        Some(serde_json::Value::Object(details)) => details,
        _ => serde_json::Map::new(),
    };
    for (key, value) in notes {
        details.insert(key.into(), value);
    }
    failure.details = Some(serde_json::Value::Object(details));
    failure
}

/// A connection of its own, for a command that follows the peer's events.
pub async fn dedicated(machine_id: &str) -> Result<Rpc, CliFailure> {
    match dial(machine_id).await {
        Ok(remote) => Ok(Rpc::from_hosted(remote)),
        Err(Failed { failure, .. }) => Err(failure),
    }
}

/// Closes connections nobody reused in time, so an idle machine does not keep
/// a route and a relay slot open until the next command happens along.
fn keep_swept() {
    {
        let mut pool = pool()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if pool.sweeping {
            return;
        }
        pool.sweeping = true;
    }
    tokio::spawn(async {
        loop {
            tokio::time::sleep(SWEEP_EVERY).await;
            let now = Instant::now();
            let mut pool = pool()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            pool.slots.retain(|_, slot| match slot.try_lock() {
                Ok(held) => !held.idle(now),
                // Someone is dialling or reusing it right now.
                Err(_) => true,
            });
            if pool.slots.is_empty() {
                pool.sweeping = false;
                return;
            }
        }
    });
}

/// A route the Hub issued a moment ago can still be refused while the relay
/// or the target catches up with it. That is not a revoked pairing, so it gets
/// one fresh ticket before it is reported, and then as something to retry.
struct Failed {
    failure: CliFailure,
    /// Whether the Hub issued a ticket for this attempt.
    spent: bool,
}

async fn dial(machine_id: &str) -> Result<Arc<rpc_wire::Rpc>, Failed> {
    let mut refused = None;
    for attempt in 0..2 {
        let ticket = ticket(machine_id).await.map_err(|failure| Failed {
            failure,
            spent: attempt > 0,
        })?;
        match Rpc::dial_hosted(&ticket).await {
            Ok(remote) => return Ok(remote),
            Err(error) => match refused_route(&error) {
                Some(message) => refused = Some(message),
                None => {
                    return Err(Failed {
                        failure: remote_connect_error(machine_id, error),
                        spent: true,
                    })
                }
            },
        }
    }
    let failure = CliFailure {
        code: "routeRefused",
        message: format!(
            "{machine_id} refused a route the Hub had just issued ({}); \
             nothing here was revoked, retry shortly",
            refused.unwrap_or_default()
        ),
        retryable: true,
        details: Some(json!({"machineId": machine_id, "stage": "hostedRoute"})),
        exit: super::EXIT_UNREACHABLE,
    };
    Err(Failed {
        failure,
        spent: true,
    })
}

fn refused_route(error: &ConnectError) -> Option<String> {
    match error {
        ConnectError::Refused {
            reason: Refusal::Credential,
            message,
        }
        | ConnectError::Rejected(ProtocolError {
            code: ErrorCode::Unauthorized,
            message,
        }) => Some(message.clone()),
        _ => None,
    }
}

/// The CLI holds no Hub enrolment of its own, so this only works where a local
/// daemon is running and paired. That is a real limit and it is reported as
/// one — a machine that is unreachable because nothing here is enrolled must
/// not read as a machine that does not exist.
async fn ticket(machine_id: &str) -> Result<HubTicket, CliFailure> {
    let local = Rpc::connect().await.map_err(connect_error)?;
    match local
        .call(Request::HubConnect {
            machine_id: machine_id.to_string(),
        })
        .await
    {
        Ok(Reply::HubTicket(ticket)) => Ok(ticket),
        Ok(other) => Err(CliFailure::protocol(format!("unexpected reply: {other:?}"))),
        Err(error) => {
            let mut failure = rpc_error(error);
            failure.message = format!(
                "Hub ticket request for {machine_id} failed: {}",
                failure.message
            );
            failure.details = Some(
                json!({"machineId": machine_id, "stage": "hubTicket", "upstream": failure.details}),
            );
            Err(failure)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unreachable() -> CliFailure {
        CliFailure {
            code: "unreachable",
            message: "relay closed the connection".into(),
            retryable: true,
            details: Some(json!({"machineId": "mch_a"})),
            exit: super::super::EXIT_UNREACHABLE,
        }
    }

    #[test]
    fn a_repeated_failure_says_it_did_not_connect_and_when_one_will() {
        let held = held_back(
            "mch_a",
            &unreachable(),
            Duration::from_millis(3_200),
            Duration::from_millis(6_800),
        );
        assert_eq!(held.code, "unreachable");
        assert!(held.retryable);
        assert!(
            held.message
                .starts_with("not reconnected: mch_a failed 3s ago"),
            "{}",
            held.message
        );
        assert!(held.message.contains("retry in 7s"), "{}", held.message);
        assert!(
            held.message.ends_with("relay closed the connection"),
            "{}",
            held.message
        );
        let details = held.details.unwrap();
        assert_eq!(details["retryAfterMs"], 6_800);
        assert_eq!(details["reconnected"], false);
        assert_eq!(details["failedMsAgo"], 3_200);
        assert_eq!(details["machineId"], "mch_a");
    }

    #[test]
    fn a_repeat_of_a_final_failure_does_not_invite_a_retry() {
        let mut failure = unreachable();
        failure.retryable = false;
        let held = held_back("mch_a", &failure, Duration::ZERO, HOLD_FAILURE);
        assert!(!held.retryable);
        assert!(!held.message.contains("retry in"), "{}", held.message);
        assert!(
            held.message.contains("after 10s will really connect"),
            "{}",
            held.message
        );
    }
}
