# Native PC control full-stack integration

This branch integrates the real MCP host with the Desktop Commander compatibility surface only. It does not add, restore, or depend on any relay implementation.

## Exact source pins

- Primary base: `agent/pc-native-mcp-host` at `345a7b76321475493d63a9e5316c3992e02a5268`.
- Compatibility source: `agent/dc-compatibility-surface` at `61d7037938f45c34fbcf5abde79392d33cad1865`.
- Shared compatibility source base: `2a3a2a79b9ddd7521d220361286fbe9d5568751d`.
- Compatibility commits replayed: `2348090fb67808b9f18a29fa63c60d9ebbe06629` and `61d7037938f45c34fbcf5abde79392d33cad1865`.

The compatibility source delta was limited to its registry/translator, exports, documentation, tests, package script, and CI changes.

## Conflict resolution

`package.json` conflicted because the MCP-host branch added the official SDK dependencies and MCP scripts while the compatibility branch added `test:dc-compat`. Resolution retained the MCP-host dependency pins and scripts unchanged and added only the compatibility test script.

`.github/workflows/ci.yml` conflicted only in the push branch list. Resolution retained the MCP-host CI steps, kept the compatibility test step from the source delta, and added `agent/pc-native-control-full-stack` so this integration branch runs the same Ubuntu/Windows matrix.

No native MCP tool name or official Streamable HTTP/stdio implementation was replaced. Compatibility aliases are registered alongside the native registry and delegate through `DesktopCommanderCompatibilitySurface` into `NativeControlFacade`.

## MCP compatibility integration

The original integration established the eight mandatory observed aliases. The security/compatibility follow-on expands the registry to the full 28-tool non-vendor installed surface documented in `DC_COMPATIBILITY_SURFACE_V1.md`, while retaining the original names and semantics.

Every alias has a strict Zod input schema and deterministic description. `tools/list` reports compatibility registry metadata and whether the current Executor capability manifest can satisfy each alias. Missing actions remain explicit as `CAPABILITY_UNAVAILABLE`; registration never fakes readiness.

Caller-supplied `request_id` remains the compatibility logical request identity. Compatibility sub-operations use deterministic derived request IDs where required for batch reads and atomic edit preconditions. MCP cancellation is forwarded to the same facade invocation, preserving NativeFacade at-most-once and UNKNOWN/RECONCILE behavior.

Protected-path inputs are rejected by the compatibility translator before any native `facade.invoke` or provider dispatch. The integration tests use only temporary `C:\\tmp` fixtures and never access `E:\\manhwa`.

## Verification

Local Windows verification commands:

- `npm run test:native-mcp`
- `npm run test:dc-compat`
- `npm run test:mcp-host`
- `npm test`
- `git diff --check`

GitHub Actions runs the same control suite on `ubuntu-latest` and `windows-latest` for this branch.
