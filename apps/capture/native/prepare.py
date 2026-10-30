#!/usr/bin/env python3
"""Fetch the hash-pinned standalone module, codecs and platform header dependencies.
No upstream scripts, product updater, Qt, GameStream or installer are executed.
"""
import argparse
import hashlib
import io
import json
import platform
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
LIMIT = 256 * 1024 * 1024

def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "GeneHub-Capture-build/1"})
    with urllib.request.urlopen(request, timeout=90) as response:
        data = response.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError("source archive exceeds build limit")
    return data

def prepare():
    lock = json.loads((HERE / "sources.lock.json").read_text(encoding="utf-8"))
    cache = HERE / ".cache"
    cache.mkdir(exist_ok=True)
    target = cache / "mw-native-host"
    marker = target / ".genehub-source-lock"
    identity = hashlib.sha256((HERE / "sources.lock.json").read_bytes() + Path(__file__).read_bytes())
    for patch in sorted((HERE / "patches").glob("*")):
        if patch.is_file(): identity.update(patch.name.encode() + patch.read_bytes())
    digest = identity.hexdigest()
    if marker.is_file() and marker.read_text(encoding="utf-8") == digest:
        print("Pinned native sources ready")
        return
    stage = cache / "preparing"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir()
    try:
        for source in lock["sources"]:
            if source.get("platforms") and platform.system() not in source["platforms"]:
                continue
            archive = cache / (source["sha256"] + ".tar.gz")
            data = archive.read_bytes() if archive.is_file() else fetch(source["url"])
            if hashlib.sha256(data).hexdigest() != source["sha256"]:
                raise ValueError("source archive digest mismatch: " + source["name"])
            if not archive.exists():
                archive.write_bytes(data)
            destination = stage / source["destination"]
            destination.mkdir(parents=True, exist_ok=True)
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
                prefix = None
                total = 0
                for member in tar:
                    parts = PurePosixPath(member.name).parts
                    if prefix is None:
                        prefix = parts[0]
                    if not parts or parts[0] != prefix:
                        raise ValueError("invalid source archive root")
                    relative = PurePosixPath(*parts[1:])
                    if source["name"] == "mw-native-host" and str(relative) == "LICENSE" and member.isfile():
                        (stage / "UPSTREAM-COPYING").write_bytes(tar.extractfile(member).read())
                    strip = source.get("subtree", "")
                    if strip:
                        try: relative = relative.relative_to(strip)
                        except ValueError: continue
                    if relative.is_absolute() or ".." in relative.parts:
                        raise ValueError("source path escapes archive")
                    if not member.isfile():
                        if member.issym() or member.islnk():
                            raise ValueError("links are not allowed in the native source subset")
                        continue
                    total += member.size
                    if total > LIMIT: raise ValueError("expanded sources exceed build limit")
                    out = destination.joinpath(*relative.parts)
                    out.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(member) as src, out.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
        # Upstream probe requests TCC permissions. GeneHub's status/probe is
        # read-only; permission guidance is explicit, never a side effect of
        # remote discovery. Patch only these two calls, checking exact counts.
        probe = stage / "src/platform/macos/MacProbe.mm"
        text = probe.read_text(encoding="utf-8")
        # EDID vendor/model/serial can collide (notably serial=0). Use the OS
        # display UUID rather than accepting a different identical panel.
        before = ('d.stableKey = std::to_string(CGDisplayVendorNumber(ids[i])) + "-" +\n'
                  '                          std::to_string(CGDisplayModelNumber(ids[i])) + "-" +\n'
                  '                          std::to_string(CGDisplaySerialNumber(ids[i]));')
        after = '''d.stableKey.clear();
            if (CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(ids[i])) {
                if (CFStringRef string = CFUUIDCreateString(kCFAllocatorDefault, uuid)) {
                    char identity[64] = {};
                    if (CFStringGetCString(string, identity, sizeof(identity), kCFStringEncodingUTF8)) d.stableKey = identity;
                    CFRelease(string);
                }
                CFRelease(uuid);
            }'''
        if text.count(before) != 1: raise ValueError("pinned display identity patch no longer matches")
        text = '#include <ColorSync/ColorSync.h>\n' + text.replace(before, after)
        for call in ("CGRequestPostEventAccess();", "CGRequestScreenCaptureAccess();"):
            if text.count(call) != 1: raise ValueError("pinned preflight patch no longer matches")
            text = text.replace(call, "/* GeneHub: preflight only; grant in System Settings. */")
        probe.write_text(text, encoding="utf-8")
        input_source = stage / "src/input/macos/CgInput.mm"
        content = input_source.read_text(encoding="utf-8")
        if content.count("CGRequestPostEventAccess();") != 1:
            raise ValueError("pinned input preflight patch no longer matches")
        input_source.write_text(content.replace("CGRequestPostEventAccess();", "/* GeneHub: permission requests belong to the local UI. */"), encoding="utf-8")
        shutil.copyfile(HERE / "patches/mac_input.mm", stage / "src/platform/macos/GeneHubInput.mm")
        # The standalone engine defaults to High/CABAC on several GPUs; the
        # initial browser contract is baseline H.264, not a mislabeled stream.
        patches = [
            ("src/encode/macos/VtEncoder.mm", "kVTProfileLevel_H264_High_AutoLevel", "kVTProfileLevel_H264_Baseline_AutoLevel"),
            ("src/encode/macos/VtEncoder.mm", "kVTH264EntropyMode_CABAC", "kVTH264EntropyMode_CAVLC"),
            ("src/encode/macos/VtEncoder.mm", 'profileName = "High";', 'profileName = "Baseline";'),
            ("src/encode/windows/NvencConfig.cpp", "NV_ENC_CONFIG_H264& h264 = config.encodeCodecConfig.h264Config;", "NV_ENC_CONFIG_H264& h264 = config.encodeCodecConfig.h264Config;\n        if (!yuv444) { config.profileGUID = NV_ENC_H264_PROFILE_BASELINE_GUID; h264.entropyCodingMode = NV_ENC_H264_ENTROPY_CODING_MODE_CAVLC; }"),
            ("src/encode/windows/MfEncoder.cpp", "eAVEncH264VProfile_High", "eAVEncH264VProfile_Base"),
            ("src/encode/windows/VplSession.cpp", "case Codec::H264: params.mfx.CodecId = MFX_CODEC_AVC; break;", "case Codec::H264: params.mfx.CodecId = MFX_CODEC_AVC; params.mfx.CodecProfile = MFX_PROFILE_AVC_BASELINE; break;"),
            # Distinguish a new desktop capture from the same held picture encoded
            # again (idle floor, refinement, cursor redraw). The engine already
            # knows; Capture's source-health decision must not guess from stamps.
            ("include/mw/native/EncodedFrame.h", "    bool keyframe = false;", "    bool keyframe = false;\n\n    /// GeneHub: the held picture encoded again, not a new capture.\n    bool repeat = false;"),
            ("src/platform/windows/WindowsSession.cpp", "        out.keyframe = encoded.keyframe;", "        out.keyframe = encoded.keyframe;\n        out.repeat = stamps.resend;"),
            ("src/platform/macos/MacSession.mm", "    int64_t convertedUs = 0;\n};\n\nFrameStamps resendStamps(int64_t nowUs)\n{\n    return FrameStamps{nowUs, nowUs, nowUs, nowUs};\n}", "    int64_t convertedUs = 0;\n    bool resend = false;\n};\n\nFrameStamps resendStamps(int64_t nowUs)\n{\n    return FrameStamps{nowUs, nowUs, nowUs, nowUs, true};\n}"),
            ("src/platform/macos/MacSession.mm", "            out.keyframe = encoded.keyframe;", "            out.keyframe = encoded.keyframe;\n            out.repeat = stamps.resend;"),
            ("src/encode/windows/AmfConfig.cpp", "encoder->SetProperty(props.usage, props.usageUltraLowLatency);", "encoder->SetProperty(props.usage, props.usageUltraLowLatency);\n    if (codec == Codec::H264) encoder->SetProperty(AMF_VIDEO_ENCODER_PROFILE, static_cast<amf_int64>(AMF_VIDEO_ENCODER_PROFILE_BASELINE));"),
        ]
        for path, before, after in patches:
            file = stage / path
            content = file.read_text(encoding="utf-8")
            if content.count(before) != 1:
                raise ValueError("pinned baseline policy patch no longer matches: " + path)
            file.write_text(content.replace(before, after), encoding="utf-8")
        (stage / ".genehub-source-lock").write_text(digest, encoding="utf-8")
        if target.exists(): shutil.rmtree(target)
        stage.rename(target)
        print("Pinned native sources ready (preflight and baseline H.264 policy patches applied)")
    finally:
        if stage.exists(): shutil.rmtree(stage)

if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    prepare()
