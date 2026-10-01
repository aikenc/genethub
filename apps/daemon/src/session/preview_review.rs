//! One preview-annotation draft per session, stored beside `meta.json`.
//!
//! Old clients rewrite `meta.json` through `session.drafts.replace`. Keeping
//! this draft in its own file means those clients cannot drop annotations they
//! do not understand. Only the preview-annotation RPCs write the file, and
//! they replace it under the session metadata lock with `expected_revision`.

use std::collections::BTreeMap;
use std::io::{Seek, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use genehub_proto::{
    AssetPreviewKind, PreviewAnnotation, PreviewAnnotationRoot, PreviewAnnotationTarget,
    PreviewReviewDraft,
};

const FILE_NAME: &str = "preview-review.json";
pub const MAX_ANNOTATIONS: usize = 40;
const MAX_COMMENT_BYTES: usize = 1024;
const MAX_EXCERPT_CHARS: usize = 256;
const MAX_SELECTOR_BYTES: usize = 512;
const MAX_DRAFT_BYTES: usize = 64 * 1024;
const MAX_WRITES_PER_SECOND: usize = 4;

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredReview {
    revision: u64,
    #[serde(default)]
    annotations: Vec<PreviewAnnotation>,
    /// Next image number for `relativePath + contentVersion`. Deletes do not rewind it.
    #[serde(default)]
    next_marker: BTreeMap<String, u32>,
    /// File name inside `preview-review-images/` for one image version.
    #[serde(default)]
    snapshots: BTreeMap<String, String>,
    #[serde(default)]
    write_times: Vec<i64>,
}

impl StoredReview {
    pub(crate) fn draft(&self) -> PreviewReviewDraft {
        PreviewReviewDraft {
            revision: self.revision,
            annotations: self.annotations.clone(),
        }
    }
}

pub fn group_key(path: &str, version: &str) -> String {
    format!("{path}\n{version}")
}

pub fn validate_shape(annotation: &PreviewAnnotation) -> Result<()> {
    if !valid_id(&annotation.id) {
        bail!("批注编号无效");
    }
    if annotation.comment.trim().is_empty() {
        bail!("请填写批注");
    }
    if annotation.comment.len() > MAX_COMMENT_BYTES {
        bail!("单条批注不能超过 1 KiB");
    }
    if annotation.source.relative_path.is_empty() || annotation.source.relative_path.contains('\0')
    {
        bail!("预览路径无效");
    }
    if !is_content_version(&annotation.source.content_version) {
        bail!("预览内容版本无效");
    }
    if !matches!(annotation.source.root, PreviewAnnotationRoot::Primary) {
        bail!("多根工作区的预览批注尚未开放，请使用主目录中的文件");
    }
    match &annotation.target {
        PreviewAnnotationTarget::MarkdownLines {
            start_line,
            end_line,
            excerpt,
        } => {
            if *start_line == 0 || *end_line < *start_line {
                bail!("Markdown 行号无效");
            }
            if excerpt.chars().count() > MAX_EXCERPT_CHARS {
                bail!("摘录过长");
            }
        }
        PreviewAnnotationTarget::HtmlElement {
            selector,
            tag,
            excerpt,
            dom_fingerprint,
        } => {
            if selector.is_empty()
                || selector.len() > MAX_SELECTOR_BYTES
                || selector.contains('\n')
                || selector.contains('\0')
            {
                bail!("HTML 选择器无效");
            }
            if tag.is_empty() || tag.len() > 32 || !tag.chars().all(|ch| ch.is_ascii_alphanumeric())
            {
                bail!("HTML 标签无效");
            }
            if excerpt.chars().count() > MAX_EXCERPT_CHARS || dom_fingerprint.len() > 128 {
                bail!("HTML 摘录过长");
            }
            if dom_fingerprint.is_empty() {
                bail!("HTML 元素指纹无效");
            }
        }
        PreviewAnnotationTarget::ImageRect {
            x,
            y,
            width,
            height,
            natural_width,
            natural_height,
        } => {
            if *natural_width == 0 || *natural_height == 0 || *width == 0 || *height == 0 {
                bail!("图片区域无效");
            }
            let right = x.checked_add(*width).context("图片区域越界")?;
            let bottom = y.checked_add(*height).context("图片区域越界")?;
            if right > *natural_width || bottom > *natural_height {
                bail!("图片区域越界");
            }
        }
    }
    Ok(())
}

pub fn ensure_kind(annotation: &PreviewAnnotation, kind: AssetPreviewKind) -> Result<()> {
    let ok = matches!(
        (&annotation.target, kind),
        (
            PreviewAnnotationTarget::MarkdownLines { .. },
            AssetPreviewKind::Markdown
        ) | (
            PreviewAnnotationTarget::HtmlElement { .. },
            AssetPreviewKind::Html
        ) | (
            PreviewAnnotationTarget::ImageRect { .. },
            AssetPreviewKind::Image
        )
    );
    if ok {
        Ok(())
    } else {
        bail!("批注锚点与文件类型不一致")
    }
}

pub fn load(dir: &Path) -> Result<StoredReview> {
    let path = dir.join(FILE_NAME);
    if !path.exists() {
        return Ok(StoredReview::default());
    }
    let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| {
        format!(
            "preview-review.json 无法读取，没有覆盖它 ({})",
            path.display()
        )
    })
}

