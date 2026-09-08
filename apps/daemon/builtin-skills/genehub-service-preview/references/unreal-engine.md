# Unreal Engine viewing and cloud play

## First distinguish the requested outcome

| Request | Evidence needed |
|---|---|
| View a running UE scene remotely | Real UE frames/audio, correct source instance, media reachability and cleanup |
| Control the game remotely | Viewing plus actual keyboard/mouse/touch/gamepad input, focus and disconnect behavior |
| Preview or play inside the Editor (PIE) | Exact UE version and run mode, demonstrated editor/viewport support, then viewing/input evidence |

The current GeneHub `ServiceMediaPanel` negotiates audio/video and optional microphone. It has no Pixel Streaming DataChannel input implementation, pointer-lock/gamepad controls, or shipped UE adapter. The GeneHub data-plane DataChannel is a separate transport and does not provide UE input. Do not call a received video stream “cloud play.”

## Version-specific source of truth

Check the installed UE version, Pixel Streaming versus Pixel Streaming 2 plugin, selected project, encoder/GPU support, and the matching Infrastructure branch before choosing commands. Read the matching version of Epic's documentation; links below are unpinned discovery entrypoints, not a claim about every engine version:

- [Getting Started with Pixel Streaming](https://dev.epicgames.com/documentation/en-us/unreal-engine/getting-started-with-pixel-streaming-in-unreal-engine): distinguishes packaged application and Standalone Game setup. Do not generalize this to every PIE mode.
- [Pixel Streaming in Editor](https://dev.epicgames.com/documentation/en-us/unreal-engine/pixel-streaming-in-editor): describes a separate experimental editor-streaming route. Inspect the target version and actual viewport/editor behavior before promising support.
- [Official Pixel Streaming Infrastructure](https://github.com/EpicGamesExt/PixelStreamingInfrastructure): select the branch/release matching UE, including the actual signaling and frontend input protocol. Do not use master merely because it is latest.

## Integration work

First establish that Epic's matching player can view/control the chosen local UE instance. Record the engine version, plugin, launch mode and command, then stop that baseline when handing lifecycle ownership to a runner. The runner refuses occupied backend ports; it does not attach transparently to an already running service.

For GeneHub viewing, implement and test an application adapter against [media-contract.md](media-contract.md). GeneHub sends one browser offer by HTTP and expects an answer. Inspect the selected Pixel Streaming signaling roles, candidate exchange, codecs and session lifecycle; do not assume the engine's WebSocket signaling server accepts that HTTP shape. A signaling adapter must reconcile both sides and pass ICE configuration to the actual UE media peer. If that requires media termination/re-encoding rather than signaling alone, disclose the additional latency/resources and keep that work in the application backend.

For cloud play, also implement the viewer input and engine protocol path. The trusted media panel has no extension slot for an arbitrary Pixel Streaming frontend. A GeneHub product change may be needed for authorized input capture, protocol versioning, focus, key-up release on disconnect, touch/gamepad support, input ownership and bounded backpressure. An HTTP/WS control adapter can serve deliberate application actions where appropriate, but is not automatically a replacement for Pixel Streaming game input. Do not inject engine scripts into the trusted panel or weaken the static sandbox to bypass that gap.

If the user chooses Epic's standalone player as the experience instead, treat it as a separate application/deployment with an actually verified address and access control. Do not embed it in Asset Preview or call it an existing GeneHub-native integration. Public hosting and permanent availability require their own authorized setup.

## Acceptance

Verify the requested UE scene is running in the intended mode, frames/audio arrive, and media path/RTT are observed. For play, verify requested device inputs produce game actions, losing focus does not leave keys stuck, disconnect releases control, and reconnection targets the intended instance. For PIE, test the specified Editor mode explicitly; Standalone Game success does not prove in-viewport PIE support.

Stop media and verify per-viewer resource cleanup, then stop the owned runner and its backend process tree. Do not assume a launcher exiting, an existing Editor outside that tree, or an independently detached UE process is managed by the runner. State who owns those processes and how they stop. Report the working entry/address, required viewer access, source-machine lifetime, and remaining adaptation work. No UE input or PIE verification means that part remains incomplete.
