import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const R29_QA_V1 = "pc.native.r29.relay_cutover_qa_result.v1";
export const R29_READY = "READY_FOR_EXPLICIT_CUTOVER_DECISION";
export const R29_BLOCKED = "BLOCKED";
export const R29_RECONCILIATION_REQUIRED = "RECONCILIATION_REQUIRED";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const QA_DIR = join(ROOT, "conformance", "r29_relay_cutover_qa");

export const R29_PRODUCER_PIN = Object.freeze(
  JSON.parse(readFileSync(join(QA_DIR, "producer-pin.json"), "utf8")),
);

function gate(id, ok, reason, evidence = null) {
  return { id, ok: Boolean(ok), state: ok ? "PASS" : "BLOCK", reason, evidence };
}

function readVendored(name) {
  const item = R29_PRODUCER_PIN.source_blobs[name];
  if (!item) throw new Error(`unknown R29 producer blob: ${name}`);
  return readFileSync(join(ROOT, item.vendored_path));
}

function readJson(name) {
  return JSON.parse(readVendored(name).toString("utf8"));
}

function containsAll(text, values) {
  return values.every((value) => text.includes(value));
}

function before(text, first, second) {
  const a = text.indexOf(first);
  const b = text.indexOf(second);
  return a >= 0 && b >= 0 && a < b;
}

function noForbiddenProcessControl(text) {
  return !/Stop-Process|taskkill|TerminateProcess|Restart-Service|Stop-Service/i.test(text);
}

export function validateR29VendoredProducerBlobs(committedBlobIdentities) {
  if (!committedBlobIdentities || typeof committedBlobIdentities !== "object"
      || Array.isArray(committedBlobIdentities)) {
    return {
      ok: false,
      failures: [{
        name: "*",
        code: "COMMITTED_BLOB_IDENTITIES_REQUIRED",
        expected: "git rev-parse HEAD:<vendored_path>",
        actual: null,
      }],
    };
  }
  const failures = [];
  for (const [name, item] of Object.entries(R29_PRODUCER_PIN.source_blobs)) {
    const actual = committedBlobIdentities[item.vendored_path] ?? null;
    if (actual !== item.git_blob_sha1) {
      failures.push({ name, expected: item.git_blob_sha1, actual });
    }
  }
  return { ok: failures.length === 0, failures };
}

export function logicalRelayCount(processChain) {
  if (!Array.isArray(processChain) || processChain.length === 0) return 0;
  const ids = new Set();
  for (const item of processChain) {
    if (!item || !Number.isInteger(item.pid) || item.pid <= 0 || ids.has(item.pid)) return -1;
    ids.add(item.pid);
  }
  let roots = 0;
  for (const item of processChain) {
    if (!ids.has(item.parent_pid)) roots += 1;
  }
  return roots;
}

export function classifyR29HealthScenario(scenario, { staleAfterSeconds = 30 } = {}) {
  const logical = Number.isInteger(scenario?.logical_process_count)
    ? scenario.logical_process_count
    : logicalRelayCount(scenario?.process_chain ?? []);
  if (logical > 1) return "DUPLICATE_AMBIGUOUS";
  if (scenario?.process_exists !== true) return "PROCESS_MISSING";

  const health = scenario?.snapshot;
  if (!health || health.health_version !== "pc_relay.health.v1") return "PROCESS_EXISTS";
  if (health.reconciliation_required === true) return "RECONCILIATION_REQUIRED";
  if (scenario?.health_pid_observed !== true) return "PROCESS_EXISTS";

  const now = Number(scenario.now_unix);
  const updated = Number(health.updated_at_unix);
  if (!Number.isFinite(now) || !Number.isFinite(updated)) return "PROCESS_EXISTS";
  const budget = ["execute_request", "reconcile_interrupted_side_effect"].includes(health.phase)
    ? Math.max(staleAfterSeconds, 150)
    : staleAfterSeconds;
  if (Math.max(0, now - updated) > budget) return "STALE";

  const started = Number(health.started_at_unix ?? now);
  const cycle = health.last_cycle_completed_at_unix === null
    ? started
    : Number(health.last_cycle_completed_at_unix);
  const sync = health.last_sync_at_unix === null
    ? started
    : Number(health.last_sync_at_unix);
  const cycleAge = Number.isFinite(cycle) ? Math.max(0, now - cycle) : budget + 1;
  const syncAge = Number.isFinite(sync) ? Math.max(0, now - sync) : budget + 1;

  if (["local_behind_remote", "diverged"].includes(scenario.head_relation) && syncAge > budget) {
    return "STALE";
  }
  if (typeof scenario.observed_remote_head === "string"
      && typeof health.remote_head === "string"
      && scenario.observed_remote_head !== health.remote_head
      && cycleAge > budget) {
    return "STALE";
  }
  if (Number.isInteger(scenario.observed_remote_backlog_count)
      && scenario.observed_remote_backlog_count > Number(health.backlog_count ?? 0)
      && cycleAge > budget) {
    return "STALE";
  }
  return health.status === "healthy" ? "HEALTHY" : "PROCESS_EXISTS";
}

