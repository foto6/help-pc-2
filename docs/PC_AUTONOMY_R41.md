# PC Control Autonomy R41 — single supervisor

## Architecture

PC Control (native runtime with GitHub relay as verified fallback) is the primary control authority. The existing, SHA-pinned R45 **shadow** release is reused as the bounded agent DAG, exact-chat task dispatcher, Git/CI evidence verifier and optional local Ollama planner. This code does not create a second competing browser bridge.

The daemon runs independently of the ChatGPT coordinator tab. It writes a separate atomic state journal and never opens a new ChatGPT tab in observe mode. Exactly one coordinator is admitted through an exclusive lock.

## Included

- \`src/pc-autonomy-supervisor.js\`: PC Control relay freshness, operator lifecycle, queue pause, Bridge health, R42 hold, reconciliation, cooldown, 12 sends/hour default, 90s minimum inter-send gap, atomic journal.
- \`bin/pc-autonomy-daemon.js\`: perpetual local loop (\`--watch\`, >=60s) or one-shot observer (\`--once\`); loads exact immutable R45 SHADOW_ONLY release; independently checks all Git blob hashes; invokes R45 engine. Limits dispatch to **one assignment per tick**, even when multiple agents are waiting.
- \`examples/pc-autonomy.example.json\`: disabled observer config. The separate task plan must contain real exact chat/branch/HEAD bindings, not placeholders.
- \`test/pc-autonomy.test.js\`: adversarial no-Send, rate limiting, R42 hold, PC relay stale, crash/restart, unknown outcomes and lock tests.

Self-planning: \`enableBrain:true\` and a bounded R45 plan \`brain.enabled:true\` with \`brain.autoAccept\` explicitly approved. R45 proposes finite waves through **local Ollama**, never opens ChatGPT tabs to solicit new tasks, and requires actual GitHub HEAD + exact CI evidence to accept predecessors.

## Install without affecting live PC Control

Use an isolated checkout of branch \`agent/pc-autonomy-r41-native-supervisor-20261013\` of \`foto6/help-pc-2\`, **not the production PC Control, relay, or WebAIBridge worktrees**. Node.js 24 is preferred.

Copy the example to \`E:\PCControlAutonomy\config.json\` and configure a SHA-verified local R45 release and state paths. The existing release is under:

\`E:\WebAIBridge\app\data\operator-tools\r45-durable-autonomy\releases\28e4accf59e37e767c37585b85cdacbdbac62120\`

In the example, \`mode=observe\`, \`operatorApproved=false\`, and the plan is non-dispatchable. These commands make **no provider Send**:

\`\`\`text
node bin/pc-autonomy-daemon.js --config E:\PCControlAutonomy\config.json --once
node bin/pc-autonomy-daemon.js --config E:\PCControlAutonomy\config.json --watch
\`\`\`

In addition to the held R42 cutoff, enabled Send requires a fresh trusted local PC Control relay authority record at the explicit \`relay.healthFile\` with \`status=HEALTHY\`, \`reconciliationRequired=false\` and \`observedAt\` no more than 120 seconds old. The native PC HTTP endpoint, if configured, is merely observed; a failing native endpoint can never be used to bypass the GitHub relay production authority.

## Real-send controls — not activated

After the owner and other agents reconcile the live queue, old timeout effects, chat identities and **explicitly** remove the original R42 HOLD through the audited cutover mechanism, the exact plan must be reviewed and \`allowDispatch:true\` must be deliberately set. The owner can then choose \`mode=armed\`, \`operatorApproved=true\`, and:

\`\`\`text
node bin/pc-autonomy-daemon.js --config E:\PCControlAutonomy\config.json --watch --dispatch --i-accept-real-send
\`\`\`

Missing or stale gates fail closed. A 429 or unknown side effect induces cooldown/reconciliation; unknown effects are **never** retried under new IDs. New provider chats are never opened to evade usage limits. R45 requests checkpoints at ~35 min rather than relying on unlimited ChatGPT session duration.

**As of 2026-10-13**, production WebAIBridge R49 is BLOCKED, R42 HOLD remains active, and an unsent Telegram Curator assignment is queued. No safe basis exists to unpause or dispatch yet. The R41 code may be run **only as an isolated observer** while those issues remain.

Run focused checks with \`node --test test/pc-autonomy.test.js\`. No tool-safety disabling, social publishing, repo resets, Chrome restarts, or access to \`E:\manhwa\` is part of this implementation.


Local-only Ollama task proposals can be prepared while R42 HOLD is active, provided the approved finite R45 plan allows bounded planning. This does not enable browser Send; dispatch still requires every PC Control and R42 gate.


## Verified Windows always-on observer and crash recovery — 2026-10-13

**Exact tested code release:** \`d5c2ac399b3dc71cb9f83f28c2fc86ed942878bd\`. This release introduces a **lifetime watcher lease** alongside the pre-existing per-cycle transaction lock. A second \`--watch\` process aborts with \`AUTONOMY_LOCK_BUSY_OR_UNVERIFIED\`; a crash-abandoned lease can only be recovered after a two-minute grace period and independent proof that the recorded PID is dead, with immutable orphan evidence retained. A running or ambiguous PID is never stolen. Windows+Ubuntu focused regressions: [GitHub Actions 38344447668](https://github.com/foto6/help-pc-2/actions/runs/38344447668), full CI additionally [38344447719](https://github.com/foto6/help-pc-2/actions/runs/38344447719). The exact seven local source blobs and Node tests were also verified before controlled installation.

Operator-PC production remains separated:
- R41 isolated root: \`E:\PCControlAutonomyR41\`
- User observer source: \`E:\PCControlAutonomyR41\releases\d5c2ac399b3dc71cb9f83f28c2fc86ed942878bd\`
- Current-user startup target: \`E:\PCControlAutonomyR41\START_R41_OBSERVER.cmd\`
- Current-user shutdown: \`E:\PCControlAutonomyR41\STOP_R41_USER_OBSERVER.cmd\`
- Separate structured state: \`E:\PCControlAutonomyR41\data\pc-control-supervisor.json\`
- Current observer PID at verification: 8276. Lifetime lock is owned by the same exact PID, read-only \`--watch\`. Running a second watcher returned code 1 before any cycle.
- Automatic retry on next Windows user login: Startup cmd restarts a failed Node observer after a bounded 75-second delay, subject to the lifetime lock. A user STOP sets the explicit \`data\STOP_R41_OBSERVER.flag\` to prevent respawn, then terminates only the exact R41 Node process and removes the owned startup entry.
- All updates save backups under \`E:\PCControlAutonomyR41\backups\`; previous source releases remain unchanged.
- This user-level login startup **does not provide machine-level Windows service uptime when no user is logged in**. The scheduler ONLOGON attempt was denied by Windows and was not forced through elevation.

**Authority caveat:** R49 WebAIBridge continues at \`5da11c6b...\` with \`CUTOVER_HOLD_PREPARED\`, deliberate \`holdActive:true\`, watchdog \`enabled:false\` and \`allowAutonomousSend:false\`. The browser profile on debug port 17410 was directly observed with \`workerConnected:true\` on 2026-10-13; older \`profile_offline\` managed-chat entries are cached, not proof of current offline state. No automatic ChatGPT Send was enabled. See [independent Boss evidence](https://github.com/foto6/boss/pull/9).


## 2026-10-13 — Crash-atomic Send budget and complete **offline** canary rehearsal

**Write-ahead admission source**: \`195cc8acc9faddfcca1e14e7a4c5063f109ffb4a\`.
The coordinator now atomically reserves one Send-window slot **and** records a unique \`pendingDispatch\` token **before** calling asynchronous R45. If the Node process crashes, the pending token is persisted, so a restarted coordinator cannot silently re-send, even after the usual rate window expires. A returned R45 uncertainty or reconciliation-required task keeps the token and quarantines the original idempotency key for explicit reconciliation. A conclusive R45 result clears the token; a real Send cannot be inferred from a local journal reservation alone. The rate window is deliberately conservative and can count a rejected attempt.

- [Exact-source R41 focused CI: Windows+Ubuntu success](https://github.com/foto6/help-pc-2/actions/runs/38361435413). The general CI suite was not used as evidence until its final status could be confirmed.
- [Independent real-PC shadow install and Node tests PASS](https://github.com/foto6/help-pc-1/blob/agent/pc-github-relay/relay/results/owner-r41-20261013-writeahead-shadow-1418-31.json): all seven source blob SHA-1 values verified against GitHub; direct Bridge read-only probe verified 69 assignments (1 queued, 0 active, 47 historical terminal failures, zero unknown).
- [Controlled observer-only cutover](https://github.com/foto6/help-pc-1/blob/agent/pc-github-relay/relay/results/owner-r41-20261013-writeahead-live-switch-33.json): old PID 13384 stopped ONLY after source/PID verification; new pinned source \`195cc8acc9faddfcca1e14e7a4c5063f109ffb4a\` started as PID **16688**, without \`--dispatch\`; observer journal advanced from rev 233 to 234, exact user Startup and STOP controls updated, previous immutable releases and launchers backed up.
- [Subsequent independent liveness/protection audit](https://github.com/foto6/help-pc-1/blob/agent/pc-github-relay/relay/results/owner-r41-20261013-writeahead-live-proof-34.json): one watcher PID 16688 and matching lifetime lock, rev 236 READ_ONLY, zero unknown effects and pending dispatch, R50 Bridge PAUSED with zero reasons, R42 HOLD true, queue paused, watchdog off, Curator queued once and unsubmitted.

**Real module-to-module synthetic integration**: \`rehearsals/pc-autonomy-integration.mjs\` loads the exact immutable R45 shadow runner, the exact R50 gate Git blob and live R41 source. All Bridge APIs, Git/CI attestation and network effects are **mocked**; there is **no provider Send** or external request. It verifies (1) one logical assignment allocated, (2) deduplication and 90s spacing, (3) synthetic exact branch/SHA/High binding and independently attested CI acceptance, (4) guard denial before Enter when queue pauses and (5) timeout creates an original-intent quarantine that prevents replay across fresh coordinator instances. The first fixture failed as intended due omitted synthetic repository/branch/head; that fixture was corrected without relaxing the production exact binding gate.

- [Successful full-chain Windows rehearsal](https://github.com/foto6/help-pc-1/blob/agent/pc-github-relay/relay/results/owner-r41-20261013-fully-mocked-chain-v2-36.json), exact source \`0d81032460df360b24d5f06107c2d5684d339c72\`: PASS, zero external requests, zero provider Sends, one synthetic assignment, one synthetic independent completion attestation, one quarantined synthetic timeout.
- \`R42 HOLD\` activation was previously rejected by the action host **before dispatch**. Do not bypass that host block by editing the HOLD file, changing the route or replaying an earlier task. Actual ChatGPT browser agent E2E remains **NOT CERTIFIED**. Only an operator-authorized official release with independent green gates and an exact one-assignment canary may enable live Send.
- Ollama local planner is not installed. Current Windows official standalone CLI is about 1.5GB (plus optional AMD GPU package) and Qwen 3.5 9B is about 6.6GB. It is an optional new-wave planner, **not** prerequisite for a finite R45 DAG. No large installer/model download was started.

**Release state**: R41 source and offline tests READY. R50 live Send guard PRESENT. R42 original intentional HOLD / PAUSED queue / supervisor OFF: **NO GO for any real provider Send**.


**CI isolation (13 October)**: `npm test` runs the standard native PC Control test discovery. The R41→R45→R50 manual rehearsal requires two exact local Windows paths; it is **not** a standalone generic Node test. It was moved from `test/` into `rehearsals/` so `node --test` cannot accidentally execute it without those arguments. At commit `58cdeb38d0ccbabd2735829f7548d12db6f0a5c2` the full suite ran 556 cases, with 555 successful and just the missing-arguments rehearsal failing. Source and assertions in the actual rehearsal were preserved. Run it explicitly only with both immutable inputs:

```text
node rehearsals/pc-autonomy-integration.mjs ABSOLUTE_R45_SHADOW_RUNNER ABSOLUTE_R50_GATE
```

This rehearsal **never authorizes a live Send** and does not substitute for the official guarded R42 operator cutover.