fn save(dir: &Path, stored: &StoredReview) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(stored)?;
    if bytes.len() > MAX_DRAFT_BYTES {
        bail!("这份预览批注草稿已超过 64 KiB，请删除几条后再保存");
    }
    std::fs::create_dir_all(dir)?;
    let path = dir.join(FILE_NAME);
    let tmp = dir.join("preview-review.json.tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Copies an image once per content version. The caller holds the session lock.
pub fn ensure_image_snapshot(
    dir: &Path,
    session_id: &str,
    annotation: &PreviewAnnotation,
    source: &mut crate::files::PreviewSource,
    stored: &mut StoredReview,
) -> Result<Option<String>> {
    let PreviewAnnotationTarget::ImageRect { .. } = &annotation.target else {
        return Ok(None);
    };
    let key = group_key(
        &annotation.source.relative_path,
        &annotation.source.content_version,
    );
    let file_name = stored.snapshots.get(&key).cloned().unwrap_or_else(|| {
        format!(
            "{}-{}",
            annotation.source.content_version,
            safe_image_name(&annotation.source.relative_path)
        )
    });
    let images = dir.join("preview-review-images");
    let final_path = images.join(&file_name);
    if !final_path.is_file() {
        std::fs::create_dir_all(&images)?;
        let tmp = images.join(format!(".{file_name}.partial"));
        source.rewind()?;
        let mut output = std::fs::File::create(&tmp)?;
        std::io::copy(source, &mut output)?;
        output.sync_all()?;
        std::fs::rename(&tmp, &final_path)?;
    }
    stored.snapshots.insert(key, file_name.clone());
    Ok(Some(evidence_path(session_id, &file_name)))
}

pub fn apply_upsert(
    stored: &mut StoredReview,
    annotation: PreviewAnnotation,
    expected_revision: u64,
    now_ms: i64,
    evidence_path: Option<String>,
) -> Result<bool> {
    validate_shape(&annotation)?;
    if let Some(index) = stored
        .annotations
        .iter()
        .position(|item| item.id == annotation.id)
    {
        let same = same_body(&stored.annotations[index], &annotation);
        let anchor_matches = stored.annotations[index].source == annotation.source
            && stored.annotations[index].target == annotation.target;
        let marker_no = stored.annotations[index].marker_no;
        let created_at_ms = stored.annotations[index].created_at_ms;
        let kept_evidence = stored.annotations[index].evidence_path.clone();
        if same {
            return Ok(false);
        }
        if !anchor_matches {
            bail!("已保存的位置不能改；请删除后重新选择");
        }
        if stored.revision != expected_revision {
            bail!("preview annotation revision 冲突：请重新读取后再保存");
        }
        note_write(stored, now_ms)?;
        let slot = &mut stored.annotations[index];
        slot.comment = annotation.comment;
        slot.marker_no = marker_no;
        slot.created_at_ms = created_at_ms;
        slot.evidence_path = kept_evidence;
        stored.revision = stored.revision.saturating_add(1);
        return Ok(true);
    }
    if stored.revision != expected_revision {
        bail!("preview annotation revision 冲突：请重新读取后再保存");
    }
    if stored.annotations.len() >= MAX_ANNOTATIONS {
        bail!("一份预览批注草稿最多 40 条，请删除或先发送");
    }
    note_write(stored, now_ms)?;
    let mut created = annotation;
    created.evidence_path = evidence_path;
    created.marker_no = None;
    if matches!(created.target, PreviewAnnotationTarget::ImageRect { .. }) {
        let key = group_key(
            &created.source.relative_path,
            &created.source.content_version,
        );
        let next = stored.next_marker.get(&key).copied().unwrap_or(1);
        if next == 0 || next > 10_000 {
            bail!("这张图片的区域编号已用完");
        }
        created.marker_no = Some(next);
        stored.next_marker.insert(key, next.saturating_add(1));
    }
    stored.annotations.push(created);
    stored.revision = stored.revision.saturating_add(1);
    Ok(true)
}

pub fn apply_remove(
    stored: &mut StoredReview,
    ids: &[String],
    expected_revision: Option<u64>,
    now_ms: i64,
) -> Result<(bool, Vec<PathBuf>)> {
    if ids.is_empty() || ids.len() > MAX_ANNOTATIONS {
        bail!("要移除的批注无效");
    }
    if ids.iter().any(|id| !valid_id(id)) {
        bail!("批注编号无效");
    }
    let present: Vec<_> = ids
        .iter()
        .filter(|id| stored.annotations.iter().any(|item| item.id == **id))
        .cloned()
        .collect();
    if present.is_empty() {
        return Ok((false, Vec::new()));
    }
    if let Some(expected) = expected_revision {
        if stored.revision != expected {
            bail!("preview annotation revision 冲突：请重新读取后再删除");
        }
    }
    note_write(stored, now_ms)?;
    stored
        .annotations
        .retain(|item| !present.iter().any(|id| id == &item.id));
    stored.revision = stored.revision.saturating_add(1);
    let mut released = Vec::new();
    stored.snapshots.retain(|key, file_name| {
        let still_used = stored.annotations.iter().any(|item| {
            matches!(item.target, PreviewAnnotationTarget::ImageRect { .. })
                && group_key(&item.source.relative_path, &item.source.content_version) == *key
        });
        if !still_used {
            released.push(PathBuf::from("preview-review-images").join(file_name));
        }
        still_used
    });
    Ok((true, released))
}

pub fn read_draft(dir: &Path) -> Result<PreviewReviewDraft> {
    Ok(load(dir)?.draft())
}

pub fn commit(dir: &Path, stored: &StoredReview) -> Result<PreviewReviewDraft> {
    save(dir, stored)?;
    Ok(stored.draft())
}

fn same_body(existing: &PreviewAnnotation, incoming: &PreviewAnnotation) -> bool {
    existing.source == incoming.source
        && existing.target == incoming.target
        && existing.comment == incoming.comment
}

fn note_write(stored: &mut StoredReview, now_ms: i64) -> Result<()> {
    let recent = stored
        .write_times
        .iter()
        .filter(|stamp| now_ms.saturating_sub(**stamp) < 1000)
        .count();
    if recent >= MAX_WRITES_PER_SECOND {
        bail!("同一会话每秒最多写入 4 次预览批注");
    }
    stored.write_times.push(now_ms);
    stored
        .write_times
        .retain(|stamp| now_ms.saturating_sub(*stamp) < 1000);
    Ok(())
}

fn evidence_path(session_id: &str, file_name: &str) -> String {
    format!(".genethub/sessions/{session_id}/preview-review-images/{file_name}")
}

fn safe_image_name(relative: &str) -> String {
    let name = relative.rsplit(['/', '\\']).next().unwrap_or("image");
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
            out.push(ch);
        }
        if out.len() >= 48 {
            break;
        }
    }
    if out.is_empty() || out.starts_with('.') {
        out = format!("image{out}");
    }
    out
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn is_content_version(value: &str) -> bool {
    value.len() == 32 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn markdown(id: &str, comment: &str) -> PreviewAnnotation {
        PreviewAnnotation {
            id: id.into(),
            source: genehub_proto::PreviewAnnotationSource {
                root: PreviewAnnotationRoot::Primary,
                relative_path: "docs/spec.md".into(),
                content_version: "a".repeat(32),
            },
            target: PreviewAnnotationTarget::MarkdownLines {
                start_line: 2,
                end_line: 4,
                excerpt: "恢复".into(),
            },
            marker_no: None,
            evidence_path: None,
            comment: comment.into(),
            created_at_ms: 10,
        }
    }

    fn image(id: &str, path: &str, comment: &str) -> PreviewAnnotation {
        PreviewAnnotation {
            id: id.into(),
            source: genehub_proto::PreviewAnnotationSource {
                root: PreviewAnnotationRoot::Primary,
                relative_path: path.into(),
                content_version: "b".repeat(32),
            },
            target: PreviewAnnotationTarget::ImageRect {
                x: 0,
                y: 0,
                width: 2,
                height: 2,
                natural_width: 8,
                natural_height: 8,
            },
            marker_no: Some(99),
            evidence_path: Some("ignored".into()),
            comment: comment.into(),
            created_at_ms: 10,
        }
    }

    #[test]
    fn same_id_is_idempotent_and_markers_are_not_reused() {
        let mut stored = StoredReview::default();
        let first = image("ann-1", "design/a.png", "对比度");
        assert!(apply_upsert(&mut stored, first.clone(), 0, 1_000, Some("snap".into())).unwrap());
        assert_eq!(stored.annotations[0].marker_no, Some(1));
        assert_eq!(stored.annotations[0].evidence_path.as_deref(), Some("snap"));
        assert!(!apply_upsert(&mut stored, first, 0, 1_050, None).unwrap());
        assert_eq!(stored.revision, 1);

        let second = image("ann-2", "design/a.png", "留白");
        assert!(apply_upsert(&mut stored, second, 1, 1_100, Some("snap".into())).unwrap());
        assert_eq!(stored.annotations[1].marker_no, Some(2));
        let (changed, released) =
            apply_remove(&mut stored, &["ann-1".into()], Some(2), 1_200).unwrap();
        assert!(changed);
        assert!(
            released.is_empty(),
            "the other region still uses the snapshot"
        );
        let third = image("ann-3", "design/a.png", "标题");
        assert!(apply_upsert(&mut stored, third, 3, 1_300, Some("snap".into())).unwrap());
        assert_eq!(stored.annotations.last().unwrap().marker_no, Some(3));
    }

    #[test]
    fn stale_revision_conflicts_and_comment_edits_keep_the_anchor() {
        let mut stored = StoredReview::default();
        let note = markdown("ann-1", "原文");
        apply_upsert(&mut stored, note.clone(), 0, 1_000, None).unwrap();
        let mut edited = note.clone();
        edited.comment = "改过".into();
        assert!(apply_upsert(&mut stored, edited.clone(), 0, 2_000, None).is_err());
        assert!(apply_upsert(&mut stored, edited, 1, 2_000, None).unwrap());
        assert_eq!(stored.annotations[0].comment, "改过");
        assert_eq!(stored.annotations[0].target, note.target);

        let mut moved = note;
        moved.comment = "换位置".into();
        moved.target = PreviewAnnotationTarget::MarkdownLines {
            start_line: 9,
            end_line: 9,
            excerpt: "别的".into(),
        };
        let revision = stored.revision;
        assert!(apply_upsert(&mut stored, moved, revision, 3_000, None).is_err());
    }

    #[test]
    fn consume_without_revision_keeps_notes_added_during_send() {
        let mut stored = StoredReview::default();
        apply_upsert(&mut stored, markdown("ann-1", "一"), 0, 1_000, None).unwrap();
        apply_upsert(&mut stored, markdown("ann-2", "二"), 1, 2_000, None).unwrap();
        let (changed, _) = apply_remove(&mut stored, &["ann-1".into()], None, 3_000).unwrap();
        assert!(changed);
        assert_eq!(stored.annotations.len(), 1);
        assert_eq!(stored.annotations[0].id, "ann-2");
    }

    #[test]
    fn forty_notes_is_the_cap() {
        let mut stored = StoredReview::default();
        for index in 0..MAX_ANNOTATIONS {
            apply_upsert(
                &mut stored,
                markdown(&format!("ann-{index}"), "批注"),
                index as u64,
                10_000 + index as i64 * 1_000,
                None,
            )
            .unwrap();
        }
        assert!(apply_upsert(
            &mut stored,
            markdown("ann-extra", "太多"),
            MAX_ANNOTATIONS as u64,
            20_000,
            None
        )
        .is_err());
    }
}
