import type { Client, ClientDiagnosticEvent } from "./protocol/client";

export const CLIENT_DIAGNOSTIC_EVENT = "genehub:client-diagnostic";

const diagnosticClients = new Set<Client>();

/** Bridges the open workbench's transport diagnostics to an embedding product. */
export function emitClientDiagnostic(event: ClientDiagnosticEvent): void {
  if (typeof window === "undefined" || typeof CustomEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(CLIENT_DIAGNOSTIC_EVENT, { detail: event }));
}

/**
 * Makes a client available to an embedding product's explicit feedback flow.
 * The registry never initiates collection itself; it only lets a standalone
 * Preview page ask its already-authorized E2EE peer for a bounded safe
 * snapshot after the user presses Submit.
 */
export function registerDiagnosticClient(client: Client): () => void {
  diagnosticClients.add(client);
  return () => diagnosticClients.delete(client);
}

/** Most recently registered live client, if this surface owns one. */
export function activeDiagnosticClient(): Client | null {
  return Array.from(diagnosticClients).at(-1) ?? null;
}
