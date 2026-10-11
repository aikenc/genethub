use super::*;

fn project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".genethub/hooks")).unwrap();
    dir
}

fn write_hook(dir: &Path, id: &str, body: serde_json::Value) {
    // Written the way the daemon's own writers do: whole file, then in place.
    std::fs::write(
        dir.join(".genethub/hooks").join(format!("{id}.genet.json")),
        body.to_string(),
    )
    .unwrap();
}

fn sh(script: &str) -> serde_json::Value {
    serde_json::json!(["sh", "-c", script])
}

fn info(hooks: &Hooks, root: &Path, id: &str) -> HookInfo {
    hooks
        .list("w1", root)
        .hooks
        .into_iter()
        .find(|hook| hook.id == id)
        .unwrap_or_else(|| panic!("no hook {id}"))
}

/// Ticks until the hook has finished `runs` runs, or fails the test.
async fn until_runs(hooks: &Arc<Hooks>, root: &Path, id: &str, runs: u64) -> HookInfo {
    for _ in 0..300 {
        hooks.tick_project("w1", root, None);
        let hook = info(hooks, root, id);
        if hook.runs >= runs && !hook.running {
            return hook;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!(
        "hook {id} did not finish {runs} run(s): {:?}",
        info(hooks, root, id)
    );
}

fn read(root: &Path, name: &str) -> String {
    std::fs::read_to_string(root.join(name)).unwrap_or_default()
}

#[test]
fn the_first_run_is_immediate_then_one_per_interval_and_never_overlapping() {
    let every = Duration::from_secs(5);
    let t0 = Instant::now();
    let mut run = Run::default();
    assert!(due(t0, &run, every), "a hook that never ran is due at once");

    run.running = true;
    run.last_started = Some(t0);
    assert!(
        !due(t0 + Duration::from_secs(60), &run, every),
        "never twice at once"
    );

    run.running = false;
    run.last_finished = Some(t0 + Duration::from_millis(200));
    assert!(!due(t0 + Duration::from_millis(4_900), &run, every));
    assert!(due(t0 + every, &run, every));

    // A run that took longer than the interval waits a moment before the next,
    // instead of starting again the instant it ends.
    let mut slow = Run {
        last_started: Some(t0),
        last_finished: Some(t0 + Duration::from_secs(8)),
        ..Run::default()
    };
    assert!(!due(t0 + Duration::from_millis(8_500), &slow, every));
    assert!(due(t0 + Duration::from_secs(9), &slow, every));
    slow.last_finished = None;
    assert!(due(t0 + every, &slow, every));
}

#[tokio::test]
async fn a_hook_gets_the_envelope_the_platform_variables_and_open_env() {
    let root = project();
    let work = root.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(
        root.path().join(".genethub/open.env"),
        "FOO=bar\nGENEHUB_CLI=/evil\nGENEHUB_HOOK_ID=forged\n",
    )
    .unwrap();
    write_hook(
        root.path(),
        "demo.timer",
        serde_json::json!({
            "schema": "genet.hook.v1", "event": "timer", "every": "1s", "cwd": "work",
            "exec": ["sh", "-c",
                "cat > ../stdin.txt; echo \"$GENEHUB_HOOK_ID|$GENEHUB_HOOK_EVENT|$FOO|$GENEHUB_SPACE_DIR|$GENEHUB_CLI\" > ../env.txt; pwd > ../pwd.txt; echo \"$0\" > ../arg.txt",
                "${GENEHUB_SPACE_DIR}/x"],
            "payload": {"expert": "a"},
        }),
    );
    let hooks = Hooks::new(Some(PathBuf::from("/opt/genet")));
    let hook = until_runs(&hooks, root.path(), "demo.timer", 1).await;
    assert_eq!(hook.consecutive_failures, 0, "{hook:?}");
    assert_eq!(hook.last_exit_code, Some(0));
    assert!(hook.last_started_at_ms.is_some() && hook.valid && hook.enabled);

    let envelope: serde_json::Value =
        serde_json::from_str(read(root.path(), "stdin.txt").trim()).unwrap();
    assert_eq!(envelope["event"], "timer");
    assert_eq!(envelope["hook"], "demo.timer");
    assert_eq!(
        envelope["payload"]["expert"], "a",
        "payload reaches the command untouched"
    );
    assert_eq!(
        envelope["space"]["dir"],
        root.path().to_string_lossy().as_ref()
    );
    assert_eq!(
        envelope["openEnvProblems"].as_array().unwrap().len(),
        2,
        "the two reserved names were refused and said so"
    );
    let line = read(root.path(), "env.txt");
    assert_eq!(
        line.trim(),
        format!("demo.timer|timer|bar|{}|/opt/genet", root.path().display()),
        "open.env supplies FOO; GeneHub's own names cannot be forged"
    );
    assert_eq!(
        read(root.path(), "pwd.txt").trim(),
        work.to_string_lossy().as_ref()
    );
    assert_eq!(
        read(root.path(), "arg.txt").trim(),
        format!("{}/x", root.path().display())
    );
}

#[tokio::test]
async fn a_failing_hook_is_recorded_never_disabled_and_recovers_when_fixed() {
    let root = project();
    write_hook(
        root.path(),
        "flaky",
        serde_json::json!({"event":"timer","every":"1s","exec": sh("echo boom >&2; exit 3")}),
    );
    let hooks = Hooks::new(None);
    let first = until_runs(&hooks, root.path(), "flaky", 1).await;
    assert_eq!(first.consecutive_failures, 1);
    assert_eq!(first.last_exit_code, Some(3));
    let error = first.last_error.clone().unwrap();
    assert!(
        error.contains("exited with code 3") && error.contains("boom"),
        "{error}"
    );

    let second = until_runs(&hooks, root.path(), "flaky", 2).await;
    assert_eq!(
        second.consecutive_failures, 2,
        "it keeps running, and the count is the signal"
    );
    assert!(second.enabled, "a hook is never disabled for failing");

    write_hook(
        root.path(),
        "flaky",
        serde_json::json!({"event":"timer","every":"1s","exec": sh("exit 0")}),
    );
    let fixed = until_runs(&hooks, root.path(), "flaky", 3).await;
    assert_eq!(fixed.consecutive_failures, 0);
    assert_eq!(fixed.last_error, None);
}

#[cfg(unix)]
#[tokio::test]
async fn a_hook_that_hangs_is_ended_together_with_what_it_started() {
    let root = project();
    write_hook(
        root.path(),
        "hang",
        serde_json::json!({"event":"timer","every":"60s","timeout":1,
            "exec": sh("sleep 60 & echo $! > child.pid; wait")}),
    );
    let hooks = Hooks::new(None);
    let started = Instant::now();
    let hook = until_runs(&hooks, root.path(), "hang", 1).await;
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "ended near its timeout, not after the sleep"
    );
    assert!(
        hook.last_timed_out && hook.last_exit_code.is_none(),
        "{hook:?}"
    );
    assert!(hook.last_error.unwrap().contains("timed out after 1s"));
    let pid: u32 = read(root.path(), "child.pid").trim().parse().unwrap();
    for _ in 0..40 {
        if !crate::process::exists(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the hook's child {pid} outlived the hook");
}

#[tokio::test]
async fn an_invalid_file_is_listed_and_a_deleted_file_is_forgotten() {
    let root = project();
    std::fs::write(root.path().join(".genethub/hooks/bad.genet.json"), "{").unwrap();
    write_hook(
        root.path(),
        "ok",
        serde_json::json!({"event":"timer","every":"1s","exec": sh("exit 0")}),
    );
    let hooks = Hooks::new(None);
    let ok = until_runs(&hooks, root.path(), "ok", 1).await;
    assert_eq!(ok.runs, 1);
    let bad = info(&hooks, root.path(), "bad");
    assert!(!bad.valid && bad.problem.unwrap().contains("valid JSON"));
    assert_eq!(bad.runs, 0, "an invalid hook never runs");

    std::fs::remove_file(root.path().join(".genethub/hooks/ok.genet.json")).unwrap();
    hooks.tick_project("w1", root.path(), None);
    assert!(
        hooks
            .list("w1", root.path())
            .hooks
            .iter()
            .all(|hook| hook.id != "ok"),
        "the directory is the registry: a deleted file is gone"
    );
    // A hook of the same name written later is a new hook, with no history.
    write_hook(
        root.path(),
        "ok",
        serde_json::json!({"event":"timer","every":"1s","exec": sh("exit 0")}),
    );
    assert_eq!(
        info(&hooks, root.path(), "ok").runs,
        0,
        "a deleted hook's record was forgotten"
    );
}

#[tokio::test]
async fn a_slow_hook_is_never_started_again_while_it_runs() {
    let root = project();
    write_hook(
        root.path(),
        "slow",
        serde_json::json!({"event":"timer","every":"1s","exec": sh("echo start >> log.txt; sleep 2; echo end >> log.txt")}),
    );
    let hooks = Hooks::new(None);
    // The hook is due every second but takes two: for the 1.4 s it is running
    // (well past its next due time) every tick must leave it alone.
    for _ in 0..7 {
        hooks.tick_project("w1", root.path(), None);
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(
        read(root.path(), "log.txt").trim(),
        "start",
        "no second start while the first is still running"
    );
    until_runs(&hooks, root.path(), "slow", 1).await;
    assert_eq!(read(root.path(), "log.txt").trim(), "start\nend");
}

#[tokio::test]
async fn disabled_hooks_and_projects_without_hooks_do_nothing() {
    let root = project();
    write_hook(
        root.path(),
        "off",
        serde_json::json!({"event":"timer","every":"1s","enabled":false,"exec": sh("echo ran > off.txt")}),
    );
    let hooks = Hooks::new(None);
    for _ in 0..5 {
        hooks.tick_project("w1", root.path(), None);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        read(root.path(), "off.txt"),
        "",
        "enabled:false is the only switch"
    );
    let off = info(&hooks, root.path(), "off");
    assert!(off.valid && !off.enabled && off.runs == 0);

    let bare = tempfile::tempdir().unwrap();
    hooks.tick_project("w2", bare.path(), None);
    assert!(hooks.list("w2", bare.path()).hooks.is_empty());
    assert!(hooks
        .runs
        .lock()
        .unwrap()
        .keys()
        .all(|(workspace, _)| workspace != "w2"));
}

#[tokio::test]
async fn a_program_that_does_not_exist_is_a_recorded_failure_not_a_crash() {
    let root = project();
    write_hook(
        root.path(),
        "missing",
        serde_json::json!({"event":"timer","every":"1s","exec": ["no-such-program-anywhere"]}),
    );
    let hooks = Hooks::new(None);
    let hook = until_runs(&hooks, root.path(), "missing", 1).await;
    assert_eq!(hook.consecutive_failures, 1);
    assert!(
        hook.last_error.unwrap().contains("could not start"),
        "the error names what to fix"
    );
}
