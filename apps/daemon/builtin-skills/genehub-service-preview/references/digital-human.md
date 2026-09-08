# Digital-human pipeline

Read getting-started and media-contract before implementing the application adapter. GeneHub supplies registration, authorized application transport, trusted microphone controls and media playback. It does not ship an avatar model, ASR/LLM/TTS backend, lip-sync engine, or GPU environment.

## Select from the real task

Establish the requested avatar source, text versus spoken interaction, model/backend already selected, local versus explicitly chosen remote inference, target latency, and source-machine resources. Inspect actual GPU/VRAM/runtime, RAM, disk and existing environments before choosing models. Use the chosen project's official installation and version-specific API documentation; record versions and sources instead of inventing an environment or promising a performance figure.

A typical application owns:

```text
trusted microphone -> backend WebRTC audio track -> optional ASR
text / transcript -> conversation engine -> TTS -> avatar/lip-sync renderer
renderer audio/video tracks -> trusted GeneHub media panel
```

This is a mapping of responsibilities, not a required model stack. Preserve an existing pipeline wherever its real interfaces can be adapted.

## Prove each layer

1. Run the no-model reference media backend first when connectivity is uncertain. It produces a moving test picture and a tone. It sinks incoming microphone audio without recognizing speech; successful playback or mic transport does not prove digital-human inference.
2. Verify the chosen model pipeline independently produces real frames and audio from an allowed sample. Confirm model weights, inference, renderer and audio timing before changing GeneHub signaling.
3. Implement the offer/answer and session-scoped stop contract. Feed the provided ICE servers into the actual media peer, connect generated tracks, bound queues and concurrent sessions, and clean abandoned offers.
4. For a microphone-enabled application, consume the incoming WebRTC audio track and perform the model's actual sample-rate/channel conversion. If the existing pipeline accepts only WS PCM, implement a backend audio adapter. `microphone: "webrtc"` alone does not create that adapter.
5. Keep text/control requests on declared HTTP/WS routes. Adapt custom authentication headers or proprietary endpoints on the backend; never place service/model secrets in entry HTML or private registration data in the workspace.
6. Verify a real user-visible response, audio/video timing, stop/cancel behavior, a second connection, and the requested viewing network. Label untested parts separately.

GeneHub Composer dictation is a separate machine-level ASR contract. Use `genehub-speech-runtime` only when the task also asks to install or configure that feature. Registering a Composer ASR runtime does not wire it into the avatar's media backend.

## Deliver accurately

Provide the registered entry and viewer steps, exact launch/stop commands, model/adapter versions, current process lifetime, measured evidence and unresolved limitations. If only the reference picture works, report “media baseline passed; model pipeline still pending.” If the model works but cannot consume WebRTC input, identify the missing audio adapter and complete that authorized work before claiming voice interaction. Do not turn a request for a local experience into public hosting, remote data upload, training, or permanent GPU service installation.
