# Native MCP Protocol Host v1

This host exposes the existing `pc.native.control.v1` facade through the official Model Context Protocol TypeScript SDK v2 packages pinned at `2.1.0`. It serves modern `2026-07-28` and retains the SDK-supported 2025-era compatibility path.

The MCP host contains no filesystem, process, shell, UI, input, clipboard, search, PDF, or other machine-side implementation. Every tool call reaches machine authority only through `NativeControlFacade` and the existing Control Plane provider.

## Production Executor identity pin

Production startup does not trust an arbitrary local module because it exports the expected functions. `PC_NATIVE_EXECUTOR_MODULE` is only a locator for the already-pinned module identity.

The immutable production identity is loaded from the fixed package file `config/executor-module-pin.json`; there is no environment variable that selects a different pin file. A release bundle must replace the checked-in fail-closed placeholder with reviewed metadata for its exact Executor bridge:

- canonical real module path;
- module SHA-256;
- canonical package root;
- package name and package version;
- package.json SHA-256;
- pin contract `pc.native.executor_module_pin.v1`.

Before any dynamic import, startup resolves and verifies all fields. A module symlink, package-manifest symlink, junction/path alias drift, path substitution, package version drift, package manifest drift, or module digest mismatch aborts startup before attacker module code can execute.

The source-tree pin is deliberately `configured:false`. Consequently, the production binaries fail closed until release packaging installs a reviewed pin.

## Test-only injection

Tests may call `createConfiguredNativeMcpRuntime({testConfig:{enabled:true,...}})` in-process. The seam accepts either an explicit test bridge factory or a test module plus a trusted test pin.

The stdio/HTTP production entrypoints never set `testConfig`, and no environment variable enables this seam. Production therefore always follows the fixed identity-pin path.
## Transports

For a packaged local stdio deployment, release packaging first installs the reviewed fixed pin and then starts with the matching absolute module path:

```text
PC_NATIVE_EXECUTOR_MODULE=/reviewed/absolute/executor-bridge.js
PC_NATIVE_STATE_DIR=/absolute/path/to/state
npm run mcp:stdio
```

Streamable HTTP additionally requires its bearer token and remains loopback-only:

```text
PC_NATIVE_EXECUTOR_MODULE=/reviewed/absolute/executor-bridge.js
PC_NATIVE_STATE_DIR=/absolute/path/to/state
PC_NATIVE_MCP_TOKEN=<at-least-24-character-secret>
PC_NATIVE_MCP_HOST=127.0.0.1
PC_NATIVE_MCP_PORT=8765
npm run mcp:http
```

The MCP endpoint is `/mcp`. HTTP validates loopback binding and Host headers and has no remote-auth mode. The SDK's Streamable HTTP implementation remains authoritative; no deprecated HTTP+SSE server is added.

## Bridge contract

Only after identity verification does the host import the reviewed module. It must export `createExecutorBridge()` or a default factory returning:

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

Interface conformance is necessary but not sufficient: identity verification always precedes import in production.

## MCP tools and capabilities

Native MCP tool names remain those in `src/native-registry.js`. Desktop Commander compatibility aliases are registered alongside them with strict Zod schemas and deterministic descriptions.

Compatibility-only internal native mappings are fixed in code and are not advertised as independent native MCP tools. They exist only so the compatibility translator can bind future PC-Core actions, such as stateful search or PDF generation, through `NativeFacade`.

`tools/list` reports compatibility availability from the current Executor capability digest. Missing actions return explicit `CAPABILITY_UNAVAILABLE`; tool registration never invents readiness.
## Request identity, cancellation, and reconciliation

Every tool accepts optional `request_id`. If supplied, it remains the logical request identity. Otherwise the host derives identity from the MCP request.

The SDK cancellation signal is propagated through compatibility translation to `NativeControlFacade.invoke`. Once a side effect may have dispatched, cancellation, lost result, disconnect, or Executor restart follows the durable UNKNOWN/RECONCILE path rather than creating a replacement action. Repeating the same logical request cannot create a second side effect.

## Protected paths

The compatibility translator and native facade both reject the protected root before provider dispatch. Tests use only literal policy inputs and temporary C-drive fixtures; the protected root is never accessed.

## Verification

Focused gates:

```text
npm run test:mcp-host
npm run test:native-mcp
npm run test:dc-compat
```

`test/mcp-runtime-config-security.test.js` covers module substitution, same-path digest drift, package/version drift, and symlink/junction aliases. `test/mcp-stdio.integration.test.js` also launches the real production stdio binary with an attacker module locator and proves the official MCP client cannot connect and attacker top-level code never runs.

Repository-wide validation remains `npm test`.
