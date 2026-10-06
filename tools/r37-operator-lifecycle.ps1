param(
  [Parameter(Mandatory=$true)]
  [ValidateSet("Status","Pause","Drain","Resume","RequireReconciliation","ClearReconciliation")]
  [string]$Action,

  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$StateFile = (Join-Path $RepoRoot ".pc-native-mcp-state/operator-lifecycle-r37.json"),
  [string]$AuthoritySha = $(if ($env:PC_NATIVE_AUTHORITY_SHA) { $env:PC_NATIVE_AUTHORITY_SHA } else { "6f44216e7e5fbf9fe3ae635f302c3c33887e0930" }),
  [string]$AuthorityVersion = $(if ($env:PC_NATIVE_AUTHORITY_VERSION) { $env:PC_NATIVE_AUTHORITY_VERSION } else { "pc.native.r29.relay_cutover_qa_pin.v1" }),
  [string]$Reason = "operator_pause",
  [string]$RequestId
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$command = switch ($Action) {
  "Status" { "status" }
  "Pause" { "pause" }
  "Drain" { "drain" }
  "Resume" { "resume" }
  "RequireReconciliation" { "require-reconciliation" }
  "ClearReconciliation" { "clear-reconciliation" }
}

$args = @(
  (Join-Path $RepoRoot "tools/r37-operator-lifecycle.js"),
  $command,
  "--state-file", $StateFile,
  "--authority-version", $AuthorityVersion
)

if (-not [string]::IsNullOrWhiteSpace($AuthoritySha)) {
  $args += @("--authority-sha", $AuthoritySha)
}
if ($Action -eq "Pause") {
  $args += @("--reason", $Reason)
}
if ($Action -in @("RequireReconciliation","ClearReconciliation")) {
  if ([string]::IsNullOrWhiteSpace($RequestId)) {
    throw "RequestId is required for reconciliation commands"
  }
  $args += @("--request-id", $RequestId)
}

& node @args
if ($LASTEXITCODE -ne 0) {
  throw "R37 operator lifecycle command failed with exit $LASTEXITCODE"
}
