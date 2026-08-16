//! Release-pipeline invariants whose accidental rollback would re-open a code
//! execution path before the project has an independent signing root.

use std::fs;
use std::path::Path;

#[test]
fn release_actions_are_immutable_and_publish_alone_can_write_contents() {
    let workflow = read(".github/workflows/release.yml");
    let uses: Vec<_> = workflow
        .lines()
        .filter_map(|line| line.trim().strip_prefix("- uses: "))
        .collect();
    assert!(!uses.is_empty(), "release workflow has no actions");
    for action in &uses {
        let reference = action
            .split('#')
            .next()
            .unwrap()
            .trim()
            .rsplit_once('@')
            .unwrap_or_else(|| panic!("action has no pinned ref: {action}"))
            .1;
        assert!(
            reference.len() == 40
                && reference
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
            "action is not pinned to a full lowercase commit SHA: {action}"
        );
    }

    assert!(workflow.contains("permissions:\n  contents: read\n"));
    assert_eq!(workflow.matches("contents: write").count(), 1);
    let publish = workflow.find("\n  publish:\n").expect("publish job");
    let write = workflow.find("contents: write").expect("write permission");
    assert!(write > publish, "write permission escaped the publish job");

    let checkout_count = uses
        .iter()
        .filter(|action| action.starts_with("actions/checkout@"))
        .count();
    assert_eq!(checkout_count, 4);
    assert_eq!(
        workflow.matches("persist-credentials: false").count(),
        checkout_count,
        "a checkout retained the workflow credential"
    );

    // Repository variables are an administrative input, not Bash source.
    // Putting an expression directly inside the `run:` body lets a quote or
    // newline in a misconfigured value change the release script itself.
    assert!(!workflow.contains("echo \"hub_url=${{ vars."));
    assert!(workflow.contains("BETA_HUB_URL: ${{ vars.GENEHUB_BETA_HUB_URL"));
    assert!(workflow.contains("published Hub URL must be HTTPS"));
}

#[test]
fn release_metadata_does_not_pretend_a_sibling_digest_is_a_signature() {
    let workflow = read(".github/workflows/release.yml");
    assert!(workflow.contains("not a signed\n      # updater manifest"));
    assert!(workflow.contains("independent signing root"));
    assert!(!workflow.contains("signature` is absent"));
}

#[test]
fn tag_releases_must_come_from_the_observed_public_main_history() {
    let workflow = read(".github/workflows/release.yml");
    assert!(workflow.contains("if: startsWith(github.ref, 'refs/tags/v')"));
    assert!(workflow.contains("https://github.com/${GITHUB_REPOSITORY}.git"));
    assert!(workflow.contains("refs/heads/main"));
    assert!(workflow.contains("fetch_args+=(--unshallow)"));
    assert!(workflow.contains("git merge-base --is-ancestor \"$release_sha\" \"$main_sha\""));
    assert!(workflow.contains("public main snapshot"));
    assert!(workflow.contains("GITHUB_STEP_SUMMARY"));
}

fn read(relative: &str) -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(relative),
    )
    .unwrap_or_else(|error| panic!("cannot read {relative}: {error}"))
}
