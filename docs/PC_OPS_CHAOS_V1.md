# PC Operations Chaos v1

This branch is QA/chaos only. It does not implement gateway, relay, executor, filesystem, process, log, session, system, window, or UIA production behavior.

The deterministic harness supplies contract oracles for request identity, restart/replay safety, cursor monotonicity, expected-hash compare-and-set semantics, append crash recovery, output bounds, and the prohibition on raw-coordinate fallback. These oracles let producer fixture packs be attached without importing sibling runtime code.

`conformance/pc-ops-chaos/CHAOS_MATRIX.v1.json` is authoritative for capability status. `PASS` means exact-head green producer evidence exists for the stated capability and the local invariant model is covered. `PENDING` means the reusable harness exists but the producer has not yet published an exact-head green fixture contract for that capability. `BLOCKED` records a concrete producer-side evidence or behavior gap that prevents a safety claim.

Two current blockers are intentional and must not be patched here: relay queue recovery has no explicit stale Git rebase-metadata fixture/handling, and protected-path validation has no structured-fs junction/alias escape contract. The chaos branch records those gaps rather than modifying production implementations.

The protected path `E:\\manhwa` is referenced only as a deny target in assertions and matrix metadata. The harness never opens, stats, lists, resolves, writes, moves, deletes, or otherwise touches that path.

Frozen producer material lives below `conformance/frozen/pc-ops-chaos/` and is copied only from exact-head green producer commits. No test imports code from another branch or repository at runtime.
