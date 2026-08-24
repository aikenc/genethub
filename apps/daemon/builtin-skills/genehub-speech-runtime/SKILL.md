---
name: genehub-speech-runtime
description: Safely test GeneHub's built-in speech protocol Stub, inspect this PC, recommend and install through official or community instructions, and register a local speech-to-text runtime. Use when a user asks to test the speech path, implement an adapter, install, configure, replace, diagnose, verify, or remove Qwen3-ASR or another local ASR model, or when GeneHub reports that its speech runtime is unavailable. Covers GPU/VRAM-aware selection, explicit approval before mutations, the GeneHub adapter contract, honest Partial/N-best capability declarations, smoke tests, and rollback.
---

# GeneHub Speech Runtime

Connect a user-owned local ASR runtime to GeneHub without making GeneHub the model installer or model server. Prefer Qwen3-ASR-1.7B for the target 8–16 GB GPU class, but select from measured hardware and the user's languages rather than from a model name alone.

Read [references/models.md](references/models.md) before recommending a checkpoint. Read [references/runtime-contract.md](references/runtime-contract.md) before selecting or registering an adapter.

## Non-negotiable boundaries

- GeneHub owns the UI, bounded context and feedback data, transport-neutral speech frames, and local registration/probe interface.
- Model weights, Python/Conda/Docker environments, inference engines, drivers, and background model services come from the model author or community.
- Do not download weights, create or alter an environment, install packages or drivers, start or enable a service, register a runtime, or remove files until the user has approved the exact plan.
- Never use `sudo`, alter a GPU driver, expose a listening service beyond loopback, or weaken system security without a separate explicit request and confirmation.
- Never claim N-best, calibrated confidence, uncertain spans, timestamps, streaming, or context support unless the selected adapter actually emits and declares it. Best-1-only is a valid first delivery.
- Treat GeneHub's built-in protocol Stub as no-model test data. It exercises the normal microphone-to-daemon path but does not prove external stdio, model inference or accuracy, and its candidate choices must never enter training data.
- Never fabricate GPU model, VRAM, CUDA support, disk needs, benchmark results, or successful inference. Report unknowns and evidence.
- Do not put an executable, environment, model cache, or registration inside the current project. Registration is machine-level; project-local `.genethub/speech` is only for context and opt-in corrections.
- Do not upload audio, context, corrections, repository content, or hardware details unless the user explicitly chooses a remote community service.

## Workflow

### 1. Inspect without changing the machine

Collect only what is needed:

- OS and architecture.
- GPU vendor/model, dedicated VRAM, driver and available CUDA/ROCm/Metal runtime.
- System RAM and free space on the proposed installation volume.
- Existing isolated environment managers, containers, and already-downloaded model caches.
- Current GeneHub state using the shipped CLI.

Use the exact front-door CLI path supplied in the GeneHub built-in Skill catalog and in `GENEHUB_CLI`. If neither is available, stop and report that this session has no CLI binding. Never guess a channel command. Run:

```text
"$GENEHUB_CLI" speech runtime status
```

If that variable is absent, locate the installed GeneHub CLI without installing anything, then run the equivalent command. Do not treat an unavailable registration as a failed model installation.

Summarize observed facts in a compact table. Ask before running any hardware command that itself needs elevated access.

### 2. Establish the no-model protocol baseline

When the user wants to test the flow or the runtime is unavailable, offer the **语音协议 Stub（测试模式）** switch in speech settings. Ask before changing the persisted setting. With Stub enabled, verify real microphone permission and waveform, PCM chunk delivery, revisioned Partial, final segmented N-best and local candidate replacement. Confirm the UI says `Stub`, `no-model` and fixed test text.

The Stub preserves a registered adapter and restores it when disabled. It does not spawn `--genehub-stdio`; disable it before probing or smoke-testing a real adapter. Do not diagnose model accuracy from Stub text and do not manufacture preference records from its fixed candidates.

Use the Stub result as a behavioral baseline: a real Best-1 adapter first needs to match Ready, Audio, Finish and Completed; add Partial next; add N-best/segments only when the backend exposes real decoder evidence. See `references/runtime-contract.md`.

### 3. Recommend one primary plan

Use this order:

1. `Qwen/Qwen3-ASR-1.7B-hf` for an 8–16 GB supported GPU when Chinese/multilingual professional vocabulary and prompt context are priorities.
2. `Qwen/Qwen3-ASR-0.6B-hf` when measured memory, latency, power, or backend support makes 1.7B unsuitable.
3. A comparable model only when its language/runtime strengths better match the user. Comparable does not mean protocol-compatible; it still needs a GeneHub v1 adapter.

Treat quantization as a backend-specific community capability. A model fitting on disk does not prove its runtime, KV/cache, audio encoder, or long-dictation working set fits VRAM. Prefer a documented working backend over an arbitrary bit width.

State clearly that Qwen's documented high-level transcription path does not by itself prove true N-best. Register `maxCandidates: 1` unless the adapter exposes distinct decoder hypotheses with meaningful scores.

### 4. Present the mutation plan and wait

Before making changes, show:

