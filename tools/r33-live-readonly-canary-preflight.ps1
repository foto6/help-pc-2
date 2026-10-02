param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$OutputDir,
  [string]$RelayRepo,
  [string]$NativeRelayUrl,
  [string]$NativeRelayTokenFile,
  [string]$NativeDeviceId,
  [string]$NativeDesktopId = "desktop-A"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function New-R33OutputDir {
  $root = Join-Path $RepoRoot ".r33-preflight"
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $name = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), ([guid]::NewGuid().ToString("N"))
  $path = Join-Path $root $name
  New-Item -ItemType Directory -Force -Path $path | Out-Null
  return (Resolve-Path -LiteralPath $path).Path
}

function Get-RelayRows {
  $isWindowsHost = ($env:OS -eq "Windows_NT")
  if (-not $isWindowsHost) { return @() }
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains("github_relay.py")
  } | ForEach-Object {
    [pscustomobject]@{
      pid = [int]$_.ProcessId
      parent_pid = [int]$_.ParentProcessId
      command_line = [string]$_.CommandLine
    }
  })
}

function Get-ArgValue([string]$CommandLine, [string]$Name) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $null }
  $escaped = [regex]::Escape($Name)
  $pattern = '(?:^|\s)' + $escaped + '(?:=|\s+)(?:"([^"]+)"|''([^'']+)''|([^\s]+))'
  $match = [regex]::Match($CommandLine, $pattern)
  if (-not $match.Success) { return $null }
  foreach ($index in 1..3) {
    if ($match.Groups[$index].Success -and $match.Groups[$index].Value) {
      return $match.Groups[$index].Value
    }
  }
  return $null
}

function Get-RepoFromRelayCommand([string]$CommandLine) {
  $arg = Get-ArgValue $CommandLine "--repo"
  if ($arg) {
    try { return [IO.Path]::GetFullPath($arg) } catch { return $null }
  }
  $pattern = '(?:"([^"]*tools[\\/]+github_relay\.py)"|''([^'']*tools[\\/]+github_relay\.py)''|([^\s]*tools[\\/]+github_relay\.py))'
  $match = [regex]::Match($CommandLine, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $match.Success) { return $null }
  $script = $null
  foreach ($index in 1..3) {
    if ($match.Groups[$index].Success -and $match.Groups[$index].Value) {
      $script = $match.Groups[$index].Value
      break
    }
  }
  if (-not $script) { return $null }
  try {
    return [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $script)))
  } catch {
    return $null
  }
}

function Resolve-RelayRepo([object[]]$Rows, [string]$Explicit) {
  if ($Explicit) {
    if (Test-Path -LiteralPath $Explicit -PathType Container) {
      return (Resolve-Path -LiteralPath $Explicit).Path
    }
    return $null
  }
  $paths = @($Rows | ForEach-Object { Get-RepoFromRelayCommand $_.command_line } |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } |
    Select-Object -Unique)
  if ($paths.Count -eq 1) { return $paths[0] }
  return $null
}

function Matching-RelayRows([object[]]$Rows, [string]$Repo) {
  if (-not $Repo) { return @() }
  $needle = [IO.Path]::GetFullPath($Repo)
  return @($Rows | Where-Object {
    $theirRepo = Get-RepoFromRelayCommand $_.command_line
    $theirRepo -and ([IO.Path]::GetFullPath($theirRepo) -eq $needle)
  })
}

function Logical-RelayCount([object[]]$Rows) {
  if (-not $Rows -or $Rows.Count -eq 0) { return 0 }
  $ids = @{}
  foreach ($row in $Rows) { $ids[[int]$row.pid] = $true }
  $roots = @($Rows | Where-Object { -not $ids.ContainsKey([int]$_.parent_pid) })
  return $roots.Count
}

function Resolve-CredentialPath([string]$Explicit) {
  $candidate = $Explicit
  if (-not $candidate -and $env:PC_NATIVE_RELAY_TOKEN_FILE) {
    $candidate = $env:PC_NATIVE_RELAY_TOKEN_FILE
  }
  if (-not $candidate) { return $null }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
  return (Resolve-Path -LiteralPath $candidate).Path
}

function Resolve-NativeRelayOrigin([string]$Explicit) {
  $candidate = if ($Explicit) { $Explicit } elseif ($env:PC_NATIVE_RELAY_URL) { $env:PC_NATIVE_RELAY_URL } else { $null }
  if (-not $candidate) { return $null }
  try {
    $uri = [Uri]$candidate
    if ($uri.Scheme -notin @("http","https")) { return $null }
    if ($uri.Host -notin @("127.0.0.1","localhost","::1")) { return $null }
    if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) { return $null }
    if ($uri.AbsolutePath -ne "/") { return $null }
    return $uri.GetLeftPart([UriPartial]::Authority)
  } catch {
    return $null
  }
}

function Invoke-Node([string[]]$Arguments) {
  & node @Arguments
  if ($LASTEXITCODE -ne 0) { throw "node command failed with exit $LASTEXITCODE" }
}

if (-not $OutputDir) { $OutputDir = New-R33OutputDir }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path

$relayRows = Get-RelayRows
$resolvedRelayRepo = Resolve-RelayRepo $relayRows $RelayRepo
$matchingRows = Matching-RelayRows $relayRows $resolvedRelayRepo
$logicalCount = Logical-RelayCount $matchingRows

$authoritySnapshotPath = Join-Path $OutputDir "authority-snapshot.json"
$watchdogPath = Join-Path $OutputDir "authority-watchdog.json"
$authoritySnapshot = $null
$runtimePid = $null
$runtimeParentPid = $null

