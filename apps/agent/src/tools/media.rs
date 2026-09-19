//! On-demand media reading. The tool only validates and registers the file;
//! the agent loop then injects it as a user-message attachment, so the bytes
//! reach the model through the same provider pipeline as a chat upload. Tool
//! results themselves stay text-only — no provider accepts video in one.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use base64::{engine::general_purpose::STANDARD, Engine as _};

use super::{arg_str, resolve_path, ToolResult};
use crate::protocol::MediaAttachment;
use crate::provider::media;

pub const NAME: &str = "read_media";

/// Details key the agent loop looks for when collecting attachments to inject.
pub const ATTACHMENT_DETAIL: &str = "mediaAttachment";

pub fn definition() -> Value {
    json!({
        "name": NAME,
        "description": "Read an image or video file so you can see its content. Supported: jpg/jpeg/png/webp/gif up to 8MB, mp4/webm/mov/mpg/mpeg/avi up to 64MB. Files inside the workspace are attached by reference, anything else you can read is attached inline; the media becomes visible to you on the next model call. Use `read` for text files.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the image or video file (relative or absolute)" }
            },
            "required": ["path"]
        }
    })
}

fn mime_for(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mov" => Some("video/quicktime"),
        "mpg" | "mpeg" => Some("video/mpeg"),
        "avi" => Some("video/x-msvideo"),
        _ => None,
    }
}

