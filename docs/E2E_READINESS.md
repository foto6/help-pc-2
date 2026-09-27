# Wave 8 end-to-end readiness and sensor reconciliation

This gate freezes a cross-repository lifecycle against:

- PC Executor `foto6/help-pc-1 agent/pc-executor @ d0ccb0f390474fc3fc091e51c25f7ef8771b0f09`
- Vision `foto6/vision-2 agent/vision @ df9a84590a4a9d8fe8dfdec9ff195fe4821397f6` (producer CI `36315710091`)

Exact producer fixture bytes are copied under `conformance/frozen/executor/<sha>/` and
`conformance/frozen/vision/<sha>/`. `conformance/E2E_READINESS_PROVENANCE.json`
records producer repositories, heads, source paths, copied roots and exact Git blob SHA-1s.
There are no runtime imports from sibling repositories.

## Lifecycle

The focused simulation exercises one logical action through:

`queued -> capabilities/preflight -> optional read-only reobserve -> execute -> action outcome/journal -> before/after observations -> observation consistency -> semantic delta -> post-action verification -> terminal`

The preflight contract remains advisory admission evidence. Executor remains the final
execution-time policy/safety authority.

Vision sensor evidence is read-only. `vision.semantic_ui_delta.v1` binds the exact
before/after perception observations, target identity and verification input.
`vision.observation_consistency.v1` binds the after observation, semantic delta,
capture provenance and target. Material sensor disagreement is never resolved by
silently choosing one sensor.

Sensor status handling:

- `consistent` allows the existing post-action verification result to be consumed;
- `conflict` maps to INCONCLUSIVE/read-only recapture and reverify;
- `stale` maps to STALE/read-only recapture and reverify;
- `degraded` maps conservatively to read-only inconclusive reverify;
- malformed/version/target/snapshot/input binding evidence fails closed as terminal
  `blocked` and never authorizes execution replay.

Verification results are durably persisted before terminalization. A restart in the
post-verification/pre-terminal window therefore returns through read-only reconciliation
instead of side-effect execution.

## Restart coverage

Focused tests restart at:

- `preflight_wait`;
- queued with a persisted ready attestation;
- `executing` / provisional dispatch boundary;
- `uncertain_outcome`;
- `reconciling`;
- `verifying`;
- persisted verification result before terminalization.

Unknown or completed dispatch evidence never receives a new execution lease after
restart. Completed journal evidence goes directly to verification. Unknown journal
evidence remains reconciliation-only.

## Safety and counters

The gate preserves existing dry-run defaults, idempotency keys, lane locking,
credential/CAPTCHA prohibition, destructive-disabled defaults, audit redaction,
journal-aware recovery and bounded retries.

The report records independent counters for preflight, read-only observation,
capability checks, execution, journal reconciliation, sensor reads, read-only recapture,
verification and reconciliation. Bounded restart/process/cancel permutations assert
that after any uncertain or completed dispatch boundary there is at most one logical
side-effect provider call.

Run:

```sh
npm run test:e2e
npm run test:preflight
npm run test:journal
npm test
```

Canonical report: `conformance/reports/e2e-readiness-v1.json`.
