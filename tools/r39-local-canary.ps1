param(
  [Parameter(Mandatory=$true)]
  [ValidateSet("Preflight","Stage","RunReadOnlyCanary","Status","Resume")]
  [string]$Action,

  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$CanaryRoot,
  [string]$RelayRepo,
  [string]$NativeRelayUrl,
  [string]$NativeRelayTokenFile,
  [string]$NativeDeviceId,
  [string]$NativeDesktopId = "desktop-A",
  [int]$CandidatePort = 0
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function New-R39Root {
  $base = Join-Path $RepoRoot ".r39-canary"
  New-Item -ItemType Directory -Force -Path $base | Out-Null
  $name = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), ([guid]::NewGuid().ToString("N"))
  $path = Join-Path $base $name
  New-Item -ItemType Directory -Force -Path $path | Out-Null
  return (Resolve-Path -LiteralPath $path).Path
}

function Require-R39Root([string]$Path) {
  if (-not $Path) { return New-R39Root }
  $base = [IO.Path]::GetFullPath((Join-Path $RepoRoot ".r39-canary"))
  $full = [IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
    throw "CanaryRoot must be under $base"
  }
  New-Item -ItemType Directory -Force -Path $full | Out-Null
  return (Resolve-Path -LiteralPath $full).Path
}

function Invoke-Node([string[]]$Arguments) {
  & node @Arguments
  if ($LASTEXITCODE -ne 0) { throw "node command failed with exit $LASTEXITCODE" }
}

function Invoke-R39Preflight([string]$Root) {
  $dir = Join-Path $Root "preflight"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $args = @(
    "-NoProfile","-File",(Join-Path $RepoRoot "tools/r33-live-readonly-canary-preflight.ps1"),
    "-RepoRoot",$RepoRoot,
    "-OutputDir",$dir,
    "-NativeDesktopId",$NativeDesktopId
  )
  if ($RelayRepo) { $args += @("-RelayRepo",$RelayRepo) }
  if ($NativeRelayUrl) { $args += @("-NativeRelayUrl",$NativeRelayUrl) }
  if ($NativeRelayTokenFile) { $args += @("-NativeRelayTokenFile",$NativeRelayTokenFile) }
  if ($NativeDeviceId) { $args += @("-NativeDeviceId",$NativeDeviceId) }
  & pwsh @args | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "R33 read-only preflight failed with exit $LASTEXITCODE" }
  return (Join-Path $dir "preflight-report.json")
}

function Invoke-R39Stage([string]$Root) {
  $preflight = Invoke-R39Preflight $Root
  $report = Get-Content -Raw -LiteralPath $preflight | ConvertFrom-Json
  if ($report.state -ne "READY_FOR_COORDINATOR_CANARY") {
    Write-Output $preflight
    return
  }

  $serviceIdentity = "native-mcp-r39-canary-" + ([guid]::NewGuid().ToString("N"))
  $stateFile = Join-Path $Root "operator-lifecycle-r37.json"
  $identity = Join-Path $Root "canary-identity.json"
  $lifecycle = Join-Path $Root "lifecycle-rehearsal.json"
  $status = Join-Path $Root "lifecycle-status.json"
  $staged = Join-Path $Root "staged-canary.json"
  $plan = Join-Path $Root "cutover-plan.json"
  $reboot = Join-Path $Root "reboot-autostart-stage.json"

  Invoke-Node @(
    (Join-Path $RepoRoot "tools/r39-local-canary.js"),"identity",
    "--repo-root",$RepoRoot,
    "--canary-root",$Root,
    "--port",[string]$CandidatePort,
    "--service-identity",$serviceIdentity,
    "--state-file",$stateFile,
    "--out",$identity
  )
  Invoke-Node @(
    (Join-Path $RepoRoot "tools/r39-local-canary.js"),"lifecycle-rehearsal",
    "--state-file",$stateFile,
    "--out",$lifecycle
  )
  & node (Join-Path $RepoRoot "tools/r39-local-canary.js") status --state-file $stateFile |
    Set-Content -LiteralPath $status -Encoding utf8

  Invoke-Node @(
    (Join-Path $RepoRoot "tools/r39-local-canary.js"),"evaluate",
    "--preflight",$preflight,
    "--lifecycle-status",$status,
    "--lifecycle-rehearsal",$lifecycle,
    "--identity",$identity,
    "--actual-coordinator-run",
    "--out",$staged
  )
  Invoke-Node @(
    (Join-Path $RepoRoot "tools/r39-local-canary.js"),"cutover-plan",
    "--staged-canary",$staged,
    "--identity",$identity,
    "--out",$plan
  )

  $startCommand = "pwsh -NoProfile -File tools/r32-local-canary-operator.ps1 -Action StartCandidate -RunDir '$Root' -NativeRelayUrl '<from-r33-preflight>' -NativeRelayTokenFile '<credential-path-from-r33-preflight>' -NativeDeviceId '<device-id-from-r33-preflight>'"
  Invoke-Node @(
    (Join-Path $RepoRoot "tools/r39-local-canary.js"),"reboot-stage",
    "--identity",$identity,
    "--start-command",$startCommand,
    "--out",$reboot
  )

  [IO.File]::WriteAllText(
    (Join-Path $Root "run-canary-command.txt"),
    ([string]$report.run_canary_command + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )

  Write-Output $staged
  Write-Output $plan
  Write-Output $reboot
}

$root = Require-R39Root $CanaryRoot

switch ($Action) {
  "Preflight" {
    Invoke-R39Preflight $root
  }
  "Stage" {
    Invoke-R39Stage $root
  }
  "RunReadOnlyCanary" {
    $preflight = Invoke-R39Preflight $root
    $report = Get-Content -Raw -LiteralPath $preflight | ConvertFrom-Json
    if ($report.state -ne "READY_FOR_COORDINATOR_CANARY") {
      throw "R39 refuses read-only canary because R33 preflight is not READY"
    }
    if (-not $report.run_canary_command) { throw "R33 did not generate a canary command" }
    Write-Output $report.run_canary_command
    Write-Output "NOT_EXECUTED_BY_R39_WRAPPER: execute the emitted R32 command explicitly after coordinator review."
  }
  "Status" {
    & node (Join-Path $RepoRoot "tools/r39-local-canary.js") status --state-file (Join-Path $root "operator-lifecycle-r37.json")
    if ($LASTEXITCODE -ne 0) { throw "R39 status failed" }
  }
  "Resume" {
    & node (Join-Path $RepoRoot "tools/r39-local-canary.js") resume --state-file (Join-Path $root "operator-lifecycle-r37.json")
    if ($LASTEXITCODE -ne 0) { throw "R39 resume failed" }
  }
}
