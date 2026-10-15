$pcProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'tunnel-client.exe' -and $_.CommandLine -like '*run*pc-chrome-20261009*' })
$pcReady = $false
try {
    $pcResponse = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/readyz' -TimeoutSec 3
    $pcReady = $pcResponse.StatusCode -eq 200
} catch {}
[PSCustomObject]@{ tunnel_processes=$pcProcesses.Count; ready=$pcReady; key_saved=(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'state\connection.key')); paused=(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'state\PAUSED')) } | ConvertTo-Json -Compress
