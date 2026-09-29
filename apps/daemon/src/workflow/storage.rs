//! Keep an activated package's storage address independent of editable source.
//! Only the locator lives at the project root; records stay with their Executor.

use super::*;

const EXECUTOR_HOME: &str = ".genethub/components/executor";
const BINDING_SCHEMA: &str = "genehub.workflow.executor-binding.v1";
const MAX_BINDING_BYTES: u64 = 4096;
const MAX_EXECUTOR_DIRECTORIES: usize = 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecutorBinding {
    schema: String,
    package_id: String,
    executor_path: String,
}

fn read_binding(path: &Path) -> Result<Option<ExecutorBinding>> {
    let metadata = match crate::config::sensitive_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("读取 Executor 存储绑定"),
    };
    crate::config::reject_link_or_reparse(path, &metadata)?;
    if !metadata.is_file() {
        bail!("Executor 存储绑定不是普通文件");
    }
    ensure_record_size("Executor 存储绑定", metadata.len(), MAX_BINDING_BYTES)?;
    let binding: ExecutorBinding =
        serde_json::from_slice(&fs::read(path)?).context("读取 Executor 存储绑定")?;
    if binding.schema != BINDING_SCHEMA {
        bail!("不支持的 Executor 存储绑定 schema");
    }
    for segment in binding.package_id.split('/') {
        validate_id(segment, "Workflow 包 id 片段")?;
        if matches!(segment, "." | "..") {
            bail!("Executor 存储绑定不能含路径导航片段");
        }
    }
    if binding.executor_path != "." {
        let path = &binding.executor_path;
        let prefix = format!("spaces/{}--", package::flat_id(&binding.package_id));
        let name = path
            .strip_prefix(&prefix)
            .ok_or_else(|| anyhow!("Executor 存储绑定必须指向本包的 Space"))?;
        validate_id(name, "Executor 存储绑定 Space")?;
        if matches!(name, "." | "..") {
            bail!("Executor 存储绑定不能含路径导航片段");
        }
    }
    Ok(Some(binding))
}

impl RuntimeStore {
    fn binding_directory(&self, create: bool) -> Result<PathBuf> {
        self.checked_directory(
            &self.project_root.join(EXECUTOR_HOME),
            &self.activation_scope()?,
            create,
        )
    }

    fn bound_executor_root(&self) -> Result<Option<PathBuf>> {
        let path = self.binding_directory(false)?.join("executor.json");
        let Some(binding) = read_binding(&path)? else {
            return Ok(None);
        };
        if binding.package_id != self.require_package()? {
            bail!("Executor 存储绑定属于另一个 Workflow 包");
        }
        Ok(Some(if binding.executor_path == "." {
            self.project_root.clone()
        } else {
            self.project_root.join(binding.executor_path)
        }))
    }