/// The provider encodes attachments against this root (see `stream_assistant`),
/// so validation here must confine to the same root or the later encode fails.
fn encode_root(cwd: &Path) -> PathBuf {
    std::env::var_os("GENET_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.to_path_buf())
}

/// Validates the file and returns the attachment for the agent loop to inject.
/// Files inside the provider's encode root are attached by reference and read
/// when the next request is built, exactly like a chat upload. Files outside
/// it are read here and attached inline — `read` and `bash` impose no
/// workspace boundary either, so confining the agent's own media reads to one
/// would only break legitimate paths (e.g. evidence-scope material living
/// outside the AgentSpace root). The evidence-only boundary is enforced in
/// `tools::execute` before this runs, the same as for `read`.
pub fn read(args: &Value, cwd: &Path) -> ToolResult {
    let Some(raw_path) = arg_str(args, "path") else {
        return ToolResult::error("read_media: 'path' is required");
    };
    let file = match resolve_path(cwd, &raw_path).canonicalize() {
        Ok(file) => file,
        Err(error) => {
            return ToolResult::error(format!("read_media: 读取 {raw_path} 失败：{error}"));
        }
    };
    if !file.is_file() {
        return ToolResult::error(format!("read_media: {raw_path} 不是文件"));
    }
    let Some(mime) = mime_for(&file) else {
        return ToolResult::error(format!(
            "read_media: {raw_path} 不是支持的图片或视频格式（jpg/jpeg/png/webp/gif/mp4/webm/mov/mpg/mpeg/avi）"
        ));
    };
    let name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| raw_path.clone());
    let probe = MediaAttachment {
        name: name.clone(),
        mime: mime.into(),
        path: None,
        data_base64: None,
    };
    let kind = match media::kind(&probe) {
        Ok(kind) => kind,
        Err(error) => return ToolResult::error(format!("read_media: {error:#}")),
    };
    let limit = if kind == "image" {
        media::MAX_IMAGE_BYTES
    } else {
        media::MAX_VIDEO_BYTES
    };
    // Size gate comes before any byte read, so an oversized file is cheap to
    // reject even when it would be attached inline.
    let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if size > limit as u64 {
        return ToolResult::error(format!(
            "read_media: {} 超过 {}MB 的上限",
            name,
            limit / 1024 / 1024
        ));
    }
    // A path the provider can re-read is cheaper than carrying bytes in the
    // session history; anything else still works, inlined.
    let attachment = match encode_root(cwd)
        .canonicalize()
        .ok()
        .and_then(|root| file.strip_prefix(&root).ok().map(Path::to_path_buf))
        .and_then(|relative| relative.to_str().map(str::to_string))
    {
        Some(relative) => MediaAttachment {
            path: Some(relative),
            ..probe
        },
        None => {
            let bytes = match std::fs::read(&file) {
                Ok(bytes) => bytes,
                Err(error) => {
                    return ToolResult::error(format!("read_media: 读取 {raw_path} 失败：{error}"));
                }
            };
            MediaAttachment {
                data_base64: Some(STANDARD.encode(bytes)),
                ..probe
            }
        }
    };
    ToolResult::ok(format!(
        "已附加 {}（{}，{:.1}MB）。它将作为消息附件随下一次模型调用送入，届时你可以直接看到其内容。",
        attachment.name,
        if kind == "image" { "图片" } else { "视频" },
        size as f64 / 1024.0 / 1024.0,
    ))
    .with_details(json!({ ATTACHMENT_DETAIL: attachment, "mediaKind": kind }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("genet-media-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn attachment_of(result: &ToolResult) -> MediaAttachment {
        let details = result.details.as_ref().expect("success carries details");
        serde_json::from_value(details[ATTACHMENT_DETAIL].clone()).expect("attachment parses")
    }

    #[test]
    fn a_workspace_video_registers_a_relative_attachment() {
        let dir = temp_dir("video");
        std::fs::write(dir.join("clip.webm"), b"webm-bytes").unwrap();

        let result = read(&json!({"path": "clip.webm"}), &dir);

        assert!(!result.is_error, "{}", result.text);
        let attachment = attachment_of(&result);
        assert_eq!(attachment.name, "clip.webm");
        assert_eq!(attachment.mime, "video/webm");
        assert_eq!(attachment.path.as_deref(), Some("clip.webm"));
        assert!(attachment.data_base64.is_none());
    }

    #[test]
    fn an_absolute_path_inside_the_workspace_is_stored_relative() {
        let dir = temp_dir("absolute");
        std::fs::create_dir_all(dir.join("recordings")).unwrap();
        std::fs::write(dir.join("recordings/wave.mp4"), b"mp4-bytes").unwrap();
        let absolute = dir.join("recordings/wave.mp4").display().to_string();

        let result = read(&json!({"path": absolute}), &dir);

        assert!(!result.is_error, "{}", result.text);
        assert_eq!(
            attachment_of(&result).path.as_deref(),
            Some("recordings/wave.mp4")
        );
    }

    #[test]
    fn files_outside_the_workspace_attach_inline() {
        let dir = temp_dir("escape");
        let outside =
            std::env::temp_dir().join(format!("genet-media-outside-{}.webm", uuid::Uuid::new_v4()));
        std::fs::write(&outside, b"webm-bytes").unwrap();
        let escape = format!("../{}", outside.file_name().unwrap().to_string_lossy());

        let result = read(&json!({"path": escape}), &dir);

        assert!(!result.is_error, "{}", result.text);
        let attachment = attachment_of(&result);
        assert!(attachment.path.is_none());
        assert_eq!(
            attachment.data_base64.as_deref(),
            Some(STANDARD.encode(b"webm-bytes")).as_deref()
        );
        std::fs::remove_file(&outside).unwrap();
    }

    #[test]
    fn oversized_files_outside_the_workspace_are_rejected_before_reading() {
        let dir = temp_dir("limit-outside");
        let outside =
            std::env::temp_dir().join(format!("genet-media-big-{}.png", uuid::Uuid::new_v4()));
        std::fs::File::create(&outside)
            .unwrap()
            .set_len(media::MAX_IMAGE_BYTES as u64 + 1)
            .unwrap();

        let result = read(&json!({"path": outside.display().to_string()}), &dir);

        assert!(result.is_error);
        assert!(result.text.contains("超过 8MB 的上限"), "{}", result.text);
        std::fs::remove_file(&outside).unwrap();
    }

    #[test]
    fn missing_files_and_text_files_are_rejected() {
        let dir = temp_dir("rejected");
        std::fs::write(dir.join("notes.txt"), b"hello").unwrap();

        let missing = read(&json!({"path": "gone.mp4"}), &dir);
        assert!(missing.is_error);
        assert!(missing.text.contains("读取"), "{}", missing.text);

        let text = read(&json!({"path": "notes.txt"}), &dir);
        assert!(text.is_error);
        assert!(
            text.text.contains("不是支持的图片或视频格式"),
            "{}",
            text.text
        );
    }

    #[test]
    fn files_over_the_size_limit_are_rejected_before_any_read() {
        let dir = temp_dir("limit");
        let oversized = dir.join("big.png");
        std::fs::File::create(&oversized)
            .unwrap()
            .set_len(media::MAX_IMAGE_BYTES as u64 + 1)
            .unwrap();

        let result = read(&json!({"path": "big.png"}), &dir);

        assert!(result.is_error);
        assert!(result.text.contains("超过 8MB 的上限"), "{}", result.text);
    }
}
