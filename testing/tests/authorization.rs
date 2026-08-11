//! What a device that was let in only partway can actually do.
//!
//! These run against the daemon's own peer code path: the real invitation, the
//! real device authentication, the real gate. Only the carrier is in-process,
//! because a relay in the middle would test the relay.

use std::time::Duration;

use genehub_proto::{DeviceCredential, InviteScope, Reply, Request};
use genehub_testing::{Client, Journey};

/// Pairs a device holding exactly the named grants.
async fn pair_granting(journey: &Journey, grants: &[&str]) -> DeviceCredential {
    let scope = (!grants.is_empty()).then(|| InviteScope {
        grants: grants.iter().map(|name| (*name).to_string()).collect(),
    });
    let invite = match journey
        .client
        .call(Request::DeviceInvite(scope))
        .await
        .expect("the owner can invite")
    {
        Reply::Invite(invite) => invite,
        other => panic!("unexpected {other:?}"),
    };
    let (pairing, invite_id) = Client::connect_with_invite(journey.daemon(), &invite.code)
        .await
        .expect("the invitation is redeemable");
    let credential = match pairing
        .call(Request::DeviceClaim {
            code: invite_id,
            device_name: "ported-laptop".into(),
        })
        .await
        .expect("the claim succeeds")
    {
        Reply::Claimed(credential) => credential,
        other => panic!("unexpected {other:?}"),
    };
    pairing.close().await;
    credential
}

#[tokio::test]
async fn a_device_gets_what_its_invitation_named_and_nothing_else() {
    let journey = Journey::start().await.expect("journey starts");
    let credential = pair_granting(&journey, &["read"]).await;
    let device = Client::connect_as_device(journey.daemon(), &credential)
        .await
        .expect("a paired device connects");

    device
        .call(Request::WorkspaceList)
        .await
        .expect("read was granted");

    // Each of these is a different kind of authority, and none of them was
    // given. The point is not that one is refused but that the refusal tracks
    // the invitation rather than the request being unusual.
    for refused in [
        Request::FileWrite {
            workspace_id: journey.workspace.id.clone(),
            path: "owned.txt".into(),
            content: "owned".into(),
        },
        Request::PtyOpen {
            workspace_id: journey.workspace.id.clone(),
            cols: Some(80),
            rows: Some(24),
        },
        Request::SettingsGet,
        // Including the one that would undo the narrowing: a device that can
        // mint itself a wider invitation was never narrowed at all.
        Request::DeviceInvite(None),
    ] {
        let error = device.expect_error(refused.clone()).await;
        assert!(
            error.contains("Forbidden"),
            "{refused:?} should have been refused: {error}"
        );
    }

    device.close().await;
    journey.finish().await;
}

#[tokio::test]
async fn a_device_without_a_terminal_grant_is_not_sent_the_terminal_anyway() {
    // The fanout reaches every authenticated peer. Refusing `pty.open` while
    // still broadcasting the output would protect nothing: a shell shows
    // keystrokes, paths, and whatever gets pasted into it.
    let journey = Journey::start().await.expect("journey starts");
    let credential = pair_granting(&journey, &["read", "session"]).await;
    let device = Client::connect_as_device(journey.daemon(), &credential)
        .await
        .expect("a paired device connects");

    let pty_id = match journey
        .client
        .call(Request::PtyOpen {
            workspace_id: journey.workspace.id.clone(),
            cols: Some(80),
            rows: Some(24),
        })
        .await
        .expect("the owner opens a terminal")
    {
        Reply::Pty { pty_id } => pty_id,
        other => panic!("unexpected {other:?}"),
    };
    journey
        .client
        .call(Request::PtyWrite {
            pty_id: pty_id.clone(),
            data: "echo grant-marker\n".into(),
        })
        .await
        .expect("input accepted");

    // The owner sees it, so the terminal really did produce this output.
    let owner_saw = journey
        .client
        .collect_pty("grant-marker", Duration::from_secs(20))
        .await;
    assert!(owner_saw.contains("grant-marker"), "got: {owner_saw:?}");

    let device_saw = device
        .collect_pty("grant-marker", Duration::from_secs(2))
        .await;
    assert!(
        device_saw.is_empty(),
        "a device without the pty grant received terminal output: {device_saw:?}"
    );

    device.close().await;
    journey.finish().await;
}

#[tokio::test]
async fn a_device_granted_everything_still_works_exactly_as_before() {
    // The migration promise: pairing without naming grants gives what pairing
    // always gave. A gate that quietly narrows existing devices would lock
    // people out of their own machines on a routine update.
    let journey = Journey::start().await.expect("journey starts");
    let credential = pair_granting(&journey, &[]).await;
    let device = Client::connect_as_device(journey.daemon(), &credential)
        .await
        .expect("a paired device connects");

    device
        .call(Request::WorkspaceList)
        .await
        .expect("read works");
    device.call(Request::SettingsGet).await.expect("settings");
    let pty_id = match device
        .call(Request::PtyOpen {
            workspace_id: journey.workspace.id.clone(),
            cols: Some(80),
            rows: Some(24),
        })
        .await
        .expect("a fully granted device may open a terminal")
    {
        Reply::Pty { pty_id } => pty_id,
        other => panic!("unexpected {other:?}"),
    };
    device
        .call(Request::PtyWrite {
            pty_id,
            data: "echo full-grant\n".into(),
        })
        .await
        .expect("input accepted");
    let seen = device
        .collect_pty("full-grant", Duration::from_secs(20))
        .await;
    assert!(seen.contains("full-grant"), "got: {seen:?}");

    device.close().await;
    journey.finish().await;
}

#[tokio::test]
async fn a_device_revoked_while_connected_stops_being_able_to_act() {
    let journey = Journey::start().await.expect("journey starts");
    let credential = pair_granting(&journey, &[]).await;
    let device = Client::connect_as_device(journey.daemon(), &credential)
        .await
        .expect("a paired device connects");
    device
        .call(Request::WorkspaceList)
        .await
        .expect("it works before the revocation");

    journey
        .client
        .call(Request::DeviceRevoke {
            device_id: credential.device_id.clone(),
        })
        .await
        .expect("the owner revokes it");

    // Revoking drops the live link, and grants are also read per request, so
    // the window between those two is closed as well. Either way the device is
    // done: the assertion is about it being unable to act, not about which of
    // the two mechanisms got there first.
    let error = device.expect_error(Request::WorkspaceList).await;
    assert!(
        error.contains("Forbidden") || error.contains("closed"),
        "a revoked device could still act: {error}"
    );

    device.close().await;
    journey.finish().await;
}
