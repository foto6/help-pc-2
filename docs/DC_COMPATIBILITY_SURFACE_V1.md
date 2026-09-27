# Desktop Commander Compatibility Surface v1

## Scope

This layer exposes the observed Desktop Commander names over the existing `pc.native.control.v1` facade. It does not execute filesystem or process side effects itself. The canonical MCP host registers this translation layer as real MCP tools while keeping translation and protocol hosting separate.

Registry contract: `pc.desktop_commander.compat_registry.v1`

Response contract: `pc.desktop_commander.compat_response.v1`

Mandatory names:
- `edit_block`
- `read_file`
- `read_multiple_files`
- `write_file`
- `start_process`
- `read_process_output`
- `list_sessions`
- `force_terminate`

The registry in `src/dc-compatibility-registry.js` is the machine-readable source for names, input schemas, native tool mappings, semantics, and capability variants. `src/mcp-host.js` consumes it alongside the native registry without changing the compatibility translator.

## MCP exposure

The standards-compliant MCP host exposes both registries at once:

- native tools keep their dotted `pc.native.control.v1` names such as `file.read` and `process.start`;
- Desktop Commander compatibility tools keep the exact observed names listed above;
- the two sets do not collide;
- every compatibility tool carries `pc.desktop_commander.compat_registry.v1`, its registry digest, the native registry digest, and the Executor capability digest in `tools/list` metadata.

The MCP host accepts an optional stable `request_id` on compatibility calls. It removes that host-only field before translation and uses it as the facade correlation/idempotency key. SDK cancellation signals are forwarded through the compatibility translator to `NativeControlFacade.invoke()`.

The configured MCP runtime persists compatibility process-handle metadata in `dc-compatibility.json` next to the existing facade/control state. Discovery probes remain read-only and do not claim desktop ownership.

## Safety and execution boundary

Every filesystem/process operation is dispatched through `NativeControlFacade.invoke()`. The compatibility layer does not call the filesystem, spawn/kill processes, or emulate side effects.

Before dispatch, the layer checks the current native capability manifest. A required Executor action that is not advertised returns `CAPABILITY_UNAVAILABLE`; compatibility is never claimed by name alone.

The native facade remains authoritative for:
- session ownership and staleness;
- request idempotency;
- protected-path policy;
- Executor preflight, execution-context binding, outcome journal and audit;
- uncertain-outcome reconciliation and cancellation.

## File compatibility

### read_file

Desktop Commander offsets are 0-based. Positive offsets become native 1-based `start_line` / inclusive `end_line` bounds. A negative offset is translated to `tail_lines`; its magnitude is the effective read length and the supplied `length` is ignored.

Reads are bounded to 1000 lines and 256 KiB per compatibility request.

### read_multiple_files

The translator performs one deterministic native read request per input path using child request IDs `<request>:file:<index>`. The aggregate result preserves input order and carries independent success/error state for every path. One missing or denied file does not abort the remaining batch.

### edit_block

`edit_block` performs no read/modify/write emulation. It first obtains a SHA-256 precondition using native `file.hash`, then issues exactly one native `file.edit` request with:
- exact `old_text` / `new_text`;
- `expected_replacements` (default 1);
- the hash as `expected_current_hash`.

The Executor therefore owns replacement counting and the atomic mutation. A replacement-count mismatch is normalized to `REPLACEMENT_CONFLICT`; no fallback write occurs.

### write_file

`mode=rewrite` maps to native `file.write` / `fs.write_text`.

`mode=append` maps to native `file.append` / `fs.append_text`.

Payloads are bounded to 256 KiB before dispatch. The required capability is checked for the selected mode, so a producer can support rewrite while append remains explicitly unavailable.

## Process compatibility

`start_process` maps to native `process.start`. The native result must contain both a numeric OS pid and a facade-owned process handle. The compatibility state records only this non-secret handle metadata.

`read_process_output` maps to native `process.read`. Offset 0 uses the durable native stream cursor when one is available, so repeated reads continue rather than restarting. Absolute and negative offsets are passed through as explicit bounded range/tail semantics.

`list_sessions` maps to native `process.list` and reports compatibility-started process records. The persisted compatibility map survives compatibility-layer restart and tracks running/finished state without creating a second process authority.

`force_terminate` resolves the pid to the stored facade handle and maps to native `process.terminate`. A terminated/unknown compatibility handle is rejected before native dispatch as `STALE_HANDLE`.

## Normalized errors

The compatibility response normalizes common native/provider failures into:
- `FILE_NOT_FOUND`
- `ACCESS_DENIED`
- `STALE_HANDLE`
- `RANGE_ERROR`
- `REPLACEMENT_CONFLICT`
- `PROCESS_ERROR`
- `CAPABILITY_UNAVAILABLE`

The original native code/category are retained in error details when available.

## Tests

`test/dc-compatibility.test.js` covers:
- exact registry names and digest;
- positive-range and negative-tail reads;
- deterministic true-batch per-file results;
- hash-bound atomic edit translation and replacement conflicts;
- rewrite/append selection and bounds;
- capability-unavailable fail-closed behavior;
- persisted start/read/repeated-read/finish/list/terminate lifecycle;
- stale handle rejection;
- normalized filesystem/range/replacement/process errors.

All compatibility tests use mocks and temporary directories only. `test/mcp-host.integration.test.js` additionally exercises the observed compatibility names through the official MCP SDK client and the real Streamable HTTP host, including batch ordering, durable process reads, idempotency, cancellation, reconciliation-required outcomes, and protected-path zero-dispatch.
