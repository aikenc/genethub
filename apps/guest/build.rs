fn main() {
    use sha2::Digest;
    let wit = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../wit/genehub-host.wit");
    println!("cargo:rerun-if-changed={}", wit.display());
    let bytes = std::fs::read(&wit).unwrap_or_else(|error| {
        panic!("reading {}: {error}", wit.display());
    });
    let digest = sha2::Sha256::digest(&bytes);
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("genehub-abi.bin");
    std::fs::write(&out, digest).unwrap_or_else(|error| {
        panic!("writing {}: {error}", out.display());
    });
}
