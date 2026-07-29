//! Reaching a machine from somewhere it does not already trust.
//!
//! Everything here runs over the real forwarded path: a relay that matches
//! sockets and knows nothing else, and a daemon that decides for itself who
//! gets in (`docs/security-model.md` §4.2). These are the cases where being
//! wrong means a stranger gets a shell on someone's laptop, so they are stated
//! as properties rather than as clicks.

use std::time::Duration;

use anyhow::Result;
use genehub_proto::{DeviceCredential, Reply, Request};
use genehub_testing::{expect_reply, Client, FakeRelay, Journey, Mode};

/// A machine attached to a relay, plus the address clients meet it at.
struct Reachable {
    journey: Journey,
    relay: FakeRelay,
    rendezvous: String,
}

impl Reachable {
    async fn start() -> Result<Self> {
        let journey = Journey::start_in_mode(Mode::Mock).await?;
        let relay = FakeRelay::start().await?;

        let remote = expect_reply!(
            journey
                .client
                .call(Request::DeviceRemoteAttach {
                    relay_url: relay.url.clone(),
                    join_token: None,
                })
                .await?,
            Reply::RemoteAccess
        );
        let rendezvous = remote
            .rendezvous_url
            .expect("attaching produces somewhere to be met");

        // Dialling is asynchronous; the slot has to exist before a client can
        // be matched into it.
        for _ in 0..100 {
            if relay.has_machine().await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            relay.has_machine().await,
            "the machine never reached the relay"
        );

        Ok(Reachable {
            journey,
            relay,
            rendezvous,
        })
    }

    /// A one-time invite, as the owner would generate one.
    async fn invite(&self) -> Result<String> {
        let invite = expect_reply!(
            self.journey
                .client
                .call(Request::DeviceInvite { name: None })
                .await?,
            Reply::Invite
        );
        Ok(invite.code)
    }

    /// A fresh connection through the relay, as a stranger's browser makes it.
    async fn dial(&self) -> Result<Client> {
        Client::connect(&self.rendezvous).await
    }

    async fn finish(self) {
        self.journey.finish().await;
        self.relay.shutdown();
    }
}

/// A challenge of the length the daemon insists on, since a short one is
/// refused before anything else is looked at.
fn nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Redeems an invite the way the web client does, mutual proof included.
async fn claim(client: &Client, code: &str, name: &str) -> Result<DeviceCredential> {
    let nonce = nonce();
    let reply = client
        .call(Request::DeviceClaim {
            code: code.to_string(),
            device_name: name.to_string(),
            nonce: nonce.clone(),
            proof: genet_daemon::devices::proof("client", &nonce, code),
        })
        .await?;
    let credential = expect_reply!(reply, Reply::Claimed);
    assert_eq!(
        credential.proof,
        genet_daemon::devices::proof("server", &nonce, code),
        "the machine has to prove it knows the invite too"
    );
    Ok(credential)
}

#[tokio::test]
async fn a_new_device_pairs_through_the_relay_and_comes_back_without_the_invite() {
    let reachable = Reachable::start().await.expect("a reachable machine");
    let code = reachable.invite().await.expect("an invite");

    let phone = reachable.dial().await.expect("reaching the machine");
    let credential = claim(&phone, &code, "手机").await.expect("claiming");
    phone.close().await;

    // The invite is spent. What the device keeps is the credential, and that is
    // what gets it back in — on a new connection, as after a reload.
    let again = reachable.dial().await.expect("reaching the machine again");
    again
        .hello_as_device("phone", &credential.device_id, &credential.secret)
        .await
        .expect("a paired device is let in");
    let workspaces = expect_reply!(
        again.call(Request::WorkspaceList).await.expect("listing"),
        Reply::Workspaces
    );
    assert_eq!(
        workspaces.len(),
        1,
        "the paired device sees the machine's work"
    );

    let devices = match reachable
        .journey
        .client
        .call(Request::DeviceList)
        .await
        .expect("listing devices")
    {
        Reply::Devices { devices, .. } => devices,
        other => panic!("expected devices, got {other:?}"),
    };
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].name, "手机");
    assert!(devices[0].connected, "a live device shows as connected");

    again.close().await;
    reachable.finish().await;
}

#[tokio::test]
async fn a_client_the_machine_never_paired_with_is_turned_away() {
    let reachable = Reachable::start().await.expect("a reachable machine");

    // Reaching the rendezvous slot is not an achievement: the address is
    // unguessable, but it is also handed out in links, so it cannot be what
    // authorizes anyone.
    let stranger = reachable.dial().await.expect("reaching the machine");
    let refused = stranger.expect_error(Request::WorkspaceList).await;
    assert!(
        refused.contains("Unauthorized") || refused.contains("closed"),
        "a stranger got somewhere, saying: {refused}"
    );
    stranger.close().await;

    reachable.finish().await;
}

