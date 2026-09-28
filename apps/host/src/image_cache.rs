//! Private, content-addressed cache for encoded image previews. This runs in
//! native workers; neither directory walks nor eviction occupy the guest fiber.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use sha2::{Digest, Sha256};

use crate::bindings::genehub::host::image_preview::ImageResult;

const CACHE_VERSION: &str = "image-preview-v1";
const CACHE_MAGIC: &[u8; 8] = b"GHIMG001";
const HEADER_BYTES: usize = 8 + 1 + 4 + 4 + 8 + 32;
const DISK_CACHE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 12 * 1024 * 1024;
static CACHE_DIRECTORY: OnceLock<Option<PathBuf>> = OnceLock::new();

pub fn get_or_resize(
    source: &[u8],
    edge: u16,
    resize: impl FnOnce() -> Result<ImageResult, String>,
) -> Result<ImageResult, String> {
    let cache = cache_directory();
    get_or_resize_in(cache.as_deref(), source, edge, resize)
}

fn get_or_resize_in(
    cache: Option<&Path>,
    source: &[u8],
    edge: u16,
    resize: impl FnOnce() -> Result<ImageResult, String>,
) -> Result<ImageResult, String> {
    let key = cache_key(source, edge);
    if let Some(directory) = cache {
        if let Some(result) = read_entry(&directory.join(&key), edge) {
            return Ok(result);
        }
    }
    let result = resize()?;
    if let Some(directory) = cache {
        let _ = store_entry(&directory, &key, edge, &result, DISK_CACHE_BYTES);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn small_png() -> ImageResult {
        let mut output = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(4, 2)
            .write_to(&mut output, image::ImageFormat::Png)
            .unwrap();
        ImageResult {
            bytes: output.into_inner(),
            media_type: "image/png".into(),
            width: 4,
            height: 2,
        }
    }

    #[test]
    fn disk_hit_survives_result_drop_and_corruption_regenerates() {
        let directory = tempfile::tempdir().unwrap();
        let source = b"source-v1";
        let first =
            get_or_resize_in(Some(directory.path()), source, 128, || Ok(small_png())).unwrap();
        drop(first);
        let hit = get_or_resize_in(Some(directory.path()), source, 128, || {
            panic!("a disk hit must not decode again")
        })
        .unwrap();
        assert_eq!((hit.width, hit.height), (4, 2));
        fs::write(directory.path().join(cache_key(source, 128)), b"truncated").unwrap();
        let repaired =
            get_or_resize_in(Some(directory.path()), source, 128, || Ok(small_png())).unwrap();
        assert_eq!(hit.bytes, repaired.bytes);
        assert!(read_entry(&directory.path().join(cache_key(source, 128)), 128).is_some());
    }

    #[test]
    fn disk_budget_evicts_old_content_versions() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join(format!("{}ébin", "a".repeat(63))),
            b"unrelated",
        )
        .unwrap();
        let result = small_png();
        let budget = (HEADER_BYTES + result.bytes.len()) as u64;
        let first = cache_key(b"before", 128);
        let second = cache_key(b"after", 128);
        store_entry(directory.path(), &first, 128, &result, budget).unwrap();
        store_entry(directory.path(), &second, 128, &result, budget).unwrap();
        assert!(read_entry(&directory.path().join(&first), 128).is_none());
        assert!(read_entry(&directory.path().join(&second), 128).is_some());
    }
}

fn cache_directory() -> Option<PathBuf> {
    CACHE_DIRECTORY.get_or_init(prepare_cache_directory).clone()
}

fn prepare_cache_directory() -> Option<PathBuf> {
    let root = genet_frontdoor::paths::Paths::discover().ok()?.root;
    let cache = root.join("cache");
    let directory = cache.join(CACHE_VERSION);
    for path in [&root, &cache, &directory] {
        genet_frontdoor::perms::ensure_real_directory(path).ok()?;
        genet_frontdoor::perms::restrict_dir_to_owner(path).ok()?;
    }
    let lock = lock_cache(&directory).ok()?;
    let _ = prune_to_fit(&directory, DISK_CACHE_BYTES);
    let _ = lock.unlock();
    Some(directory)
}

fn cache_key(source: &[u8], edge: u16) -> String {
    let mut hash = Sha256::new();
    hash.update(CACHE_VERSION.as_bytes());
    hash.update(edge.to_le_bytes());
    hash.update(source);
    format!("{:x}.bin", hash.finalize())
}

