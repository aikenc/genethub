mod support;

use ed25519_dalek::{Signer, SigningKey};
use genet_daemon_platform::{
    ArtifactEnvelope, ArtifactVerifier, PlatformError, SignedArtifact, LOGIC_ABI_VERSION,
};
use support::{
    healthy_component, signed_component, signing_key, verifier, CHANNEL, KEY_ID, MODULE_ID,
    PROTOCOL_VERSION,
};

#[test]
fn signed_v2_envelope_covers_patch_identity_and_component() {
    let key = signing_key(7);
    let component = healthy_component(1);
    let artifact = signed_component(&key, 42, component.clone());
    let verified = verifier(&key, component.len()).verify(&artifact).unwrap();

    assert_eq!(verified.component(), component);
    assert_eq!(verified.envelope().module_id(), MODULE_ID);
    assert_eq!(verified.envelope().channel(), CHANNEL);
    assert_eq!(verified.envelope().logic_revision(), 42);
    assert_eq!(verified.envelope().platform_abi(), LOGIC_ABI_VERSION);
    assert_eq!(verified.envelope().protocol_version(), PROTOCOL_VERSION);
    assert_eq!(verified.envelope().size(), component.len() as u64);
    assert_eq!(verified.artifact_id().len(), 64);
    assert_eq!(verified.digest().len(), 64);
}

#[test]
fn signed_artifact_is_one_canonical_wasm_file() {
    let key = signing_key(7);
    let artifact = signed_component(&key, 42, healthy_component(1));
    let file = artifact.to_single_file().unwrap();

    wasmparser::Validator::new().validate_all(&file).unwrap();
    let decoded = SignedArtifact::from_single_file(&file).unwrap();
    assert_eq!(decoded.envelope, artifact.envelope);
    assert_eq!(decoded.component, artifact.component);
    verifier(&key, 1024 * 1024).verify(&decoded).unwrap();
}

#[test]
fn single_file_rejects_missing_duplicate_non_final_and_tampered_metadata() {
    let key = signing_key(7);
    let artifact = signed_component(&key, 42, healthy_component(1));
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
fn every_distribution_and_compatibility_field_is_signed() {
    let key = signing_key(7);
    let component = healthy_component(1);
    let artifact = signed_component(&key, 42, component.clone());
    let trusted = verifier(&key, 1024 * 1024);

    for (field, value) in [
        ("channel", serde_json::json!("beta")),
        ("logicRevision", serde_json::json!(43)),
        ("platformAbi", serde_json::json!(LOGIC_ABI_VERSION + 1)),
        ("protocolVersion", serde_json::json!(PROTOCOL_VERSION + 1)),
        ("size", serde_json::json!(component.len() as u64 + 1)),
        ("sha256", serde_json::json!("0".repeat(64))),
        ("keyId", serde_json::json!("other-key")),
    ] {
        let mut metadata = serde_json::to_value(&artifact.envelope).unwrap();
        metadata[field] = value;
        let changed =
            SignedArtifact::new(serde_json::from_value(metadata).unwrap(), component.clone());
        assert!(
            trusted.verify(&changed).is_err(),
            "unsigned mutation of {field}"
        );
    }
}

#[test]
fn channel_module_abi_size_signature_and_key_are_fail_closed() {
    let key = signing_key(7);
    let component = healthy_component(1);
    let trusted = verifier(&key, 1024 * 1024);

    let wrong_channel = sign_with(
        &key,
        KEY_ID,
        MODULE_ID,
        "beta",
        42,
        LOGIC_ABI_VERSION,
        component.clone(),
    );
    assert!(matches!(
        trusted.verify(&wrong_channel),
        Err(PlatformError::Verification(message)) if message.contains("channel")
    ));

    let wrong_module = sign_with(
        &key,
        KEY_ID,
        "genehub:other/module",
        CHANNEL,
        42,
        LOGIC_ABI_VERSION,
        component.clone(),
    );
    assert!(matches!(
        trusted.verify(&wrong_module),
        Err(PlatformError::Verification(message)) if message.contains("not trusted")
    ));

    let wrong_abi = sign_with(&key, KEY_ID, MODULE_ID, CHANNEL, 42, 99, component.clone());
    assert!(matches!(
        trusted.verify(&wrong_abi),
        Err(PlatformError::Verification(message)) if message.contains("ABI 99")
    ));

    let too_small = verifier(&key, component.len() - 1);
    assert!(matches!(
        too_small.verify(&signed_component(&key, 42, component.clone())),
        Err(PlatformError::Verification(message)) if message.contains("above")
    ));

    let mut changed_bytes = signed_component(&key, 42, component.clone());
    changed_bytes.component.push(0);
    assert!(trusted.verify(&changed_bytes).is_err());

    let attacker = signing_key(9);
    let wrong_signature = sign_with(
        &attacker,
        KEY_ID,
        MODULE_ID,
        CHANNEL,
        42,
        LOGIC_ABI_VERSION,
        component.clone(),
    );
    assert!(matches!(
        trusted.verify(&wrong_signature),
        Err(PlatformError::Verification(message)) if message.contains("signature")
    ));

    let unknown_key = sign_with(
        &attacker,
        "unknown-key",
        MODULE_ID,
        CHANNEL,
        42,
        LOGIC_ABI_VERSION,
        component,
    );
    assert!(matches!(
        trusted.verify(&unknown_key),
        Err(PlatformError::Verification(message)) if message.contains("trust store")
    ));
}

#[test]
fn same_component_has_distinct_signed_identity_per_revision_or_key() {
    let old_key = signing_key(7);
    let new_key = signing_key(9);
    let component = healthy_component(1);
    let old = sign_with(
        &old_key,
        "old-release-key",
        MODULE_ID,
        CHANNEL,
        41,
        LOGIC_ABI_VERSION,
        component.clone(),
    );
    let new = sign_with(
        &new_key,
        "new-release-key",
        MODULE_ID,
        CHANNEL,
        42,
        LOGIC_ABI_VERSION,
        component,
    );
    let trusted = ArtifactVerifier::new(
        MODULE_ID,
        CHANNEL,
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
fn trust_store_configuration_rejects_unsafe_shapes() {
    let key = signing_key(7);
    assert!(ArtifactVerifier::new(
        MODULE_ID,
        CHANNEL,
        1,
        0,
        [(KEY_ID.to_string(), key.verifying_key())]
    )
    .is_err());
    assert!(ArtifactVerifier::new(MODULE_ID, CHANNEL, 1, 1024, []).is_err());
    assert!(ArtifactVerifier::new(
        MODULE_ID,
        CHANNEL,
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
    channel: &str,
    revision: u64,
    platform_abi: u32,
    component: Vec<u8>,
) -> SignedArtifact {
    let envelope = ArtifactEnvelope::unsigned(
        module_id,
        channel,
        revision,
        platform_abi,
        PROTOCOL_VERSION,
        key_id,
        &component,
    )
    .unwrap();
    let signature = key.sign(&envelope.signing_payload().unwrap());
    SignedArtifact::new(envelope.with_signature(&signature), component)
}