- chosen checkpoint and why it fits the measured hardware/languages;
- official/community source, license, backend and adapter source;
- exact install/environment location, estimated download and free-space requirement from current source material;
- expected precision/quantization and a conservative VRAM caveat;
- every package/environment/service command to be run;
- whether a loopback service remains running and how it starts/stops;
- the absolute adapter executable that will be registered;
- what capability claims will be declared, especially Partial and N-best;
- rollback steps that preserve unrelated caches and environments.

Ask for explicit approval. A request to “inspect” or “recommend” is not approval to install.

### 5. Follow the selected community installation

After approval, follow the current official model/backend documentation rather than inventing dependency versions. Use a fresh isolated environment at the approved non-project location. Pin versions or image digests when the source supports it and retain the source URL and observed version in the handoff.

For Qwen3, prefer the native Transformers path for a simple Best-1 baseline or the official vLLM path when the adapter requires documented streaming. Do not add the forced aligner unless the user needs timestamps; it is a separate model and memory cost.

Install or select a community adapter that implements the exact contract in `references/runtime-contract.md`. A generic HTTP, OpenAI-compatible, Gradio, or WebSocket ASR endpoint is not directly registrable. Do not generate an unreviewed shell wrapper that hides such an incompatibility.

If the model works but no compatible adapter exists, stop with the truthful state `model ready, GeneHub adapter missing`. Provide the contract link and do not register a fake runtime.

### 6. Probe and register transactionally

The adapter command must be an existing absolute executable path. GeneHub does not search `PATH`, use a shell, or accept registration over a paired/forwarded connection.

Run the local registration command, repeating `--arg` for each literal argument:

```text
"$GENEHUB_CLI" speech runtime register --command /absolute/path/to/adapter --arg VALUE
```

Arguments that begin with `--` are values after `--arg`, not GeneHub options. Registration first validates the path and bounded capability document, actively probes the adapter, and persists only a successful candidate.

Then verify independently:

```text
"$GENEHUB_CLI" speech runtime probe
"$GENEHUB_CLI" speech runtime status
```

Inspect the JSON envelope. Require `state: ready`, the intended model ID, mono 16 kHz PCM support, and capability claims that match the adapter. Do not interpret process exit 0 alone as proof.

Registration of a successfully probed adapter disables Stub mode. Verify the reported runtime/model is the community adapter, not `genehub-speech-stub`/`no-model`.

### 7. Smoke-test the user path

Ask the user before activating the microphone. In GeneHub:

1. Open a real project and place the caret in the normal Composer input.
2. Add one harmless project term to `.genethub/speech/terms.txt` or pinned terms.
3. Dictate a short sentence containing that term.
4. Verify waveform movement, bounded chunk delivery, in-place Best-1 revisions when Partial is declared, and a final transcript.
5. If the runtime declares local N-best/uncertain spans, verify a non-default choice and the opt-in correction record. If it declares Best-1 only, verify that no candidate UI is invented.
6. Repeat after a daemon restart to prove registration persistence and model-service startup behavior.

Record observed first-partial latency and finalization latency without presenting one machine's result as a general benchmark.

### 8. Roll back safely

Registration rollback never deletes the model or environment:

```text
"$GENEHUB_CLI" speech runtime unregister
```

Probe afterward and expect an actionable unavailable state. Stop/disable only the service created in the approved plan. Ask for a second explicit confirmation before deleting an environment or weights, and never delete a shared model cache recursively.

## Corrections and later tuning

GeneHub can opt in separately for each project to store explicit human candidate choices in `.genethub/speech/preferences.jsonl` and learned terms in `.genethub/speech/learned-terms.txt`. Treat these as private project data. GeneHub defaults both generated files into `.genethub/speech/.gitignore`; disabling collection does not delete them. The daemon binds each record to a recent validated completion and records the runtime/model actually used, so do not manufacture, rewrite or import candidate text through the feedback RPC. They are preference pairs suitable for a later DPO/reranker pipeline only when the rejected alternative is a real decoder hypothesis and the selected text is human-confirmed.

When diagnosing an adapter failure, ask for the `sp_...` error number shown in the Composer and inspect GeneHub logs for the matching correlation ID. Report the lifecycle stage, runtime identity, exit code, stderr category/fingerprint and timing; do not paste raw stderr, transcript, candidate, prompt or project content into a support report.

Installing a runtime does not authorize training, aggregation, upload, or LoRA. Before any later fine-tuning, obtain separate consent, define redaction and train/eval splits, preserve context snapshot and audio provenance where legally allowed, and hold out project- and speaker-disjoint evaluation data.

## Completion report

Return:

- measured hardware and selected model/backend;
- exact authoritative/community sources and versions;
- model and adapter locations without secrets;
- registered command as an argv array, not a shell command line;
- probed capability document and any deliberately disabled features;
- smoke-test evidence and observed latency;
- whether the Stub baseline passed and proof that the final smoke used the real adapter;
- service lifecycle and rollback command;
- remaining limitation, especially Best-1-only or missing adapter.

Do not say “installed” or “ready” unless both model inference and GeneHub probe were verified.
