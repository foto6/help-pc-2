# PC Operations Chaos v1

This branch is QA/chaos only. It does not implement gateway, relay, executor, filesystem, process, log, session, system, window, or UIA production behavior.

The deterministic harness supplies contract oracles for request identity, restart/replay safety, cursor monotonicity, expected-hash compare-and-set semantics, append crash recovery, output bounds, and the prohibition on raw-coordinate fallback. These oracles let producer fixture packs be attached without importing sibling runtime code.

`conformance/pc-ops-chaos/CHAOS_MATRIX.v1.json` is authoritative for capability status. `PASS` means exact-head green producer evidence exists for the stated capability and the local invariant model is covered. `PENDING` means the reusable harness exists but the producer has not yet published an exact-head green fixture contract for that capability. `BLOCKED` records a concrete producer-side evidence or behavior gap that prevents a safety claim.

Two current blockers are intentional and must not be patched here: relay queue recovery has no explicit stale Git rebase-metadata fixture/handling, and protected-path validation has no structured-fs junction/alias escape contract. The chaos branch records those gaps rather than modifying production implementations.

The protected path `E:\\manhwa` is referenced only as a deny target in assertions and matrix metadata. The harness never opens, stats, lists, resolves, writes, moves, deletes, or otherwise touches that path.

Frozen producer material lives below `conformance/frozen/pc-ops-chaos/` and is copied only from exact-head green producer commits. No test imports code from another branch or repository at runtime.

Producer cutoff: the latest admissible relay evidence at this freeze is `e083eea1b4d36a41ee74c11b7ec00f4062b38c39` (CI 36328814629 SUCCESS). The successor `dd803270a80a7199918361abf1c52b01324745e0` publishes `tests/fixtures/pc_ops_v1/` but its exact-head CI 36329130849 failed, so those fixtures are intentionally not frozen or used to claim PASS.


## Native MCP cutover chaos preparation

The native-cutover validation cycle starts from:

`agent/pc-ops-chaos @ 53bf83a63cb4137c5e41fbd06cd18863f890d730`

It remains validation-only. No primary `pc-ops-gateway`, MCP gateway, Control Plane, Executor, relay, or Vision policy/implementation is modified here.

The new authoritative artifacts for this cycle are:

- `conformance/pc-ops-chaos/NATIVE_CUTOVER_CHAOS_MATRIX.v1.json`;
- `conformance/pc-ops-chaos/NATIVE_CUTOVER_PROVENANCE.v1.json`;
- their canonical SHA-256 sidecars;
- exact producer evidence copied under `conformance/frozen/pc-ops-chaos/`.

The older `CHAOS_MATRIX.v1.json` / `PROVENANCE.v1.json` remain the prior transport freeze and are not rewritten to manufacture historical continuity.

### Exact-green producer bindings

Native-cutover validation is bound to these exact producer heads/checks:

- Control MCP gateway: `5495c320304860bf190476833177f716fe9ad960`, CI `36318885810` SUCCESS;
- Control Plane: `801d024a4e9bf71eda0e362c64ec719efb869ddc`, CI `36325018742` SUCCESS;
- PC ops gateway: `732f0f5e6482f6bb96f0dfa582dc1c0fe2ea712e`, CI `36330547286` SUCCESS;
- Executor: `2cc1e40f792a3d74560b726a0d246c90b7f077e9`, CI `36318986551` SUCCESS;
- relay hardening: `58bad1bc60f7d4d26d03223c8f0bea5f138f49a6`, CI `36330545372` SUCCESS;
- Vision: `bdfa71226a9265f9ac052ef576a6d18cada80b84`, CI `36328030126` SUCCESS.

The relay exact-green tree now contains the structured `tests/fixtures/pc_ops_v1/` pack. Its fixture manifest records its own producer source head, and that distinction is preserved in provenance rather than rewritten.

### Adversarial restart/reconnect coverage

The independent oracle now covers:

- MCP disconnect after dispatch;
- Control Plane restart after dispatch;
- Executor restart;
- stale execution-context binding;
- duplicate request id, identical and conflicting payloads;
- outcome journal `unknown`;
- result loss after a side effect;
- managed process reconnect;
- managed shell-session reconnect;
- UI observation-epoch change before dispatch and after a completed effect.

The contract asserted by the chaos harness is:

- unknown or completed uncertain boundaries never authorize blind replay;
- only durable `not_started` evidence can authorize one bounded redispatch;
- an observed side effect occurs at most once for one logical request;
- stale context/epoch fails closed before side-effect dispatch;
- a post-effect epoch change can trigger read-only recapture/reverification only;
- managed start identity/remote handle survives reconnect and is never duplicated merely because the client or Control Plane restarted.

### Protected path

Explicit native structured-operation tests cover the protected root `E:\manhwa`, descendants, case/slash aliases, lexical `..\manhwa` traversal, and protected process `cwd`.

The validation oracle checks policy before invoking either its path-access hook or dispatch hook. The tests require both counts to remain zero for a rejected protected request. No test opens, stats, lists, resolves, hashes, writes, starts a process in, or otherwise accesses `E:\manhwa`.

This does **not** close the older junction/reparse-point alias blocker. Proving that a different lexical path resolves through a Windows junction into `E:\manhwa` requires producer/runtime filesystem evidence and remains outside this validation PASS.

### Non-claims

A `PASS` in the native matrix means the independent chaos invariant is covered and is bound to the listed exact-green producer contracts. It does not mean:

- migration ready;
- cutover ready;
- release ready;
- all producer implementations integrated;
- live MCP transport validated end-to-end on the target PC.

No merge, release, migration, or cutover is performed by this branch.
