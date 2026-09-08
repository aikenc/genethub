# Media architecture and adapter contract

## Three separate paths

```text
Workspace entry/assets -> Asset Preview sandbox
Sandbox /api/.../ or trusted panel signaling
    -> authorized service client -> encrypted GeneHub data plane
    -> daemon -> authenticated local runner -> declared loopback backend
Trusted Workbench media panel <-> WebRTC audio/video <-> application media peer
                                     |
                           optional Channel TURN relay
```

The daemon associates registration with a canonical HTML entry. A fresh run identity and secret authenticate daemon/runner communication, preventing a reused port from inheriting an old run. The page receives neither private registry material nor a daemon Client. The runner is trusted application orchestration, not isolation against malicious backend code.

The static sandbox stays opaque. It cannot capture devices or host another application iframe. HTTP/WS bridging does not make cookies, OAuth navigation, arbitrary headers, or an arbitrary website compatible. Media stays outside the sandbox and Fabric Relay; signaling/business data still uses the existing encrypted data plane. TURN relays encrypted media packets; GeneHub does not transcode the application's media.

## HTTP/WS surface

Use the declared `/api/.../` paths with normal fetch / supported WebSocket calls. Only registered routes are forwarded to loopback; paths cannot escape and redirects are not followed. HTTP request bodies are limited to 8 MiB; individual bridge packets to 256 KiB. Allowed request headers are `accept`, `content-type`, `range`, `if-none-match`, and `last-event-id`; cookies, Authorization, and arbitrary custom headers are not forwarded. Keep backend credentials server-side in the application adapter.

Streaming responses follow consumer progress and cancellation. WS supports text and ArrayBuffer with bounded buffering and normal close, not Blob send or subprotocol negotiation. A bridge connection has a maximum one-hour lifetime; applications must surface closure rather than assume an indefinite session or replay writes. A WS PCM stream is application data, not a native audio track.

## Offer and stop

The trusted panel creates a browser PeerConnection, receives video/audio, and optionally adds a microphone audio track after a user click. It gathers candidates until complete or a 12-second gathering deadline, then sends a single request:

```text
POST <media.offerPath>
Content-Type: application/json
{"type":"offer","sdp":"...","iceServers":[...]}

200 application/json
{"type":"answer","sdp":"...","sessionId":"application-session-id"}

POST <media.stopPath>
Content-Type: application/json
{"sessionId":"application-session-id"}
```

There is no separate trickle-ICE endpoint in this contract. The backend must accept the browser's offer, apply the received ICE configuration to its own PeerConnection, negotiate compatible codecs/directions, and return a complete usable answer. Adapting an engine's different signaling roles or trickle flow may require more than renaming an endpoint.

Answer SDP must be a string at most 256 KiB; account for HTTP/bridge limits as well. `sessionId` is optional in the wire shape, but the current panel only invokes `stopPath` when it has a string session ID of at most 128 characters. Real model/UE adapters should supply both a nonempty ID and a stop endpoint. Make stop idempotent and session-scoped; release tracks, inference tasks, queues and GPU allocations owned by that session.

Stop delivery is best effort. Also reclaim abandoned/failed peers on the backend, including offers whose answer never reaches the browser. Do not depend solely on the client stop request for resource cleanup. The reference backend has bounded session count/lifetime; actual applications must choose and test their own limits.

## ICE and relay

By default the panel uses STUN/host candidates and disallows relay candidates. It obtains Channel configuration (or private self-hosted STUN config); if unavailable, host-only candidates remain. Do not silently substitute public third-party STUN servers.

The user can select “允许媒体中继” before connecting. Only then does the paired Channel issue short-lived TURN credentials. Both peers must consume that ICE configuration. Opt-in permits relay but does not force it: verify the selected candidate pair before claiming TURN was used. If no TURN credentials are available, the panel reports failure. Do not bypass it with hard-coded credentials or public relay infrastructure.

`dataPolicy: "direct-only"` rejects this service's Fabric data route; `auto` uses normal data routing. Neither selects the media path nor changes other features' data policy. Successful GeneHub chat or offer exchange is not evidence that the application's media ports are reachable. The current documented Channel deployment uses UDP STUN/TURN; do not promise TURN/TLS on 443 or enterprise-network reachability.

## Verify and recover

1. Prove backend readiness and signal exchange independently of media.
2. Observe real moving frames and expected audio; a connected PeerConnection is insufficient. Test the browser's playback gesture if audio is muted by autoplay policy.
3. Record the selected direct/relay candidate types, observed RTT, first-frame time and sustained playback. Do not log raw SDP, credentials, or user audio.
4. If microphone is requested, use the trusted panel's microphone action and prove the application actually consumes it. A mic indicator alone does not prove model input.
5. Stop, switch entry, and reconnect. Verify capture indicators disappear and backend session resources are reclaimed. Persistent disconnection is closed by the panel; backend cleanup still needs independent handling.
6. Test the requested remote network separately. A LAN result does not prove cellular or enterprise reachability. A direct-only cross-network failure is a reported limitation, not grounds for silently enabling relay.

For maintainers with the product source, existing `testctl` cases are `specialty.preview.registered-service-http-ws`, `specialty.preview.channel-ice-credentials`, and `specialty.preview.native-browser-media`. Use the workspace's test workflow. The browser case needs Playwright Chromium and the actual aiortc environment; missing dependencies are blocked, not passing. These cases prove reference behavior, not a user's digital-human model or UE input implementation.
