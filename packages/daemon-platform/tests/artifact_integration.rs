mod support;

use ed25519_dalek::{Signer, SigningKey};
use genet_daemon_platform::{
    ArtifactEnvelope, ArtifactVerifier, PlatformError, SignedArtifact, LOGIC_ABI_VERSION,
};
use support::{healthy_component, signed_component, signing_key, verifier, KEY_ID, MODULE_ID};

#[test]
fn trusted_signature_hash_size_and_metadata_are_verified_together() {
    let key = signing_key(7);
    let component = healthy_component(1);
    let artifact = signed_component(&key, "1.2.3", component.clone());
    let verified = verifier(&key, component.len()).verify(&artifact).unwrap();

    assert_eq!(verified.component(), component);
    assert_eq!(verified.envelope().version(), "1.2.3");
    assert_eq!(verified.envelope().module_id(), MODULE_ID);
    assert_eq!(verified.envelope().abi_version(), LOGIC_ABI_VERSION);
    assert_eq!(verified.envelope().size(), component.len() as u64);
    assert_eq!(verified.artifact_id().len(), 64);
    assert_eq!(verified.digest().len(), 64);
}

#[test]
fn signed_artifact_is_one_canonical_wasm_file() {
    let key = signing_key(7);
    let artifact = signed_component(&key, "1.2.3", healthy_component(1));
    let file = artifact.to_single_file().unwrap();

    // The package is still directly consumable as WebAssembly; the release
    // metadata is a standard ignored custom section rather than a wrapper.
    wasmparser::Validator::new().validate_all(&file).unwrap();
    let decoded = SignedArtifact::from_single_file(&file).unwrap();
    assert_eq!(decoded.envelope, artifact.envelope);
    assert_eq!(decoded.component, artifact.component);
    verifier(&key, 1024 * 1024).verify(&decoded).unwrap();
}

#[test]
fn single_file_rejects_missing_duplicate_non_final_and_tampered_metadata() {
    let key = signing_key(7);
    let artifact = signed_component(&key, "1.2.3", healthy_component(1));
    let file = artifact.to_single_file().unwrap();

    assert!(matches!(
        SignedArtifact::from_single_file(&artifact.component),
        Err(PlatformError::Verification(message)) if message.contains("no signed metadata")
    ));

    let mut duplicate = file.clone();
    duplicate.extend_from_slice(&file[artifact.component.len()..]);
    assert!(matches!(
        SignedArtifact::from_single_file(&duplicate),
        Err(PlatformError::Verification(message)) if message.contains("duplicate")
    ));

    let mut trailing = file.clone();
    // A valid unrelated empty custom section after the signature section.
    trailing.extend_from_slice(&[0, 1, 0]);
    assert!(matches!(
        SignedArtifact::from_single_file(&trailing),
        Err(PlatformError::Verification(message)) if message.contains("final canonical")
    ));

    let mut tampered = file;
    *tampered.last_mut().unwrap() ^= 1;
    assert!(SignedArtifact::from_single_file(&tampered).is_err());
}

#[test]
fn signed_manifest_identity_changes_without_duplicating_component_identity() {
    let old_key = signing_key(7);
    let new_key = signing_key(9);
    let component = healthy_component(1);
    let old = sign_with(
        &old_key,
        "old-release-key",
        MODULE_ID,
        "1.0.0",
        component.clone(),
    );
    let new = sign_with(&new_key, "new-release-key", MODULE_ID, "2.0.0", component);
    let trusted = ArtifactVerifier::new(
        MODULE_ID,
        LOGIC_ABI_VERSION,
        1024 * 1024,
        [
            ("old-release-key".to_string(), old_key.verifying_key()),
            ("new-release-key".to_string(), new_key.verifying_key()),
        ],
    )
    .unwrap();

    let old = trusted.verify(&old).unwrap();
    let new = trusted.verify(&new).unwrap();
    assert_eq!(old.digest(), new.digest());
    assert_ne!(old.artifact_id(), new.artifact_id());
}

