import { WebSocket } from "ws";

import {
  Client,
  type ClientDiagnosticEvent,
  type InviteChannelCredential,
  type LocalServerProof,
  type WebSocketLike,
} from "@genehub/workbench/client";

export async function connectProductClient(input: {
  url: string;
  localServerProof?: LocalServerProof;
  credential?: { deviceId: string; secret: string };
  inviteCredential?: InviteChannelCredential;
  name?: string;
  socketFactory?: (url: string) => WebSocketLike;
  onDiagnostic?: (event: ClientDiagnosticEvent) => void;
  redial?: () => Promise<{
    url: string;
    localServerProof?: LocalServerProof;
    credential?: { deviceId: string; secret: string };
    inviteCredential?: InviteChannelCredential;
  }>;
}): Promise<Client> {
  const client = new Client({
    url: input.url,
    localServerProof: input.localServerProof,
    credential: input.credential,
    inviteCredential: input.inviteCredential,
    rtcEnabled: false,
    connectTimeoutMs: 45_000,
    helloTimeoutMs: 45_000,
    redialTimeoutMs: 45_000,
    ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
    redial: input.redial
      ? async () => {
          const next = await input.redial!();
          return {
            url: next.url,
            localServerProof: next.localServerProof,
            credential: next.credential,
            inviteCredential: next.inviteCredential,
          };
        }
      : undefined,
    socketFactory:
      input.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike),
    clientName: input.name ?? "testctl",
  });
  let lastError = "";
  client.connect();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (client.connectionState === "ready") return client;
    if (client.failure) lastError = JSON.stringify(client.failure);
    if (client.connectionState === "closed") {
      throw new Error(
        `canonical Client closed: ${JSON.stringify(client.lastCloseReason ?? {})} ${lastError}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const close = client.lastCloseReason;
  client.close();
  throw new Error(
    `canonical Client did not become ready (${client.connectionState}): ${JSON.stringify(close ?? {})} ${client.failure?.message ?? ""}`,
  );
}
