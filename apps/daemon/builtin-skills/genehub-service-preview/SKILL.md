---
name: genehub-service-preview
description: Build, register, diagnose, and share a GeneHub service or native WebRTC media preview. Use for local HTTP/WS backends, digital-human or avatar pipelines, remote Unreal Engine (UE) viewing, Pixel Streaming, and PIE/cloud-play requests. Guides runner setup, service permission, offer/stop adaptation, ICE/TURN, and verified experience delivery; identifies UE input and model adapters still needed. For static H5 games, galleries, and file previews use genehub-html-preview.
---

# GeneHub Service Preview

Deliver a running application through a registered workspace entry and GeneHub's trusted controls. Static files use Asset Preview; declared HTTP/WS routes use the service bridge; live audio/video uses the trusted media panel's native WebRTC connection.

## Choose the path

- Static H5, gallery, or prerecorded video: use `genehub-html-preview`.
- Application backend or first service connection: read [getting-started.md](references/getting-started.md).
- Native media or connectivity failure: also read [media-contract.md](references/media-contract.md) for the architecture, exact offer/stop contract, ICE, and cleanup.
- Digital human: read [digital-human.md](references/digital-human.md) before selecting or adapting a model pipeline.
- UE remote viewing, Pixel Streaming, or PIE cloud play: read [unreal-engine.md](references/unreal-engine.md). The current panel has no Pixel Streaming input protocol; receiving video alone does not deliver playable UE.

## Workflow

1. Establish the source machine, workspace entry, viewer, target GeneHub Channel/version, and whether the task needs viewing, microphone interaction, or game input. Inspect existing software and available hardware before choosing dependencies. Preserve the user's chosen engine/model and existing authorization.
2. Locate the actual target daemon data directory and a compatible runner. These are different from the workspace and this Skill's directory. Follow the getting-started reference when the product source is absent; do not invent a CLI registration command or an installed runner path.
3. Build the smallest application adapter that implements the requested behavior. The runner owns one foreground run and checks readiness; it is neither permanent hosting nor an OS sandbox. Only configure backend commands and routes needed for the application.
4. Start the runner and verify registration, service permission, and HTTP/WS behavior. For media, verify real frames/audio and the selected ICE pair through the trusted panel. A health response, SDP answer, or test pattern proves only its own layer.
5. Exercise stop and reconnect, check backend session cleanup, then deliver the existing entry HTML as a workspace-relative file link. Explain how the viewer selects the source machine, opens that workspace/entry, authorizes services, and connects. Use only an observed or configured remote GeneHub address, with required pairing/access; never invent a public URL.

## Boundaries that affect the implementation

- The entry remains a sandboxed static page. Use declared `/api/.../` routes for backend calls; do not point a remote viewer at `127.0.0.1`, embed another site in an iframe, add GeneHub loader scripts, or put a PeerConnection or microphone capture in the entry.
- The user enables service access in the trusted toolbar. `files` permission alone is insufficient. Microphone capture and optional media relay require the trusted panel's user actions; the Agent does not manufacture those gestures or copy credentials into the page.
- `dataPolicy: "direct-only"` governs this service's Fabric data path. It does not mean TURN is enabled or govern other GeneHub features. Media relay remains a separate opt-in.
- An authorized setup request allows necessary local work. Obtain missing authorization for public hosting, paid resources, uploading user media, or changing drivers/system security before those actions; do not add a new approval round for work already authorized.
- Do not edit private registration records to impersonate the runner. Stop normally; clean a stale record only after verifying its owner/run is gone. Keep private records, TURN credentials, and user audio out of shared artifacts.

## Completion evidence

Report the entry link, source machine and target Channel, backend/version and launch/stop instructions, what was actually tested, and the current run lifetime. For media include real content, mic behavior if requested, direct/TURN path and observed RTT, stop cleanup, and tested viewer/network. Separate reference-pattern success from real model inference, UE viewing from game input, and local success from cross-network success. State any missing adapter or runtime plainly and continue the authorized work needed to resolve it; never label a placeholder “ready.”