#[test]
fn changed_bytes_metadata_signature_and_key_are_rejected() {
    let key = signing_key(7);
    let component = healthy_component(1);
    let artifact = signed_component(&key, "1.0.0", component.clone());
    let trusted = verifier(&key, 1024 * 1024);

    let mut changed_bytes = artifact.clone();
    changed_bytes.component.push(0);
    assert!(matches!(
        trusted.verify(&changed_bytes),
        Err(PlatformError::Verification(message)) if message.contains("length")
    ));

    let mut metadata = serde_json::to_value(&artifact.envelope).unwrap();
    metadata["version"] = serde_json::Value::String("9.9.9".to_string());
    let changed_metadata =
        SignedArtifact::new(serde_json::from_value(metadata).unwrap(), component.clone());
    assert!(matches!(
        trusted.verify(&changed_metadata),
        Err(PlatformError::Verification(message)) if message.contains("signature")
    ));

    let mut malformed_signature = serde_json::to_value(&artifact.envelope).unwrap();
    malformed_signature["signature"] = serde_json::Value::String("!".repeat(86));
    let malformed_signature = SignedArtifact::new(
        serde_json::from_value(malformed_signature).unwrap(),
        component.clone(),
    );
    assert!(matches!(
        trusted.verify(&malformed_signature),
        Err(PlatformError::Verification(message)) if message.contains("encoding")
    ));

    let attacker = signing_key(9);
    let wrong_signature = sign_with(&attacker, KEY_ID, MODULE_ID, "1.0.0", component.clone());
    assert!(matches!(
        trusted.verify(&wrong_signature),
        Err(PlatformError::Verification(message)) if message.contains("signature")
    ));

    let unknown_key = sign_with(&attacker, "unknown-key", MODULE_ID, "1.0.0", component);
    assert!(matches!(
        trusted.verify(&unknown_key),
        Err(PlatformError::Verification(message)) if message.contains("trust store")
    ));
}

#[test]
fn module_abi_and_artifact_size_are_hard_policy_not_guest_policy() {
    let key = signing_key(7);
    let component = healthy_component(1);
    let too_small = verifier(&key, component.len() - 1);
    let valid = signed_component(&key, "1.0.0", component.clone());
    assert!(matches!(
        too_small.verify(&valid),
        Err(PlatformError::Verification(message)) if message.contains("above")
    ));

    let wrong_module = sign_with(
        &key,
        KEY_ID,
        "genehub:other/module",
        "1.0.0",
        component.clone(),
    );
    assert!(matches!(
        verifier(&key, 1024 * 1024).verify(&wrong_module),
        Err(PlatformError::Verification(message)) if message.contains("not trusted")
    ));

    let envelope = ArtifactEnvelope::unsigned(MODULE_ID, "1.0.0", 99, KEY_ID, &component).unwrap();
    let signature = key.sign(&envelope.signing_payload().unwrap());
    let wrong_abi = SignedArtifact::new(envelope.with_signature(&signature), component);
    assert!(matches!(
        verifier(&key, 1024 * 1024).verify(&wrong_abi),
        Err(PlatformError::Verification(message)) if message.contains("ABI 99")
    ));
}

#[test]
fn trust_store_configuration_rejects_unsafe_shapes() {
    let key = signing_key(7);
    assert!(
        ArtifactVerifier::new(MODULE_ID, 1, 0, [(KEY_ID.to_string(), key.verifying_key())])
            .is_err()
    );
    assert!(ArtifactVerifier::new(MODULE_ID, 1, 1024, []).is_err());
    assert!(ArtifactVerifier::new(
        MODULE_ID,
        1,
        1024,
        [
            (KEY_ID.to_string(), key.verifying_key()),
            (KEY_ID.to_string(), key.verifying_key()),
        ],
    )
    .is_err());
}

fn sign_with(
    key: &SigningKey,
    key_id: &str,
    module_id: &str,
    version: &str,
    component: Vec<u8>,
) -> SignedArtifact {
    let envelope =
        ArtifactEnvelope::unsigned(module_id, version, LOGIC_ABI_VERSION, key_id, &component)
            .unwrap();
    let signature = key.sign(&envelope.signing_payload().unwrap());
    SignedArtifact::new(envelope.with_signature(&signature), component)
}
