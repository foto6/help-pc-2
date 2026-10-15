param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$pcRoot = $PSScriptRoot
$pcExisting = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'tunnel-client.exe' -and $_.CommandLine -like '*run*pc-chrome-20261009*'
}
if ($pcExisting) { exit 0 }
$pcPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (Test-Path -LiteralPath (Join-Path $pcRoot 'state\connection.key')) {
    Start-Process -FilePath $pcPowerShell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + (Join-Path $pcRoot 'RUN_CONNECTION.ps1') + '"')) -WindowStyle Hidden | Out-Null
} elseif (-not $Quiet) {
    Start-Process -FilePath $pcPowerShell -ArgumentList @('-NoProfile','-STA','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + (Join-Path $pcRoot 'SETUP_CONNECTION.ps1') + '"')) -WindowStyle Hidden | Out-Null
}
