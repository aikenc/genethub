#!/usr/bin/env python3
"""Build an independent developer package on the target OS.
Does not install, start, grant permissions, change daemon files or publish.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
import macos_signing

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

def run(*args):
    subprocess.run([str(arg) for arg in args], check=True, cwd=ROOT)

def archive_source():
    manifest = ROOT / "CAPTURE_SOURCE_IDENTITY.json"
    if not manifest.is_file(): return None
    identity = json.loads(manifest.read_text(encoding="utf-8"))
    if identity.get("schema") != "genehub-capture-source/1": raise RuntimeError("invalid source archive identity")
    for name, expected in identity["files"].items():
        if ".." in Path(name).parts or Path(name).is_absolute(): raise RuntimeError("source identity path escapes archive")
        path = ROOT / name
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected: raise RuntimeError("source archive changed: " + name)
    # Reproducible archives have fixed mtimes. A subsequent source snapshot
    # extracted over a previous one would otherwise look older than Cargo /
    # CMake outputs despite changed content. Force source timestamp checks to
    # see the verified files before either compiler is invoked.
    for name in identity["files"]: os.utime(ROOT / name, None)
    return identity

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--jobs", type=int, default=4)
    signing = parser.add_mutually_exclusive_group()
    signing.add_argument("--mac-local-signing", action="store_true", help="reuse the explicitly initialized machine-local development identity")
    signing.add_argument("--mac-sign-identity", help="existing certificate identity; never an ad-hoc '-'")
    parser.add_argument("--mac-keychain", type=Path, help="keychain containing --mac-sign-identity")
    args = parser.parse_args()
    source = archive_source()
    system = platform.system()
    signing_identity, signing_keychain = None, None
    if system == "Darwin":
        if args.mac_local_signing:
            signing_identity, signing_keychain = macos_signing.local_identity()
        elif args.mac_sign_identity:
            signing_identity, signing_keychain = args.mac_sign_identity, args.mac_keychain
        else:
            parser.error("macOS requires --mac-local-signing or --mac-sign-identity; initialize local signing once with macos_signing.py init-local")
    elif args.mac_local_signing or args.mac_sign_identity or args.mac_keychain:
        parser.error("macOS signing options require macOS")
    if args.mac_keychain and not args.mac_sign_identity:
        parser.error("--mac-keychain requires --mac-sign-identity")
    profile = "Debug" if args.debug else "Release"
    run(sys.executable, HERE / "native/prepare.py")
    run("cmake", "-S", HERE / "native", "-B", HERE / "native/build", f"-DCMAKE_BUILD_TYPE={profile}")
    run("cmake", "--build", HERE / "native/build", "--config", profile, "--parallel", args.jobs)
    run("cargo", "build", "--manifest-path", HERE / "Cargo.toml", "--locked", *([] if args.debug else ["--release"]))
    # CARGO_TARGET_DIR may be configured for the entire developer machine.
    metadata = json.loads(subprocess.check_output(["cargo", "metadata", "--manifest-path", str(HERE / "Cargo.toml"), "--no-deps", "--format-version", "1"], cwd=ROOT))
    built = Path(metadata["target_directory"]) / ("debug" if args.debug else "release")
    package_path = HERE / "dist" / (system.lower() + "-" + platform.machine().lower())
    package_path.parent.mkdir(parents=True, exist_ok=True)
    # Compile/package/sign/verify before touching the last successful package.
    staging = tempfile.TemporaryDirectory(prefix=".capture-build-", dir=package_path.parent)
    output = Path(staging.name) / package_path.name
    output.mkdir()
    binary_name = "genehub-capture.exe" if system == "Windows" else "genehub-capture"
    library_name = "genehub-capture-engine.dll" if system == "Windows" else "libgenehub-capture-engine." + ("dylib" if system == "Darwin" else "so")
    executable_dir = output
    resources = output
    if system == "Darwin":
        contents = output / "GeneHub Capture.app/Contents"
        executable_dir = contents / "MacOS"
        resources = contents / "Resources"
        executable_dir.mkdir(parents=True); resources.mkdir()
        with (contents / "Info.plist").open("wb") as file:
            plistlib.dump({"CFBundleIdentifier": "com.genehub.capture", "CFBundleName": "GeneHub Capture",
                "CFBundleExecutable": binary_name, "CFBundlePackageType": "APPL", "CFBundleVersion": "1",
                "CFBundleShortVersionString": "0.1.0", "LSMinimumSystemVersion": "12.3",
                "NSHighResolutionCapable": True,
                "NSLocalNetworkUsageDescription": "Connect an authorized browser to this desktop preview over the local network.",
                "NSMicrophoneUsageDescription": "Remote desktop does not request microphone capture."}, file)
    shutil.copy2(built / binary_name, executable_dir / binary_name)
    candidates = [HERE / "native/build" / library_name, HERE / "native/build" / profile / library_name]
    library = next((path for path in candidates if path.is_file()), None)
    if library is None: raise RuntimeError("native library missing after successful build")
    shutil.copy2(library, executable_dir / library_name)
    shutil.copytree(ROOT / "apps/daemon/builtin-skills/genehub-preview/assets/remote-desktop", resources / "client")
    # Preserve notices as shipped, including vendor header SDK licenses. Also
    # carry our patches, lock and build recipe for the modified native module.
    notices = resources / "notices"
    notices.mkdir()
    native = HERE / "native/.cache/mw-native-host"
    for path in native.rglob("*"):
        if path.is_file() and any(word in path.name.lower() for word in ("license", "copying", "notice")):
            destination = notices / path.relative_to(native)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
    for path in [ROOT / "LICENSE", HERE / "THIRD_PARTY.md"]:
        shutil.copy2(path, notices / path.name)
    recipes = resources / "native-source"
    recipes.mkdir()
    for name in ("prepare.py", "sources.lock.json", "CMakeLists.txt", "capture.h", "capture.cpp", "manager_mac.mm", "manager_win.cpp", "manager_none.cpp"):
        shutil.copy2(HERE / "native" / name, recipes / name)
    shutil.copytree(HERE / "native/patches", recipes / "patches")
    shutil.copy2(HERE / "README.md", resources / "README.md")
    signature = macos_signing.sign(output / "GeneHub Capture.app", signing_identity, signing_keychain) if system == "Darwin" else None
    if source is not None:
        revision, dirty = source["revision"], source["dirty"]
    else:
        revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip()
        dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT))
    files = {str(path.relative_to(output)).replace(os.sep, "/"): hashlib.sha256(path.read_bytes()).hexdigest()
             for path in sorted(output.rglob("*")) if path.is_file()}
    (output / "build.json").write_text(json.dumps({"schema": "genehub-capture-build/1", "system": system,
        "arch": platform.machine(), "profile": profile, "revision": revision, "dirty": dirty,
        "signed": signature is not None, "signing": signature, "notarized": False,
        "sourceDigest": hashlib.sha256(json.dumps(source["files"], sort_keys=True).encode()).hexdigest() if source else None,
        "nativeSources": json.loads((HERE / "native/sources.lock.json").read_text(encoding="utf-8")), "files": files}, indent=2) + "\n", encoding="utf-8")
    # dist is build output, not the durable installation. On macOS refuse to
    # overwrite a bundle still used by a Capture process from an earlier build.
    if system == "Darwin" and package_path.exists():
        executable = str(package_path / "GeneHub Capture.app/Contents/MacOS/genehub-capture")
        for line in macos_signing.command("/bin/ps", "-axo", "pid=,comm=").splitlines():
            fields = line.strip().split(None, 1)
            if len(fields) == 2 and fields[1] == executable:
                raise RuntimeError("Capture is running from dist; stop it and use a durable installed bundle")
    previous = Path(staging.name) / "previous"
    if package_path.exists(): package_path.rename(previous)
    try:
        output.rename(package_path)
    except BaseException:
        if previous.exists(): previous.rename(package_path)
        raise
    staging.cleanup()
    print(package_path)

if __name__ == "__main__": main()
