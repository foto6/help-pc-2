# Native MCP R37 — operator lifecycle

R37 adds a durable operator lifecycle around the existing native MCP / PC Control stack without changing live authority. GitHub relay remains authoritative and no production cutover is performed in this milestone.

Contract: `native_mcp.operator_lifecycle.r37.v1`.

## States

- `RUNNING` — new side-effect dispatch is admitted.
- `PAUSED` — new side-effect dispatch is blocked; read-only status/health remains available.
- `DRAINING` — no new side-effect dispatch is admitted while existing work is allowed to settle outside the lifecycle gate.
- `RECONCILIATION_REQUIRED` — unknown side effects block resume and all new side-effect dispatch until explicitly reconciled.

Resume is explicit and idempotent. Clearing the final reconciliation item moves the lifecycle to `PAUSED`, not `RUNNING`; a separate explicit resume is required. R37 never authorizes automatic replay.

## Durable state

The lifecycle store is append-safe at the operator level through an atomic replacement state file:

`.pc-native-mcp-state/operator-lifecycle-r37.json`

The state records the operator state, generation, pause/drain metadata, unresolved request IDs, current authority lane/SHA/version, and the invariant flags:

- `automatic_side_effect_replay=false`
- `live_pc_control_cutover=false`

Cold start reloads the persisted state before side-effect admission.

## One-command status

`node tools/r37-operator-lifecycle.js status`

The status contract reports:

- native MCP host
- control service
- Executor
- GitHub relay fallback
- direct-lane availability
- reconciliation requirement
- current authority SHA/version
- operator state and state generation

The production runtime wires the same lifecycle into `NativeControlFacade`. Read-only tools remain available while paused. Side-effecting tools are checked immediately before durable action allocation/advancement.

Operator commands:

```
node tools/r37-operator-lifecycle.js pause --reason maintenance
node tools/r37-operator-lifecycle.js drain
node tools/r37-operator-lifecycle.js resume
node tools/r37-operator-lifecycle.js require-reconciliation --request-id <id>
node tools/r37-operator-lifecycle.js clear-reconciliation --request-id <id>
```

Windows wrapper:

`pwsh -NoProfile -File tools/r37-operator-lifecycle.ps1 -Action Status`

## Direct-host rehearsal

R37 requires a real direct-host rehearsal with relay fallback disabled: one read-only call and one harmless reversible local operation whose rollback restores the fixture.

During this milestone the authorized Windows host was offline, so the rehearsal failed closed. The exact blocker is recorded in:

`conformance/r37_operator_lifecycle/direct-host-rehearsal.blocked.json`

No synthetic result is promoted to live proof. The report remains `BLOCKED`, GitHub relay authority remains unchanged, and no production cutover is claimed.

## CI artifact

The R37 focused lifecycle suite contains more than 30 lifecycle/reboot/reconciliation tests. CI generates and uploads:

`r37-operator-lifecycle-readiness-<os>.json`

The artifact binds the exact GitHub Actions source SHA and preserves the direct-host blocker until a real direct-lane rehearsal is completed.
