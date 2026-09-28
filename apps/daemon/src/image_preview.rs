//! Image resize dispatch. Native tests use their blocking pool; production
//! WASM delegates CPU work to the shell and polls without parking the guest.

use std::time::Duration;

pub struct ImageResult {
    pub bytes: Vec<u8>,
    pub media_type: String,
    pub width: u32,
    pub height: u32,
}

pub async fn resize(bytes: Vec<u8>, edge: u16) -> Result<ImageResult, String> {
    #[cfg(target_family = "wasm")]
    {
        let result =
            genet_wasi::image_preview::resize(bytes, edge, Duration::from_secs(15)).await?;
        Ok(ImageResult {
            bytes: result.bytes,
            media_type: result.media_type,
            width: result.width,
            height: result.height,
        })
    }
    #[cfg(not(target_family = "wasm"))]
    {
        let task = crate::blocking::run(move || resize_native(&bytes, edge));
        tokio::time::timeout(Duration::from_secs(15), task)
            .await
            .map_err(|_| "image preview timed out".to_string())?
            .map_err(|error| error.to_string())?
    }
}

#[cfg(not(target_family = "wasm"))]
fn resize_native(bytes: &[u8], edge: u16) -> Result<ImageResult, String> {
    use image::imageops::FilterType;
    use image::{ImageDecoder, ImageReader};
    use std::io::Cursor;

    if bytes.is_empty() || bytes.len() > 64 * 1024 * 1024 || !matches!(edge, 128 | 1024) {
        return Err("image input exceeds the preview budget".into());
    }
    let (width, height) = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "unsupported image".to_string())?
        .into_dimensions()
        .map_err(|_| "cannot read image dimensions".to_string())?;
    if width == 0 || height == 0 || (width as u64) * (height as u64) > 40_000_000 {
        return Err("image dimensions exceed the preview budget".into());
    }
    let orientation = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "unsupported image".to_string())?
        .into_decoder()
        .and_then(|mut decoder| decoder.orientation())
        .map_err(|_| "cannot read image orientation".to_string())?;
    let mut decode_reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "unsupported image".to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(32_768);
    limits.max_image_height = Some(32_768);
    limits.max_alloc = Some(256 * 1024 * 1024);
    decode_reader.limits(limits);
    let mut decoded = decode_reader
        .decode()
        .map_err(|_| "cannot decode image".to_string())?;
    decoded.apply_orientation(orientation);
    let scaled = if width.max(height) > u32::from(edge) {
        decoded.resize(u32::from(edge), u32::from(edge), FilterType::Triangle)
    } else {
        decoded
    };
    let has_alpha = scaled.color().has_alpha();
    let media_type = if has_alpha { "image/png" } else { "image/jpeg" };
    let mut output = Cursor::new(Vec::new());
    scaled
        .write_to(
            &mut output,
            if has_alpha {
                image::ImageFormat::Png
            } else {
                image::ImageFormat::Jpeg
            },
        )
        .map_err(|_| "cannot encode preview image".to_string())?;
    let bytes = output.into_inner();
    if bytes.len() > 12 * 1024 * 1024 {
        return Err("preview image exceeds the output budget".into());
    }
    Ok(ImageResult {
        bytes,
        media_type: media_type.into(),
        width: scaled.width(),
        height: scaled.height(),
    })
}