fn read_entry(path: &Path, edge: u16) -> Option<ImageResult> {
    let metadata = genet_frontdoor::perms::sensitive_metadata(path).ok()?;
    genet_frontdoor::perms::reject_link_or_reparse(path, &metadata).ok()?;
    if !metadata.is_file()
        || metadata.len() < HEADER_BYTES as u64
        || metadata.len() > (HEADER_BYTES + MAX_OUTPUT_BYTES) as u64
    {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .ok()?
        .take((HEADER_BYTES + MAX_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() != metadata.len() as usize || &bytes[..8] != CACHE_MAGIC {
        return None;
    }
    let media_type = match bytes[8] {
        1 => "image/png",
        2 => "image/jpeg",
        _ => return None,
    };
    let width = u32::from_le_bytes(bytes[9..13].try_into().ok()?);
    let height = u32::from_le_bytes(bytes[13..17].try_into().ok()?);
    let size = u64::from_le_bytes(bytes[17..25].try_into().ok()?);
    if width == 0
        || height == 0
        || width.max(height) > u32::from(edge)
        || size == 0
        || size > MAX_OUTPUT_BYTES as u64
        || size as usize != bytes.len() - HEADER_BYTES
    {
        return None;
    }
    let payload = &bytes[HEADER_BYTES..];
    if Sha256::digest(payload).as_slice() != &bytes[25..57] {
        return None;
    }
    let format = image::guess_format(payload).ok()?;
    if !matches!(
        (format, media_type),
        (image::ImageFormat::Png, "image/png") | (image::ImageFormat::Jpeg, "image/jpeg")
    ) {
        return None;
    }
    let dimensions = image::ImageReader::new(std::io::Cursor::new(payload))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()?;
    if dimensions != (width, height) {
        return None;
    }
    Some(ImageResult {
        bytes: payload.to_vec(),
        media_type: media_type.into(),
        width,
        height,
    })
}

fn store_entry(
    directory: &Path,
    key: &str,
    edge: u16,
    result: &ImageResult,
    limit: u64,
) -> std::io::Result<()> {
    let destination = directory.join(key);
    let media_code = match result.media_type.as_str() {
        "image/png" => 1u8,
        "image/jpeg" => 2u8,
        _ => return Ok(()),
    };
    if result.bytes.is_empty() || result.bytes.len() > MAX_OUTPUT_BYTES {
        return Ok(());
    }
    let lock = lock_cache(directory)?;
    let outcome = (|| {
        if read_entry(&destination, edge).is_some() {
            return Ok(());
        }
        if destination.exists() {
            fs::remove_file(&destination)?;
        }
        prune_to_fit(
            directory,
            limit.saturating_sub((HEADER_BYTES + result.bytes.len()) as u64),
        )?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".preview-tmp-")
            .tempfile_in(directory)?;
        genet_frontdoor::perms::restrict_to_owner(temporary.path())
            .map_err(std::io::Error::other)?;
        temporary.write_all(CACHE_MAGIC)?;
        temporary.write_all(&[media_code])?;
        temporary.write_all(&result.width.to_le_bytes())?;
        temporary.write_all(&result.height.to_le_bytes())?;
        temporary.write_all(&(result.bytes.len() as u64).to_le_bytes())?;
        temporary.write_all(&Sha256::digest(&result.bytes))?;
        temporary.write_all(&result.bytes)?;
        temporary.flush()?;
        temporary
            .persist_noclobber(&destination)
            .map_err(|error| error.error)?;
        Ok(())
    })();
    let _ = lock.unlock();
    outcome
}

fn lock_cache(directory: &Path) -> std::io::Result<File> {
    let path = directory.join("cache.lock");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&path)?;
    genet_frontdoor::perms::restrict_to_owner(&path).map_err(std::io::Error::other)?;
    lock.lock_exclusive()?;
    Ok(lock)
}

fn prune_to_fit(directory: &Path, target_bytes: u64) -> std::io::Result<()> {
    let mut entries = Vec::new();
    let mut total = 0u64;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".preview-tmp-") {
            let metadata = genet_frontdoor::perms::sensitive_metadata(&entry.path())?;
            if metadata.is_file()
                && metadata
                    .modified()
                    .ok()
                    .and_then(|time| SystemTime::now().duration_since(time).ok())
                    .is_some_and(|age| age > Duration::from_secs(3600))
            {
                let _ = fs::remove_file(entry.path());
            }
            continue;
        }
        let name_bytes = name.as_bytes();
        if name_bytes.len() != 68
            || &name_bytes[64..] != b".bin"
            || !name_bytes[..64].iter().all(u8::is_ascii_hexdigit)
        {
            continue;
        }
        let metadata = genet_frontdoor::perms::sensitive_metadata(&entry.path())?;
        if !metadata.is_file() {
            continue;
        }
        total = total.saturating_add(metadata.len());
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        entries.push((modified, entry.path(), metadata.len()));
    }
    entries.sort_by_key(|(modified, _, _)| *modified);
    for (_, path, size) in entries {
        if total <= target_bytes {
            break;
        }
        fs::remove_file(path)?;
        total = total.saturating_sub(size);
    }
    if total > target_bytes {
        return Err(std::io::Error::other("image cache could not be pruned"));
    }
    Ok(())
}
