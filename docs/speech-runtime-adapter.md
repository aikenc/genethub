# Community speech runtime adapter

Status: GeneHub speech protocol v2, adapter capability schema v1.

GeneHub ships the Composer UI, microphone capture, bounded project/context compiler, correction data path, and a transport-neutral speech contract. It does not ship model weights, a Python/Conda environment, an inference engine, a model server, or a model-specific adapter. Those pieces follow their official or community distribution.

The same application frames are carried between Web and daemon today and can later be carried through Fabric to a paired device. The daemon-to-runtime binding is stdio, not WebSocket.

## Built-in protocol Stub

Before a model is installed, enable **语音协议 Stub（测试模式）** in GeneHub's speech settings. It preserves any registered community adapter but temporarily selects a deterministic `implementation=stub`, `model=no-model` runtime. Real microphone PCM still traverses the normal Web/Fabric-to-daemon stream; the daemon consumes it in memory and the Stub emits revisioned Partial plus fixed segmented N-best results. UI choices from this runtime are blocked from correction/training storage.

Use it as the behavioral baseline for microphone permission, chunk framing, context compilation, full-replacement Partial, final review and uncertain-span UI. It intentionally does not spawn an external process, so it cannot prove an adapter's `--genehub-probe`, `--genehub-stdio`, process lifecycle or model inference. Turn it off before probing a registered adapter.

Implement adapters incrementally:

1. Probe plus Ready/Audio/Finish and one Best-1 Completed result (`maxCandidates: 1`).
2. Cancellation, bounded failures/timeouts and full-replacement Partial.
3. Whole-utterance N-best only when the decoder exposes distinct hypotheses and meaningful scores.
4. VAD/decoder segmentation, segment-local N-best and Unicode uncertain spans last.

The first step is a small framed stdio client; backend startup, model memory and incremental decoding are normally the larger engineering effort. A warm model service behind a bounded adapter client avoids paying model load time inside the 15-second Ready deadline.

## Registration and trust boundary

Only a loopback-local caller can change the machine registration:

```text
genet speech runtime register --command /absolute/path/to/adapter --arg VALUE
genet speech runtime probe
genet speech runtime status
genet speech runtime unregister
```

The command must canonicalize to an existing executable ordinary file. GeneHub does not search `PATH`, parse a command line, invoke a shell, or accept control characters/reserved mode flags. It stores an argv array in the private machine config. Registration probes the proposed adapter before persisting it; unregistering removes only the registration.

Project content cannot select an executable. A paired phone or forwarded client can use an already-registered runtime when granted speech access but cannot register another one.

## Executable modes

GeneHub appends one of these arguments after the registered argv:

### `--genehub-probe`

Print one UTF-8 JSON object to stdout and exit successfully within 10 seconds. Put logs on stderr. Stdout is capped at 256 KiB. GeneHub continuously drains stderr to avoid pipe deadlocks, retains at most the last 64 KiB, and never copies raw stderr into daemon logs or support bundles.

```json
{
  "schema": "genehub.speech-runtime.capabilities.v1",
  "speechProtocolVersion": 2,
  "runtime": {
    "id": "community-qwen3-asr",
    "model": "Qwen/Qwen3-ASR-1.7B-hf",
    "label": "Qwen3-ASR 1.7B",
    "implementation": "example-adapter/1.0.0"
  },
  "audio": [
    { "encoding": "pcmS16Le", "sampleRateHz": 16000, "channels": 1 }
  ],
  "languages": ["zh", "yue", "en"],
  "maxLanguageHints": 1,
  "maxDurationMs": 300000,
  "nBest": {
    "maxCandidates": 1,
    "scoreKind": "unavailable",
    "calibrated": false
  },
  "segmentation": {
    "maxSegments": 0,
    "partialResults": true,
    "localNBest": false,
    "uncertainSpans": false
  }
}
```

GeneHub rejects an incompatible schema/protocol, missing mono 16 kHz PCM, duplicate or malformed languages, values above its limits, mock score declarations from an external runtime, or contradictory local N-best/uncertainty claims.

`scoreKind` is one of:

- `unavailable`: Best-1/no comparable decoder scores;
- `lengthNormalizedLogProbability`: distinct decoder hypotheses with this score shape;
- `mockRelative`: reserved for GeneHub's explicit no-model protocol Stub and rejected from external adapters.

### `--genehub-stdio`

Read GeneHub speech frames from stdin and write response frames to stdout. Write no logs or banners to stdout. The session adapter must send Ready within 15 seconds; expensive model weights should normally remain in a community-owned warm process while this executable acts as its bounded client.

GeneHub terminates the child on cancel, protocol failure, timeout or stream drop. The adapter is responsible for canceling its own downstream request.

