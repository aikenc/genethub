#!/usr/bin/env python3
"""GeneHub's local macOS code identity: one signer for every program the system tracks.

macOS remembers a privacy grant against a program's *designated requirement*,
not against its bytes. An ad-hoc signature makes that requirement a hash of the
file, so every update looks like a different program and the grant is lost. A
stable certificate plus a fixed identifier keeps the requirement the same
across updates, so the grant survives them. No Apple ID or Developer ID is
needed: the certificate is created on this machine, in a private keychain, and
trusted for code signing only (it does not touch TLS or any system root).

Operations print one JSON object. Exit code 0 = done, 3 = a person must confirm
a system dialog first, anything else = failure with {"error": ...}.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import secrets
import subprocess
import sys
import tempfile

# Shared with Capture's own signer: one identity for everything GeneHub ships.
LOCAL = Path.home() / "Library/Application Support/GeneHubCapture/signing"
CERT_NAME = "GeneHub Capture Local Development"
NEEDS_USER = 3


class NeedsUser(RuntimeError):
    pass


def run(*args, check=True):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError(f"{Path(str(args[0])).name} failed: {(result.stderr or result.stdout).strip()}")
    return (result.stdout or "") + (result.stderr or ""), result.returncode


def private_file(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise RuntimeError(f"expected an owner-only regular file: {path}")
    return path


def identity_record():
    path = LOCAL / "identity.json"
    if not path.exists():
        return None
    identity = json.loads(private_file(path).read_text())["identity"]
    if not re.fullmatch(r"[0-9A-F]{40}", identity):
        raise RuntimeError("invalid local signing certificate fingerprint")
    return identity


def keychain_ready():
    keychain = private_file(LOCAL / "capture.keychain-db")
    password = private_file(LOCAL / "keychain-password").read_text()
    run("/usr/bin/security", "unlock-keychain", "-p", password, keychain)
    listing, _ = run("/usr/bin/security", "list-keychains", "-d", "user")
    paths = re.findall(r'^\s*"(.*)"\s*$', listing, re.MULTILINE)
    if str(keychain) not in paths:
        run("/usr/bin/security", "list-keychains", "-d", "user", "-s", *paths, keychain)
    return keychain


def trusted(fingerprint):
    valid, _ = run("/usr/bin/security", "find-identity", "-v", "-p", "codesigning", check=False)
    return fingerprint in valid


def create():
    if LOCAL.exists() and not (LOCAL / "identity.json").exists():
        # A half-made identity must be inspected, not silently replaced: a new
        # signer would invalidate every grant made to the old one.
        raise RuntimeError(f"incomplete signing identity; preserve and inspect {LOCAL}")
    LOCAL.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(LOCAL, 0o700)
    password = secrets.token_urlsafe(48)
    (LOCAL / "keychain-password").write_text(password)
    os.chmod(LOCAL / "keychain-password", 0o600)
    keychain = LOCAL / "capture.keychain-db"
    run("/usr/bin/security", "create-keychain", "-p", password, keychain)
    os.chmod(keychain, 0o600)
    run("/usr/bin/security", "unlock-keychain", "-p", password, keychain)
    with tempfile.TemporaryDirectory(prefix="certificate-", dir=LOCAL) as directory:
        temporary = Path(directory)
        config = temporary / "openssl.cnf"
        config.write_text("[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=signing\n"
                          f"[dn]\nCN={CERT_NAME}\n"
                          "[signing]\nbasicConstraints=critical,CA:false\n"
                          "keyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning\n")
        key, certificate = temporary / "key.pem", temporary / "certificate.pem"
        run("/usr/bin/openssl", "req", "-new", "-x509", "-newkey", "rsa:3072", "-nodes",
            "-days", "3650", "-config", config, "-keyout", key, "-out", certificate)
        os.chmod(key, 0o600)
        run("/usr/bin/security", "import", certificate, "-k", keychain)
        run("/usr/bin/security", "import", key, "-k", keychain, "-x", "-T", "/usr/bin/codesign")
        run("/usr/bin/security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:",
            "-s", "-k", password, keychain)
        out, _ = run("/usr/bin/openssl", "x509", "-in", certificate, "-noout", "-fingerprint", "-sha1")
        fingerprint = out.strip().split("=")[-1].replace(":", "").upper()
    (LOCAL / "identity.json").write_text(json.dumps({"schema": "genehub-capture-local-signing/1", "identity": fingerprint}) + "\n")
    os.chmod(LOCAL / "identity.json", 0o600)
    return fingerprint


def trust(fingerprint, keychain):
    certificate, _ = run("/usr/bin/security", "find-certificate", "-p", "-c", CERT_NAME, keychain)
    with tempfile.TemporaryDirectory(prefix="trust-", dir=LOCAL) as directory:
        path = Path(directory) / "certificate.pem"
        path.write_text(certificate)
        # macOS asks the person at the machine to confirm this one setting.
        _, code = run("/usr/bin/security", "add-trusted-cert", "-r", "trustRoot", "-p", "codeSign",
                      "-k", keychain, path, check=False)
    if code or not trusted(fingerprint):
        raise NeedsUser("macOS needs a person at this Mac to confirm the code-signing trust prompt")


def ensure():
    created = False
    fingerprint = identity_record()
    if fingerprint is None:
        fingerprint, created = create(), True
    keychain = keychain_ready()
    if not trusted(fingerprint):
        trust(fingerprint, keychain)
    return fingerprint, keychain, created


def macho(path):
    out, _ = run("/usr/bin/file", "-b", path, check=False)
    return "Mach-O" in out


def identifier_for(name):
    name = str(name).lstrip(".")
    return "com.genehub." + re.sub(r"[^A-Za-z0-9.-]", "-", name.replace("genehub-", "", 1))


def describe(path):
    path = Path(path)
    info = {"path": str(path), "exists": path.exists(), "macho": False, "quarantined": False}
    if not path.exists() or not path.is_file():
        return info
    info["macho"] = macho(path)
    quarantine, _ = run("/usr/bin/xattr", "-p", "com.apple.quarantine", path, check=False)
    info["quarantined"] = bool(quarantine.strip()) and "No such xattr" not in quarantine
    if not info["macho"]:
        return info
    text, code = run("/usr/bin/codesign", "-dvv", "--requirements", "-", path, check=False)
    info["signed"] = "not signed at all" not in text
    info["adhoc"] = "Signature=adhoc" in text or "flags=0x20002(adhoc" in text
    identifier = re.search(r"^Identifier=(.+)$", text, re.MULTILINE)
    info["identifier"] = identifier.group(1) if identifier else None
    match = re.search(r"^(?:# )?designated => (.+)$", text, re.MULTILINE)
    info["requirement"] = match.group(1) if match else None
    info["authority"] = [m for m in re.findall(r"^Authority=(.+)$", text, re.MULTILINE)]
    info["stable"] = bool(info["signed"] and not info["adhoc"] and info["requirement"]
                          and "cdhash" not in info["requirement"]
                          and CERT_NAME in " ".join(info["authority"]))
    return info


def op_status(paths):
    fingerprint = identity_record()
    present = fingerprint is not None and (LOCAL / "capture.keychain-db").exists()
    return {"identity": {"present": present, "fingerprint": fingerprint,
                         "trusted": bool(present and trusted(fingerprint)), "name": CERT_NAME},
            "files": [describe(p) for p in paths]}


def op_sign(paths):
    fingerprint, keychain, created = ensure()
    results = []
    for raw in paths:
        # "path" signs a file under its own name; "path::name" signs a staged
        # file under the name it will have once installed, so an update keeps
        # the identifier (and therefore the requirement) of what it replaces.
        raw, _, final_name = raw.partition("::")
        path = Path(raw)
        final_name = final_name or path.name
        before = describe(path)
        if not before["macho"]:
            results.append({"path": str(path), "action": "skipped", "reason": "not a Mach-O file"})
            continue
        stage = path.with_name(f".{path.name}.sign-{os.getpid()}")
        try:
            stage.write_bytes(path.read_bytes())
            os.chmod(stage, path.stat().st_mode & 0o7777)
            run("/usr/bin/xattr", "-c", stage, check=False)
            run("/usr/bin/codesign", "--force", "--sign", fingerprint, "--keychain", keychain,
                "--timestamp=none", "--identifier", identifier_for(final_name), stage)
            run("/usr/bin/codesign", "--verify", "--strict", stage)
            after = describe(stage)
            if before.get("stable") and before.get("requirement") == after.get("requirement"):
                results.append({"path": str(path), "action": "unchanged", "requirement": after["requirement"]})
                continue
            # A new file, never a rewrite: a running copy keeps its own inode, and
            # the system kills a signed process whose file is modified in place.
            os.replace(stage, path)
            results.append({"path": str(path), "action": "signed", "identifier": after["identifier"],
                            "requirement": after["requirement"],
                            "previousRequirement": before.get("requirement")})
        finally:
            if stage.exists():
                stage.unlink()
    return {"identity": fingerprint, "created": created, "files": results}


def op_compatible(old, new):
    before, after = describe(old), describe(new)
    for item in (before, after):
        if not item.get("stable"):
            return {"compatible": False, "reason": f"{item['path']} is not signed with the stable GeneHub identity"}
    ok_new = run("/usr/bin/codesign", "--verify", "--strict", "-R=" + before["requirement"], new, check=False)[1] == 0
    ok_old = run("/usr/bin/codesign", "--verify", "--strict", "-R=" + after["requirement"], old, check=False)[1] == 0
    return {"compatible": ok_new and ok_old, "requirement": before["requirement"]}


def main():
    if platform.system() != "Darwin":
        print(json.dumps({"error": "macOS only"}))
        return 2
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    for name in ("status", "sign"):
        p = sub.add_parser(name)
        p.add_argument("paths", nargs="*")
    p = sub.add_parser("compatible")
    p.add_argument("old")
    p.add_argument("new")
    args = parser.parse_args()
    try:
        if args.operation == "status":
            result = op_status(args.paths)
        elif args.operation == "sign":
            result = op_sign(args.paths)
        else:
            result = op_compatible(args.old, args.new)
    except NeedsUser as error:
        print(json.dumps({"error": str(error), "needsUser": True}))
        return NEEDS_USER
    except Exception as error:  # noqa: BLE001 - reported to the caller as JSON
        print(json.dumps({"error": str(error)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
