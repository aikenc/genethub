# Capture dependencies

GeneHub Capture is a separate AGPL-3.0-or-later application. The native engine
reuses `backend/native-host` from MoonlightWeb, copyright Bruno Martin, under
GPL-3.0-or-later. “Standalone” describes its build boundary, not a permissive
license. `native/sources.lock.json` pins the source revisions and archive hashes;
`native/prepare.py` applies the checked patches. No Qt or GameStream component
is linked. The complete GeneHub application sources and recipes are in this
repository; do not distribute binaries without the corresponding source and
license obligations being satisfied.

The package copies the native module's original license notice and COPYING,
and dependency notices, into `notices/`. They include Opus (BSD), OpenH264
(BSD), vendor headers (NVIDIA SDK, AMD AMF, Intel oneVPL), ViGEm/WinUHid headers,
Khronos headers, and the pinned Microsoft DirectX-Headers (MIT, Windows only).
These are headers for compiling against the existing Windows runtime; no
Agility SDK runtime is installed or shipped. Some optional components are compiled but never
activated by this app (virtual displays, controllers, elevated input); their
notices are preserved. No kernel driver is installed by this package.

OpenH264 is built from the pinned source; this is not Cisco's downloadable
binary distribution. Its upstream patent/licensing documentation must be
considered before distribution. Linux is a later priority; if its optional
portal backend is enabled, upstream documents a dynamic LGPL libsystemd
dependency in `LICENSE.md`. Rust dependency versions are pinned by Cargo.lock;
their license notices must accompany a distributable release as well. The
current `build.py` creates an unsigned developer package, not a release.
