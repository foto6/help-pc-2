param(
  [Parameter(Mandatory=$true)]
  [ValidateSet("StartCandidate","AuthoritySnapshot","Canary","Cleanup","RunCanary")]
  [string]$Action,

  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$RunDir,
  [string]$RelayRepo,
  [string]$NativeRelayUrl,
  [string]$NativeRelayTokenFile,
  [string]$NativeDeviceId,
  [string]$NativeDesktopId = "desktop-A",
  [string]$CandidateDescriptor,
  [string]$AuthoritySnapshot,
  [string]$CanaryEvidence,
  [switch]$ExplicitLiveReadOnlyCanary,
  [string]$Tools = "device.ping,device.info",
  [int]$CandidatePort = 0
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function New-R32RunDir {
  $root = Join-Path $RepoRoot ".r32-canary"
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $name = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), ([guid]::NewGuid().ToString("N"))
  $path = Join-Path $root $name
  New-Item -ItemType Directory -Force -Path $path | Out-Null
  return $path
}

function New-R32Secret {
  $bytes = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+","-").Replace("/","_")
}

function Require-File([string]$Path, [string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Name is required and must be an existing file"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Require-Dir([string]$Path, [string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Name is required and must be an existing directory"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Invoke-Node([string[]]$Arguments) {
  & node @Arguments
  if ($LASTEXITCODE -ne 0) { throw "node command failed with exit $LASTEXITCODE" }
}

function Start-R32Candidate {
  $dir = if ($RunDir) { $RunDir } else { New-R32RunDir }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $dir = (Resolve-Path -LiteralPath $dir).Path
  $relayTokenPath = Require-File $NativeRelayTokenFile "NativeRelayTokenFile"
  if ([string]::IsNullOrWhiteSpace($NativeRelayUrl)) { throw "NativeRelayUrl is required" }
  if ([string]::IsNullOrWhiteSpace($NativeDeviceId)) { throw "NativeDeviceId is required" }

  $tokenPath = Join-Path $dir "candidate-token.txt"
  $token = New-R32Secret
  [IO.File]::WriteAllText($tokenPath, $token, [Text.UTF8Encoding]::new($false))
  if ($IsWindows) {
    & attrib +H $tokenPath 2>$null
  }

  $stateDir = Join-Path $dir "candidate-state"
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  $descriptor = Join-Path $dir "candidate.json"
  $stdout = Join-Path $dir "candidate.stdout.log"
  $stderr = Join-Path $dir "candidate.stderr.log"
  $relayToken = [IO.File]::ReadAllText($relayTokenPath).Trim()
  if ($relayToken.Length -lt 32) { throw "Native relay token file is invalid" }
  if ($relayToken -eq $token) { throw "Candidate MCP credential must differ from relay credential" }

  $saved = @{
    PC_NATIVE_RELAY_URL = $env:PC_NATIVE_RELAY_URL
    PC_NATIVE_RELAY_TOKEN = $env:PC_NATIVE_RELAY_TOKEN
    PC_NATIVE_DEVICE_ID = $env:PC_NATIVE_DEVICE_ID
    PC_NATIVE_DESKTOP_ID = $env:PC_NATIVE_DESKTOP_ID
  }
  try {
    $env:PC_NATIVE_RELAY_URL = $NativeRelayUrl
    $env:PC_NATIVE_RELAY_TOKEN = $relayToken
    $env:PC_NATIVE_DEVICE_ID = $NativeDeviceId
    $env:PC_NATIVE_DESKTOP_ID = $NativeDesktopId
    $runner = Join-Path $RepoRoot "tools/r32-isolated-candidate.js"
    $args = @(
      $runner,
      "--state-dir", $stateDir,
      "--token-file", $tokenPath,
      "--descriptor", $descriptor,
      "--port", [string]$CandidatePort
    )
    $process = Start-Process -FilePath "node" -ArgumentList $args -WorkingDirectory $RepoRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Hidden
  } finally {
    foreach ($key in $saved.Keys) {
      [Environment]::SetEnvironmentVariable($key, $saved[$key], "Process")
    }
    $relayToken = $null
    $token = $null
  }

  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $descriptor)) {
    if ($process.HasExited) {
      throw "isolated candidate exited before descriptor creation; inspect candidate.stderr.log"
    }
    Start-Sleep -Milliseconds 100
    $process.Refresh()
  }
  if (-not (Test-Path -LiteralPath $descriptor)) {
    throw "isolated candidate descriptor was not created within 20 seconds"
  }
  $data = Get-Content -Raw -LiteralPath $descriptor | ConvertFrom-Json
  if ([int]$data.pid -ne $process.Id -or $data.bind_host -ne "127.0.0.1") {
    throw "isolated candidate descriptor identity mismatch"
  }
  Write-Output $descriptor
}

function Get-R32ObservedRelayProcesses([string]$Repo) {
  if (-not $IsWindows) { return @() }
  $needle = [IO.Path]::GetFullPath($Repo)
  $rows = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and
    $_.CommandLine.Contains("github_relay.py") -and
    $_.CommandLine.Contains($needle)
  }
  return @($rows | ForEach-Object { "{0}:{1}" -f $_.ProcessId, $_.ParentProcessId })
}

