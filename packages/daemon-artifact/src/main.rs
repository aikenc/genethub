use std::path::Path;

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use genet_daemon_platform::{ArtifactEnvelope, SignedArtifact, LOGIC_ABI_VERSION};

const MODULE_ID: &str = "genehub:daemon/logic";
const SIGNING_KEY_ENV: &str = "GENET_DAEMON_LOGIC_SIGNING_KEY";
const DEVELOPMENT_SEED: [u8; 32] = [7; 32];

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    match arguments.as_slice() {
        [command, input, output, version, key_id] if command == "pack" => {
            let encoded = std::env::var(SIGNING_KEY_ENV).map_err(|_| {
                format!("{SIGNING_KEY_ENV} must contain a base64-no-pad 32-byte Ed25519 seed")
            })?;
            let key = parse_signing_key(&encoded)?;
            pack(input, output, version, key_id, &key)
        }
        [command, input, output, version] if command == "pack-dev" => pack(
            input,
            output,
            version,
            "dev-local",
            &SigningKey::from_bytes(&DEVELOPMENT_SEED),
        ),
        [command] if command == "dev-public-key" => {
            let key = SigningKey::from_bytes(&DEVELOPMENT_SEED).verifying_key();
            println!("{}", STANDARD_NO_PAD.encode(key.to_bytes()));
            Ok(())
        }
        [command] if command == "public-key" => {
            let encoded = std::env::var(SIGNING_KEY_ENV).map_err(|_| {
                format!("{SIGNING_KEY_ENV} must contain a base64-no-pad 32-byte Ed25519 seed")
            })?;
            let key = parse_signing_key(&encoded)?.verifying_key();
            println!("{}", STANDARD_NO_PAD.encode(key.to_bytes()));
            Ok(())
        }
        _ => Err(format!(
            "usage:\n  genet-daemon-artifact pack <raw.wasm> <signed.wasm> <version> <key-id>\n  genet-daemon-artifact pack-dev <raw.wasm> <signed.wasm> <version>\n  genet-daemon-artifact public-key\n  genet-daemon-artifact dev-public-key\n\npack/public-key read the secret seed from {SIGNING_KEY_ENV}; pack-dev is never for a release"
        )),
    }
}

fn pack(
    input: impl AsRef<Path>,
    output: impl AsRef<Path>,
    version: &str,
    key_id: &str,
    key: &SigningKey,
) -> Result<(), String> {
    let component = std::fs::read(input.as_ref())
        .map_err(|error| format!("reading {}: {error}", input.as_ref().display()))?;
    let envelope =
        ArtifactEnvelope::unsigned(MODULE_ID, version, LOGIC_ABI_VERSION, key_id, &component)
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

fn parse_signing_key(encoded: &str) -> Result<SigningKey, String> {
    let bytes = STANDARD_NO_PAD
        .decode(encoded.trim())
        .map_err(|_| format!("{SIGNING_KEY_ENV} is not canonical base64-no-pad"))?;
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_| format!("{SIGNING_KEY_ENV} must decode to exactly 32 bytes"))?;
    Ok(SigningKey::from_bytes(&seed))
}
