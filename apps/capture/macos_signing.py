#!/usr/bin/env python3
"""Capture's macOS code identity and compatible local updates.

Local development signing is opt-in and machine-local. Its user certificate is
trusted only for code signing; it does not grant TCC access. Distribution uses an explicitly
supplied signing identity instead. Never create a fresh identity per build.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import subprocess
import tempfile

IDENTIFIER = "com.genehub.capture"
LOCAL = Path.home() / "Library/Application Support/GeneHubCapture/signing"


def command(*args):
    # In particular, never echo arguments containing keychain passwords.
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"{Path(args[0]).name} failed: {result.stderr.strip()}")
    return result.stdout + result.stderr


def private_file(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise RuntimeError(f"expected an owner-only regular file: {path}")
    return path


def local_identity():
    record = json.loads(private_file(LOCAL / "identity.json").read_text())
    identity = record["identity"]
    if not re.fullmatch(r"[0-9A-F]{40}", identity):
        raise RuntimeError("invalid local signing certificate fingerprint")
    keychain = private_file(LOCAL / "capture.keychain-db")
    password = private_file(LOCAL / "keychain-password").read_text()
    command("/usr/bin/security", "unlock-keychain", "-p", password, keychain)
    # codesign --keychain limits identity lookup, but certificate-chain lookup
    # still uses the user's search list (including this self-signed leaf).
    search = command("/usr/bin/security", "list-keychains", "-d", "user")
    paths = re.findall(r'^\s*"(.*)"\s*$', search, re.MULTILINE)
    if str(keychain) not in paths:
        command("/usr/bin/security", "list-keychains", "-d", "user", "-s", *paths, keychain)
    return identity, keychain


def init_local():
    if (LOCAL / "identity.json").exists():
        identity, _ = local_identity()
        return {"identity": identity, "created": False}
    # A partial initialization must be inspected rather than silently rotating
    # the signer and invalidating all previous privacy grants.
    if LOCAL.exists():
        raise RuntimeError(f"incomplete signing identity; preserve and inspect {LOCAL}")
    LOCAL.mkdir(parents=True, mode=0o700)
    os.chmod(LOCAL, 0o700)
    password = secrets.token_urlsafe(48)
    (LOCAL / "keychain-password").write_text(password)
    os.chmod(LOCAL / "keychain-password", 0o600)
    keychain = LOCAL / "capture.keychain-db"
    command("/usr/bin/security", "create-keychain", "-p", password, keychain)
    os.chmod(keychain, 0o600)
    command("/usr/bin/security", "unlock-keychain", "-p", password, keychain)
    with tempfile.TemporaryDirectory(prefix="certificate-", dir=LOCAL) as directory:
        temporary = Path(directory)
        config = temporary / "openssl.cnf"
        config.write_text("[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=signing\n"
                          "[dn]\nCN=GeneHub Capture Local Development\n"
                          "[signing]\nbasicConstraints=critical,CA:false\n"
                          "keyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning\n")
        key, certificate = temporary / "key.pem", temporary / "certificate.pem"
        command("/usr/bin/openssl", "req", "-new", "-x509", "-newkey", "rsa:3072", "-nodes",
                "-days", "3650", "-config", config, "-keyout", key, "-out", certificate)
        os.chmod(key, 0o600)
        command("/usr/bin/security", "import", certificate, "-k", keychain)
        command("/usr/bin/security", "import", key, "-k", keychain, "-x", "-T", "/usr/bin/codesign")
        command("/usr/bin/security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:",
                "-s", "-k", password, keychain)
        fingerprint = command("/usr/bin/openssl", "x509", "-in", certificate, "-noout", "-fingerprint", "-sha1")
        identity = fingerprint.strip().split("=")[-1].replace(":", "").upper()
    (LOCAL / "identity.json").write_text(json.dumps({"schema": "genehub-capture-local-signing/1", "identity": identity}) + "\n")
    os.chmod(LOCAL / "identity.json", 0o600)
    trust_local()
    return {"identity": identity, "created": True}


def trust_local():
    identity, keychain = local_identity()
    # Only the public certificate is exported. macOS may request local Human
    # authentication for this one-time user-domain code-signing trust setting.
    certificate = command("/usr/bin/security", "find-certificate", "-p", "-c", "GeneHub Capture Local Development", keychain)
    with tempfile.TemporaryDirectory(prefix="trust-", dir=LOCAL) as directory:
        path = Path(directory) / "certificate.pem"
        path.write_text(certificate)
        command("/usr/bin/security", "add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", keychain, path)
    return {"identity": identity, "trust": "user-domain codeSign only"}


def inspect(app):
    command("/usr/bin/codesign", "--verify", "--deep", "--strict", app)
    description = command("/usr/bin/codesign", "--display", "--verbose=2", "--requirements", "-", app)
    match = re.search(r"^(?:# )?designated => (.+)$", description, re.MULTILINE)
    if f"Identifier={IDENTIFIER}\n" not in description or "Signature=adhoc" in description or not match:
        raise RuntimeError("Capture requires a certificate-backed bundle identity")
    requirement = match.group(1)
    if "cdhash" in requirement or ("certificate" not in requirement and "anchor" not in requirement):
        raise RuntimeError("Capture requirement must bind its signer, not a mutable binary hash")
    return {"identifier": IDENTIFIER, "requirement": requirement,
            "executableSha256": hashlib.sha256((app / "Contents/MacOS/genehub-capture").read_bytes()).hexdigest()}


def compatible(old, new):
    before, after = inspect(old), inspect(new)
    # Use the OS evaluator, not equality of a hand-built identifier string.
    command("/usr/bin/codesign", "--verify", "--strict", "-R=" + before["requirement"], new)
    command("/usr/bin/codesign", "--verify", "--strict", "-R=" + after["requirement"], old)
    return before, after


def sign(app, identity, keychain=None):
    if identity == "-":
        raise RuntimeError("ad-hoc signing cannot retain Capture permissions across executable updates")
    options = ["--force", "--sign", identity, "--timestamp=none"]
    if keychain:
        options += ["--keychain", str(keychain)]
    command("/usr/bin/codesign", *options, app / "Contents/MacOS/libgenehub-capture-engine.dylib")
    command("/usr/bin/codesign", *options, "--identifier", IDENTIFIER, app)
    return inspect(app)


@contextmanager
def update_locks():
    import fcntl
    # The same OS locks used by the real app and its independent input guard.
    # Hold both through replacement so a new app cannot start mid-update.
    root = LOCAL.parent
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    handles = []
    try:
        for name in ("instance.lock", "input.lock"):
            path = root / name
            fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            handles.append(fd)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    except BlockingIOError as error:
        raise RuntimeError("stop Capture and wait for its input guard to exit before updating") from error
    finally:
        for fd in handles:
            os.close(fd)


def install(candidate, destination):
    with update_locks():
        return install_stopped(candidate, destination)


def install_stopped(candidate, destination):
    candidate, destination = candidate.resolve(), destination.absolute()
    identity = inspect(candidate)
    if destination.is_symlink():
        raise RuntimeError("refusing a symlink installation target")
    if destination.exists():
        compatible(destination, candidate)
        executable = str(destination.resolve() / "Contents/MacOS/genehub-capture")
        for line in command("/bin/ps", "-axo", "pid=,comm=").splitlines():
            fields = line.strip().split(None, 1)
            if len(fields) == 2 and fields[1] == executable:
                raise RuntimeError(f"stop Capture PID {fields[0]} before updating its bundle")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".capture-update-", dir=destination.parent) as directory:
        stage, previous = Path(directory) / destination.name, Path(directory) / "previous.app"
        shutil.copytree(candidate, stage, symlinks=True)
        inspect(stage)
        if destination.exists():
            compatible(destination, stage)
            destination.rename(previous)
        try:
            stage.rename(destination)
        except BaseException:
            if previous.exists():
                previous.rename(destination)
            raise
    return {"installed": str(destination), **identity}


def main():
    if platform.system() != "Darwin":
        raise RuntimeError("macOS signing and update verification require macOS")
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    sub.add_parser("init-local")
    sub.add_parser("trust-local", help="complete the one-time code-signing trust setup without changing the existing signer")
    show = sub.add_parser("inspect")
    show.add_argument("app", type=Path)
    update = sub.add_parser("install")
    update.add_argument("candidate", type=Path)
    update.add_argument("destination", type=Path)
    args = parser.parse_args()
    if args.operation == "init-local":
        result = init_local()
    elif args.operation == "trust-local":
        result = trust_local()
    elif args.operation == "inspect":
        result = inspect(args.app)
    else:
        result = install(args.candidate, args.destination)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
