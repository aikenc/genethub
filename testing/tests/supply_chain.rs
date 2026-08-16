//! Release-pipeline invariants whose accidental rollback would re-open a code
//! execution path before the project has an independent signing root.

use std::fs;
use std::path::Path;

#[test]
fn release_actions_are_immutable_and_only_official_github_can_write_contents() {
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
    let publish = workflow
        .find("\n  publish_official_github:\n")
        .expect("Official GitHub publish job");
    let write = workflow.find("contents: write").expect("write permission");
    assert!(write > publish, "write permission escaped the publish job");

    let checkout_count = uses
        .iter()
        .filter(|action| action.starts_with("actions/checkout@"))
        .count();
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

    let fast = between(
        &workflow,
        "\n  publish_fast_website:\n",
        "\n  publish_official_website:\n",
    );
    assert!(!fast.contains("contents: write"));
    assert!(!fast.contains("softprops/action-gh-release"));
    assert!(fast.contains("deploy/publish-app-release.sh"));
    assert!(!workflow.contains("tag_name: ${{ needs.channel.outputs.name }}"));
}

#[test]
fn app_release_embeds_one_signed_logic_and_separates_fast_from_official_distribution() {
    let workflow = read(".github/workflows/release.yml");
    assert!(workflow.contains("GENEHUB_BETA_LOGIC_SIGNING_KEY"));
    assert!(workflow.contains("GENEHUB_OFFICIAL_LOGIC_SIGNING_KEY"));
    assert!(workflow.contains("node scripts/beta-promotion.mjs"));
    assert!(workflow.contains("GENEHUB_UNPROMOTED_OFFICIAL_REASON"));
    assert!(workflow.contains("promoted_from_beta: ${{ steps.logic.outputs.promoted_from_beta }}"));
    assert!(workflow
        .contains("pack \"$raw\" dist/daemon-logic.wasm \"$CHANNEL\" \"$revision\" \"$key_id\""));
    assert!(workflow.contains("dist/daemon-logic.wasm > dist/logic-identity.json"));
    assert!(workflow.matches("cmp \"").count() >= 3);
    assert!(workflow
        .contains("needs: [channel, daemon_logic, installers, binaries, publish_official_github]"));
    assert!(workflow.contains("repository contents and there is no rolling beta/alpha release"));
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

#[test]
fn native_runtime_cannot_take_back_business_wire_ownership() {
    let native_files = [
        "apps/daemon/src/dataplane/endpoint.rs",
        "apps/daemon/src/router.rs",
        "packages/daemon-platform/src/runtime.rs",
    ];
    let forbidden = [
        "genehub_proto::Request",
        "genehub_proto::Reply",
        "genehub_proto::ServerFrame",
        "use genehub_proto::{Request",
        "use genehub_proto::{Reply",
        "use genehub_proto::{ServerFrame",
    ];
    for relative in native_files {
        let body = read(relative);
        for symbol in forbidden {
            assert!(
                !body.contains(symbol),
                "native runtime {relative} regained business wire type {symbol}"
            );
        }
    }

    let guest = read("packages/daemon-logic/src/lib.rs");
    assert!(guest.contains("genehub_proto::Request"));
    assert!(guest.contains("genehub_proto::ServerFrame"));
    assert!(guest.contains("decode_json(\"business request\""));
}

fn read(relative: &str) -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(relative),
    )
    .unwrap_or_else(|error| panic!("cannot read {relative}: {error}"))
}

fn between<'a>(body: &'a str, start: &str, end: &str) -> &'a str {
    let start = body
        .find(start)
        .unwrap_or_else(|| panic!("missing {start}"));
    let rest = &body[start..];
    let end = rest.find(end).unwrap_or_else(|| panic!("missing {end}"));
    &rest[..end]
}
