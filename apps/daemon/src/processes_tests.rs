use super::*;

fn row(pid: u32, parent: u32, group: u32, command: &str) -> Row {
    Row {
        pid,
        parent,
        group,
        running_for_seconds: 0,
        command: command.to_string(),
    }
}

fn agent(pid: u32) -> Agent {
    Agent {
        pid,
        group: pid,
        watched_at: std::time::Instant::now(),
    }
}

/// Watched a moment ago, which is what every test here means unless it is
/// about the passage of time.
const JUST_NOW: u64 = 0;

#[test]
fn the_agent_itself_is_not_reported_as_something_it_left_behind() {
    // It is running because the conversation is open. Listing it would put a
    // permanent count next to every session and teach people to ignore it.
    let census = vec![row(100, 1, 100, "codex")];
    let claimed = claimed_by(&census, agent(100), JUST_NOW);
    assert!(claimed.is_empty());
}

#[test]
fn a_process_still_in_the_group_is_claimed_even_after_its_parent_died() {
    // The shell that started the server has exited and init has adopted it, so
    // there is no longer a chain of parents leading back to the agent. The
    // group is what remembers.
    let census = vec![
        row(100, 1, 100, "codex"),
        row(140, 1, 100, "node server.js"),
    ];
    let claimed = claimed_by(&census, agent(100), JUST_NOW);
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].pid, 140);
}

#[test]
fn a_process_that_left_the_group_is_claimed_while_it_is_still_descended() {
    // An agent that manages its children properly gives each one a session of
    // its own, which is exactly what takes them out of the group. Ancestry is
    // what covers that, and the two rules exist to cover each other.
    let census = vec![
        row(100, 1, 100, "codex"),
        row(150, 100, 150, "bash -lc npm run dev"),
        row(151, 150, 150, "node"),
    ];
    let claimed = claimed_by(&census, agent(100), JUST_NOW);
    let pids: Vec<u32> = claimed.iter().map(|row| row.pid).collect();
    assert_eq!(pids, vec![150, 151]);
}

#[test]
fn another_sessions_work_is_not_claimed() {
    let census = vec![
        row(100, 1, 100, "codex"),
        row(140, 100, 100, "node ours.js"),
        row(200, 1, 200, "claude"),
        row(240, 200, 200, "node theirs.js"),
    ];
    let claimed = claimed_by(&census, agent(100), JUST_NOW);
    let pids: Vec<u32> = claimed.iter().map(|row| row.pid).collect();
    assert_eq!(pids, vec![140]);
}

#[test]
fn a_stranger_wearing_the_dead_agents_pid_is_not_mistaken_for_it() {
    // Pids are handed out again. An agent that exited an hour ago may have had
    // its number taken by somebody's editor, and claiming that group would put
    // a stranger's processes under this conversation with a button that ends
    // them. The giveaway is age: the impostor has not been running as long as
    // we have been watching.
    let census = vec![
        Row {
            running_for_seconds: 30,
            ..row(100, 1, 100, "vim")
        },
        Row {
            running_for_seconds: 25,
            ..row(140, 100, 100, "not ours")
        },
    ];
    let watched_for = 3600;
    assert!(claimed_by(&census, agent(100), watched_for).is_empty());
}

#[test]
fn an_agent_that_has_been_running_all_along_is_still_believed() {
    // The other side of the same check: an old agent is the normal case, and a
    // guard that cannot tell it apart from an impostor would report nothing,
    // ever.
    let census = vec![
        Row {
            running_for_seconds: 3700,
            ..row(100, 1, 100, "codex")
        },
        Row {
            running_for_seconds: 600,
            ..row(140, 100, 100, "node server.js")
        },
    ];
    let claimed = claimed_by(&census, agent(100), 3600);
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].pid, 140);
}

#[test]
fn nothing_is_claimed_for_an_agent_that_is_no_longer_running() {
    // Its group number is now just a number, free to be given to anything.
    let census = vec![row(140, 1, 100, "node server.js")];
    assert!(claimed_by(&census, agent(100), JUST_NOW).is_empty());
}

#[test]
fn a_command_with_spaces_survives_being_read_back() {
    // `args` is last precisely because it is the only field that can contain
    // whitespace; splitting it off early would truncate every real command.
    let census = parse_census("  100     1   100    01:02 bash -lc 'npm run dev -- --port 3000'\n");
    assert_eq!(census.len(), 1);
    assert_eq!(
        census[0].command,
        "bash -lc 'npm run dev -- --port 3000'".to_string()
    );
    assert_eq!(census[0].running_for_seconds, 62);
}

