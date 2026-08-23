/**
 * Canonical product Client entry for browsers, Desktop, and Node.
 *
 * This subpath must not load workbench UI, React, or theme bootstrap.
 * Workbench code and testctl both consume this same implementation.
 */
export {
  AssetPreviewError_,
  Client,
  ClientQueueFullError,
  ClientRequestTimeoutError,
  ClientRequestTooLargeError,
  ConnectionOutcomeUnknownError,
  MAX_RPC_BODY_BYTES,
  PROTOCOL_VERSION,
  ProtocolError_,
} from "./protocol/client";
export type {
  AssetPreviewResult,
  ClientDiagnosticDetail,
  ClientDiagnosticEvent,
  ClientDiagnosticKind,
  ClientOptions,
  CloseReason,
  ConnectionState,
  HostedChannelCredential,
  InviteChannelCredential,
  LocalServerProof,
  ProtocolDial,
  RtcState,
  WebSocketLike,
} from "./protocol/client";
export type { DataStream } from "./dataplane";
