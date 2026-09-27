# Executor journal-aware recovery

Wave 6 consumes the durable, read-only PC Executor outcome journal without importing sibling repository code at runtime.

Pinned producer: `foto6/help-pc-1 agent/pc-executor @ 06217fe4246d0191ac3c93e69aac855bdd6e4136`.

Frozen contracts:
- `pc_executor.outcome_journal.lookup.v1`
- `pc_executor.outcome_journal.record.v1`
- embedded `pc_executor.action_outcome.v1`

The exact producer corpus is copied beneath `conformance/frozen/executor/06217fe4246d0191ac3c93e69aac855bdd6e4136/`. `conformance/JOURNAL_PROVENANCE.json` records source paths, source commit, Git blob SHA-1 and byte SHA-256.

## Recovery ownership

The Control Plane persists the execution correlation supplied by the Executor adapter for every side-effect attempt. For the frozen journal contract this binds:

- Control action id -> `request_id`;
- Control action type -> `action`;
- persisted `executionAttempts` -> `execution_attempt`;
- deterministic producer correlation -> `execution_id`.

Strict lookup validation also verifies the record contract version, exact field sets, embedded outcome v1, record SHA-256, history hash chain, lookup/provenance consistency and `replay_authorized=false`.

The journal is evidence only. It never directly authorizes a side effect.

Decision matrix:

| journal evidence | Control action |
| --- | --- |
| clean terminal `completed` | no re-execution; verification/reconciliation only |
| clean provisional/terminal `unknown` | no re-execution; observe/verify/reconcile |
| truncated tail | conservative `unknown`; no re-execution; observe/verify/reconcile |
| missing journal | conservative `unknown`; no re-execution; observe/verify/reconcile |
| clean, bound `not_started` with `reexecution_safe=true` | may enter the existing bounded Control retry policy |
| policy-blocked/cancelled terminal | no automatic retry |
| version/binding/hash/non-truncated integrity failure | fail closed as `blocked` |

A clean `not_started` lookup does not override Control policy. It only proves that the previous attempt did not start; Control still owns the maximum execution-attempt budget, cancellation state, idempotency and lane locks.

## Fault coverage

Focused tests cover restart from interrupted executing state with journal missing, completed, unknown, truncated tail and safe not-started evidence; request/action/version conflicts; stale/inconclusive/verified Vision reconciliation; persisted execution correlation; and side-effect/evidence/observation counters.

The Wave 5 state-machine soak also routes selected randomized unknown/completed reconciliation paths through strict journal lookup fixtures, preserving the same fixed seeds and workload distribution.

Deterministic report: `conformance/reports/executor-journal-recovery-v1.json`.

Run:

```sh
npm run test:journal
npm test
```

Safety remains unchanged: Executor adapter dry-run defaults true, credential/CAPTCHA actions are rejected, destructive actions remain disabled by default, and reconciliation is read-only.
