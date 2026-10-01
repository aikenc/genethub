# Local ASR model selection

Last source review: 2026-08-12. Re-check the linked primary source before installation because packages, backends, licenses, and hardware support change.

## Default family

### Qwen3-ASR-1.7B

- Checkpoint: `Qwen/Qwen3-ASR-1.7B-hf`.
- Default for GeneHub's 8–16 GB GPU target when Chinese/multilingual recognition, domain prompt context, and accuracy matter most.
- Qwen documents 30 languages plus 22 Chinese dialects, unified offline/streaming inference, long-audio transcription, and free-form context/hotwords through a prompt.
- Native Transformers support was announced on 2026-06-26; the official `qwen-asr` package also offers a vLLM backend. Qwen documents streaming on the vLLM path. Confirm the chosen adapter/backend instead of assuming both paths have the same behavior.
- The high-level official examples return transcription text/language and optional forced-alignment timestamps. They do not establish true N-best. Default the adapter to Best-1 unless it implements and tests distinct beam hypotheses.
- Primary sources: [official repository](https://github.com/QwenLM/Qwen3-ASR), [native Transformers model card](https://huggingface.co/Qwen/Qwen3-ASR-1.7B-hf).

### Qwen3-ASR-0.6B

- Checkpoint: `Qwen/Qwen3-ASR-0.6B-hf`.
- Same documented language/dialect family and context-oriented interface, with a lower resource/latency target and lower reported accuracy than 1.7B on Qwen's tables.
- Prefer it when the measured GPU/backend cannot keep 1.7B reliably resident, or when power and first-partial latency dominate.
- Primary sources: [official repository](https://github.com/QwenLM/Qwen3-ASR), [native Transformers model card](https://huggingface.co/Qwen/Qwen3-ASR-0.6B-hf).

### Qwen3-ForcedAligner-0.6B

- This is an optional aligner, not the transcription model.
- Qwen documents word/character timestamps for up to five minutes in 11 languages. It adds weights, memory and latency; do not install it for the first Best-1-only release unless timestamps are required.
- Primary source: [official repository](https://github.com/QwenLM/Qwen3-ASR).

## Comparable checkpoints requiring their own adapter

None of these is directly compatible merely because it accepts audio. The adapter must implement `genehub.speech-runtime.capabilities.v1` and the GeneHub speech-v2 stdio frames.

### Fun-ASR-Nano-2512 / Fun-ASR-MLT-Nano-2512 — 0.8B

- Strong alternative for Chinese dialects, accents, hotwords and low-latency ASR. The official card lists 0.8B and an Apache-2.0 license; the MLT variant expands to 31 languages.
- Its runtime/tooling and feature vocabulary differ from Qwen3. Validate whether contextual terms, streaming partials and actual decoder alternatives can be mapped truthfully.
- Primary source: [FunAudioLLM model card](https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-2512).

### GLM-ASR-Nano-2512

- Chinese/English alternative with MIT-licensed weights and a current Transformers integration on its official model page.
- Do not infer parameter count or streaming/N-best support from “Nano”; use the current config/model card and measured runtime. Consider it only after language and adapter fit are demonstrated.
- Primary source: [Z.ai model page](https://huggingface.co/zai-org/GLM-ASR-Nano-2512).

### Voxtral Mini 3B 2507

- Mistral markets the language backbone as 3B, while the Hugging Face card reports 5B total parameters including audio components. It documents eight languages, a 32k transcription context, up to 30 minutes, Apache-2.0, and about 9.5 GB GPU RAM in bf16/fp16.
- It can fit some 12–16 GB systems but is not the default for Chinese, which is not in the documented eight-language transcription set.
- Primary source: [Mistral model card](https://huggingface.co/mistralai/Voxtral-Mini-3B-2507).

### NVIDIA Parakeet-TDT-0.6B-v3

- Efficient 0.6B transducer with 25 documented European languages, punctuation and timestamps; the official card documents NeMo, a native NeMo-Speech.cpp path, and streaming examples.
- It does not document Chinese support, so it is inappropriate for the primary Chinese professional-terminology use case but can be a strong European-language/throughput option.
- Primary source: [NVIDIA model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3).

## Selection cautions

- Leaderboard WER is dataset- and normalization-specific. Do not rank a Chinese project from an English-only mean.
- Quantized community artifacts must preserve the model license and be supported by the selected runtime. “4-bit exists” is not proof of acceptable accuracy, working streaming, or an 8 GB end-to-end fit.
- Long language-model context is not the same as bounded ASR prompt context. GeneHub currently sends at most 4,000 prompt characters / 16 KiB total context and five minutes of mono 16 kHz PCM.
- LoRA/DPO is a separate training workflow. A 24 GB fine-tuning ceiling does not change the inference adapter's truthful capability declaration.
