//! Pair the shell with the guest *before* Wasmtime instantiates anything.
//!
//! The digest is `sha256` of `wit/genehub-host.wit` as checked in. Host and
//! guest bake the same 32 bytes at compile time; the guest carries them in a
//! `genehub-abi` custom section. A WIT edit that only one side rebuilt is a
//! start failure with a rebuild instruction, not an opaque linker trap after
//! a long compile.

use anyhow::{Context, Result};

use crate::channel::CHANNEL;

const SECTION: &str = "genehub-abi";
const HOST_DIGEST: [u8; 32] = *include_bytes!(concat!(env!("OUT_DIR"), "/genehub-abi.bin"));

/// Host process exit when the guest is not the pair this binary was built for.
pub const EXIT_PAIRING: i32 = 5;

/// The WIT digest this host binary was compiled against.
pub fn host_digest() -> [u8; 32] {
    HOST_DIGEST
}

pub fn hex_digest(digest: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Fail closed unless the component bytes name the same WIT digest we do.
///
/// Called on the raw file, before instantiate, so a mismatched pair never
/// reaches the linker.
pub fn assert_paired(component: &[u8]) -> Result<()> {
    let guest = guest_digest(component).context(pairing_message(
        CHANNEL,
        "missing-digest",
        None,
    ))?;
    assert_same(guest)
}

/// A stamped digest that does not match this host is always a start failure,
/// including on a leftover file that is not the product guest.
pub fn assert_digest_if_present(component: &[u8]) -> Result<()> {
    match guest_digest(component) {
        Some(guest) => assert_same(guest),
        None => Ok(()),
    }
}

fn assert_same(guest: [u8; 32]) -> Result<()> {
    if guest != host_digest() {
        anyhow::bail!(pairing_message(
            CHANNEL,
            "digest-mismatch",
            Some(guest),
        ));
    }
    Ok(())
}

/// What a supervisor or a person should do after `ABI_PAIRING_FAILED`.
pub fn recovery_action(channel: &str) -> &'static str {
    if channel == "dev" {
        "rebuild"
    } else {
        "update"
    }
}

pub fn pairing_message(channel: &str, reason: &str, guest: Option<[u8; 32]>) -> String {
    let action = recovery_action(channel);
    let host = hex_digest(&host_digest());
    let guest = guest
        .map(|digest| hex_digest(&digest))
        .unwrap_or_else(|| "none".to_string());
    let how = if action == "rebuild" {
        "compile genehub-host and genehub-guest from this checkout against wit/genehub-host.wit, then restart"
    } else {
        "install the GeneHub update that ships this host and guest together; do not mix artifacts from different builds"
    };
    format!(
        "ABI_PAIRING_FAILED channel={channel} action={action} reason={reason} host={host} guest={guest} {how}"
    )
}

pub fn is_pairing_failure(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string().contains("ABI_PAIRING_FAILED"))
}

/// The first `genehub-abi` custom section in a module or component.
pub fn guest_digest(bytes: &[u8]) -> Option<[u8; 32]> {
    find_section(bytes, SECTION)
        .and_then(|payload| <[u8; 32]>::try_from(payload).ok())
}

/// Walk core-module and component custom sections, including nested modules.
fn find_section<'a>(bytes: &'a [u8], name: &str) -> Option<&'a [u8]> {
    if bytes.len() < 8 || bytes[..4] != *b"\0asm" {
        return None;
    }
    let mut offset = 8;
    while offset < bytes.len() {
        let (id, id_len) = read_leb128(&bytes[offset..])?;
        offset += id_len;
        let (size, size_len) = read_leb128(&bytes[offset..])?;
        offset += size_len;
        let end = offset.checked_add(size)?;
        if end > bytes.len() {
            return None;
        }
        let payload = &bytes[offset..end];
        if id == 0 {
            let (name_len, name_len_size) = read_leb128(payload)?;
            let name_start = name_len_size;
            let name_end = name_start.checked_add(name_len)?;
            if name_end <= payload.len() {
                if let Ok(section_name) = std::str::from_utf8(&payload[name_start..name_end]) {
                    if section_name == name {
                        return Some(&payload[name_end..]);
                    }
                }
            }
        } else if id == 1 || id == 4 {
            // core:module or nested component: the payload is itself a wasm.
            if let Some(found) = find_section(payload, name) {
                return Some(found);
            }
        }
        offset = end;
    }
    None
}

