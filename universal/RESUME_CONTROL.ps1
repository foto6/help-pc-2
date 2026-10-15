$pcPauseFile = Join-Path $PSScriptRoot 'state\PAUSED'
if (Test-Path -LiteralPath $pcPauseFile) { Remove-Item -LiteralPath $pcPauseFile }
Write-Output 'PC Control actions resumed.'
