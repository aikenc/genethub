use std::collections::BTreeMap;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{ArtifactError, Result};

const ENVELOPE_FORMAT_VERSION: u32 = 2;
const SIGNATURE_DOMAIN: &[u8] = b"genehub-app-artifact-v2\0";
const ARTIFACT_ID_DOMAIN: &[u8] = b"genehub-app-artifact-id-v2\0";
const MAX_MODULE_ID_BYTES: usize = 128;
const MAX_CHANNEL_BYTES: usize = 32;
const MAX_KEY_ID_BYTES: usize = 64;
const ED25519_SIGNATURE_BASE64_BYTES: usize = 86;
const ARTIFACT_CUSTOM_SECTION: &str = "genehub.daemon.artifact.v2";
const MAX_ENVELOPE_BYTES: usize = 16 * 1024;

/// Signed, immutable metadata stored beside one Wasm component.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactEnvelope {
    format_version: u32,
    module_id: String,
    channel: String,
    logic_revision: u64,
    platform_abi: u32,
    protocol_version: u32,
    size: u64,
    sha256: String,
    key_id: String,
    signature: String,
}

impl ArtifactEnvelope {
    /// Builds unsigned metadata. Release tooling signs [`Self::signing_payload`]
    /// and attaches it with [`Self::with_signature`].
    pub fn unsigned(
        module_id: impl Into<String>,
        channel: impl Into<String>,
        logic_revision: u64,
        platform_abi: u32,
        protocol_version: u32,
        key_id: impl Into<String>,
        component: &[u8],
    ) -> Result<Self> {
        let envelope = Self {
            format_version: ENVELOPE_FORMAT_VERSION,
            module_id: module_id.into(),
            channel: channel.into(),
            logic_revision,
            platform_abi,
            protocol_version,
            size: u64::try_from(component.len()).map_err(|_| {
                ArtifactError::Verification("component size does not fit in u64".to_string())
            })?,
            sha256: sha256_hex(component),
            key_id: key_id.into(),
            signature: String::new(),
        };
        envelope.validate_shape()?;
        Ok(envelope)
    }

    pub fn with_signature(mut self, signature: &Signature) -> Self {
        self.signature = STANDARD_NO_PAD.encode(signature.to_bytes());
        self
    }

    /// Stable, length-delimited bytes covered by the artifact signature.
    pub fn signing_payload(&self) -> Result<Vec<u8>> {
        self.validate_shape()?;
        let mut payload = Vec::with_capacity(256);
        payload.extend_from_slice(SIGNATURE_DOMAIN);
        payload.extend_from_slice(&self.format_version.to_be_bytes());
        append_field(&mut payload, self.module_id.as_bytes())?;
        append_field(&mut payload, self.channel.as_bytes())?;
        payload.extend_from_slice(&self.logic_revision.to_be_bytes());
        payload.extend_from_slice(&self.platform_abi.to_be_bytes());
        payload.extend_from_slice(&self.protocol_version.to_be_bytes());
        payload.extend_from_slice(&self.size.to_be_bytes());
        append_field(&mut payload, self.sha256.as_bytes())?;
        append_field(&mut payload, self.key_id.as_bytes())?;
        Ok(payload)
    }

    pub fn module_id(&self) -> &str {
        &self.module_id
    }

    pub fn channel(&self) -> &str {
        &self.channel
    }

    pub fn logic_revision(&self) -> u64 {
        self.logic_revision
    }

    pub fn platform_abi(&self) -> u32 {
        self.platform_abi
    }

    pub fn protocol_version(&self) -> u32 {
        self.protocol_version
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    fn validate_shape(&self) -> Result<()> {
        if self.format_version != ENVELOPE_FORMAT_VERSION {
            return Err(ArtifactError::Verification(format!(
                "unsupported envelope format {}",
                self.format_version
            )));
        }
        validate_text("module id", &self.module_id, MAX_MODULE_ID_BYTES)?;
        validate_channel(&self.channel)?;
        if self.logic_revision == 0 {
            return Err(ArtifactError::Verification(
                "logic revision must be positive".to_string(),
            ));
        }
        if self.platform_abi == 0 {
            return Err(ArtifactError::Verification(
                "platform ABI must be positive".to_string(),
            ));
        }
        if self.protocol_version == 0 {
            return Err(ArtifactError::Verification(
                "protocol version must be positive".to_string(),
            ));
        }
        validate_key_id(&self.key_id)?;
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ArtifactError::Verification(
                "SHA-256 must be 64 lowercase hexadecimal characters".to_string(),
            ));
        }
        Ok(())
    }
}