#[tokio::test]
async fn an_invite_is_good_for_exactly_one_device() {
    let reachable = Reachable::start().await.expect("a reachable machine");
    let code = reachable.invite().await.expect("an invite");

    let first = reachable.dial().await.expect("reaching the machine");
    claim(&first, &code, "第一台")
        .await
        .expect("the first claim");
    first.close().await;

    let second = reachable.dial().await.expect("reaching the machine");
    let nonce = nonce();
    let refused = second
        .expect_error(Request::DeviceClaim {
            code: code.clone(),
            device_name: "第二台".into(),
            nonce: nonce.clone(),
            proof: genet_daemon::devices::proof("client", &nonce, &code),
        })
        .await;
    assert!(
        refused.contains("Unauthorized") || refused.contains("closed"),
        "a spent invite was accepted again: {refused}"
    );
    second.close().await;

    reachable.finish().await;
}

#[tokio::test]
async fn a_stolen_proof_cannot_be_replayed() {
    let reachable = Reachable::start().await.expect("a reachable machine");
    let code = reachable.invite().await.expect("an invite");

    let phone = reachable.dial().await.expect("reaching the machine");
    let credential = claim(&phone, &code, "手机").await.expect("claiming");
    phone.close().await;

    let reused = nonce();
    let proof = genet_daemon::devices::proof("client", &reused, &credential.secret);
    let honest = reachable.dial().await.expect("reaching the machine");
    honest
        .call(Request::Hello {
            client_name: "phone".into(),
            protocol_version: genehub_proto::PROTOCOL_VERSION,
            device: Some(genehub_proto::DeviceAuth {
                device_id: credential.device_id.clone(),
                nonce: reused.clone(),
                proof: proof.clone(),
            }),
        })
        .await
        .expect("the first use of a nonce is fine");

    // Someone who saw that handshake go past has the whole of it. Sending it
    // again must not work, or watching one connection would be enough.
    let eavesdropper = reachable.dial().await.expect("reaching the machine");
    let refused = eavesdropper
        .expect_error(Request::Hello {
            client_name: "phone".into(),
            protocol_version: genehub_proto::PROTOCOL_VERSION,
            device: Some(genehub_proto::DeviceAuth {
                device_id: credential.device_id.clone(),
                nonce: reused.clone(),
                proof,
            }),
        })
        .await;
    assert!(
        refused.contains("Unauthorized") || refused.contains("closed"),
        "a replayed handshake was accepted: {refused}"
    );

    honest.close().await;
    eavesdropper.close().await;
    reachable.finish().await;
}

#[tokio::test]
async fn revoking_a_device_drops_the_connection_it_is_using() {
    let reachable = Reachable::start().await.expect("a reachable machine");
    let code = reachable.invite().await.expect("an invite");

    let phone = reachable.dial().await.expect("reaching the machine");
    let credential = claim(&phone, &code, "手机").await.expect("claiming");
    phone.close().await;

    let live = reachable.dial().await.expect("reaching the machine");
    live.hello_as_device("phone", &credential.device_id, &credential.secret)
        .await
        .expect("the paired device is let in");

    reachable
        .journey
        .client
        .call(Request::DeviceRevoke {
            device_id: credential.device_id.clone(),
        })
        .await
        .expect("revoking");

    // "Revoked" has to mean gone now, not gone next time: someone pressing
    // this button is usually looking at a device they no longer control.
    let after = live.expect_error(Request::WorkspaceList).await;
    assert!(
        after.contains("closed") || after.contains("Unauthorized"),
        "a revoked device kept working: {after}"
    );

    let back = reachable.dial().await.expect("reaching the machine");
    let fresh = nonce();
    let refused = back
        .expect_error(Request::Hello {
            client_name: "phone".into(),
            protocol_version: genehub_proto::PROTOCOL_VERSION,
            device: Some(genehub_proto::DeviceAuth {
                device_id: credential.device_id.clone(),
                nonce: fresh.clone(),
                proof: genet_daemon::devices::proof("client", &fresh, &credential.secret),
            }),
        })
        .await;
    assert!(
        refused.contains("Unauthorized") || refused.contains("closed"),
        "a revoked credential still opened a door: {refused}"
    );

    live.close().await;
    back.close().await;
    reachable.finish().await;
}

#[tokio::test]
async fn authorized_devices_survive_a_restart_and_so_does_being_reachable() {
    let mut reachable = Reachable::start().await.expect("a reachable machine");
    let code = reachable.invite().await.expect("an invite");

    let phone = reachable.dial().await.expect("reaching the machine");
    let credential = claim(&phone, &code, "手机").await.expect("claiming");
    phone.close().await;

    reachable
        .journey
        .restart_daemon()
        .await
        .expect("restarting the daemon");
    for _ in 0..100 {
        if reachable.relay.has_machine().await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Remote access is a setting, not a session: quitting the app and coming
    // back must not silently make the machine unreachable from a phone.
    assert!(
        reachable.relay.has_machine().await,
        "the machine did not go back to the relay after a restart"
    );
    let again = reachable.dial().await.expect("reaching the machine again");
    again
        .hello_as_device("phone", &credential.device_id, &credential.secret)
        .await
        .expect("a paired device is still paired after a restart");

    again.close().await;
    reachable.finish().await;
}