#[test]
fn elapsed_time_is_read_in_all_the_shapes_ps_uses() {
    assert_eq!(parse_elapsed("05"), None);
    assert_eq!(parse_elapsed("01:30"), Some(90));
    assert_eq!(parse_elapsed("02:01:30"), Some(7290));
    assert_eq!(parse_elapsed("3-02:01:30"), Some(266_490));
}

#[test]
fn a_line_that_cannot_be_read_is_dropped_rather_than_guessed() {
    let census = parse_census("nonsense\n\n  100 1 100 01:00 sh\n");
    assert_eq!(census.len(), 1);
    assert_eq!(census[0].pid, 100);
}

/// The operating system really does answer, and in the shape assumed above.
///
/// Everything else here is parsing; this is the one test that would notice if
/// `ps` on the machine running it did not take these arguments at all.
#[cfg(unix)]
#[tokio::test]
async fn the_operating_system_answers_and_knows_about_this_process() {
    let census = census().await.expect("ps answers");
    let ours = std::process::id();
    assert!(
        census.iter().any(|row| row.pid == ours),
        "the census did not include the process asking for it"
    );
}

/// A session that has an agent but nothing left over reports nothing, and a
/// session nobody is watching cannot be used to end processes.
#[tokio::test]
async fn nothing_can_be_ended_through_a_session_that_owns_nothing() {
    let processes = Processes::new();
    assert_eq!(processes.stop("s_absent", 1).await, Stopped::NotThisSession);
    assert_eq!(processes.stop_all("s_absent").await, 0);
    assert!(processes.list().await.is_empty());
}

/// The whole thing, against a real operating system.
///
/// Everything above tests a rule against a made-up census. This starts a
/// process, lets it leave something running the way an agent does, and then
/// finds and ends that through the same calls the workbench makes.
#[cfg(unix)]
#[tokio::test]
async fn what_an_agent_leaves_running_can_be_found_and_ended() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let marker = directory.path().join("left-running.txt");
    // Stands in for an agent: it starts something long-lived and then goes
    // quiet, which is exactly the shape of a turn that ended with a dev server
    // still up.
    let script = format!(
        "(while true; do echo alive >> {}; sleep 0.05; done) & sleep 60",
        marker.display()
    );
    let argv = crate::process::launch_argv("/bin/sh", None).expect("an unconfined launcher");
    let mut command = crate::process::command(&argv, &["-c".to_string(), script], directory.path());
    let agent = crate::process::Group::spawn(&mut command).expect("the stand-in agent starts");
    let agent_pid = agent.pid().expect("the agent has a pid");

    let processes = Processes::new();
    processes.watch("s_test", agent_pid).await;
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    let listed = processes.list().await;
    assert!(
        listed.iter().all(|process| process.pid != agent_pid),
        "the agent reported itself: {listed:?}"
    );
    let loop_process = listed
        .iter()
        .find(|process| process.command.contains(&marker.display().to_string()))
        .expect("the process the agent left running was not found");
    assert_eq!(loop_process.session_id, "s_test");

    assert_eq!(
        processes.stop("s_test", loop_process.pid).await,
        Stopped::Yes
    );
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let settled = std::fs::read_to_string(&marker).unwrap_or_default();
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let later = std::fs::read_to_string(&marker).unwrap_or_default();
    assert_eq!(
        settled.len(),
        later.len(),
        "the process was reported as ended and kept running"
    );
}

/// The count reaches the screen without anybody asking for it.
///
/// This is the half that makes a badge possible: a client that had to poll for
/// this would either poll constantly or show a number that is usually wrong.
#[tokio::test]
async fn the_end_of_a_turn_is_said_out_loud() {
    let (sender, mut listener) = tokio::sync::broadcast::channel(4);
    let processes = Processes::new();
    processes.announce_to(sender);

    processes.announce_now().await;

    match listener.try_recv().expect("a frame was pushed") {
        genehub_proto::ServerFrame::BackgroundProcesses { processes } => {
            assert!(processes.is_empty())
        }
        other => panic!("unexpected {other:?}"),
    }
}

/// Saying nothing is better than blocking when nobody is connected.
#[tokio::test]
async fn nothing_is_said_before_there_is_anywhere_to_say_it() {
    Processes::new().announce_now().await;
}

/// The pid check is the whole of the authorization, so it gets its own test:
/// a session may not end a process that is not its own, even one that exists.
#[cfg(unix)]
#[tokio::test]
async fn a_session_cannot_end_a_process_that_is_not_its_own() {
    let processes = Processes::new();
    // This process exists and is emphatically not the session's to end.
    processes.watch("s_test", std::process::id()).await;
    assert_eq!(processes.stop("s_test", 1).await, Stopped::NotThisSession);
}