/// Artifact bytes and their signed envelope as received from a release source.
#[derive(Clone, Debug)]
pub struct SignedArtifact {
    pub envelope: ArtifactEnvelope,
    pub component: Vec<u8>,
}

impl SignedArtifact {
    pub fn new(envelope: ArtifactEnvelope, component: impl Into<Vec<u8>>) -> Self {
        Self {
            envelope,
            component: component.into(),
        }
    }

    /// Encodes the signed envelope into a standard Wasm custom section.
    ///
    /// The returned bytes remain a valid Wasm module, so one immutable file can
    /// be built and signed on Linux and passed directly through every native
    /// platform's verifier. The signature covers the exact module prefix; the
    /// custom section itself is deliberately excluded to avoid a circular
    /// signature.
    pub fn to_single_file(&self) -> Result<Vec<u8>> {
        if self.envelope.size != self.component.len() as u64
            || self.envelope.sha256 != sha256_hex(&self.component)
        {
            return Err(ArtifactError::Verification(
                "artifact envelope does not describe its component".to_string(),
            ));
        }
        reject_existing_artifact_section(&self.component)?;
        let envelope = serde_json::to_vec(&self.envelope)?;
        if envelope.len() > MAX_ENVELOPE_BYTES {
            return Err(ArtifactError::Verification(
                "artifact envelope exceeds the single-file limit".to_string(),
            ));
        }

        let mut section = Vec::with_capacity(ARTIFACT_CUSTOM_SECTION.len() + envelope.len() + 10);
        append_leb_u32(&mut section, ARTIFACT_CUSTOM_SECTION.len())?;
        section.extend_from_slice(ARTIFACT_CUSTOM_SECTION.as_bytes());
        section.extend_from_slice(&envelope);

        let mut file = Vec::with_capacity(self.component.len() + section.len() + 6);
        file.extend_from_slice(&self.component);
        file.push(0); // WebAssembly custom section id.
        append_leb_u32(&mut file, section.len())?;
        file.extend_from_slice(&section);
        Ok(file)
    }

    /// Decodes one self-contained signed Wasm file.
    ///
    /// Canonical re-encoding is required byte-for-byte. This rejects duplicate,
    /// reordered or trailing metadata and makes the signed module prefix
    /// unambiguous before trust verification runs.
    pub fn from_single_file(file: &[u8]) -> Result<Self> {
        let mut encoded_envelope = None;
        for payload in wasmparser::Parser::new(0).parse_all(file) {
            let payload = payload.map_err(|error| {
                ArtifactError::Verification(format!("invalid Wasm artifact: {error}"))
            })?;
            if let wasmparser::Payload::CustomSection(section) = payload {
                if section.name() == ARTIFACT_CUSTOM_SECTION
                    && encoded_envelope.replace(section.data()).is_some()
                {
                    return Err(ArtifactError::Verification(
                        "artifact contains duplicate signed metadata".to_string(),
                    ));
                }
            }
        }
        let encoded_envelope = encoded_envelope.ok_or_else(|| {
            ArtifactError::Verification("artifact has no signed metadata section".to_string())
        })?;
        if encoded_envelope.len() > MAX_ENVELOPE_BYTES {
            return Err(ArtifactError::Verification(
                "artifact envelope exceeds the single-file limit".to_string(),
            ));
        }
        let envelope: ArtifactEnvelope = serde_json::from_slice(encoded_envelope)?;
        let component_size = usize::try_from(envelope.size).map_err(|_| {
            ArtifactError::Verification("component length does not fit this host".to_string())
        })?;
        let component = file.get(..component_size).ok_or_else(|| {
            ArtifactError::Verification(
                "signed component length exceeds the artifact file".to_string(),
            )
        })?;
        let artifact = Self::new(envelope, component.to_vec());
        let canonical = artifact.to_single_file()?;
        if canonical != file {
            return Err(ArtifactError::Verification(
                "artifact metadata is not the final canonical section".to_string(),
            ));
        }
        Ok(artifact)
    }
}

#[derive(Clone)]
pub struct VerifiedArtifact {
    pub(crate) artifact_id: String,
    pub(crate) envelope: ArtifactEnvelope,
    pub(crate) component: Arc<[u8]>,
}

impl VerifiedArtifact {
    /// Identity of this exact signed artifact envelope. Unlike the component
    /// digest, this changes when its channel, revision or signing key changes.
    pub fn artifact_id(&self) -> &str {
        &self.artifact_id
    }

    /// Content digest of the Wasm component, shared by manifests that publish
    /// identical code under a different version or signing key.
    pub fn digest(&self) -> &str {
        self.envelope.sha256()
    }

