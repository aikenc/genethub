//! Tool-result images: shed adapter payloads into timeline-safe rows.
//!
//! Adapters hand over `ToolImage`s whose `data_base64` still carries the
//! source bytes. This module is the single intake point that strips them:
//! images the agent *read* keep only a workspace-relative path (the original
//! stays on disk and is opened through `asset.preview`); images the agent
//! *produced* move to the blob layer. Either way a thumbnail is inlined so
//! the batch strip renders with zero extra round trips. Source base64 never
//! reaches the timeline, the log or the tool blob.

use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use genehub_proto::domain::ImageThumb;
use genehub_proto::timeline::ToolImage;
use image::ImageReader;
use image::imageops::FilterType;
use serde_json::{Value, json};

/// Read images are the common case and pure navigation aids.
pub const READ_THUMB_WIDTH: u32 = 64;
/// Produced images are content; give them a bit more room.
pub const OUTPUT_THUMB_WIDTH: u32 = 128;
/// base64 inflates by 4/3; this keeps a fetched original inside the 64 MiB
/// finite-exchange response cap.
pub const MAX_IMAGE_BYTES: usize = 48 * 1024 * 1024;

/// One produced image's payload, queued for the blob writer under a synthetic
/// item id (`<tool item>:img:<n>`) so the regular ref merge addresses it.
pub struct ImageBlobPut {
    pub item_id: String,
    pub value: Value,
}

/// Strips `data_base64` from every image in place and returns the blob
/// payloads to preserve. `cwd` resolves relative tool paths; `workspace_root`
/// decides whether a read image stays a path reference (inside) or becomes a
/// blob (outside — the workspace boundary is the preview boundary).
pub fn shed_tool_images(
    item_id: &str,
    images: &mut Vec<ToolImage>,
    cwd: &Path,
    workspace_root: &Path,
) -> Vec<ImageBlobPut> {
    let mut puts = Vec::new();
    for (index, image) in images.iter_mut().enumerate() {
        let workspace_path = image
            .path
            .as_deref()
            .and_then(|path| workspace_relative(path, cwd, workspace_root));
        // Adapters that only know the path (codex `imageView`) hand over no
        // bytes at all: read the workspace file for the thumbnail instead.
        let data = match image.data_base64.take() {
            Some(data) => data,
            None => {
                if let Some(relative) = &workspace_path {
                    let bytes =
                        std::fs::read(workspace_root.join(relative)).unwrap_or_default();
                    image.thumb = make_thumb(&bytes, &image.mime, READ_THUMB_WIDTH);
                    image.path = Some(relative.clone());
                }
                continue;
            }
        };
        let bytes = BASE64.decode(&data).unwrap_or_default();
        let thumb_width = if workspace_path.is_some() {
            READ_THUMB_WIDTH
        } else {
            OUTPUT_THUMB_WIDTH
        };
        image.thumb = make_thumb(&bytes, &image.mime, thumb_width);
        if let Some(relative) = workspace_path {
            image.path = Some(relative);
            continue;
        }
        image.path = None;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            image.alt = format!("{} [image omitted: too large]", image.alt);
            image.thumb = None;
            continue;
        }
        puts.push(ImageBlobPut {
            item_id: format!("{item_id}:img:{index}"),
            value: json!({
                "mime": image.mime,
                "dataBase64": data,
            }),
        });
    }
    puts
}

/// Best-effort mime for a path-only image reference, by extension.
pub fn mime_from_path(path: &str) -> String {
    match Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Decodes, downscales to `target_width` keeping aspect, re-encodes as JPEG.
/// `None` for undecodable input — SVG included, which the frontend renders
/// from the original vector source instead of a raster thumbnail.
pub fn make_thumb(bytes: &[u8], mime: &str, target_width: u32) -> Option<ImageThumb> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES || mime == "image/svg+xml" {
        return None;
    }
    let decoded = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    let (width, height) = (decoded.width(), decoded.height());
    if width == 0 || height == 0 {
        return None;
    }
    let scaled = if width > target_width {
        decoded.resize(target_width, u32::MAX, FilterType::Lanczos3)
    } else {
        decoded
    };
    let mut out = std::io::Cursor::new(Vec::new());
    scaled
        .to_rgb8()
        .write_to(&mut out, image::ImageFormat::Jpeg)
        .ok()?;
    Some(ImageThumb {
        mime: "image/jpeg".into(),
        data_base64: BASE64.encode(out.into_inner()),
        width,
        height,
    })
}

