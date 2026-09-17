//! Resolve explicit user media into provider data URLs. Files are read only
//! when a configured model accepts that medium, and only inside this workspace.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::config::ModelConfig;
use crate::protocol::MediaAttachment;

const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES: usize = 64 * 1024 * 1024;

pub fn data_url(
    model: &ModelConfig,
    cwd: &Path,
    attachment: &MediaAttachment,
) -> Result<(&'static str, String)> {
    let mime = attachment.mime.to_ascii_lowercase();
    let kind = kind(attachment)?;
    if !model.input_modalities.iter().any(|input| input == kind) {
        bail!(
            "模型 {}/{} 未配置 {} 输入能力",
            model.provider,
            model.id,
            kind
        );
    }
    let limit = if kind == "image" {
        MAX_IMAGE_BYTES
    } else {
        MAX_VIDEO_BYTES
    };
    let encoded = match (&attachment.path, &attachment.data_base64) {
        (Some(_), Some(_)) | (None, None) => {
            bail!("{} 必须且只能提供文件路径或内联内容", attachment.name)
        }
        (Some(path), None) => {
            let relative = Path::new(path);
            if relative.is_absolute() {
                bail!("{} 的附件路径必须在当前工作区内", attachment.name);
            }
            let root = cwd.canonicalize().context("读取工作区路径")?;
            let file = root
                .join(relative)
                .canonicalize()
                .with_context(|| format!("读取附件 {}", attachment.name))?;
            if !file.starts_with(&root) || !file.is_file() {
                bail!("{} 的附件路径不在当前工作区内", attachment.name);
            }
            let size = file.metadata()?.len();
            if size > limit as u64 {
                bail!("{} 超过 {}MB 的上限", attachment.name, limit / 1024 / 1024);
            }
            STANDARD.encode(
                std::fs::read(&file).with_context(|| format!("读取附件 {}", attachment.name))?,
            )
        }
        (None, Some(encoded)) => {
            if encoded.len() > limit.div_ceil(3) * 4 + 4 {
                bail!("{} 超过 {}MB 的上限", attachment.name, limit / 1024 / 1024);
            }
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| anyhow!("{} 不是有效的 base64 附件", attachment.name))?;
            if bytes.len() > limit {
                bail!("{} 超过 {}MB 的上限", attachment.name, limit / 1024 / 1024);
            }
            encoded.clone()
        }
    };
    Ok((kind, format!("data:{mime};base64,{encoded}")))
}

pub fn kind(attachment: &MediaAttachment) -> Result<&'static str> {
    match attachment.mime.to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/png" | "image/webp" | "image/gif" => Ok("image"),
        "video/mp4" | "video/webm" | "video/quicktime" | "video/mpeg" | "video/x-msvideo" => {
            Ok("video")
        }
        _ => bail!(
            "{} 的媒体类型 {} 尚不支持",
            attachment.name,
            attachment.mime
        ),
    }
}

pub fn historical_note(attachment: &MediaAttachment, kind: &str) -> String {
    format!(
        "历史附件「{}」（{}）无法由当前模型读取。",
        attachment.name,
        if kind == "image" { "图片" } else { "视频" }
    )
}