    pub fn envelope(&self) -> &ArtifactEnvelope {
        &self.envelope
    }

    pub fn component(&self) -> &[u8] {
        &self.component
    }
}

/// Immutable trust policy used before any candidate component is compiled.
#[derive(Clone)]
pub struct ArtifactVerifier {
    expected_module_id: String,
    expected_channel: String,
    expected_platform_abi: u32,
    max_artifact_bytes: usize,
    trusted_keys: Arc<BTreeMap<String, VerifyingKey>>,
}

impl ArtifactVerifier {
    pub fn new(
        expected_module_id: impl Into<String>,
        expected_channel: impl Into<String>,
        expected_platform_abi: u32,
        max_artifact_bytes: usize,
        trusted_keys: impl IntoIterator<Item = (String, VerifyingKey)>,
    ) -> Result<Self> {
        let expected_module_id = expected_module_id.into();
        validate_text("module id", &expected_module_id, MAX_MODULE_ID_BYTES)?;
        let expected_channel = expected_channel.into();
        validate_channel(&expected_channel)?;
        if max_artifact_bytes == 0 {
            return Err(ArtifactError::Verification(
                "maximum artifact size must be positive".to_string(),
            ));
        }
        let mut keys = BTreeMap::new();
        for (key_id, key) in trusted_keys {
            validate_key_id(&key_id)?;
            if keys.insert(key_id.clone(), key).is_some() {
                return Err(ArtifactError::Verification(format!(
                    "duplicate trusted key id {key_id}"
                )));
            }
        }
        if keys.is_empty() {
            return Err(ArtifactError::Verification(
                "at least one trusted artifact key is required".to_string(),
            ));
        }
        Ok(Self {
            expected_module_id,
            expected_channel,
            expected_platform_abi,
            max_artifact_bytes,
            trusted_keys: Arc::new(keys),
        })
    }

    pub fn verify(&self, artifact: &SignedArtifact) -> Result<VerifiedArtifact> {
        let envelope = &artifact.envelope;
        envelope.validate_shape()?;
        if envelope.module_id != self.expected_module_id {
            return Err(ArtifactError::Verification(format!(
                "module id {} is not trusted for {}",
                envelope.module_id, self.expected_module_id
            )));
        }
        if envelope.channel != self.expected_channel {
            return Err(ArtifactError::Verification(format!(
                "artifact channel {} does not match platform channel {}",
                envelope.channel, self.expected_channel
            )));
        }
        if envelope.platform_abi != self.expected_platform_abi {
            return Err(ArtifactError::Verification(format!(
                "artifact ABI {} does not match platform ABI {}",
                envelope.platform_abi, self.expected_platform_abi
            )));
        }
        if artifact.component.len() > self.max_artifact_bytes {
            return Err(ArtifactError::Verification(format!(
                "artifact is {} bytes, above the {} byte limit",
                artifact.component.len(),
                self.max_artifact_bytes
            )));
        }
        if envelope.size != artifact.component.len() as u64 {
            return Err(ArtifactError::Verification(
                "artifact length does not match the signed envelope".to_string(),
            ));
        }
        let digest = sha256_hex(&artifact.component);
        if digest != envelope.sha256 {
            return Err(ArtifactError::Verification(
                "artifact digest does not match the signed envelope".to_string(),
            ));
        }

        let key = self.trusted_keys.get(&envelope.key_id).ok_or_else(|| {
            ArtifactError::Verification(format!(
                "artifact key {} is not in this channel's trust store",
                envelope.key_id
            ))
        })?;
        if envelope.signature.len() != ED25519_SIGNATURE_BASE64_BYTES {
            return Err(ArtifactError::Verification(
                "Ed25519 signature has a non-canonical encoded length".to_string(),
            ));
        }
        let signature_bytes = STANDARD_NO_PAD
            .decode(&envelope.signature)
            .map_err(|_| ArtifactError::Verification("invalid signature encoding".to_string()))?;
        let signature_bytes: [u8; 64] = signature_bytes.try_into().map_err(|_| {
            ArtifactError::Verification("Ed25519 signature must be 64 bytes".to_string())
        })?;
        let signature = Signature::from_bytes(&signature_bytes);
        key.verify_strict(&envelope.signing_payload()?, &signature)
            .map_err(|_| {
                ArtifactError::Verification("artifact signature is not valid".to_string())
            })?;
        let artifact_id = signed_artifact_id(envelope, &signature_bytes)?;

        Ok(VerifiedArtifact {
            artifact_id,
            envelope: envelope.clone(),
            component: Arc::from(artifact.component.clone()),
        })
    }

