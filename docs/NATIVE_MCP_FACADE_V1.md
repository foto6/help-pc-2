# Native MCP / Control Facade v1

## Purpose

`pc.native.control.v1` is the provider-neutral boundary exposed by help-pc-2 for native PC operations. It does not implement filesystem, process, shell, window, UIA, input, clipboard, or system side effects itself. All operations are translated to durable Control Plane actions targeting provider `help-pc-1`; Executor policy, preflight, execution-context binding, outcome journal, audit, and final side-effect safety remain authoritative.

There is no sibling source import and no runtime dependency on a checkout of help-pc-1. The only coupling is the versioned wire/action contract described below.

## Versioned contracts

The facade exports:
- request protocol: `pc.native.control.v1`
- tool registry: `pc.native.tool_registry.v1`
- response envelope: `pc.native.response.v1`

Clients first fetch the capability manifest, then open/reconnect a session with the exact protocol version, registry digest, and current Executor capability digest. Any schema, registry, or Executor capability drift fails closed before dispatch.

Each request carries `session_id`, globally stable `request_id`, tool name, arguments, and optional bounded page cursor. The facade persists the request fingerprint and maps the same request ID to the same Control Plane idempotency key. Reuse with different input is rejected.

## Desktop Commander-compatible surface

The registry projects device/health/config, filesystem read/write/edit/list/info/move/create/search, content search, process start/read/interact/list/terminate, system process list/kill, shell sessions, and the existing shell/window/screenshot/UIA/input/clipboard operations.

Representative mappings:
- `file.read` -> `fs.read_text`
- `file.write` -> `fs.write_text`
- `file.edit` -> `fs.edit_text`
- `file.list` -> `fs.list`
- `file.info` -> `fs.stat`
- `file.search` -> `fs.find`
- `content.search` -> `fs.search_text`
- `process.start/read/interact/list/terminate` -> same Executor action names
- `system.process.list/kill` -> same Executor action names
- `device.health` -> `system.health`
- `device.get_config/set_config` -> `system.config.get/set`

The exact registry and digest are generated from `src/native-registry.js`.

## At-most-once boundary

A side-effect request is durably identified before execution and enqueued with:
- provider `help-pc-1`
- Executor action from the registry
- idempotency key `native:<facade-session>:<request-id>`
- correlation ID equal to the request ID

If dispatch/result becomes unknown, the Control Plane owns the transition to `uncertain_outcome` / `reconciliation_wait`. The facade returns `reconciliation_required` with the durable action ID and requires lookup/retry of the same logical request. It never creates a replacement side-effect action merely because the client disconnected, the facade restarted, or a result was lost.

Control Plane restart and Executor restart are therefore recovery events, not replay authorization.

## Sessions, reconnect, cancellation and handles

Facade sessions use a resume token and TTL. Reconnect repeats full capability negotiation. Closed, expired, or capability-drifted sessions are stale.

Process and shell handles returned by Executor are recorded against the facade session. Read/interact/terminate/close operations reject unknown, cross-session, or already-closed handles before dispatch.

Cancellation is forwarded to the existing Control Plane action. A cancellation race after dispatch remains an uncertain outcome and is reconciled; it is never treated as permission to execute again.

## Bounded streaming and pagination

Streaming-capable tools negotiate a page limit capped by `max_page_size`. Executor cursors are wrapped in an opaque facade cursor binding them to the session and tool. Malformed, cross-session, or cross-tool cursors fail before dispatch. Executor results that exceed the negotiated item bound are rejected as a provider bounds violation.

Tool-specific range/tail parameters remain Executor inputs; the facade only enforces the cross-tool page/cursor envelope.

## Local authenticated transport

Wave 1 includes `LocalNativeHttpTransport`, which can bind only to `127.0.0.1`, `::1`, or `localhost` and requires a Bearer token on every endpoint.

Endpoints:
- `GET /v1/health`
- `GET /v1/lifecycle`
- `GET /v1/capabilities`
- `POST /v1/session/open`
- `POST /v1/session/reconnect`
- `POST /v1/session/close`
- `POST /v1/request`
- `POST /v1/request/lookup`
- `POST /v1/request/cancel`

The transport is intentionally thin. A future remote transport can call the same facade methods and envelopes without changing orchestration or Executor semantics.

## help-pc-1 boundary

help-pc-1 must provide the Executor actions named by the tool registry and a capability document with a stable digest. help-pc-2 does not import Executor implementation code. Executor remains responsible for:
- protected/sensitive path policy and sensitive-input rules
- capability/preflight validation
- execution-context binding
- local side effects
- outcome journal and execution evidence
- audit semantics

The facade also fail-closes requests mentioning `E:\\manhwa` before queueing. This is a conformance guard only; it does not replace Executor enforcement. Tests assert such requests create no Control Plane action and never reach the provider.

## Failure tests

`test/native-facade.test.js` covers duplicate request IDs, control restart, Executor restart, connection/result loss after dispatch, stale sessions, cancellation races, malformed cursors, capability drift, handle lifetime, pagination bounds, and the protected-path no-dispatch invariant.

`test/native-http.test.js` covers authenticated loopback health/lifecycle/capability discovery, session negotiation, request execution, and refusal to bind a non-loopback address.
