/**
 * Privacy-safe speech events for the shell that embeds the open workbench.
 *
 * The Cloud console records these in its explicit feedback bundle. Detail is
 * intentionally metadata-only: never add transcript, candidate, prompt, term,
 * audio, project path or raw runtime error fields here.
 */
export const SPEECH_DIAGNOSTIC_EVENT = "genehub:speech-diagnostic";

export interface SpeechDiagnosticDetail {
  action: string;
  requestId: string;
  stage: string;
  severity?: "info" | "error";
  correlationId?: string;
  errorCode?: string;
  runtimeId?: string;
  modelId?: string;
  implementation?: string;
  elapsedMs?: number;
  audioDurationMs?: number;
  audioEndMs?: number;
  contextBytes?: number;
  contextTerms?: number;
  partialRevision?: number;
  partialCharacters?: number;
  stablePrefixCharacters?: number;
  candidateCount?: number;
  segmentCount?: number;
  stored?: boolean;
  feedbackId?: string;
  scope?: string;
}

export function emitSpeechDiagnostic(detail: SpeechDiagnosticDetail): void {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
  window.dispatchEvent(new CustomEvent(SPEECH_DIAGNOSTIC_EVENT, { detail }));
}
