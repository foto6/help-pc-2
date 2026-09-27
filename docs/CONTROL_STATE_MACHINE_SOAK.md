# Control state-machine fault soak

Round 2 Wave 5 adds a deterministic model/state-machine reliability soak on top of the accepted Wave 4 contracts. It does not redefine Executor or Vision semantics.

## Workload

The full soak uses two fixed seeds and 256 logical actions per seed (512 total). Each run spans eight independently owned desktops and nineteen shared resource names. Action types are chosen from the frozen Executor v1 side-effecting action set, so normal keyboard/mouse, UIA, shell, clipboard and grounded-target lanes are exercised alongside global resource locks.

The generator interleaves enqueue, durable idempotent duplicate submission, leasing, execution, confirmed `not_started` retry, `completed`, `unknown`, frozen Vision verification results, read-only reconciliation evidence, cancellation, lease expiry, clock advancement, process reconstruction, injected crash-after-dispatch state and malformed external evidence.

The Wave 4 frozen fixture files are loaded directly from `conformance/frozen/`. The soak binds the authoritative Executor outcome fixtures to generated action ids/types and consumes the authoritative Vision result fixtures through `VisionVerificationResultV1Adapter`; it does not implement alternate Executor/Vision semantics.

## Per-transition invariants

After every generated operation the harness checks:

- once dispatch is completed/unknown, the logical action never receives a later execution lease;
- side-effect-provider count is at most one after any dispatch-started boundary;
- a second execution attempt is allowed only after confirmed `not_started` evidence under the existing bounded retry policy;
- verification and reconciliation counters advance independently from execution attempts;
- no two live leases own the same lane and every lock is owned by its live lease;
- persisted idempotency mappings remain valid, with duplicate submission checked again after restarts;
- terminal/cancelled actions never leave their terminal state;
- audit sequence remains gap-free and sensitive-key metadata remains redacted;
- malformed Executor/Vision evidence never becomes an automatic execution retry.

The harness repeatedly reconstructs `ControlPlane` from snapshots. Separate real `JsonStateStore` vectors truncate/corrupt durable JSON and require `STATE_CORRUPTED` fail-closed behavior.

## Cross-language canonical regression

`test/conformance/python-canonical-vectors.test.js` freezes Python canonical JSON SHA-256 vectors containing integral-looking floats (`50.0`) and negative zero. It explicitly proves that JavaScript numeric reserialization produces different digests and that the Wave 4 consumer continues to hash the authoritative Python canonical transport bytes for Vision verification bindings.

## Report

`conformance/reports/control-state-machine-soak-v1.json` is the deterministic golden report. It records seeds, logical-action/event/restart counts, persistence fault count, aggregate execution/verification/reconciliation counters, external-call counters, per-run transition hashes and a final aggregate transition hash.

Run:

```sh
npm run test:soak
npm test
```

Safety contracts remain unchanged: no credential/CAPTCHA automation, destructive actions remain disabled by default, Executor dry-run remains the adapter default outside explicit simulation configuration, and no protected-path behavior is introduced.
