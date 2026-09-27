# Native MCP Protocol Host v1

This host exposes the existing `pc.native.control.v1` facade as a standards-compliant Model Context Protocol server. It uses the official Model Context Protocol TypeScript SDK v2 packages pinned at `2.1.0`, serves the modern `2026-07-28` protocol revision, and keeps the SDK's supported 2025-era compatibility path enabled.

The MCP host contains no filesystem, process, shell, UI, input, clipboard, or other machine-side effect implementation. Every `tools/call` delegates to `NativeControlFacade`, which in turn creates or resumes the existing durable Control Plane action targeting the injected help-pc-1 Executor bridge.

## Transports

For local spawned clients, use stdio:

```text
PC_NATIVE_EXECUTOR_MODULE=/absolute/path/to/executor-bridge.js
PC_NATIVE_STATE_DIR=/absolute/path/to/state
npm run mcp:stdio
```

For network clients, use Streamable HTTP:

```text
PC_NATIVE_EXECUTOR_MODULE=/absolute/path/to/executor-bridge.js
PC_NATIVE_STATE_DIR=/absolute/path/to/state
PC_NATIVE_MCP_TOKEN=<at-least-24-character-secret>
PC_NATIVE_MCP_HOST=127.0.0.1
PC_NATIVE_MCP_PORT=8765
npm run mcp:http
```

The MCP endpoint is `/mcp`. HTTP defaults to `127.0.0.1`, requires a Bearer token on every request, validates the Host header as loopback, and refuses non-loopback bind addresses. There is no remote-auth mode in Wave 1B, so remote binding fails closed.

The host uses Streamable HTTP via the SDK's `createMcpHandler` and Node adapter. It does not add a new deprecated HTTP+SSE endpoint. The SDK may use SSE framing inside Streamable HTTP when required by the current transport specification.

## Executor bridge boundary

`PC_NATIVE_EXECUTOR_MODULE` points to a local module exporting either `createExecutorBridge()` or a default factory. The returned object must provide:

```js
{
  desktopId?: string,
  dryRun?: boolean,
  invoke(request, context),
  readCapabilities(request, context),
  readEvidence?(request, context),
  preflight?(request, context),
  bindExecutionContext?(request, context)
}
```

The bridge is dependency injection only. help-pc-2 does not import help-pc-1 source or require a sibling repository checkout. The injected functions must speak the existing Executor wire/action contracts already consumed by `HelpPc1Adapter`.

## MCP tool contract

Every entry in `src/native-registry.js` and every v1 Desktop Commander compatibility entry in `src/dc-compatibility-registry.js` is registered as an MCP tool. Native tools retain dotted names while compatibility tools retain the exact observed underscore names, so the two registries are unambiguous. `tools/list` exposes strict JSON schemas, stable descriptions, MCP annotations, and version/digest metadata.

Native tools publish the native protocol version, native registry contract/digest, current Executor capability digest, effect classification, and streaming classification. Compatibility tools publish `pc.desktop_commander.compat_registry.v1`, its digest, the native registry digest, Executor digest, capability variants/availability, and effect classification.

Each native or compatibility tool accepts an optional `request_id`. Clients that may retry a logical call should supply a stable value. If omitted, the host derives one from the MCP request identity. Compatibility translation derives deterministic child IDs for multi-step/batch work; all calls still bind to the facade's durable idempotency boundary.

Paginated tools accept:

```json
{"page":{"limit":100,"cursor":"opaque-continuation"}}
```

The host/facade enforce the negotiated native page bound. Executor continuation cursors are wrapped so they are bound to the native session and tool. Large file/process output must therefore use pagination/ranges rather than a single unbounded result. The MCP host also caps serialized tool results and returns a bounded truncation marker if a provider violates the response expectation.

## Sessions, probes, and protocol compatibility

MCP discovery/initialize does not claim the desktop or create a side-effect-capable facade session. The host pins the initial native capability manifest and performs read-only capability validation while constructing MCP server instances. A durable facade/control session is acquired lazily on the first `tools/call`. The configured runtime also persists Desktop Commander process compatibility metadata in `dc-compatibility.json` so pid-to-native-handle mapping survives host restart without becoming a second execution authority.

This matters for modern stdio negotiation: the official SDK may use a disposable sibling process for `server/discover`. Probe processes stay read-only and cannot take desktop ownership.

The same server factory supports:
- modern MCP `2026-07-28` negotiation;
- supported 2025-era initialize compatibility through the official SDK.

Capability/schema drift between host startup and a call fails closed before provider dispatch.

## Cancellation and uncertain outcomes

The SDK request cancellation signal is passed into `NativeControlFacade.invoke`. The facade maps it to the existing Control Plane cancellation path. If cancellation races with a dispatched side effect, the result remains uncertain and follows the existing read-only reconciliation path.

A lost connection, lost result, Executor restart, or unknown side-effect outcome never creates a replacement action. The MCP result surfaces `reconciliation_required`, and a retry with the same logical `request_id` reuses the same durable action.

## Protected paths

The Executor remains authoritative for protected-path policy. The native facade also rejects `E:\\manhwa` before enqueue as a conformance guard. MCP tests use only the literal mocked path and verify zero provider dispatch; the host never accesses that location.

## Verification

Focused integration tests use the official SDK client and transports rather than handwritten MCP framing:

```text
npm run test:mcp-host
npm run test:native-mcp
```

The repository-wide suite remains:

```text
npm test
```
