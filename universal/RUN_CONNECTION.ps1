$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$pcRoot = $PSScriptRoot
$pcState = Join-Path $pcRoot 'state'
$pcLogs = Join-Path $pcState 'connection'
New-Item -ItemType Directory -Path $pcLogs -Force | Out-Null
$pcMutex = New-Object System.Threading.Mutex($false, ('Local\PCControlUniversal-' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
if (-not $pcMutex.WaitOne(0)) { $pcMutex.Dispose(); exit 0 }
$pcClearBytes = $null
try {
    $pcExisting = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'tunnel-client.exe' -and $_.CommandLine -like '*run*pc-chrome-20261009*' }
    if ($pcExisting) { exit 0 }
    $pcProtectedText = [IO.File]::ReadAllText((Join-Path $pcState 'connection.key'))
    if (-not $pcProtectedText.StartsWith('dpapi-v1:')) { throw 'KEY_FORMAT_REQUIRES_SETUP' }
    $pcClearBytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($pcProtectedText.Substring(9)),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $env:CONTROL_PLANE_API_KEY = [Text.Encoding]::UTF8.GetString($pcClearBytes)
    $env:PC_CONTROL_ENABLE_UNIVERSAL = '1'
    $env:PC_CONTROL_ENABLE_BROWSER_TAB_CAPTURE = '1'
    $env:PC_CONTROL_BROWSER_CDP_ALLOWED_PORTS = '17410,17447'
    $pcBinary = 'E:\PC-Control\TunnelChrome-20261009\full\tunnel-client.exe'
    $pcDoctor = Join-Path $pcLogs 'doctor.log'
    & $pcBinary doctor --profile pc-chrome-20261009 --explain *> $pcDoctor
    if ($LASTEXITCODE -ne 0) {
        @{state='diagnostics_failed';updated=[DateTime]::UtcNow.ToString('o');diagnostic_path=$pcDoctor} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pcLogs 'status.json') -Encoding UTF8
        exit 2
    }
    @{state='starting';updated=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pcLogs 'status.json') -Encoding UTF8
    $pcTunnel = Start-Process -FilePath $pcBinary -ArgumentList @('run','--profile','pc-chrome-20261009') -WorkingDirectory $pcRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $pcLogs 'stdout.log') -RedirectStandardError (Join-Path $pcLogs 'stderr.log')
    @{state='running';pid=$pcTunnel.Id;updated=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pcLogs 'status.json') -Encoding UTF8
    $pcTunnel.WaitForExit()
    @{state='stopped';exit_code=$pcTunnel.ExitCode;updated=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pcLogs 'status.json') -Encoding UTF8
} catch {
    @{state='failed';error_type=$_.Exception.GetType().Name;updated=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pcLogs 'status.json') -Encoding UTF8
} finally {
    if ($pcClearBytes) { [Array]::Clear($pcClearBytes,0,$pcClearBytes.Length) }
    Remove-Item Env:\CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    Remove-Variable pcClearBytes,pcProtectedText -ErrorAction SilentlyContinue
    $pcMutex.ReleaseMutex()
    $pcMutex.Dispose()
}
