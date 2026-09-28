# Native remote relay server

This server is the transport-only counterpart for the current outbound device-transport contract evidence at `foto6/help-pc-1` branch `agent/pc-native-core-final-candidate`, commit `b62da531ac045c2ccd3b4c6b82da7bb55cb93b8c`. This is contract evidence, not the final release pin.

## Scope

The relay is transport-only. It authenticates device frames, tracks device/session
state, routes opaque versioned request bodies, preserves request/delivery identity,
and returns device responses to the originating control request.

It does not parse native-PC action names, execute shell commands, touch files, drive
UI, or replace Executor policy. Action authorization and side-effect policy remain
behind the help-pc-1 dispatcher/Executor boundary.

The implementation never accesses `E:\manhwa`.

## Wire compatibility

The WebSocket endpoint defaults to `/v1/device/connect` and implements
`pc_remote_transport.frame.v1` exactly:

- canonical JSON with sorted object keys;
- HMAC-SHA256 frame authentication;
- device ID + session epoch binding;
- positive monotonic frame sequences;
- strict hello/welcome nonce handshake;
- capability advertisement plus canonical digest;
- heartbeat / heartbeat acknowledgement;
- request, response, reconcile-required and error frames;
- token rotation acknowledgement using the new generation;
- ordered chunk streams with per-chunk and whole-stream SHA-256 validation.

`test/fixtures/pc-remote-transport-vector-v1.json` is the frozen wire vector. Its provenance pins `src/pc_remote_transport/protocol.py` at commit `b62da531ac045c2ccd3b4c6b82da7bb55cb93b8c`, Git blob `648d741d11c74d03b2f37039286ce23dc4b8d158`. Before updating this provenance, the producer's own Python `encode_frame` was run against the fixture and produced byte-for-byte identical UTF-8 (`pc_remote_transport.frame.v1`, 296 bytes). The blob SHA is also identical on the original verified transport producer, so no protocol adaptation was introduced.

## Device registry and credentials

`NativeRelayState` maintains a bounded device registry and bounded delivery ledger.
A `JsonRelayStateStore` can persist both atomically. Device discovery never returns
credential bytes or base64 credential material.

Only one session is online for a device at a time. A reconnect supersedes the old
session. The last 16 session epochs are retained and cannot be reused, including
after a durable restart.

Credential rotation advances exactly one generation. The previous generation is
accepted only for the configured overlap window. When the device acknowledges
`token.rotated` using the new generation, the previous generation is retired
immediately. Revocation removes overlap credentials and closes the active session.

## Delivery safety

A delivery is persisted as dispatched before the request frame is sent. Request IDs
and delivery IDs are replay-protected. Reusing a delivery ID with different content
or a request ID under another delivery fails closed.

The relay never automatically redelivers unresolved work. If a side-effecting
delivery loses its connection or relay process after dispatch, its durable state
becomes `reconciliation_required` with `automatic_replay=false`. Read-only result
loss becomes a retryable failure instead.

The pinned device protocol has no cancellation frame. Relay cancellation therefore
cancels only relay-side waiting. A dispatched side effect becomes
`reconciliation_required`; it is never represented as a proven device cancellation.

## Streaming and bounds

Response streams are accepted only after a response manifest. Chunks must be ordered,
bound to the originating request, match the declared chunk count/size, and pass
SHA-256 validation. The final stream digest and total byte count must also match.

Server limits cover:

- frame bytes;
- request-body bytes;
- chunk bytes;
- total stream bytes;
- total and per-device pending deliveries;
- total WebSocket connections;
- WebSocket buffered bytes;
- control HTTP body bytes;
- idle timeout;
- heartbeat timeout.

Negotiated device limits can only reduce the corresponding relay bounds.

## Control API

The HTTP control API requires a bearer token of at least 32 characters and defaults
to a loopback bind. Non-loopback binding requires explicit opt-in.

Available endpoints:

- `GET /v1/relay/health`
- `GET /v1/relay/devices`
- `GET /v1/relay/request?delivery_id=...`
- `POST /v1/relay/request`
- `POST /v1/relay/request/cancel`
- `POST /v1/relay/device/rotate`
- `POST /v1/relay/device/revoke`

Device provisioning is an in-process administrative operation
(`registerDevice`) rather than an unauthenticated public endpoint.

## Verification

Run relay-specific tests with:

```
npm run test:relay
```

The suite covers exact pinned wire bytes, authenticated discovery, request routing,
duplicate delivery suppression, reconnect, stale epoch, forged device, duplicate
frame rejection, ordered and reordered chunks, connection/result loss, credential
rotation, immediate revocation, and durable restart recovery.
