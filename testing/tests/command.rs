//! Running a command on a machine, for someone who is not sitting at it.
//!
//! The interesting cases are not "does it run". They are the ones where the
//! feature would look like it works while quietly failing at its job: output
//! merged into one stream, a failing command reported as a success, a command
//! that reaches out of the workspace, or one that keeps running after the
//! caller is gone.

use std::time::Duration;

use genehub_proto::{DeviceCredential, InviteScope, Reply, Request, ShellFrame, ShellRunRequest};
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
            device_name: "a-laptop".into(),
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

fn ask(workspace_id: &str, argv: &[&str]) -> ShellRunRequest {
    ShellRunRequest {
        workspace_id: workspace_id.to_string(),
        argv: argv.iter().map(|word| (*word).to_string()).collect(),
        cwd: None,
    }
}

/// Everything the command wrote to one stream, in order.
fn text(frames: &[ShellFrame], stream: &str) -> String {
    frames
        .iter()
        .filter_map(|frame| match (frame, stream) {
            (ShellFrame::Stdout { data }, "stdout") => Some(data.as_str()),
            (ShellFrame::Stderr { data }, "stderr") => Some(data.as_str()),
            _ => None,
        })
        .collect()
}

fn exit(frames: &[ShellFrame]) -> Option<(Option<i32>, Option<i32>)> {
    frames.iter().find_map(|frame| match frame {
        ShellFrame::Exit { code, signal } => Some((*code, *signal)),
        _ => None,
    })
}

#[tokio::test]
async fn the_two_output_streams_arrive_apart_and_the_status_is_the_command_s_own() {
    // A terminal merges these because a person reads both at once. A caller
    // that has to tell a diagnostic from a result cannot un-merge them, which
    // is the whole reason this is not built on a pty.
    let journey = Journey::start().await.expect("journey starts");
    let (_, frames) = journey
        .client
        .run_command(ask(
            &journey.workspace.id,
            &[
                "/bin/sh",
                "-c",
                "echo to-stdout; echo to-stderr 1>&2; exit 3",
            ],
        ))
        .await
        .expect("the command runs");

    assert!(text(&frames, "stdout").contains("to-stdout"));
    assert!(text(&frames, "stderr").contains("to-stderr"));
    assert!(
        !text(&frames, "stdout").contains("to-stderr"),
        "the streams were merged: {frames:?}"
    );
    // A command that failed has to be reported as a command that failed. The
    // easiest bug here is to treat "the run succeeded" as "the command
    // succeeded", and nobody notices until a broken build reports green.
    assert_eq!(exit(&frames), Some((Some(3), None)));
}

#[tokio::test]
async fn a_command_is_a_list_so_nothing_in_it_becomes_a_second_command() {
    let journey = Journey::start().await.expect("journey starts");
    // If any layer handed this to a shell, the semicolon would start a second
    // command and the marker would appear. It is an argument, so `echo` prints
    // it and that is all that happens.
    let (_, frames) = journey
        .client
        .run_command(ask(
            &journey.workspace.id,
            &["/bin/echo", "safe; echo INJECTED"],
        ))
        .await
        .expect("the command runs");

    let output = text(&frames, "stdout");
    assert!(output.contains("safe; echo INJECTED"), "got {output:?}");
    assert_eq!(output.matches("INJECTED").count(), 1, "got {output:?}");
    assert_eq!(exit(&frames), Some((Some(0), None)));
}

#[tokio::test]
async fn a_device_without_the_terminal_grant_cannot_run_a_command_either() {
    // `shell.run` and `pty.open` are the same authority: anything one can do,
    // the other can. A separate grant for one of them would make an invitation
    // look narrower than it is.
    let journey = Journey::start().await.expect("journey starts");
    let credential = pair_granting(&journey, &["read", "files"]).await;
    let device = Client::connect_as_device(journey.daemon(), &credential)
        .await
        .expect("a paired device connects");

    let (head, frames) = device
        .run_command(ask(&journey.workspace.id, &["/bin/echo", "hello"]))
        .await
        .expect("the machine answers");
    assert_eq!(head.status, 403, "{head:?}");
    assert!(frames.is_empty(), "a refused command still ran: {frames:?}");
    device.close().await;
    journey.finish().await;
}

