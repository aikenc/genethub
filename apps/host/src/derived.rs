//! Derived (precompiled) component artifacts per §5.1.6.
//!
//! After a signed component is verified, the update flow precompiles it and
//! atomically persists the result. Later loads — the in-place reload that
//! follows, and every cold start after that — deserialize the derived image
//! instead of recompiling from Wasm bytes.
//!
//! The signature chain is not bypassed: the trust anchor moved from "every
//! load" to "the moment of derivation". Loading a derived artifact does not
//! re-verify the publisher signature; it checks that the artifact was derived
//! from exactly the Wasm bytes that did verify (digest match), that the local
//! engine can still run it (invalidation key), and that the file itself is
//! intact (SHA-256). Anything short of all three is fail-closed: delete the
//! artifact and recompile from the verified bytes.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use wasmtime::component::Component;
use wasmtime::Engine;

use crate::channel;

/// Metadata sidecar for one derived artifact. Serialized as JSON next to the
/// `.cwasm` it describes.
#[derive(Serialize, Deserialize)]
struct DerivedMeta {
    /// SHA-256 of the exact Wasm bytes the artifact was derived from. This is
    /// the link back to the verified input: a derived artifact is only ever
    /// consulted for bytes whose digest matches.
    wasm_sha256: String,
    /// Engine-side invalidation key. Wasmtime's own header rejects version or
    /// configuration drift at deserialize time, but CPU/ISA features have no
    /// such backstop (§5.1.6: an AVX2 artifact loads fine on a non-AVX2 engine
    /// and then dies on an illegal instruction). This key closes that gap.
    engine_key: String,
    /// SHA-256 of the `.cwasm` file itself, recorded at write time. Catches
    /// non-adversarial corruption (bit rot, interrupted write, sync damage).
    artifact_sha256: String,
}

/// Try to load a precompiled component for these exact Wasm bytes.
///
/// Returns `None` on any mismatch, corruption, or IO failure — and deletes
/// the offending artifact so the next start does not walk the same failure
/// path again. The caller falls back to a full compile.
pub fn try_load(engine: &Engine, wasm_bytes: &[u8]) -> Option<Component> {
    match try_load_inner(engine, wasm_bytes) {
        Ok(component) => component,
        Err(error) => {
            crate::load::debug_log(&format!("derived artifact unusable: {error:#}"));
            None
        }
    }
}

