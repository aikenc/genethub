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
            workspace_id: Some(journey.workspace.id.clone()),
            cols: Some(80),
            rows: Some(24),
        },
        Request::SettingsGet,
        // Ending what an agent left running is part of driving the session
        // that started it, so a device that may not drive one may not do this
        // either.
        Request::ProcessList,
        Request::ProcessKillAll {
            session_id: "s_any".into(),
        },
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
            workspace_id: Some(journey.workspace.id.clone()),
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
            workspace_id: Some(journey.workspace.id.clone()),
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

#[tokio::test]
async fn a_device_without_a_files_grant_cannot_take_the_bytes_by_another_door() {
    // Requests are not the only way in. `asset.preview` returns file contents
    // over a stream of its own, so a gate that only reads the rpc envelope
    // would leave the Files grant decorative.
    let journey = Journey::start().await.expect("journey starts");
    std::fs::write(
        std::path::Path::new(&journey.workspace.root).join("secret.txt"),
        "the bytes",
    )
    .expect("writing a file worth reading");

    // A preview names a root handle, not a bare path: a workspace can have
    // more than one folder and the two could both hold a `secret.txt`.
    let asset = format!(
        "{}/secret.txt",
        journey
            .workspace
            .folders
            .first()
            .expect("a workspace with no folders")
            .root_handle
    );

    let narrow = pair_granting(&journey, &["read"]).await;
    let device = Client::connect_as_device(journey.daemon(), &narrow)
        .await
        .expect("a paired device connects");
    let (head, body) = device
        .preview(&journey.workspace.id, &asset)
        .await
        .expect("the stream is answered rather than hung");
    assert_eq!(head.status, 403, "read alone bought the file bytes");
    // Refused by the gate, before the file was ever looked for: the message
    // names the missing grant so a narrowed caller knows to ask for it.
    let refusal = head.error.expect("the gate refused without saying why");
    assert!(refusal.message.contains("files"), "{refusal:?}");
    assert!(
        !String::from_utf8_lossy(&body).contains("the bytes"),
        "the refusal carried the file anyway"
    );
    device.close().await;

    // And the same door opens for a device that was given files, so the gate
    // is refusing the grant rather than the method.
    let allowed = pair_granting(&journey, &["read", "files"]).await;
    let device = Client::connect_as_device(journey.daemon(), &allowed)
        .await
        .expect("a paired device connects");
    let (head, body) = device
        .preview(&journey.workspace.id, &asset)
        .await
        .expect("the preview is answered");
    assert_eq!(
        head.status, 200,
        "files was granted and still refused: {head:?}"
    );
    assert_eq!(String::from_utf8_lossy(&body), "the bytes");
    device.close().await;

    journey.finish().await;
}

#[tokio::test]
async fn a_terminal_for_someone_else_is_confined_or_refused_but_never_neither() {
    // A shell is not a file editor: it is every authority the account has, at
    // once. So a device that was given `pty` and nothing else gets a terminal
    // the operating system holds to the workspace — and on a machine that
    // cannot do that, it gets a refusal rather than the unconstrained login
    // shell that used to be the only kind (`genet-remote-execution.md` §7.6).
    let journey = Journey::start().await.expect("journey starts");
    let confinable = genet_daemon::isolation::report().enforced;

    let narrow = pair_granting(&journey, &["read", "pty"]).await;
    let device = Client::connect_as_device(journey.daemon(), &narrow)
        .await
        .expect("a paired device connects");
    let ask = Request::PtyOpen {
        workspace_id: Some(journey.workspace.id.clone()),
        cols: Some(80),
        rows: Some(24),
    };
    if confinable {
        let pty_id = match device.call(ask).await.expect("a confined terminal opens") {
            Reply::Pty { pty_id } => pty_id,
            other => panic!("unexpected {other:?}"),
        };
        // Opening is the easy half. A confinement that leaves the shell unable
        // to load its own libraries produces a terminal that opens and then
        // dies, which reads to the person at the other end as the feature not
        // working at all — so the shell has to answer, from inside.
        let outside = std::path::Path::new(&journey.workspace.root)
            .parent()
            .map(|parent| {
                let path = parent.join("outside-the-workspace.txt");
                std::fs::write(&path, "OUT-OF-BOUNDS").expect("a file next door");
                path
            });
        // Two details keep this from passing without proving anything. The
        // marker is computed by the shell, so it cannot match the terminal
        // echoing back the line we typed; and the read of the file next door
        // comes first, so arriving at the marker means its output would already
        // have been sent.
        let probe = match &outside {
            Some(path) => format!("cat {}; echo confined-$((6*7))\n", path.display()),
            None => "echo confined-$((6*7))\n".to_string(),
        };
        device
            .call(Request::PtyWrite {
                pty_id,
                data: probe,
            })
            .await
            .expect("input accepted");
        let transcript = device
            .collect_pty("confined-42", Duration::from_secs(20))
            .await;
        assert!(
            transcript.contains("confined-42"),
            "the confined terminal never answered, so it was confined into uselessness: \
             {transcript:?}"
        );
        // And the same terminal, one directory up from the work, gets nothing.
        assert!(
            !transcript.contains("OUT-OF-BOUNDS"),
            "a confined terminal read a file outside its workspace: {transcript:?}"
        );
    } else {
        let error = device.expect_error(ask).await;
        assert!(
            error.contains("IsolationUnavailable"),
            "an unconfinable machine has to say so: {error}"
        );
        // The refusal has to be told apart from "you were not allowed": no
        // wider invitation would fix this one, and an agent that reads it as a
        // permission problem will go and ask for authority it cannot use.
        assert!(!error.contains("Forbidden"), "{error}");
    }
    device.close().await;

    // Everything that worked before this existed still works. A device paired
    // before grants were a thing holds the full set, `pty:unconfined` among
    // them, and opens exactly the terminal it always did.
    let whole = pair_granting(&journey, &[]).await;
    let device = Client::connect_as_device(journey.daemon(), &whole)
        .await
        .expect("a paired device connects");
    device
        .call(Request::PtyOpen {
            workspace_id: Some(journey.workspace.id.clone()),
            cols: Some(80),
            rows: Some(24),
        })
        .await
        .expect("an unconfined terminal is still allowed to those who hold it");
    device.close().await;

    // And the person sitting at the machine is not confined at all: they own
    // the account, so a sandbox would cost them a working shell and protect
    // nobody (`architecture.md` §3.4).
    journey
        .client
        .call(Request::PtyOpen {
            workspace_id: Some(journey.workspace.id.clone()),
            cols: Some(80),
            rows: Some(24),
        })
        .await
        .expect("the local user opens a terminal");

    journey.finish().await;
}