fn read_leb128(bytes: &[u8]) -> Option<(usize, usize)> {
    let mut value = 0usize;
    let mut shift = 0;
    for (index, byte) in bytes.iter().copied().enumerate() {
        let bits = (byte & 0x7f) as usize;
        value |= bits
            .checked_shl(shift)?;
        if byte & 0x80 == 0 {
            return Some((value, index + 1));
        }
        shift += 7;
        if shift > 35 {
            return None;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom_section(name: &str, data: &[u8]) -> Vec<u8> {
        let name_bytes = name.as_bytes();
        let mut payload = encode_leb128(name_bytes.len());
        payload.extend_from_slice(name_bytes);
        payload.extend_from_slice(data);
        let mut section = vec![0];
        section.extend(encode_leb128(payload.len()));
        section.extend(payload);
        section
    }

    fn encode_leb128(mut value: usize) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                break;
            }
        }
        out
    }

    fn module_with_section(name: &str, data: &[u8]) -> Vec<u8> {
        let mut bytes = b"\0asm\x01\x00\x00\x00".to_vec();
        bytes.extend(custom_section(name, data));
        bytes
    }

    #[test]
    fn a_matching_section_pairs() {
        let guest = module_with_section(SECTION, &host_digest());
        assert_eq!(guest_digest(&guest), Some(host_digest()));
        assert_paired(&guest).unwrap();
    }

    #[test]
    fn a_missing_section_is_a_start_failure() {
        let empty = b"\0asm\x01\x00\x00\x00";
        assert!(guest_digest(empty).is_none());
        let error = assert_paired(empty).unwrap_err().to_string();
        assert!(error.contains("ABI_PAIRING_FAILED"), "{error}");
        assert!(error.contains("action=rebuild"), "{error}");
        assert!(error.contains("reason=missing-digest"), "{error}");
        assert!(is_pairing_failure(&anyhow::anyhow!("{error}")));
    }

    #[test]
    fn a_different_digest_is_a_start_failure() {
        let mut other = host_digest();
        other[0] ^= 0xff;
        let guest = module_with_section(SECTION, &other);
        let error = assert_paired(&guest).unwrap_err().to_string();
        assert!(error.contains("ABI_PAIRING_FAILED"), "{error}");
        assert!(error.contains("action=rebuild"), "{error}");
        assert!(error.contains("reason=digest-mismatch"), "{error}");
        assert!(error.contains(&hex_digest(&host_digest())), "{error}");
        assert!(error.contains(&hex_digest(&other)), "{error}");
    }

    #[test]
    fn official_and_beta_ask_for_an_update() {
        assert_eq!(recovery_action("dev"), "rebuild");
        assert_eq!(recovery_action("beta"), "update");
        assert_eq!(recovery_action("official"), "update");
        let official = pairing_message("official", "digest-mismatch", Some(host_digest()));
        assert!(official.contains("action=update"), "{official}");
        assert!(official.contains("install the GeneHub update"), "{official}");
        assert!(!official.contains("compile genehub-host"), "{official}");
    }

    #[test]
    fn a_nested_core_module_section_is_found() {
        let inner = module_with_section(SECTION, &host_digest());
        let mut outer = b"\0asm\x0d\x00\x01\x00".to_vec();
        let mut module_section = vec![1];
        module_section.extend(encode_leb128(inner.len()));
        module_section.extend(inner);
        outer.extend(module_section);
        assert_eq!(guest_digest(&outer), Some(host_digest()));
    }

    #[test]
    fn an_appended_component_section_is_found() {
        let mut bytes = b"\0asm\x0d\x00\x01\x00".to_vec();
        bytes.extend(custom_section(SECTION, &host_digest()));
        assert_eq!(guest_digest(&bytes), Some(host_digest()));
        assert_paired(&bytes).unwrap();
    }
}