fn try_load_inner(engine: &Engine, wasm_bytes: &[u8]) -> Result<Option<Component>> {
    let wasm_digest = sha256_hex(wasm_bytes);
    let dir = derived_dir()?;
    let meta_path = dir.join(format!("{wasm_digest}.json"));
    let cwasm_path = dir.join(format!("{wasm_digest}.cwasm"));

    let meta_bytes = match fs::read(&meta_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let meta: DerivedMeta = serde_json::from_slice(&meta_bytes).context("parsing derived meta")?;

    if meta.wasm_sha256 != wasm_digest {
        // The file was written for different bytes. This should not happen
        // (the name is the digest), but a collision or a rename is not our
        // problem to debug — discard and recompile.
        discard(&meta_path, &cwasm_path);
        return Ok(None);
    }
    if meta.engine_key != engine_key() {
        discard(&meta_path, &cwasm_path);
        return Ok(None);
    }

    let cwasm = match fs::read(&cwasm_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            discard(&meta_path, &cwasm_path);
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    if sha256_hex(&cwasm) != meta.artifact_sha256 {
        discard(&meta_path, &cwasm_path);
        return Ok(None);
    }

    // Safety: the bytes came from `Engine::precompile_component` on this
    // machine (digest-matched to the verified Wasm), the engine key pinned
    // the CPU feature set, and Wasmtime's own header rejects version or
    // configuration drift. `deserialize` — never `deserialize_file`: the
    // bytes are in memory and cannot change under us (§5.1.6).
    match unsafe { Component::deserialize(engine, &cwasm) } {
        Ok(component) => Ok(Some(component)),
        Err(error) => {
            crate::load::debug_log(&format!("derived artifact deserialize failed: {error:#}"));
            discard(&meta_path, &cwasm_path);
            Ok(None)
        }
    }
}

/// Precompile these (already verified) Wasm bytes and atomically persist the
/// derived artifact. Called from the update flow after signature verification
/// and before the reload that will load it — the user is already waiting
/// (§5.1.6).
///
/// Failures are logged by the caller and never block the update: a missing
/// artifact is the status quo, not an error.
pub fn derive_and_store(engine: &Engine, wasm_bytes: &[u8]) -> Result<()> {
    let precompiled = engine
        .precompile_component(wasm_bytes)
        .map_err(anyhow::Error::from)
        .context("precompile_component")?;
    store_precompiled(wasm_bytes, &precompiled)
}

/// Persist an already-compiled artifact. The caller compiled the Wasm bytes
/// and owns the result — this function only handles the atomic write and
/// metadata sidecar.
pub fn store_precompiled(wasm_bytes: &[u8], precompiled: &[u8]) -> Result<()> {
    let wasm_digest = sha256_hex(wasm_bytes);
    let dir = derived_dir()?;
    fs::create_dir_all(&dir).context("creating derived artifact directory")?;
    set_owner_only_dir(&dir)?;

    let meta = DerivedMeta {
        wasm_sha256: wasm_digest.clone(),
        engine_key: engine_key(),
        artifact_sha256: sha256_hex(precompiled),
    };
    let meta_bytes = serde_json::to_vec(&meta).context("encoding derived meta")?;

    write_atomic(&dir.join(format!("{wasm_digest}.cwasm")), precompiled)?;
    write_atomic(&dir.join(format!("{wasm_digest}.json")), &meta_bytes)?;
    Ok(())
}

/// The derived-artifact directory lives next to the update store, in a
/// location only this user can read or write (§5.1.6 first phase).
fn derived_dir() -> Result<PathBuf> {
    let data = std::env::var(channel::ENV_DATA_DIR)
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(PathBuf::from).map(|home| {
                home.join(".local")
                    .join("share")
                    .join(match channel::CHANNEL {
                        "stable" => "GeneHub",
                        "beta" => "GeneHub-beta",
                        "dev" => "GeneHub-dev",
                        _ => "GeneHub-local",
                    })
            })
        })
        .ok_or_else(|| anyhow::anyhow!("no data directory for derived artifacts"))?;
    Ok(data.join("component").join("derived"))
}

/// The engine-side invalidation key. Wasmtime's artifact header already
/// rejects version and configuration drift; this key covers what it does
/// not — the CPU feature set (§5.1.6).
fn engine_key() -> String {
    format!("cranelift:{}", cpu_features_key())
}

#[cfg(target_arch = "x86_64")]
fn cpu_features_key() -> String {
    // Linux exposes the full CPU flag set; hashing it avoids enumerating
    // every feature Cranelift might use.
    #[cfg(target_os = "linux")]
    {
        if let Ok(cpuinfo) = fs::read_to_string("/proc/cpuinfo") {
            for line in cpuinfo.lines() {
                if line.starts_with("flags") {
                    let digest = Sha256::digest(line.as_bytes());
                    return format!("cpuinfo:{}", hex_prefix(&digest));
                }
            }
        }
    }
    // Other x86_64 platforms: probe the features Cranelift is known to use.
    let mut features = Vec::new();
    for (name, detected) in [
        ("sse3", std::arch::is_x86_feature_detected!("sse3")),
        ("ssse3", std::arch::is_x86_feature_detected!("ssse3")),
        ("sse4.1", std::arch::is_x86_feature_detected!("sse4.1")),
        ("sse4.2", std::arch::is_x86_feature_detected!("sse4.2")),
        ("avx", std::arch::is_x86_feature_detected!("avx")),
        ("avx2", std::arch::is_x86_feature_detected!("avx2")),
        ("avx512f", std::arch::is_x86_feature_detected!("avx512f")),
        ("bmi1", std::arch::is_x86_feature_detected!("bmi1")),
        ("bmi2", std::arch::is_x86_feature_detected!("bmi2")),
        ("fma", std::arch::is_x86_feature_detected!("fma")),
        ("lzcnt", std::arch::is_x86_feature_detected!("lzcnt")),
        ("popcnt", std::arch::is_x86_feature_detected!("popcnt")),
    ] {
        if detected {
            features.push(name);
        }
    }
    format!("x86_64:{}", features.join(","))
}