#[tokio::test]
async fn a_command_run_for_someone_else_is_confined_or_refused_but_never_neither() {
    let journey = Journey::start().await.expect("journey starts");
    let confinable = genet_daemon::isolation::report().enforced;
    let outside = std::path::Path::new(&journey.workspace.root)
        .parent()
        .map(|parent| {
            let path = parent.join("outside.txt");
            std::fs::write(&path, "OUT-OF-BOUNDS").expect("a file next door");
            path
        })
        .expect("the workspace has a parent");

    let credential = pair_granting(&journey, &["read", "pty"]).await;
    let device = Client::connect_as_device(journey.daemon(), &credential)
        .await
        .expect("a paired device connects");
    let (head, frames) = device
        .run_command(ask(
            &journey.workspace.id,
            &["/bin/cat", &outside.to_string_lossy()],
        ))
        .await
        .expect("the machine answers");

    if confinable {
        assert_eq!(head.status, 200, "{head:?}");
        let read = text(&frames, "stdout");
        assert!(
            !read.contains("OUT-OF-BOUNDS"),
            "a confined command read a file outside its workspace: {read:?}"
        );
        assert_ne!(
            exit(&frames),
            Some((Some(0), None)),
            "the read outside the workspace succeeded: {frames:?}"
        );
    } else {
        // A machine that cannot confine refuses. It does not run the command
        // unconfined, which is the one outcome nobody could detect.
        assert_eq!(head.status, 501, "{head:?}");
        assert!(frames.is_empty());
    }
    device.close().await;
    journey.finish().await;
}

#[tokio::test]
async fn a_confined_command_still_works_inside_the_workspace() {
    let journey = Journey::start().await.expect("journey starts");
    if !genet_daemon::isolation::report().enforced {
        eprintln!("skipping: this machine cannot confine a process");
        return;
    }
    std::fs::write(
        std::path::Path::new(&journey.workspace.root).join("inside.txt"),
        "in the workspace",
    )
    .expect("a file to read");

    let credential = pair_granting(&journey, &["read", "pty"]).await;
    let device = Client::connect_as_device(journey.daemon(), &credential)
        .await
        .expect("a paired device connects");
    // Relative, so it also proves the command really started in the workspace
    // rather than wherever the daemon happens to be running.
    let (head, frames) = device
        .run_command(ask(&journey.workspace.id, &["/bin/cat", "inside.txt"]))
        .await
        .expect("the machine answers");

    assert_eq!(head.status, 200, "{head:?}");
    assert!(
        text(&frames, "stdout").contains("in the workspace"),
        "a confined command could not read its own workspace: {frames:?}"
    );
    assert_eq!(exit(&frames), Some((Some(0), None)));
    device.close().await;
    journey.finish().await;
}

