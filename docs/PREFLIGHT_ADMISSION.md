# Preflight-aware admission and capability drift

Wave 7 consumes the read-only PC Executor preflight contracts from:

`foto6/help-pc-1 agent/pc-executor @ d0ccb0f390474fc3fc091e51c25f7ef8771b0f09`

Contracts:
- `pc_executor.capabilities.v1`
- `pc_executor.action_preflight.v1`

The exact producer fixture pack is copied under
`conformance/frozen/executor/d0ccb0f390474fc3fc091e51c25f7ef8771b0f09/tests/fixtures/preflight_v1/`.
`conformance/PREFLIGHT_PROVENANCE.json` records source paths, exact producer SHA, Git blob SHA-1 and SHA-256.

No sibling repository is imported at runtime.

## Admission lifecycle

Existing providers remain backward compatible. A provider that advertises Executor preflight support must expose both read-only capabilities and preflight operations. For such an action:

1. durable queued work leases in `preflight` mode;
2. Control reads and strictly validates `pc_executor.capabilities.v1`;
3. Control submits the exact logical action to `pc_executor.action_preflight.v1`;
4. the result is bound to action id, action kind and capability attestation digest;
5. Control persists the normalized preflight result, its deterministic attestation digest and the capability digest;
6. only persisted `ready` work can receive an execution lease;
7. immediately before dispatch, Control reads capabilities again and compares the digest;
8. drift or read-only unavailability prevents execution and enters bounded re-preflight.

A `ready` result never overrides Executor execution-time policy. The Executor remains the final authority and can still block or fail the actual dispatch.

## Result handling

| Preflight status | Control behavior |
| --- | --- |
| `ready` | persist attestation; execution may proceed only after current capability digest matches |
| `blocked` | terminal blocked; no execute |
| `unsupported` | terminal blocked; no execute |
| `invalid_request` | terminal blocked; no execute |
| `stale_observation` | bounded read-only re-preflight; no execute |
| `ambiguous_target` | bounded read-only re-preflight; no execute |
| malformed/version/binding mismatch | fail closed as blocked |
| capability drift | bounded re-preflight; no execute under stale attestation |
| capability/preflight transport unavailable | bounded read-only retry, then blocked |

Restart from a preflight lease or `preflighting` state returns to `preflight_wait`. Cancellation during preflight is definitively pre-dispatch and cannot create an uncertain side-effect outcome.

Execution retry after journal-confirmed `not_started` invalidates the prior preflight attestation, so the next dispatch must pass preflight again when admission control is enabled.

## Counters

Runtime metrics keep independent:
- `preflightAttempts`;
- `observationAttempts` for stale/ambiguous read-only target resolution;
- `capabilityChecks` and `capabilityDrifts`;
- `executionAttempts`;
- `verificationAttempts`;
- `reconciliationAttempts`.

The Wave 5 fault soak remains intact, while Wave 7 adds bounded state-machine/property tests for non-ready preflight states and for preserving at-most-once execution after an uncertain dispatch boundary.

Deterministic report:
`conformance/reports/preflight-admission-v1.json`.

Run:

```sh
npm run test:preflight
npm run test:journal
npm test
```

Safety semantics are unchanged: default Executor dry-run remains enabled unless explicitly configured otherwise, credential/CAPTCHA actions remain rejected, destructive actions remain disabled by default, lane/idempotency/audit rules remain active, and protected-path policy remains Executor-owned.
