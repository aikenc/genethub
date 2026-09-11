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
    let publish = workflow.find("\n  publish:\n").expect("GitHub publish job");
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

    // Rolling addresses are an explicit current product requirement, restricted to prereleases.
    let rolling = workflow
        .find("tag_name: ${{ needs.channel.outputs.name }}")
        .expect("channel discovery release");
    let action = workflow[..rolling]
        .rfind("- uses:")
        .expect("rolling release action");
    let block = &workflow[action..];
    assert!(block.contains("if: needs.channel.outputs.prerelease == 'true'"));
    assert!(block.contains("prerelease: true"));
    assert!(workflow.contains("if: startsWith(github.ref, 'refs/tags/v')"));
}

#[test]
fn app_release_embeds_one_signed_logic_and_separates_fast_from_official_distribution() {
    let workflow = read(".github/workflows/release.yml");
    // Same artifact/signing intent, adapted to the current host + component layout.
    assert_eq!(workflow.matches("\n  signed_component:\n").count(), 1);
    assert!(workflow
        .contains("\"$host_bin\" pack \"$raw\" dist/genehub_guest.wasm \"$CHANNEL\" \"$version\""));
    assert!(workflow.contains("\"$host_bin\" inspect dist/genehub_guest.wasm"));
    assert!(workflow.contains("identity.releaseVersion !== process.env.VERSION"));
    assert!(workflow
        .contains("cmp \"$GENEHUB_COMPONENT_WASM\" apps/desktop/src-tauri/bin/genehub_guest.wasm"));
    assert!(workflow.contains("needs: [channel, verify, signed_component]"));
    assert!(workflow.contains("cp component/genehub_guest.wasm dist/genehub_guest.wasm"));
    assert!(workflow.contains("not a signed\n      # updater manifest"));
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
    // daemon is now compiled into the guest; the thin native host/CLI own only transport.
    let native_roots = ["apps/host/src", "apps/cli/src", "packages/frontdoor/src"];
    let forbidden = [
        "genehub_proto::Request",
        "genehub_proto::Reply",
        "genehub_proto::ServerFrame",
        "use genehub_proto::{Request",
        "use genehub_proto::{Reply",
        "use genehub_proto::{ServerFrame",
    ];
    for root in native_roots {
        for relative in rust_files(root) {
            let body = read(&relative);
            for symbol in forbidden {
                assert!(
                    !body.contains(symbol),
                    "native runtime {relative} regained business wire type {symbol}"
                );
            }
        }
    }

    let guest = read("apps/guest/Cargo.toml");
    assert!(
        guest.contains("genet-daemon"),
        "guest must retain the business runtime"
    );
    let native = read("apps/host/Cargo.toml");
    assert!(
        !native
            .lines()
            .any(|line| line.starts_with("genehub-proto =") || line.starts_with("genet-daemon =")),
        "native shell linked business protocol/runtime"
    );
    let wire = read("apps/daemon/src/dataplane/endpoint.rs");
    assert!(
        wire.contains("Request") && wire.contains("Reply"),
        "guest business dispatcher missing"
    );
}

fn rust_files(relative: &str) -> Vec<String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut pending = vec![root.join(relative)];
    let mut files = Vec::new();
    while let Some(path) = pending.pop() {
        for entry in fs::read_dir(&path)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
        {
            let path = entry.expect("directory entry").path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().and_then(|value| value.to_str()) == Some("rs") {
                files.push(
                    path.strip_prefix(&root)
                        .expect("native path is below repository root")
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    files
}

fn read(relative: &str) -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join(relative),
    )
    .unwrap_or_else(|error| panic!("cannot read {relative}: {error}"))
}

#[test]
fn release_metadata_does_not_pretend_a_sibling_digest_is_a_signature() {
    let workflow = read(".github/workflows/release.yml");
    assert!(workflow.contains("not a signed\n      # updater manifest"));
    assert!(workflow.contains("independent signing root"));
    assert!(!workflow.contains("signature` is absent"));
}