/// Maps a tool-input path onto a workspace-relative one. Relative paths
/// resolve against the session cwd; anything that escapes the workspace root
/// is not a preview target.
fn workspace_relative(path: &str, cwd: &Path, workspace_root: &Path) -> Option<String> {
    let raw = Path::new(path);
    let absolute: PathBuf = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        cwd.join(raw)
    };
    let relative = absolute.strip_prefix(workspace_root).ok()?;
    if relative
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(relative.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(width, height)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn thumbnail_keeps_aspect_and_reports_original_size() {
        let bytes = png_bytes(800, 400);
        let thumb = make_thumb(&bytes, "image/png", READ_THUMB_WIDTH).unwrap();
        assert_eq!(thumb.mime, "image/jpeg");
        assert_eq!((thumb.width, thumb.height), (800, 400));
        let decoded = ImageReader::new(std::io::Cursor::new(BASE64.decode(&thumb.data_base64).unwrap()))
            .with_guessed_format()
            .unwrap()
            .decode()
            .unwrap();
        assert_eq!(decoded.width(), READ_THUMB_WIDTH);
        assert_eq!(decoded.height(), READ_THUMB_WIDTH / 2);
    }

    #[test]
    fn svg_and_garbage_get_no_thumbnail() {
        assert!(make_thumb(b"<svg xmlns='x'/>", "image/svg+xml", 64).is_none());
        assert!(make_thumb(b"not an image", "image/png", 64).is_none());
        assert!(make_thumb(&[], "image/png", 64).is_none());
    }

    #[test]
    fn read_images_shed_to_a_workspace_path_without_a_blob() {
        let bytes = png_bytes(100, 100);
        let mut images = vec![ToolImage {
            alt: "Read: assets/logo.png".into(),
            mime: "image/png".into(),
            data_base64: Some(BASE64.encode(&bytes)),
            thumb: None,
            path: Some("assets/logo.png".into()),
        }];
        let puts = shed_tool_images(
            "t1",
            &mut images,
            Path::new("/repo"),
            Path::new("/repo"),
        );
        assert!(puts.is_empty());
        assert_eq!(images[0].path.as_deref(), Some("assets/logo.png"));
        assert!(images[0].data_base64.is_none());
        assert!(images[0].thumb.is_some());
    }

    #[test]
    fn produced_images_move_to_the_blob_layer() {
        let bytes = png_bytes(100, 100);
        let mut images = vec![ToolImage {
            alt: "generate_image".into(),
            mime: "image/png".into(),
            data_base64: Some(BASE64.encode(&bytes)),
            thumb: None,
            path: None,
        }];
        let puts = shed_tool_images("t1", &mut images, Path::new("/repo"), Path::new("/repo"));
        assert_eq!(puts.len(), 1);
        assert_eq!(puts[0].item_id, "t1:img:0");
        assert_eq!(puts[0].value["mime"], "image/png");
        assert!(images[0].data_base64.is_none());
        assert!(images[0].path.is_none());
        assert!(images[0].thumb.is_some());
    }

    #[test]
    fn paths_outside_the_workspace_become_blobs() {
        let bytes = png_bytes(10, 10);
        let mut images = vec![ToolImage {
            alt: "Read: /etc/secret.png".into(),
            mime: "image/png".into(),
            data_base64: Some(BASE64.encode(&bytes)),
            thumb: None,
            path: Some("/etc/secret.png".into()),
        }];
        let puts = shed_tool_images("t1", &mut images, Path::new("/repo"), Path::new("/repo"));
        assert_eq!(puts.len(), 1);
        assert!(images[0].path.is_none());
    }

    #[test]
    fn oversized_images_collapse_to_a_placeholder() {
        let mut images = vec![ToolImage {
            alt: "huge".into(),
            mime: "image/png".into(),
            data_base64: Some(BASE64.encode(vec![0u8; MAX_IMAGE_BYTES + 1])),
            thumb: None,
            path: None,
        }];
        let puts = shed_tool_images("t1", &mut images, Path::new("/repo"), Path::new("/repo"));
        assert!(puts.is_empty());
        assert!(images[0].alt.contains("too large"));
        assert!(images[0].thumb.is_none());
    }

    #[test]
    fn path_only_images_read_the_workspace_file_for_a_thumbnail() {
        let dir = std::env::temp_dir().join(format!("genet-images-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("assets/pic.png"), png_bytes(200, 100)).unwrap();
        let mut images = vec![ToolImage {
            alt: "imageView".into(),
            mime: "image/png".into(),
            data_base64: None,
            thumb: None,
            path: Some("assets/pic.png".into()),
        }];
        let puts = shed_tool_images("t1", &mut images, &dir, &dir);
        assert!(puts.is_empty());
        assert_eq!(images[0].path.as_deref(), Some("assets/pic.png"));
        let thumb = images[0].thumb.as_ref().expect("workspace file thumbnailed");
        assert_eq!((thumb.width, thumb.height), (200, 100));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn workspace_relative_resolution() {
        let root = Path::new("/repo");
        let cwd = Path::new("/repo/sub");
        assert_eq!(
            workspace_relative("a/b.png", cwd, root).as_deref(),
            Some("sub/a/b.png")
        );
        assert_eq!(
            workspace_relative("/repo/a.png", cwd, root).as_deref(),
            Some("a.png")
        );
        assert_eq!(workspace_relative("/elsewhere/a.png", cwd, root), None);
        assert_eq!(workspace_relative("../../a.png", cwd, root), None);
    }
}
