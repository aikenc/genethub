use std::fmt::Write as _;
use std::path::{Path, PathBuf};

const MAX_NAME_LENGTH: usize = 64;
const MAX_DESCRIPTION_LENGTH: usize = 1024;

pub(crate) struct BuiltinTree {
    pub(crate) directories: Vec<PathBuf>,
    pub(crate) files: Vec<String>,
    entrypoints: Vec<String>,
}

pub(crate) fn scan_builtin_tree(root: &Path) -> Result<BuiltinTree, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }

    let mut directories = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut entrypoints = Vec::new();
    let mut skill_dirs = read_entries(root)?;
    skill_dirs.sort();
    if skill_dirs.is_empty() {
        return Err("the built-in Skill tree is empty".into());
    }

    for skill_dir in skill_dirs {
        let metadata = std::fs::symlink_metadata(&skill_dir)
            .map_err(|error| format!("reading {}: {error}", skill_dir.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!(
                "{} must be a real top-level Skill directory",
                skill_dir.display()
            ));
        }
        let directory_name = utf8_file_name(&skill_dir)?;
        validate_skill_name(directory_name)?;

        let entrypoint = skill_dir.join("SKILL.md");
        let entrypoint_metadata = std::fs::symlink_metadata(&entrypoint)
            .map_err(|_| format!("{} has no regular SKILL.md", skill_dir.display()))?;
        if entrypoint_metadata.file_type().is_symlink() || !entrypoint_metadata.is_file() {
            return Err(format!("{} must be a regular file", entrypoint.display()));
        }
        validate_skill_entrypoint(&entrypoint, directory_name)?;

        collect_files(root, &skill_dir, &mut directories, &mut files)?;
        entrypoints.push(format!("{directory_name}/SKILL.md"));
    }

    directories.sort();
    directories.dedup();
    files.sort();
    files.dedup();
    entrypoints.sort();
    Ok(BuiltinTree {
        directories,
        files,
        entrypoints,
    })
}

fn collect_files(
    root: &Path,
    directory: &Path,
    directories: &mut Vec<PathBuf>,
    files: &mut Vec<String>,
) -> Result<(), String> {
    directories.push(directory.to_path_buf());
    let mut entries = read_entries(directory)?;
    entries.sort();
    for path in entries {
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("reading {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("symlinks are not allowed: {}", path.display()));
        }
        if metadata.is_dir() {
            collect_files(root, &path, directories, files)?;
        } else if metadata.is_file() {
            files.push(portable_relative_path(root, &path)?);
        } else {
            return Err(format!("unsupported filesystem entry: {}", path.display()));
        }
    }
    Ok(())
}

fn read_entries(directory: &Path) -> Result<Vec<PathBuf>, String> {
    std::fs::read_dir(directory)
        .map_err(|error| format!("reading {}: {error}", directory.display()))?
        .map(|entry| {
            entry
                .map(|entry| entry.path())
                .map_err(|error| format!("reading {}: {error}", directory.display()))
        })
        .collect()
}

fn portable_relative_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| format!("{} escaped {}", path.display(), root.display()))?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return Err(format!("non-portable path: {}", path.display()));
        };
        let part = part
            .to_str()
            .ok_or_else(|| format!("non-UTF-8 path: {}", path.display()))?;
        if part.contains('\\') {
            return Err(format!("backslashes are not portable: {}", path.display()));
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return Err(format!("empty relative path: {}", path.display()));
    }
    Ok(parts.join("/"))
}

fn utf8_file_name(path: &Path) -> Result<&str, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("non-UTF-8 directory name: {}", path.display()))
}

fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > MAX_NAME_LENGTH
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(format!(
            "Skill directory {name:?} must be 1-{MAX_NAME_LENGTH} lowercase ASCII letters, digits, or hyphens"
        ));
    }
    Ok(())
}

fn validate_skill_entrypoint(path: &Path, directory_name: &str) -> Result<(), String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|error| format!("reading {} as UTF-8: {error}", path.display()))?;
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Err(format!("{} has no YAML frontmatter", path.display()));
    }

    let mut name = None;
    let mut description = None;
    let mut closed = false;
    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        match key.trim() {
            "name" => name = Some(value),
            "description" => description = Some(value),
            _ => {}
        }
    }
    if !closed {
        return Err(format!("{} has unclosed YAML frontmatter", path.display()));
    }
    if name != Some(directory_name) {
        return Err(format!(
            "{} name must equal its directory {directory_name:?}",
            path.display()
        ));
    }
    let description = description.unwrap_or_default();
    if description.is_empty() || description.len() > MAX_DESCRIPTION_LENGTH {
        return Err(format!(
            "{} description must be 1-{MAX_DESCRIPTION_LENGTH} bytes",
            path.display()
        ));
    }
    Ok(())
}

pub(crate) fn render_manifest(tree: &BuiltinTree) -> String {
    let mut generated = String::from(
        "// @generated by apps/daemon/build.rs. Do not edit.\n\
         const BUILTIN_FILES: &[BuiltinFile] = &[\n",
    );
    for relative in &tree.files {
        writeln!(
            generated,
            "    BuiltinFile {{ relative_path: {relative:?}, contents: include_bytes!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/builtin-skills/\", {relative:?})) }},"
        )
        .expect("writing to a String cannot fail");
    }
    generated.push_str("];\n\nconst BUILTIN_ENTRYPOINTS: &[&str] = &[\n");
    for relative in &tree.entrypoints {
        writeln!(generated, "    {relative:?},").expect("writing to a String cannot fail");
    }
    generated.push_str("];\n");
    generated
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempTree(PathBuf);

    impl TempTree {
        fn new(tag: &str) -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let sequence = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "genet-daemon-build-skills-{tag}-{}-{sequence}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_skill(root: &Path, directory: &str, name: &str) -> PathBuf {
        let skill = root.join(directory);
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Test Skill\n---\n"),
        )
        .unwrap();
        skill
    }

    #[test]
    fn scan_discovers_and_sorts_every_regular_resource() {
        let temp = TempTree::new("valid");
        let root = temp.0.join("builtin-skills");
        let zeta = write_skill(&root, "zeta", "zeta");
        std::fs::create_dir_all(zeta.join("assets")).unwrap();
        std::fs::write(zeta.join("assets/binary.bin"), [0, 255, 1]).unwrap();
        write_skill(&root, "alpha", "alpha");

        let tree = scan_builtin_tree(&root).unwrap();
        assert!(tree.directories.iter().any(|path| path.ends_with("assets")));
        assert_eq!(
            tree.files,
            ["alpha/SKILL.md", "zeta/SKILL.md", "zeta/assets/binary.bin"]
        );
        assert_eq!(tree.entrypoints, ["alpha/SKILL.md", "zeta/SKILL.md"]);
        let generated = render_manifest(&tree);
        assert!(generated.contains("zeta/assets/binary.bin"));
        assert!(generated.contains("include_bytes!"));
    }

    #[test]
    fn scan_rejects_a_mismatched_entrypoint_name() {
        let temp = TempTree::new("mismatch");
        let root = temp.0.join("builtin-skills");
        write_skill(&root, "expected-name", "different-name");

        let error = scan_builtin_tree(&root).err().expect("invalid tree");
        assert!(error.contains("name must equal its directory"));
    }

    #[test]
    fn scan_rejects_unknown_top_level_files() {
        let temp = TempTree::new("top-level-file");
        let root = temp.0.join("builtin-skills");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("README.md"), "not a Skill").unwrap();

        let error = scan_builtin_tree(&root).err().expect("invalid tree");
        assert!(error.contains("real top-level Skill directory"));
    }
}
