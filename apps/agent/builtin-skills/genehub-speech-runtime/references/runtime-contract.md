# GeneHub community speech runtime contract

The canonical implementation document ships with GeneHub at `docs/speech-runtime-adapter.md`. Read that file from the installed source/package when available; this reference is the operational checklist for installation.

## Process modes

The registered absolute executable must accept two GeneHub-owned arguments. GeneHub appends them to the registered argv and never invokes a shell.

- `--genehub-probe`: print exactly one UTF-8 JSON capability document to stdout and exit. Diagnostics go to stderr. Finish within 10 seconds and stay within the output limits.
- `--genehub-stdio`: speak the framed duplex transcription protocol over stdin/stdout. Logs go to stderr. The executable may be a lightweight client for a separately pre-warmed community model service.

GeneHub drains stderr, retains a bounded tail and logs only byte counts, truncation, a coarse category and fingerprint. Never write audio, prompt, transcript, candidates, repository content or secrets to stderr; raw content is deliberately absent from GeneHub support diagnostics.

Generic WebSocket/HTTP/Gradio/OpenAI endpoints do not satisfy this contract directly. An adapter may call them internally, but GeneHub sees only this transport-neutral boundary.

## Built-in Stub baseline

GeneHub settings can select a deterministic `genehub-speech-stub` / `no-model` runtime without removing the registered adapter. It sends real PCM over the normal application stream and returns fixed Partial, N-best, segments and uncertain spans. Stub choices are excluded from correction storage.

Use it to establish the expected UI behavior, then disable it before testing a community adapter. It does not exercise either executable mode below and is not evidence that model inference, subprocess framing or startup works.

Implement the real adapter in this order:

1. `--genehub-probe`, Ready, Audio, Finish and Best-1 Completed with `maxCandidates: 1`.
2. Cancel, bounded errors/timeouts and full-replacement Partial.
3. Whole-utterance N-best only from distinct decoder hypotheses.
4. VAD/decoder segmentation, local N-best and Unicode uncertain spans.

## Capability document

Minimum truthful Best-1 example:

```json
{
  "schema": "genehub.speech-runtime.capabilities.v1",
  "speechProtocolVersion": 2,
  "runtime": {
    "id": "community-qwen3-asr",
    "model": "Qwen/Qwen3-ASR-1.7B-hf",
    "label": "Qwen3-ASR 1.7B",
    "implementation": "community-adapter-name-and-version"
  },
  "audio": [{"encoding":"pcmS16Le","sampleRateHz":16000,"channels":1}],
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

Set `partialResults` false if the backend only returns text after Finish. Set `maxCandidates` above one only for real distinct decoder hypotheses. `uncertainSpans` requires segment-local N-best; a language-model rewrite is not an acoustic candidate.

## Stream behavior

- Framing header: version byte `2`, kind byte, two zero flag bytes, big-endian u32 payload length, then payload. Payload is capped at 256 KiB.
- GeneHub sends Start first, then contiguous Audio frames (mono 16 kHz signed little-endian PCM, normally 20–200 ms), optional increasing ContextUpdate, and Finish or Cancel.
- The runtime sends Ready first. It may send increasing Partial frames only when Start opted in and capabilities declared support. Partial text is a full replacement, not a delta.
- Completed is final and contains Best-1 plus only the N-best/segments actually declared. Failed is terminal.
- IDs, revisions, audio duration, Unicode character offsets, context snapshot, candidate counts/scores and segment coverage are all validated by GeneHub. Invalid or contradictory output terminates the stream.
- A GeneHub-owned `sp_...` correlation ID links Composer failures to daemon/runtime lifecycle logs. An adapter-supplied correlation ID is ignored.

The stdio child is a session adapter, not necessarily the model process. Keep expensive weights in a community-owned warm service and make the registered executable a bounded client if startup would otherwise exceed 15 seconds.

## Registration

Use the installed channel CLI:

```text
genet speech runtime register --command /absolute/path/to/adapter --arg VALUE
genet speech runtime probe
genet speech runtime status
```

Registration is accepted only over the daemon's loopback connection. The command must resolve to an existing executable ordinary file. Arguments are an argv list, capped and never shell-parsed. The daemon probes before persisting.

Rollback only removes registration:

```text
genet speech runtime unregister
```

It does not stop an unrelated community service or delete environments/weights.
