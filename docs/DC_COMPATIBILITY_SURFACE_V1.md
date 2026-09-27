# Desktop Commander Compatibility Surface v1

## Scope

This layer exposes the installed Desktop Commander-compatible tool names over `pc.native.control.v1`. It contains translation and compatibility state only; all machine operations delegate to `NativeControlFacade.invoke()`.

Registry contract: `pc.desktop_commander.compat_registry.v1`

Response contract: `pc.desktop_commander.compat_response.v1`

The machine-readable registry and strict MCP schemas cover 28 non-vendor tools:

`list_devices`, `ping`, `get_config`, `set_config_value`, `read_file`, `read_multiple_files`, `write_file`, `write_pdf`, `edit_block`, `create_directory`, `list_directory`, `move_file`, `get_file_info`, `start_search`, `get_more_search_results`, `stop_search`, `list_searches`, `start_process`, `read_process_output`, `interact_with_process`, `list_sessions`, `force_terminate`, `list_processes`, `kill_process`, `shutdown`, `who_am_i`, `get_usage_stats`, and `get_recent_tool_calls`.

Two installed Desktop Commander tools are intentionally excluded because they are vendor-service functions rather than native PC control semantics:

- `get_prompts`;
- `give_feedback_to_desktop_commander`.

They are recorded in `DC_VENDOR_SPECIFIC_EXCLUSIONS` and are not registered as compatibility tools.

## Capability binding

Every compatibility definition declares one or more exact Executor action variants. `tools/list` marks a tool available only when at least one complete variant is present in the current Executor capability manifest.

Missing capabilities are not emulated. The call returns `CAPABILITY_UNAVAILABLE` before provider dispatch. This is the expected state for capabilities not yet present on the currently pinned PC-Core branch and allows the same translator to become active when the final PC capability digest advertises them.

Examples of conditional capabilities include:

- stateful search: `search.start/read/stop/list`;
- mutable configuration: `config.set`;
- PDF generation: `fs.write_pdf`;
- device shutdown: `device.shutdown`;
- sanitized recent native audit retrieval: `audit.history`;
## File and directory semantics

`read_file` preserves 0-based Desktop Commander offsets, including negative-tail reads. When PC Core advertises `fs.read_many`, `read_multiple_files` dispatches exactly one true bounded batch request with ordered per-path success/error results; the older per-file facade loop is retained only as an explicit legacy fallback.

`edit_block` obtains a native hash precondition and issues exactly one native edit with the requested exact replacement count; a mismatch never falls back to rewrite.

`write_file` selects explicit native rewrite or append capabilities. `create_directory`, `list_directory`, `move_file`, and `get_file_info` translate to fixed native facade tools.

`write_pdf` has a strict schema for markdown creation and insert/delete operation arrays. It remains unavailable until the provider advertises `fs.write_pdf`; there is no local PDF implementation in help-pc-2.

## Search semantics

Stateful search compatibility binds only when the provider advertises `search.start`, `search.read`, `search.stop`, and `search.list` as applicable. PC Core does not currently publish `filePattern` or `earlyTermination` controls, so supplying either optional Desktop Commander argument returns `CAPABILITY_UNAVAILABLE` rather than silently ignoring it.

The translator maps installed Desktop Commander argument names to the native stateful-search contract, including files/content mode, literal/regex behavior, case handling, context lines, hidden-file inclusion, result/time bounds, absolute result offsets, and negative-tail reads. Search IDs remain provider generation-scoped; the control layer does not synthesize or rebind stale searches.

## Process semantics

`start_process` stores the facade-owned native handle against the returned numeric pid. When published, `read_process_output` binds to PC-Core `process.read_output`, `interact_with_process` binds to `shell.session.write_stdin`, and `list_sessions` binds to `process.managed.list`; legacy control actions remain explicit fallbacks. `force_terminate` resolves the pid only through the persisted compatibility handle map.

`list_sessions` reports compatibility-started sessions. `list_processes` uses the provider's system process inventory. `kill_process` delegates to the existing destructive native action; provider policy remains authoritative.

No compatibility method directly spawns, reads, writes, or terminates a process.

## Device/config semantic equivalents

`list_devices` and `who_am_i` describe only the authorized local native device; help-pc-2 does not invent a remote device broker or vendor account identity.

`ping` uses native `health.get`. `get_usage_stats` binds to sanitized PC-Core `metrics.get` and explicitly does not synthesize Desktop Commander connector billing telemetry.

`get_config` reads native safety/config metadata. `set_config_value` is unavailable unless a future provider explicitly advertises mutable `config.set`.

`who_am_i` binds to sanitized `identity.get`. `get_recent_tool_calls` binds to sanitized `audit.history` only when that action is published. Existing audit/journal authority is not duplicated inside the compatibility layer.

`shutdown` likewise remains unavailable until an explicit native `device.shutdown` capability exists.
## Safety and request semantics

Compatibility input is checked for the protected root before any facade/provider dispatch. All actual native requests use a fixed public or compatibility-internal tool definition and pass through `NativeControlFacade`; there is no arbitrary raw-action escape hatch.

Caller `request_id` remains the logical request identity. Deterministic child IDs are used only for composed batch reads and atomic edit preconditions. MCP cancellation propagates to the same logical facade request, preserving at-most-once behavior and UNKNOWN/RECONCILE semantics.

Common normalized failures include `FILE_NOT_FOUND`, `ACCESS_DENIED`, `STALE_HANDLE`, `RANGE_ERROR`, `REPLACEMENT_CONFLICT`, `PROCESS_ERROR`, and `CAPABILITY_UNAVAILABLE`.

## Tests

`test/dc-compatibility.test.js` verifies the exact 28-tool registry, intentional exclusions, batch/read/edit/process behavior, representative device/config/filesystem/search/PDF/audit translations, persistent process handles, and explicit unavailable behavior with zero provider dispatch.

`test/mcp-host.integration.test.js` uses the official MCP SDK client to validate `tools/list`, strict schemas, representative full-compat calls, unavailable future capabilities, cancellation, protected-path rejection, and UNKNOWN/RECONCILE at-most-once behavior.