if ($resolvedRelayRepo -and (Test-Path -LiteralPath (Join-Path $resolvedRelayRepo "tools/github_relay.py"))) {
  $relayScript = Join-Path $resolvedRelayRepo "tools/github_relay.py"
  $args = @($relayScript, "--repo", $resolvedRelayRepo, "--status")
  foreach ($row in $matchingRows) {
    $args += @("--observed-process", ("{0}:{1}" -f $row.pid, $row.parent_pid))
  }

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $watchdogOutput = & python @args 2>$null
  $watchdogExit = $LASTEXITCODE
  $sw.Stop()
  if (-not [string]::IsNullOrWhiteSpace(($watchdogOutput -join ""))) {
    [IO.File]::WriteAllText(
      $watchdogPath,
      (($watchdogOutput -join [Environment]::NewLine) + [Environment]::NewLine),
      [Text.UTF8Encoding]::new($false)
    )
    try {
      $watchdog = Get-Content -Raw -LiteralPath $watchdogPath | ConvertFrom-Json
      if ($watchdog.process -and $watchdog.process.health_pid) {
        $runtimePid = [int]$watchdog.process.health_pid
        $runtimeRow = $matchingRows | Where-Object { $_.pid -eq $runtimePid } | Select-Object -First 1
        if ($runtimeRow) { $runtimeParentPid = [int]$runtimeRow.parent_pid }
      }
      Invoke-Node @(
        (Join-Path $RepoRoot "tools/r32-authority-snapshot.js"),
        "--watchdog-status", $watchdogPath,
        "--latency-ms", ([math]::Round($sw.Elapsed.TotalMilliseconds,3).ToString([Globalization.CultureInfo]::InvariantCulture)),
        "--out", $authoritySnapshotPath
      )
      $authoritySnapshot = Get-Content -Raw -LiteralPath $authoritySnapshotPath | ConvertFrom-Json
    } catch {
      $authoritySnapshot = $null
    }
  }
}

$credentialPath = Resolve-CredentialPath $NativeRelayTokenFile
$nativeRelayOrigin = Resolve-NativeRelayOrigin $NativeRelayUrl
$nativeProbe = $null
$probeClassification = $null

if ($credentialPath -and $nativeRelayOrigin) {
  $token = $null
  $headers = $null
  try {
    $token = [IO.File]::ReadAllText($credentialPath).Trim()
    if ($token.Length -lt 32) {
      $probeClassification = "CREDENTIAL_FILE_INVALID"
    } else {
      $headers = @{ Authorization = "Bearer $token" }
      try {
        $health = Invoke-RestMethod -Method Get -Uri ($nativeRelayOrigin.TrimEnd("/") + "/v1/relay/health") -Headers $headers -TimeoutSec 5
        $devicesEnvelope = Invoke-RestMethod -Method Get -Uri ($nativeRelayOrigin.TrimEnd("/") + "/v1/relay/devices") -Headers $headers -TimeoutSec 5
        $devices = @($devicesEnvelope.devices)
        $nativeProbe = [ordered]@{
          contract_version = "pc.control.r33.native_relay_probe.v1"
          observed_at = (Get-Date).ToUniversalTime().ToString("o")
          health = $health
          devices = $devices
        }
      } catch {
        $probeClassification = $_.Exception.GetType().Name
      }
    }
  } finally {
    $token = $null
    $headers = $null
  }
}

$selectedDeviceId = $NativeDeviceId
if (-not $selectedDeviceId -and $nativeProbe) {
  $online = @($nativeProbe.devices | Where-Object { $_.online -eq $true })
  if ($online.Count -eq 1) {
    $selectedDeviceId = [string]$online[0].device_id
  }
}

$discovery = [ordered]@{
  contract_version = "pc.control.r33.runtime_discovery.v1"
  observed_at = (Get-Date).ToUniversalTime().ToString("o")
  relay_checkout = $resolvedRelayRepo
  relay_process = [ordered]@{
    logical_process_count = $logicalCount
    runtime_pid = $runtimePid
    parent_pid = $runtimeParentPid
    observed_matching_process_count = $matchingRows.Count
  }
  authority_snapshot = $authoritySnapshot
  native_relay = [ordered]@{
    origin = $nativeRelayOrigin
    probe = $nativeProbe
    probe_error_classification = $probeClassification
  }
  credential_path = $credentialPath
  native_device_id = $selectedDeviceId
  native_desktop_id = $NativeDesktopId
  secret_bytes_persisted = $false
  raw_command_lines_persisted = $false
  process_environment_scraped = $false
  port_scan_performed = $false
  side_effect_probe_count = 0
  current_authority_changed = $false
}

$discoveryPath = Join-Path $OutputDir "runtime-discovery.json"
[IO.File]::WriteAllText(
  $discoveryPath,
  (($discovery | ConvertTo-Json -Depth 30) + [Environment]::NewLine),
  [Text.UTF8Encoding]::new($false)
)

$reportPath = Join-Path $OutputDir "preflight-report.json"
Invoke-Node @(
  (Join-Path $RepoRoot "tools/r33-preflight-evaluate.js"),
  "--input", $discoveryPath,
  "--out", $reportPath,
  "--repo-root", $RepoRoot,
  "--run-dir", (Join-Path $OutputDir "r32-live-canary")
)

$report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
Write-Output $reportPath
if ($report.state -eq "READY_FOR_COORDINATOR_CANARY") {
  Write-Output $report.run_canary_command
} else {
  Write-Output (($report.blockers | ForEach-Object { $_.code }) -join ",")
}