export function assessR29WatchdogState(state) {
  if (state === "HEALTHY") {
    return {
      state,
      cutover_precondition: "PASS",
      startup_or_recovery_allowed: true,
      live_cutover_authorized: false,
    };
  }
  if (state === "RECONCILIATION_REQUIRED") {
    return {
      state,
      cutover_precondition: "BLOCK",
      startup_or_recovery_allowed: false,
      live_cutover_authorized: false,
    };
  }
  return {
    state,
    cutover_precondition: "BLOCK",
    startup_or_recovery_allowed: false,
    live_cutover_authorized: false,
  };
}

export function inspectR29ProducerSafety({ committedBlobIdentities } = {}) {
  const manifest = readJson("candidate_manifest");
  const healthManifest = readJson("health_manifest");
  const healthPin = readJson("health_producer_pin");
  const watchdogManifest = readJson("watchdog_manifest");
  const fixture = readJson("incident_fixture");
  const incidentDocument = readVendored("incident_document").toString("utf8");
  const relay = readVendored("relay").toString("utf8");
  const launcher = readVendored("launcher").toString("utf8");
  const installer = readVendored("autostart_installer").toString("utf8");
  const uninstaller = readVendored("autostart_uninstaller").toString("utf8");
  const rollback = readVendored("rollback").toString("utf8");
  const workflow = readVendored("producer_workflow").toString("utf8");

  const scenarioStates = Object.fromEntries(
    fixture.scenarios.map((scenario) => [scenario.name, classifyR29HealthScenario(scenario)]),
  );
  const incidentChain = fixture.recorded_incident.process_chain;
  const incidentLogicalCount = logicalRelayCount(incidentChain);

  const gates = [
    gate(
      "exact_vendored_producer_blobs",
      validateR29VendoredProducerBlobs(committedBlobIdentities).ok,
      "every vendored file is byte-identical to its immutable producer Git blob",
    ),
    gate(
      "exact_producer_identity",
      manifest.repository === R29_PRODUCER_PIN.producer.repository
        && manifest.branch === R29_PRODUCER_PIN.producer.branch
        && manifest.release_gate === "NO_LIVE_CUTOVER",
      "candidate manifest is bound to the exact producer repository/branch and no-live gate",
    ),
    gate(
      "real_incident_bound",
      fixture.source_document === "docs/PC_RELAY_STALE_SYNC_INCIDENT_2026-10-01.md"
        && incidentDocument.includes("22 request files lacked result files")
        && fixture.recorded_incident.local_head === "be374169e51309bbc943f68e7965f23f53c85380"
        && fixture.recorded_incident.observed_remote_head === "e29d3746d2fbdc35b26e4b0725a63b78100a07c6",
      "fixture matches the recorded stale-sync incident evidence",
    ),
    gate(
      "stale_semantics",
      scenarioStates.recorded_stale_sync === "STALE"
        && scenarioStates.healthy_after_forward_progress === "HEALTHY"
        && scenarioStates.unknown_side_effect_after_reboot === "RECONCILIATION_REQUIRED",
      "independent classifier reproduces STALE/HEALTHY/RECONCILIATION_REQUIRED",
      scenarioStates,
    ),
    gate(
      "process_existence_not_health",
      healthManifest.safety_invariants?.pid_presence_is_health === false
        && watchdogManifest.safety_invariants?.pid_presence_is_health === false
        && classifyR29HealthScenario({
          process_exists: true,
          logical_process_count: 1,
          health_pid_observed: false,
          snapshot: null,
          now_unix: 1,
        }) === "PROCESS_EXISTS",
      "PID presence without durable health cannot become HEALTHY",
    ),
    gate(
      "one_logical_py_python_chain",
      incidentLogicalCount === 1
        && watchdogManifest.safety_invariants?.py_launcher_child_chain_counts_as_one_logical_relay === true,
      "py.exe parent -> python runtime child is one logical relay",
      { logical_process_count: incidentLogicalCount },
    ),
    gate(
      "no_blind_side_effect_replay",
      healthPin.recovery?.automatic_side_effect_replay === false
        && healthPin.recovery?.interrupted_side_effect_sets_reconciliation_required === true
        && containsAll(relay, [
          '"action": "outcome.lookup"',
          '"relay_status": "interrupted_requires_reconciliation"',
          '"reexecuted": False',
          '"replay_authorized": False',
          'if state.get("status") == "started":',
          'self._health["reconciliation_required"] = True',
        ]),
      "interrupted side effects reconcile by original request identity; replay remains false",
    ),
    gate(
      "autostart_guarded_and_reversible",
      containsAll(installer, [
        "[switch]$Apply",
        "expected_head = $ExpectedHead",
        "expected_branch = $ExpectedBranch",
        "New-ScheduledTaskTrigger -AtLogOn",
        "MultipleInstances IgnoreNew",
        "LogonType Interactive",
        "RunLevel Limited",
        "starts_task_immediately = $false",
        "automatic_replay = $false",
      ])
        && before(installer, "if (-not $Apply)", "Register-ScheduledTask")
        && !installer.includes("Start-ScheduledTask")
        && noForbiddenProcessControl(installer)
        && containsAll(uninstaller, [
          "[switch]$Apply",
          "requires_relay_absent = $true",
          "deletes_runtime_state = $false",
          "deletes_outcome_journal = $false",
          "automatic_replay = $false",
        ])
        && before(uninstaller, "if (-not $Apply)", "Unregister-ScheduledTask")
        && before(uninstaller, "if ($matching.Count -gt 0)", "Unregister-ScheduledTask")
        && noForbiddenProcessControl(uninstaller),
      "install/uninstall are explicit-apply, one-instance, non-killing, state/journal preserving",
    ),
    gate(
      "rollback_exact_and_journal_preserving",
      containsAll(rollback, [
        "[switch]$Apply",
        "refs/remotes/origin/$PreviousBranch",
        "checkout_mode = 'detached_exact_head'",
        "Invoke-Git -Arguments @('checkout', '--detach', $PreviousHead)",
        "starts_relay = $false",
        "automatic_process_kill = $false",
        "automatic_replay = $false",
        ".pc-relay\\state",
        ".pc-relay\\outcomes.jsonl",
      ])
        && before(rollback, "if (-not $Apply)", "Unregister-ScheduledTask")
        && before(rollback, "if ($matching.Count -gt 0)", "Unregister-ScheduledTask")
        && before(rollback, 'rev-parse "refs/remotes/origin/$PreviousBranch"', "Unregister-ScheduledTask")
        && !/reset\s+--hard/i.test(rollback)
        && noForbiddenProcessControl(rollback),
      "rollback refuses ambiguous live ownership, keeps journal/state, and detaches to exact prior SHA",
    ),
    gate(
      "launcher_blocks_degraded_or_start_failure",
      containsAll(launcher, [
        "if ($existing.Count -gt 0)",
        "if ($status.state -eq 'HEALTHY')",
        "process exists but is not proven healthy",
        "exit 2",
        "failed to stay running",
        "started, but health is not yet proven",
      ])
        && before(launcher, "if ($existing.Count -gt 0)", "Start-Process")
        && noForbiddenProcessControl(launcher),
      "only proven HEALTHY is accepted; stale/degraded/start failure stays blocked",
    ),
    gate(
      "bounded_log_rotation",
      manifest.logs?.max_bytes === 5242880
        && manifest.logs?.backup_count === 3
        && containsAll(launcher, [
          "[long]$LogMaxBytes = 5242880",
          "[int]$LogBackupCount = 3",
          "function Rotate-BoundedLog",
          "Rotate-BoundedLog -Path $Stdout",
          "Rotate-BoundedLog -Path $Stderr",
        ]),
      "stdout/stderr rotation is bounded to 5 MiB active logs with three backups",
    ),
    gate(
      "ci_plan_only_no_mutation",
      workflow.includes("CUTOVER_CANDIDATE_POWERSHELL_PLAN_ONLY_PASS")
        && !workflow.includes(" -Apply")
        && manifest.autostart?.registration_performed_by_ci === false
        && manifest.live_branch?.modified_by_milestone === false,
      "producer CI exercises syntax/plan-only paths and never applies autostart/cutover",
    ),
  ];

  return {
    gates,
    scenario_states: scenarioStates,
    incident_logical_process_count: incidentLogicalCount,
    source_blob_count: Object.keys(R29_PRODUCER_PIN.source_blobs).length,
  };
}

export function evaluateR29RelayCutoverQa({ committedBlobIdentities } = {}) {
  const safety = inspectR29ProducerSafety({ committedBlobIdentities });
  const blockers = safety.gates.filter((item) => !item.ok);
  const decision = blockers.length === 0 ? R29_READY : R29_BLOCKED;

  return {
    contract_version: R29_QA_V1,
    decision,
    producer: structuredClone(R29_PRODUCER_PIN.producer),
    producer_source_bound: blockers.every((item) => item.id !== "exact_vendored_producer_blobs"),
    validated_states: structuredClone(safety.scenario_states),
    incident_logical_process_count: safety.incident_logical_process_count,
    gate_count: safety.gates.length,
    gates: safety.gates,
    blockers: blockers.map((item) => ({ gate: item.id, reason: item.reason })),
    live_cutover_authorized: false,
    mutation_execution_authorized: false,
    autostart_apply_authorized: false,
    automatic_replay_authorized: false,
    automatic_process_kill_authorized: false,
    release_gate: "NO_LIVE_CUTOVER",
  };
}