Every process exit is recorded with the GeneHub request/correlation ID, runtime/model/implementation, end reason, exit status, forced-kill flag, total stderr byte count, truncation flag, a coarse category and a short fingerprint. Raw stderr is withheld. Keep stderr free of audio, prompts, transcripts, candidates, repository content and secrets anyway: it remains visible to whoever runs the adapter directly, and a future community supervisor may retain it under its own policy.

## Framing

Every record has an eight-byte header followed by a payload:

| Offset | Size | Meaning |
| --- | ---: | --- |
| 0 | 1 | frame version, currently `2` |
| 1 | 1 | kind |
| 2 | 2 | big-endian flags, must be zero |
| 4 | 4 | big-endian payload byte length |
| 8 | N | JSON UTF-8 or Audio binary payload |

Payloads are capped at 256 KiB. Reads and writes may split or coalesce frames, so adapters need an incremental decoder.

Kinds below `0x80` are GeneHub/client to runtime; kinds at or above `0x80` are runtime to GeneHub:

| Kind | Value | Payload |
| --- | ---: | --- |
| Start | `0x01` | `SpeechStart` JSON; must be first |
| Audio | `0x02` | binary audio chunk |
| ContextUpdate | `0x03` | `SpeechContextUpdate` JSON |
| Finish | `0x04` | empty |
| Cancel | `0x05` | `{ "reason": ... }` JSON |
| Ready | `0x80` | `SpeechReady` JSON; must be first response |
| ContextApplied | `0x81` | `{ "revision": number }` JSON |
| Completed | `0x82` | `SpeechCompleted` JSON; terminal |
| Failed | `0x83` | `SpeechFailure` JSON; terminal |
| Partial | `0x84` | `SpeechPartial` JSON |

The canonical Rust types live in `packages/proto/src/speech.rs`; generated TypeScript types live in `packages/proto/bindings/index.ts`.

## Audio payload

Audio payload is ten metadata bytes plus PCM:

| Offset | Size | Meaning |
| --- | ---: | --- |
| 0 | 4 | big-endian monotonically contiguous chunk index |
| 4 | 4 | big-endian capture start in milliseconds |
| 8 | 2 | big-endian duration in milliseconds, 20–200 |
| 10 | N | mono 16 kHz signed 16-bit little-endian PCM |

The byte length must equal `16000 * 2 * durationMs / 1000`; capture start must equal all preceding durations. Total duration is at most five minutes.

## Start, context and Ready

Start includes the request/workspace identity, optional session, exact audio format, bounded language hints, a bounded context snapshot, its revision, and `acceptPartial`.

The context snapshot is at most 16 KiB / 4,000 prompt characters. It may contain explicit `.genethub/speech` terms, recent bounded conversation/draft context and safe project index terms. The adapter passes the prompt to the model only if the selected model supports context; it must fail or declare the limitation rather than silently inventing support.

Ready must echo request ID, the probed runtime/model IDs and context revision. A later ContextUpdate has a strictly increasing revision; ContextApplied acknowledges only a revision the adapter actually began using.

## Partial replacement

An adapter may send Partial only when both its capability and Start opt in:

```json
{
  "requestId": "request-id",
  "revision": 3,
  "text": "complete current Best-1 replacement",
  "audioEndMs": 1840,
  "stablePrefixChars": 6
}
```

Revision is positive and increasing. Text is a full replacement, not a token delta. Character counts use Unicode scalar values. `audioEndMs` cannot exceed received audio, and the stable prefix cannot exceed the text. The Composer renders this text in place; candidates and uncertainty decoration remain final-only.

An adapter that implements pseudo-streaming by repeatedly decoding accumulated audio should declare and measure that behavior honestly because long-dictation cost can grow with every revision.

## Completion and truthful N-best

Completed must match request ID, exact received duration and active context snapshot. Candidate rank 1 must equal `text`; IDs/ranks/texts are unique and bounded. `scoreKind` and calibration must exactly match the probe.

Whole-utterance N-best is not segment-local N-best. To declare `localNBest`, every segment supplies its own candidates and the segments exactly cover the Best-1 text with non-overlapping Unicode offsets and bounded audio times. `uncertainSpans` additionally requires alternatives that reference those real segment candidates. A post-hoc LLM spelling rewrite is not an acoustic decoder hypothesis.

If the backend exposes only generated text, use one candidate, score `0`, `scoreKind: unavailable`, no segments and no uncertain spans. The UI will still provide a good streaming Best-1 experience without misleading the user.

## Failures and lifecycle

Use a typed `SpeechFailure`: runtime unavailable, unsupported language, rejected context, timeout, protocol mismatch, canceled, or internal. Messages should be actionable and must not include secrets, full prompts or repository content. GeneHub bounds child messages, removes control characters and replaces child-supplied correlation IDs with its own.

The daemon applies its own idle/final timeouts, concurrency limit and structural validation. Treat all model/runtime output as untrusted. A successful probe is necessary but not sufficient; release validation should include real audio, context bias, restart persistence, cancel/timeout, and Best-1-only behavior when N-best is absent.