#[tokio::test]
async fn every_folder_of_a_multi_root_workspace_is_inside_the_confinement() {
    // A `.code-workspace` is one project that happens to live in several
    // directories. Confining only the first would leave the second readable but
    // not writable — a shell that works until it touches the other half, and
    // the report would still say "confined".
    let journey = Journey::start().await.expect("journey starts");
    if !genet_daemon::isolation::report().enforced {
        eprintln!("skipping: this machine cannot confine a process");
        return;
    }
    let home = std::path::Path::new(&journey.workspace.root)
        .parent()
        .expect("the workspace has a parent")
        .to_path_buf();
    let product = home.join("product");
    let docs = home.join("docs");
    let elsewhere = home.join("elsewhere");
    for directory in [&product, &docs, &elsewhere] {
        std::fs::create_dir_all(directory).expect("a directory");
    }
    std::fs::write(elsewhere.join("secret.txt"), "OUT-OF-BOUNDS").expect("a file next door");
    let definition = home.join("suite.code-workspace");
    std::fs::write(
        &definition,
        r#"{ "folders": [{ "path": "product" }, { "path": "docs" }] }"#,
    )
    .expect("a workspace file");
    let suite = journey
        .daemon()
        .state
        .workspaces
        .open(&definition, None)
        .await
        .expect("the machine opens the multi-root workspace");
    assert_eq!(suite.folders.len(), 2, "the fixture is not multi-root");

    let credential = pair_granting(&journey, &["read", "pty"]).await;
    let device = Client::connect_as_device(journey.daemon(), &credential)
        .await
        .expect("a paired device connects");

    // The second folder is writable, which is the part a single-root
    // confinement would silently get wrong.
    let mut request = ask(
        &suite.id,
        &["/bin/sh", "-c", "echo written > note.txt && cat note.txt"],
    );
    request.cwd = Some(docs.to_string_lossy().into_owned());
    let (head, frames) = device
        .run_command(request)
        .await
        .expect("the machine answers");
    assert_eq!(head.status, 200, "{head:?}");
    assert!(
        text(&frames, "stdout").contains("written"),
        "the second folder was not writable inside the confinement: {frames:?}"
    );
    assert_eq!(exit(&frames), Some((Some(0), None)));
    assert!(docs.join("note.txt").exists(), "the write went nowhere");

    // And the confinement is still a confinement: a sibling directory that is
    // not one of the folders stays out of reach.
    let (_, frames) = device
        .run_command(ask(
            &suite.id,
            &["/bin/cat", &elsewhere.join("secret.txt").to_string_lossy()],
        ))
        .await
        .expect("the machine answers");
    assert!(
        !text(&frames, "stdout").contains("OUT-OF-BOUNDS"),
        "a third directory came along with the two that were named: {frames:?}"
    );
    device.close().await;
    journey.finish().await;
}

#[tokio::test]
async fn a_directory_outside_the_workspace_is_refused_rather_than_clamped() {
    let journey = Journey::start().await.expect("journey starts");
    let mut request = ask(&journey.workspace.id, &["/bin/pwd"]);
    request.cwd = Some("/tmp".into());

    let (head, frames) = journey
        .client
        .run_command(request)
        .await
        .expect("the machine answers");
    // Silently running in the workspace root instead would look like it
    // worked, and the caller would read the output of the wrong directory.
    assert_eq!(head.status, 403, "{head:?}");
    assert!(frames.is_empty());
    journey.finish().await;
}

#[tokio::test]
async fn a_command_does_not_outlive_the_caller_that_asked_for_it() {
    // Nothing is watching a process whose only reason to exist has gone away,
    // and on a machine people leave running that is how a mistake becomes
    // permanent.
    let journey = Journey::start().await.expect("journey starts");
    let marker = std::path::Path::new(&journey.workspace.root).join("still-running.txt");
    let script = format!(
        "for i in $(seq 1 200); do echo alive >> {}; sleep 0.05; done",
        marker.display()
    );

    let credential = pair_granting(&journey, &[]).await;
    let device = Client::connect_as_device(journey.daemon(), &credential)
        .await
        .expect("a paired device connects");
    let workspace_id = journey.workspace.id.clone();
    let started = tokio::spawn(async move {
        let _ = device
            .run_command(ask(&workspace_id, &["/bin/sh", "-c", &script]))
            .await;
        device
    });

    // Let it get going, then drop the connection the way a lost link would.
    tokio::time::sleep(Duration::from_millis(400)).await;
    started.abort();
    let _ = started.await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    let after = std::fs::read_to_string(&marker).unwrap_or_default();
    // Without this the test would pass just as happily if the command had
    // never started, which is the opposite of what it claims to prove.
    assert!(
        !after.is_empty(),
        "the command never got going, so nothing was proven about stopping it"
    );
    tokio::time::sleep(Duration::from_millis(600)).await;
    let later = std::fs::read_to_string(&marker).unwrap_or_default();
    assert_eq!(
        after.len(),
        later.len(),
        "the command kept running after the caller disconnected"
    );
    journey.finish().await;
}
