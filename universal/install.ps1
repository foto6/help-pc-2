$ErrorActionPreference = 'Stop'
$pcSource = $PSScriptRoot
$pcDestination = 'E:\PC-Control\UniversalMCP-20261015'
$pcChrome = 'E:\PC-Control\BrowserTabMCP-Canary-20261009'
$pcBridgeEntry = Join-Path $pcChrome 'bin\pc-browser-tab-mcp-stdio.js'
$pcExistingLauncher = 'E:\PC-Control\TunnelChrome-20261009\START_CHROME_TUNNEL.ps1'
$pcStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$pcManaged = @('package.json','START_CONNECTION.ps1','RUN_CONNECTION.ps1','SETUP_CONNECTION.ps1','CHECK_CONNECTION.ps1','PAUSE_CONTROL.cmd','RESUME_CONTROL.ps1')
if (-not (Test-Path -LiteralPath $pcBridgeEntry)) { throw 'Existing Chrome MCP entrypoint not found' }
New-Item -ItemType Directory -Path $pcDestination -Force | Out-Null
foreach ($pcRelative in $pcManaged) {
    $pcSourceFile = Join-Path $pcSource $pcRelative
    $pcTargetFile = Join-Path $pcDestination $pcRelative
    if ([IO.Path]::GetExtension($pcRelative) -eq '.ps1') {
        [IO.File]::WriteAllText($pcTargetFile,[IO.File]::ReadAllText($pcSourceFile),(New-Object System.Text.UTF8Encoding($true)))
    } else { Copy-Item -LiteralPath $pcSourceFile -Destination $pcTargetFile -Force }
}
foreach ($pcDirectory in @('runtime','src','bin','tests')) {
    $pcTarget = Join-Path $pcDestination $pcDirectory
    New-Item -ItemType Directory -Path $pcTarget -Force | Out-Null
    foreach ($pcFile in Get-ChildItem -LiteralPath (Join-Path $pcSource $pcDirectory) -File) {
        if ($pcFile.Extension -eq '.ps1') {
            [IO.File]::WriteAllText((Join-Path $pcTarget $pcFile.Name),[IO.File]::ReadAllText($pcFile.FullName),(New-Object System.Text.UTF8Encoding($true)))
        } elseif ($pcFile.Extension -in @('.py','.js')) { Copy-Item -LiteralPath $pcFile.FullName -Destination $pcTarget -Force }
    }
}
$pcState = Join-Path $pcDestination 'state'
New-Item -ItemType Directory -Path (Join-Path $pcState 'requests') -Force | Out-Null
$pcOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $pcState /inheritance:r /grant:r ('*' + $pcOwner + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'State ACL setup failed' }
$pcModules = Join-Path $pcDestination 'node_modules'
if (-not (Test-Path -LiteralPath $pcModules)) {
    New-Item -ItemType Junction -Path $pcModules -Target (Join-Path $pcChrome 'node_modules') | Out-Null
}
$pcExistingText = [IO.File]::ReadAllText($pcBridgeEntry)
if (-not $pcExistingText.Contains('UniversalMCP-20261015')) {
    Copy-Item -LiteralPath $pcBridgeEntry -Destination ($pcBridgeEntry + '.pre-universal-' + $pcStamp)
    $pcWrapper = @'
#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createBrowserTabMcpServer } from '../src/browser-tab-mcp-sidecar.js';
if (process.env.PC_CONTROL_ENABLE_BROWSER_TAB_CAPTURE !== '1') throw new Error('BROWSER_CAPTURE_EXPLICIT_OPT_IN_REQUIRED');
const factory = process.env.PC_CONTROL_ENABLE_UNIVERSAL === '1'
  ? (await import('file:///E:/PC-Control/UniversalMCP-20261015/src/server.js')).createUniversalServer
  : createBrowserTabMcpServer;
const handle = serveStdio(factory, {legacy: 'serve', onerror: error => console.error('[pc-control]', error?.name || 'Error')});
process.once('SIGINT', () => handle.close().finally(() => process.exit(0)));
process.once('SIGTERM', () => handle.close().finally(() => process.exit(0)));
'@
    [IO.File]::WriteAllText($pcBridgeEntry, $pcWrapper)
}
if (Test-Path -LiteralPath $pcExistingLauncher) {
    $pcLauncherText = [IO.File]::ReadAllText($pcExistingLauncher)
    if (-not $pcLauncherText.Contains('UniversalMCP-20261015')) {
        Copy-Item -LiteralPath $pcExistingLauncher -Destination ($pcExistingLauncher + '.pre-universal-' + $pcStamp)
        [IO.File]::WriteAllText($pcExistingLauncher, "& 'E:\PC-Control\UniversalMCP-20261015\START_CONNECTION.ps1'`r`n")
    }
}
$pcShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'PC Control Universal.lnk'
$pcShell = New-Object -ComObject WScript.Shell
$pcShortcut = $pcShell.CreateShortcut($pcShortcutPath)
$pcShortcut.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$pcShortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "E:\PC-Control\UniversalMCP-20261015\START_CONNECTION.ps1" -Quiet'
$pcShortcut.WorkingDirectory = $pcDestination
$pcShortcut.WindowStyle = 7
$pcShortcut.Save()
@{version='0.4.0';installed_at=[DateTime]::UtcNow.ToString('o');root=$pcDestination;tunnel_profile='pc-chrome-20261009';chrome_entry=$pcBridgeEntry;shortcut=$pcShortcutPath} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pcState 'installation.json') -Encoding UTF8
Write-Output ('Installed PC Control Universal 0.4.0: ' + $pcDestination)