    pub(crate) fn max_artifact_bytes(&self) -> usize {
        self.max_artifact_bytes
    }
}

fn append_field(output: &mut Vec<u8>, value: &[u8]) -> Result<()> {
    let length = u32::try_from(value.len()).map_err(|_| {
        ArtifactError::Verification("signed metadata field is too large".to_string())
    })?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn append_leb_u32(output: &mut Vec<u8>, value: usize) -> Result<()> {
    let mut value = u32::try_from(value)
        .map_err(|_| ArtifactError::Verification("Wasm custom section is too large".to_string()))?;
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        output.push(byte);
        if value == 0 {
            return Ok(());
        }
    }
}

fn reject_existing_artifact_section(component: &[u8]) -> Result<()> {
    for payload in wasmparser::Parser::new(0).parse_all(component) {
        let payload = payload.map_err(|error| {
            ArtifactError::Verification(format!("invalid Wasm component: {error}"))
        })?;
        if matches!(
            payload,
            wasmparser::Payload::CustomSection(section)
                if section.name() == ARTIFACT_CUSTOM_SECTION
        ) {
            return Err(ArtifactError::Verification(
                "component already contains signed artifact metadata".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_text(label: &str, value: &str, max_bytes: usize) -> Result<()> {
    if value.is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(ArtifactError::Verification(format!(
            "{label} must contain 1 through {max_bytes} non-control UTF-8 bytes"
        )));
    }
    Ok(())
}

fn validate_channel(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_CHANNEL_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(ArtifactError::Verification(
            "channel must be a lowercase identifier".to_string(),
        ));
    }
    Ok(())
}

fn validate_key_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_KEY_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(ArtifactError::Verification(
            "key id contains unsupported characters".to_string(),
        ));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn signed_artifact_id(envelope: &ArtifactEnvelope, signature: &[u8; 64]) -> Result<String> {
    let signing_payload = envelope.signing_payload()?;
    let payload_len = u64::try_from(signing_payload.len()).map_err(|_| {
        ArtifactError::Verification("signed artifact identity is too large".to_string())
    })?;
    let mut identity = Vec::with_capacity(
        ARTIFACT_ID_DOMAIN.len() + std::mem::size_of::<u64>() + signing_payload.len() + 64,
    );
    identity.extend_from_slice(ARTIFACT_ID_DOMAIN);
    identity.extend_from_slice(&payload_len.to_be_bytes());
    identity.extend_from_slice(&signing_payload);
    identity.extend_from_slice(signature);
    Ok(sha256_hex(&identity))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const EMPTY_WASM: &[u8] = b"\0asm\x01\x00\x00\x00";

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7; 32])
    }

    fn signed(revision: u64) -> SignedArtifact {
        let envelope = ArtifactEnvelope::unsigned(
            "genehub:guest/wasm",
            "dev",
            revision,
            23,
            3,
            "dev-local",
            EMPTY_WASM,
        )
        .unwrap();
        let signature = key().sign(&envelope.signing_payload().unwrap());
        SignedArtifact::new(envelope.with_signature(&signature), EMPTY_WASM)
    }

    fn verifier() -> ArtifactVerifier {
        ArtifactVerifier::new(
            "genehub:guest/wasm",
            "dev",
            23,
            64 * 1024,
            [("dev-local".to_string(), key().verifying_key())],
        )
        .unwrap()
    }

    #[test]
    fn a_canonical_single_file_round_trips_and_verifies() {
        let file = signed(1).to_single_file().unwrap();
        let artifact = SignedArtifact::from_single_file(&file).unwrap();
        let verified = verifier().verify(&artifact).unwrap();
        assert_eq!(verified.envelope().logic_revision(), 1);
        assert_eq!(verified.component(), EMPTY_WASM);
    }

    #[test]
    fn a_tampered_section_is_rejected_before_instantiate() {
        let mut file = signed(1).to_single_file().unwrap();
        let last = file.len() - 1;
        file[last] ^= 0x01;
        assert!(
            SignedArtifact::from_single_file(&file).is_err()
                || verifier()
                    .verify(&SignedArtifact::from_single_file(&file).unwrap())
                    .is_err()
        );
    }

    #[test]
    fn a_wrong_channel_or_abi_is_not_trusted() {
        let artifact = signed(1);
        let other = ArtifactVerifier::new(
            "genehub:guest/wasm",
            "official",
            23,
            64 * 1024,
            [("dev-local".to_string(), key().verifying_key())],
        )
        .unwrap();
        assert!(other.verify(&artifact).is_err());
    }
}
