fn main() {
    use sha2::Digest;
    let wit = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../wit/genehub-host.wit");
    println!("cargo:rerun-if-changed={}", wit.display());
    let mut bytes = std::fs::read(&wit).unwrap_or_else(|error| {
        panic!("reading {}: {error}", wit.display());
    });
    // Pairing is the WIT text, not the checkout's newline convention. A
    // Windows rustc hashing CRLF and a Linux rustc hashing LF would reject
    // a guest compiled once on Linux.
    bytes.retain(|&b| b != b'\r');
    let digest = sha2::Sha256::digest(&bytes);
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("genehub-abi.bin");
    std::fs::write(&out, digest).unwrap_or_else(|error| {
        panic!("writing {}: {error}", out.display());
    });
}
