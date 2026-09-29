mod build_support;

use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    let root = manifest_dir.join("builtin-skills");
    println!("cargo:rerun-if-changed={}", root.display());

    let tree = build_support::scan_builtin_tree(&root)
        .unwrap_or_else(|error| panic!("invalid daemon built-in Skill tree: {error}"));
    for directory in &tree.directories {
        println!("cargo:rerun-if-changed={}", directory.display());
    }
    for relative in &tree.files {
        println!("cargo:rerun-if-changed={}", root.join(relative).display());
    }

    let generated = build_support::render_manifest(&tree);
    let output = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"))
        .join("builtin_skills.rs");
    std::fs::write(&output, generated)
        .unwrap_or_else(|error| panic!("writing {}: {error}", output.display()));
}