function Write-R32AuthoritySnapshot {
  $repo = Require-Dir $RelayRepo "RelayRepo"
  $dir = if ($RunDir) { $RunDir } else { New-R32RunDir }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $statusPath = Join-Path $dir "authority-watchdog.json"
  $snapshotPath = if ($AuthoritySnapshot) { $AuthoritySnapshot } else { Join-Path $dir "authority-snapshot.json" }
  $relayScript = Join-Path $repo "tools/github_relay.py"
  if (-not (Test-Path -LiteralPath $relayScript)) { throw "RelayRepo does not contain tools/github_relay.py" }

  $observed = Get-R32ObservedRelayProcesses $repo
  $args = @($relayScript, "--repo", $repo, "--status")
  foreach ($item in $observed) { $args += @("--observed-process", $item) }

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $output = & python @args 2>$null
  $exit = $LASTEXITCODE
  $sw.Stop()
  if ([string]::IsNullOrWhiteSpace(($output -join ""))) {
    throw "GitHub relay watchdog produced no JSON"
  }
  [IO.File]::WriteAllText($statusPath, (($output -join [Environment]::NewLine) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  Invoke-Node @(
    (Join-Path $RepoRoot "tools/r32-authority-snapshot.js"),
    "--watchdog-status", $statusPath,
    "--latency-ms", ([math]::Round($sw.Elapsed.TotalMilliseconds,3).ToString([Globalization.CultureInfo]::InvariantCulture)),
    "--out", $snapshotPath
  )
  if ($exit -ne 0 -and $exit -ne 2) {
    throw "GitHub relay watchdog status command failed with exit $exit"
  }
  Write-Output $snapshotPath
}

function Invoke-R32Canary {
  $descriptor = Require-File $CandidateDescriptor "CandidateDescriptor"
  $authority = Require-File $AuthoritySnapshot "AuthoritySnapshot"
  $dir = if ($RunDir) { $RunDir } else { Split-Path -Parent $descriptor }
  $out = if ($CanaryEvidence) { $CanaryEvidence } else { Join-Path $dir "canary-evidence.json" }
  $args = @(
    (Join-Path $RepoRoot "tools/r32-read-only-canary.js"),
    "--candidate-descriptor", $descriptor,
    "--authority-snapshot", $authority,
    "--tools", $Tools,
    "--out", $out
  )
  if ($ExplicitLiveReadOnlyCanary) { $args += "--actual-coordinator-run" }
  Invoke-Node $args
  Write-Output $out
}

function Stop-R32Candidate {
  $descriptorPath = Require-File $CandidateDescriptor "CandidateDescriptor"
  $data = Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
  if ($data.contract_version -ne "pc.control.r32.isolated_candidate.v1") {
    throw "candidate descriptor contract mismatch"
  }
  $pidValue = [int]$data.pid
  $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($null -ne $proc) {
    if ($IsWindows) {
      $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue"
      $expectedDescriptor = [IO.Path]::GetFullPath($descriptorPath)
      if (-not $cim.CommandLine -or
          -not $cim.CommandLine.Contains("r32-isolated-candidate.js") -or
          -not $cim.CommandLine.Contains($expectedDescriptor)) {
        throw "refusing cleanup: PID is not the exact isolated R32 candidate"
      }
    }
    Stop-Process -Id $pidValue -ErrorAction Stop
    try { Wait-Process -Id $pidValue -Timeout 10 -ErrorAction SilentlyContinue } catch {}
  }
  if ($data.token_file -and (Test-Path -LiteralPath $data.token_file)) {
    Remove-Item -Force -LiteralPath $data.token_file
  }
  Write-Output $descriptorPath
}

switch ($Action) {
  "StartCandidate" {
    Start-R32Candidate
  }
  "AuthoritySnapshot" {
    Write-R32AuthoritySnapshot
  }
  "Canary" {
    Invoke-R32Canary
  }
  "Cleanup" {
    Stop-R32Candidate
  }
  "RunCanary" {
    if (-not $ExplicitLiveReadOnlyCanary) {
      throw "RunCanary requires -ExplicitLiveReadOnlyCanary; synthetic/operator-dry evidence must remain SOURCE_READY"
    }
    $dir = if ($RunDir) { $RunDir } else { New-R32RunDir }
    $RunDir = $dir
    $descriptor = $null
    try {
      $descriptor = Start-R32Candidate | Select-Object -Last 1
      $CandidateDescriptor = $descriptor
      $authority = Write-R32AuthoritySnapshot | Select-Object -Last 1
      $AuthoritySnapshot = $authority
      $evidence = Invoke-R32Canary | Select-Object -Last 1
      Write-Output $evidence
    } finally {
      if ($descriptor -and (Test-Path -LiteralPath $descriptor)) {
        $CandidateDescriptor = $descriptor
        Stop-R32Candidate | Out-Null
      }
    }
  }
}
