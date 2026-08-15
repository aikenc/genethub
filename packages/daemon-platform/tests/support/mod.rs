#![allow(dead_code)]

use ed25519_dalek::{Signer, SigningKey};
use genet_daemon_platform::{
    ArtifactEnvelope, ArtifactVerifier, SignedArtifact, LOGIC_ABI_VERSION,
};

pub const MODULE_ID: &str = "genehub:daemon/logic";
pub const KEY_ID: &str = "official-test";

pub fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

pub fn verifier(key: &SigningKey, max_artifact_bytes: usize) -> ArtifactVerifier {
    ArtifactVerifier::new(
        MODULE_ID,
        LOGIC_ABI_VERSION,
        max_artifact_bytes,
        [(KEY_ID.to_string(), key.verifying_key())],
    )
    .unwrap()
}

pub fn signed_component(key: &SigningKey, version: &str, component: Vec<u8>) -> SignedArtifact {
    signed_component_with_key_id(key, KEY_ID, version, component)
}

pub fn signed_component_with_key_id(
    key: &SigningKey,
    key_id: &str,
    version: &str,
    component: Vec<u8>,
) -> SignedArtifact {
    let envelope =
        ArtifactEnvelope::unsigned(MODULE_ID, version, LOGIC_ABI_VERSION, key_id, &component)
            .unwrap();
    let signature = key.sign(&envelope.signing_payload().unwrap());
    SignedArtifact::new(envelope.with_signature(&signature), component)
}

pub fn healthy_component(delta: i64) -> Vec<u8> {
    component(ComponentSpec {
        probe_body: format!("local.get 0 i64.const {delta} i64.add"),
        ..ComponentSpec::default()
    })
}

#[derive(Clone)]
pub struct ComponentSpec {
    pub abi: i32,
    pub self_check_body: String,
    pub probe_body: String,
    pub core_prelude: String,
    pub module_import: String,
    pub include_probe: bool,
    pub probe_signature: String,
}

impl Default for ComponentSpec {
    fn default() -> Self {
        Self {
            abi: LOGIC_ABI_VERSION as i32,
            self_check_body: "i32.const 1".to_string(),
            probe_body: "local.get 0".to_string(),
            core_prelude: String::new(),
            module_import: String::new(),
            include_probe: true,
            probe_signature: "(param i64) (result i64)".to_string(),
        }
    }
}

pub fn component(spec: ComponentSpec) -> Vec<u8> {
    let probe = if spec.include_probe {
        format!(
            "(func (export \"genehub-probe\") {} {})",
            spec.probe_signature, spec.probe_body
        )
    } else {
        String::new()
    };
    let text = format!(
        r#"
        (module
          {module_import}
          {core_prelude}
          (func (export "genehub-abi-version") (result i32) i32.const {abi})
          (func (export "genehub-self-check") (result i32) {self_check_body})
          {probe}
        )
        "#,
        module_import = spec.module_import,
        core_prelude = spec.core_prelude,
        abi = spec.abi,
        self_check_body = spec.self_check_body,
        probe = probe,
    );
    wat::parse_str(text).unwrap()
}
