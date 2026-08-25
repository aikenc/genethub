//! Offline release tooling for the signed client component.
//!
//! These commands deliberately live in the host crate so the producer and
//! consumer share the exact envelope parser and the exact WIT ABI digest.
//! They do not contact a release service or mutate the local activation store.

use std::path::Path;

use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;

use crate::artifact::{ArtifactEnvelope, SignedArtifact};
use crate::version::ProductVersion;
use crate::{abi, channel, keys};

pub fn run(arguments: &[String]) -> Result<(), String> {
    match arguments {
        [command, input, output, artifact_channel, version] if command == "pack" => pack(
            input,
            output,
            artifact_channel,
            parse_release_version(version)?,
            keys::development_key_id(),
            &keys::development_signing_key(),
        ),
        [command, input] if command == "inspect" => inspect(input),
        _ => Err(
            "usage:\n  genehub-host pack <raw.wasm> <signed.wasm> <channel> <release-version>\n  genehub-host inspect <signed.wasm>\n\npack signs with the one self-contained development root."
                .to_string(),
        ),
    }
}

fn inspect(input: impl AsRef<Path>) -> Result<(), String> {
    let file = std::fs::read(input.as_ref())
        .map_err(|error| format!("reading {}: {error}", input.as_ref().display()))?;
    let artifact = SignedArtifact::from_single_file(&file).map_err(|error| error.to_string())?;
    let envelope = artifact.envelope;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "moduleId": envelope.module_id(),
            "channel": envelope.channel(),
            "releaseVersion": envelope.release_version(),
            "appAbiHash": envelope.app_abi_hash(),
            "webProtocol": envelope.web_protocol(),
            "componentSha256": envelope.sha256(),
            "componentSize": envelope.size(),
            "keyId": envelope.key_id(),
            "signedFileSize": file.len(),
        }))
        .map_err(|error| error.to_string())?
    );
    Ok(())
}

fn pack(
    input: impl AsRef<Path>,
    output: impl AsRef<Path>,
    artifact_channel: &str,
    version: ProductVersion,
    key_id: &str,
    key: &SigningKey,
) -> Result<(), String> {
    let component = std::fs::read(input.as_ref())
        .map_err(|error| format!("reading {}: {error}", input.as_ref().display()))?;
    // Debug builds may stamp a foreign ABI digest into the envelope so the
    // release specialties can manufacture a component from another App
    // generation; release packs always name the digest this binary was built
    // against.
    #[cfg(debug_assertions)]
    let abi_hash = match std::env::var("GENEHUB_ABI_DIGEST") {
        Ok(value) if !value.is_empty() => value,
        _ => abi::hex_digest(&abi::host_digest()),
    };
    #[cfg(not(debug_assertions))]
    let abi_hash = abi::hex_digest(&abi::host_digest());
    let envelope = ArtifactEnvelope::unsigned(
        channel::MODULE_ID,
        artifact_channel,
        version.to_string(),
        abi_hash,
        genehub_identity::WEB_PROTOCOL_VERSION,
        key_id,
        &component,
    )
    .map_err(|error| error.to_string())?;
    let signature = key.sign(
        &envelope
            .signing_payload()
            .map_err(|error| error.to_string())?,
    );
    let file = SignedArtifact::new(envelope.with_signature(&signature), component)
        .to_single_file()
        .map_err(|error| error.to_string())?;
    std::fs::write(output.as_ref(), file)
        .map_err(|error| format!("writing {}: {error}", output.as_ref().display()))
}

fn parse_release_version(value: &str) -> Result<ProductVersion, String> {
    ProductVersion::parse(value)
        .map_err(|_| "release version must be a canonical Product Version".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_versions_are_canonical() {
        assert_eq!(parse_release_version("0.1.2").unwrap().to_string(), "0.1.2");
        assert!(parse_release_version("0.2.0-beta.1").is_ok());
        for value in ["0", "1.2", "01.2.3", "+1", "-1", "1 ", "x"] {
            assert!(parse_release_version(value).is_err(), "accepted {value:?}");
        }
    }
}
