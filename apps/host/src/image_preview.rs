//! Bounded image work outside the single guest fiber. A poll never waits for
//! the decoder; dropping a job releases its result, while the worker finishes
//! under the same global two-job limit.

use std::io::Cursor;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};

use image::imageops::FilterType;
use image::{ImageDecoder, ImageReader};
use wasmtime::component::Resource;

use crate::bindings::genehub::host::image_preview as wit;

const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_PIXELS: u64 = 40_000_000;
const MAX_OUTPUT_BYTES: usize = 12 * 1024 * 1024;
const MAX_JOBS: usize = 2;
static ACTIVE: AtomicUsize = AtomicUsize::new(0);

pub struct Job {
    receiver: Receiver<Result<wit::ImageResult, String>>,
}

struct JobPermit;

impl Drop for JobPermit {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::AcqRel);
    }
}

fn reserve() -> Result<JobPermit, String> {
    ACTIVE
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
            (active < MAX_JOBS).then_some(active + 1)
        })
        .map_err(|_| "image workers are busy".to_string())?;
    Ok(JobPermit)
}

fn resize(bytes: &[u8], edge: u16) -> Result<wit::ImageResult, String> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES || !matches!(edge, 128 | 1024) {
        return Err("image input exceeds the preview budget".into());
    }
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "unsupported image".to_string())?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "cannot read image dimensions".to_string())?;
    if width == 0 || height == 0 || (width as u64) * (height as u64) > MAX_PIXELS {
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
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err("preview image exceeds the output budget".into());
    }
    Ok(wit::ImageResult {
        bytes,
        media_type: media_type.into(),
        width: scaled.width(),
        height: scaled.height(),
    })
}

impl wit::HostJob for crate::load::Host {
    async fn poll(&mut self, this: Resource<Job>) -> Result<Option<wit::ImageResult>, String> {
        let job = self.table.get(&this).map_err(|error| error.to_string())?;
        match job.receiver.try_recv() {
            Ok(result) => result.map(Some),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err("image worker stopped".into()),
        }
    }

    async fn drop(&mut self, this: Resource<Job>) -> wasmtime::Result<()> {
        let _ = self.table.delete(this);
        Ok(())
    }
}

impl wit::Host for crate::load::Host {
    async fn resize(&mut self, bytes: Vec<u8>, edge: u16) -> Result<Resource<Job>, String> {
        if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES || !matches!(edge, 128 | 1024) {
            return Err("image input exceeds the preview budget".into());
        }
        let permit = reserve()?;
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("genehub-image-preview".into())
            .spawn(move || {
                let _permit = permit;
                let _ = sender.send(resize(&bytes, edge));
            })
            .map_err(|error| error.to_string())?;
        self.table
            .push(Job { receiver })
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jpeg_preview_applies_exif_orientation() {
        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(4, 2)
            .write_to(&mut encoded, image::ImageFormat::Jpeg)
            .unwrap();
        let original = encoded.into_inner();
        // APP1 Exif with little-endian TIFF orientation 6 (rotate 90°).
        let exif = [
            0xff, 0xe1, 0x00, 0x22, b'E', b'x', b'i', b'f', 0, 0, b'I', b'I', 0x2a, 0, 8, 0, 0, 0,
            1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
        ];
        let mut with_exif = Vec::with_capacity(original.len() + exif.len());
        with_exif.extend_from_slice(&original[..2]);
        with_exif.extend_from_slice(&exif);
        with_exif.extend_from_slice(&original[2..]);

        let shown = resize(&with_exif, 128).unwrap();
        assert_eq!((shown.width, shown.height), (2, 4));
    }
}
