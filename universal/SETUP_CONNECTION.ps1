param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Security
$pcRoot = $PSScriptRoot
$pcForm = New-Object System.Windows.Forms.Form
$pcForm.Text = 'PC Control — подключение'
$pcForm.Size = New-Object System.Drawing.Size(560,310)
$pcForm.StartPosition = 'CenterScreen'
$pcForm.FormBorderStyle = 'FixedDialog'
$pcForm.MaximizeBox = $false
$pcInfo = New-Object System.Windows.Forms.Label
$pcInfo.Location = New-Object System.Drawing.Point(22,20)
$pcInfo.Size = New-Object System.Drawing.Size(505,70)
$pcInfo.Text = "Введи runtime API key для своего OpenAI MCP Tunnel.`r`nКлюч сохранится на этом ПК под защитой твоей учётной записи Windows.`r`nВ чат его отправлять не нужно."
$pcInput = New-Object System.Windows.Forms.TextBox
$pcInput.Location = New-Object System.Drawing.Point(22,105)
$pcInput.Size = New-Object System.Drawing.Size(500,25)
$pcInput.UseSystemPasswordChar = $true
$pcInput.AccessibleName = 'Secret runtime key — owner input only'
$pcLink = New-Object System.Windows.Forms.LinkLabel
$pcLink.Location = New-Object System.Drawing.Point(22,145)
$pcLink.Size = New-Object System.Drawing.Size(490,25)
$pcLink.Text = 'Открыть настройки ключей OpenAI Platform'
$pcLink.Add_LinkClicked({ Start-Process 'https://platform.openai.com/settings/organization/api-keys' })
$pcSave = New-Object System.Windows.Forms.Button
$pcSave.Location = New-Object System.Drawing.Point(22,190)
$pcSave.Size = New-Object System.Drawing.Size(245,38)
$pcSave.Text = 'Сохранить и подключить'
$pcSave.Tag = @{Root=$pcRoot;Input=$pcInput;Form=$pcForm;SelfTest=[bool]$SelfTest}
$pcSave.Add_Click({
    param($pcSender, $pcEvent)
    $pcContext = $pcSender.Tag
    if ([string]::IsNullOrWhiteSpace($pcContext.Input.Text)) { return }
    $pcStage = 'protect-key'
    try {
        $pcKeyBytes = [Text.Encoding]::UTF8.GetBytes($pcContext.Input.Text.Trim())
        $pcProtected = [Security.Cryptography.ProtectedData]::Protect($pcKeyBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        $pcEncrypted = 'dpapi-v1:' + [Convert]::ToBase64String($pcProtected)
        $pcStage = 'save-key'
        $pcKeyName = if ($pcContext.SelfTest) { 'state\setup-selftest.dpapi' } else { 'state\connection.key' }
        [IO.File]::WriteAllText((Join-Path $pcContext.Root $pcKeyName), $pcEncrypted)
        $pcContext.Input.Clear()
        [Array]::Clear($pcKeyBytes,0,$pcKeyBytes.Length)
        Remove-Variable pcEncrypted,pcKeyBytes,pcProtected -ErrorAction SilentlyContinue
        if ($pcContext.SelfTest) { $pcContext.Form.Close(); return }
        $pcStage = 'start-connection'
        $pcStartScript = Join-Path $pcContext.Root 'START_CONNECTION.ps1'
        $pcWindowsShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        Start-Process -FilePath $pcWindowsShell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $pcStartScript + '"'),'-Quiet') -WindowStyle Hidden | Out-Null
        [System.Windows.Forms.MessageBox]::Show('Ключ сохранён. Запускаю соединение; результат появится в проверке подключения.', 'PC Control') | Out-Null
        $pcContext.Form.Close()
    } catch {
        $pcSafeError = @{stage=$pcStage;error_type=$_.Exception.GetType().Name;error_id=$_.FullyQualifiedErrorId;line=$_.InvocationInfo.ScriptLineNumber}
        try { $pcSafeError | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pcContext.Root 'state\setup-error.json') -Encoding UTF8 } catch {}
        if ($pcContext.SelfTest) { $pcContext.Form.Close() } else {
            [System.Windows.Forms.MessageBox]::Show(('Ошибка на шаге ' + $pcStage + '. Код: ' + $pcSafeError.error_type + '. Ключ в сообщение не включён.'), 'PC Control') | Out-Null
        }
    }
})
$pcForm.Controls.AddRange(@($pcInfo,$pcInput,$pcLink,$pcSave))
$pcForm.AcceptButton = $pcSave
if ($SelfTest) {
    $pcForm.Add_Shown({$pcInput.Text='pc-control-public-selftest';$pcSave.PerformClick()})
}
[void]$pcForm.ShowDialog()
$pcInput.Clear()
$pcForm.Dispose()
if ($SelfTest) {
    $pcTestPath = Join-Path $pcRoot 'state\setup-selftest.dpapi'
    $pcTestSaved = Test-Path -LiteralPath $pcTestPath
    if ($pcTestSaved) {
        $pcTestCipher = [IO.File]::ReadAllText($pcTestPath).Substring(9)
        $pcTestClear = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($pcTestCipher),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        $pcTestSaved = [Text.Encoding]::UTF8.GetString($pcTestClear) -eq 'pc-control-public-selftest'
        [Array]::Clear($pcTestClear,0,$pcTestClear.Length)
        Remove-Item -LiteralPath $pcTestPath
    }
    [PSCustomObject]@{gui_dpapi_roundtrip=$pcTestSaved} | ConvertTo-Json -Compress
    if (-not $pcTestSaved) { exit 1 }
}