#[cfg(not(target_arch = "x86_64"))]
fn cpu_features_key() -> String {
    format!("arch:{}", std::env::consts::ARCH)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        write!(hex, "{byte:02x}").expect("writing to a String");
    }
    hex
}

fn hex_prefix(digest: &[u8]) -> String {
    use std::fmt::Write;
    let mut hex = String::with_capacity(16);
    for byte in &digest[..8] {
        write!(hex, "{byte:02x}").expect("writing to a String");
    }
    hex
}

/// Atomic write: temp file in the same directory, sync, rename, sync the
/// directory. Owner-only permissions on the file itself.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("derived artifact path has no parent"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    use std::io::Write;
    temporary.as_file_mut().write_all(bytes)?;
    temporary.as_file_mut().sync_all()?;
    set_owner_only_file(temporary.path())?;
    temporary
        .persist(path)
        .map_err(|error| anyhow::anyhow!("persisting {}: {}", path.display(), error.error))?;
    #[cfg(unix)]
    {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn discard(meta_path: &Path, cwasm_path: &Path) {
    let _ = fs::remove_file(meta_path);
    let _ = fs::remove_file(cwasm_path);
}

#[cfg(unix)]
fn set_owner_only_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_owner_only_dir(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_owner_only_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_owner_only_file(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The data-dir override is process-global; tests that set it must not
    /// run concurrently.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn test_engine() -> Engine {
        let mut config = wasmtime::Config::new();
        config.wasm_component_model(true);
        Engine::new(&config).unwrap()
    }

    /// A minimal valid component, derived from the empty module header.
    fn test_wasm() -> Vec<u8> {
        // (component) — the smallest valid component binary.
        b"\0asm\x0d\x00\x01\x00".to_vec()
    }

    #[test]
    fn roundtrip_loads_what_was_stored() {
        let _lock = ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(channel::ENV_DATA_DIR, dir.path());
        let engine = test_engine();
        let wasm = test_wasm();

        assert!(try_load(&engine, &wasm).is_none());
        derive_and_store(&engine, &wasm).unwrap();
        assert!(try_load(&engine, &wasm).is_some());
    }

    #[test]
    fn corrupted_artifact_is_discarded_and_recompiled() {
        let _lock = ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(channel::ENV_DATA_DIR, dir.path());
        let engine = test_engine();
        let wasm = test_wasm();

        derive_and_store(&engine, &wasm).unwrap();
        let wasm_digest = sha256_hex(&wasm);
        let cwasm_path = dir
            .path()
            .join("component")
            .join("derived")
            .join(format!("{wasm_digest}.cwasm"));
        // Flip a byte in the middle of the artifact.
        let mut corrupted = fs::read(&cwasm_path).unwrap();
        let mid = corrupted.len() / 2;
        corrupted[mid] ^= 0xff;
        fs::write(&cwasm_path, &corrupted).unwrap();

        assert!(try_load(&engine, &wasm).is_none());
        assert!(!cwasm_path.exists());
    }

    #[test]
    fn missing_cwasm_with_present_meta_is_discarded() {
        let _lock = ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(channel::ENV_DATA_DIR, dir.path());
        let engine = test_engine();
        let wasm = test_wasm();

        derive_and_store(&engine, &wasm).unwrap();
        let wasm_digest = sha256_hex(&wasm);
        let derived = dir.path().join("component").join("derived");
        fs::remove_file(derived.join(format!("{wasm_digest}.cwasm"))).unwrap();

        assert!(try_load(&engine, &wasm).is_none());
        assert!(!derived.join(format!("{wasm_digest}.json")).exists());
    }
}