    /// A bounded compatibility lookup for releases that predate the locator.
    /// It reads only package-prefixed carriers and refuses duplicate pointers.
    fn legacy_executor_root(&self) -> Result<Option<PathBuf>> {
        let id = self.require_package()?;
        let mut roots = vec![self.project_root.clone()];
        let spaces = self.checked_directory(&self.project_root, Path::new("spaces"), false)?;
        match fs::read_dir(&spaces) {
            Ok(entries) => {
                let prefix = format!("{}--", package::flat_id(id));
                for (count, entry) in entries.enumerate() {
                    if count >= MAX_EXECUTOR_DIRECTORIES {
                        bail!("Executor 存储目录数量超过恢复查找上限");
                    }
                    let entry = entry?;
                    let name = entry.file_name();
                    if name.to_str().is_some_and(|name| name.starts_with(&prefix)) {
                        let metadata = crate::config::sensitive_metadata(&entry.path())?;
                        crate::config::reject_link_or_reparse(&entry.path(), &metadata)?;
                        if metadata.is_dir() {
                            roots.push(entry.path());
                        }
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("查找旧 Executor 存储"),
        }
        let mut found = None;
        for root in roots {
            let directory = self.checked_directory(
                &root.join(EXECUTOR_HOME),
                &self.activation_scope()?,
                false,
            )?;
            let path = directory.join("activation.json");
            match crate::config::sensitive_metadata(&path) {
                Ok(metadata) => {
                    crate::config::reject_link_or_reparse(&path, &metadata)?;
                    if !metadata.is_file() {
                        bail!("DCG Activation 不是普通文件");
                    }
                    ensure_record_size(
                        "DCG Activation",
                        metadata.len(),
                        MAX_ACTIVATION_RECORD_BYTES,
                    )?;
                    let activation: DcgActivationRecord = serde_json::from_slice(&fs::read(&path)?)
                        .context("读取旧 Executor 激活记录")?;
                    if activation.schema != ACTIVATION_SCHEMA {
                        bail!("不支持的 DCG Activation schema：{}", activation.schema);
                    }
                    let candidates = self.checked_directory(
                        &root.join(EXECUTOR_HOME),
                        Path::new("candidates"),
                        false,
                    )?;
                    let candidate_path = candidates.join(format!(
                        "{}.json",
                        candidate_hex(&activation.active_digest)?
                    ));
                    let metadata = crate::config::sensitive_metadata(&candidate_path)?;
                    crate::config::reject_link_or_reparse(&candidate_path, &metadata)?;
                    if !metadata.is_file() {
                        bail!("DCG Candidate 不是普通文件");
                    }
                    ensure_record_size(
                        "DCG Candidate",
                        metadata.len(),
                        MAX_CANDIDATE_RECORD_BYTES,
                    )?;
                    let candidate: DcgCandidateRecord =
                        serde_json::from_slice(&fs::read(candidate_path)?)?;
                    validate_candidate(&candidate)?;
                    if candidate.digest != activation.active_digest || candidate.package.id != id {
                        bail!("Executor 存储绑定的旧快照不属于 Workflow 包 {id}");
                    }
                    if found.is_some() {
                        bail!("Workflow 包存在多个 Executor 激活记录，无法确定存储绑定");
                    }
                    found = Some(root);
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error).context("读取旧 Executor 激活记录"),
            }
        }
        Ok(found)
    }

    pub(super) fn executor_root(&self, create: bool) -> Result<PathBuf> {
        let Some(id) = self.package_id.as_deref() else {
            return Ok(self.project_root.clone());
        };
        if let Some(root) = self.bound_executor_root()? {
            return Ok(root);
        }
        // Serialize first binding at a stable project path, before choosing the
        // legacy/source location, so two daemons cannot pin different carriers.
        let _lock = if create {
            Some(lock_exclusive_file(
                &self.binding_directory(true)?.join("executor.lock"),
                "Executor 存储绑定正在建立，请重试",
            )?)
        } else {
            None
        };
        if let Some(root) = self.bound_executor_root()? {
            return Ok(root);
        }
        let root = match self.legacy_executor_root()? {
            Some(root) => root,
            None => package::load(&self.project_root, id)?
                .executor_relative()?
                .map_or_else(
                    || self.project_root.clone(),
                    |path| self.project_root.join(path),
                ),
        };
        // Retain all existing path/link checks even when the address is frozen.
        self.checked_directory(&root.join(EXECUTOR_HOME), Path::new(""), false)?;
        if create {
            let binding = ExecutorBinding {
                schema: BINDING_SCHEMA.into(),
                package_id: id.into(),
                executor_path: if root == self.project_root {
                    ".".into()
                } else {
                    root.strip_prefix(&self.project_root)?
                        .to_string_lossy()
                        .replace('\\', "/")
                },
            };
            let body = encode_private_record("Executor 存储绑定", &binding, MAX_BINDING_BYTES)?;
            crate::config::save_private(
                &self.binding_directory(true)?.join("executor.json"),
                &body,
            )?;
        }
        Ok(root)
    }
}

/// Source discovery stays independent; this adds saved activations to selection.
pub(super) fn active_package_ids(project_root: &Path) -> Result<Vec<String>> {
    let runtime = RuntimeStore::new(project_root, "inspection", project_root)?;
    let directory = runtime.checked_directory(
        &runtime.project_root.join(EXECUTOR_HOME),
        Path::new("packages"),
        false,
    )?;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("读取已激活 Workflow 包"),
    };
    let mut ids = Vec::new();
    for (count, entry) in entries.enumerate() {
        if count >= 64 {
            bail!("已激活 Workflow 包数量超过上限");
        }
        let entry = entry?;
        let metadata = crate::config::sensitive_metadata(&entry.path())?;
        crate::config::reject_link_or_reparse(&entry.path(), &metadata)?;
        if !metadata.is_dir() {
            continue;
        }
        let Some(binding) = read_binding(&entry.path().join("executor.json"))? else {
            continue;
        };
        if entry.file_name().to_str() != Some(&package::flat_id(&binding.package_id)) {
            bail!("Executor 存储绑定与包目录不一致");
        }
        let scoped = RuntimeStore::for_package(
            project_root,
            "inspection",
            project_root,
            &binding.package_id,
        )?;
        if load_activation(&scoped)?.is_some() {
            ids.push(binding.package_id);
        }
    }
    Ok(ids)
}
