Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$pcFixtureState = Join-Path $PSScriptRoot '..\state\fixture-result.json'
$pcFixture = New-Object System.Windows.Forms.Form
$pcFixture.Text = 'PC Control Universal Test'
$pcFixture.Size = New-Object System.Drawing.Size(620,360)
$pcFixture.StartPosition = 'CenterScreen'
$pcText = New-Object System.Windows.Forms.TextBox
$pcText.Location = New-Object System.Drawing.Point(20,25)
$pcText.Size = New-Object System.Drawing.Size(560,140)
$pcText.Multiline = $true
$pcText.AccessibleName = 'PcControlTestInput'
$pcButton = New-Object System.Windows.Forms.Button
$pcButton.Text = 'Test button'
$pcButton.AccessibleName = 'PcControlTestButton'
$pcButton.Location = New-Object System.Drawing.Point(20,190)
$pcButton.Size = New-Object System.Drawing.Size(180,40)
$pcCount = New-Object System.Windows.Forms.Label
$pcCount.Text = 'Clicks: 0'
$pcCount.Location = New-Object System.Drawing.Point(230,200)
$pcCount.Size = New-Object System.Drawing.Size(300,40)
$script:pcClicks = 0
$pcButton.Add_Click({
    $script:pcClicks += 1
    $pcCount.Text = 'Clicks: ' + $script:pcClicks
    [IO.File]::WriteAllText($pcFixtureState, (@{clicks=$script:pcClicks;text=$pcText.Text} | ConvertTo-Json -Compress))
})
$pcFixture.Controls.AddRange(@($pcText,$pcButton,$pcCount))
[void]$pcFixture.ShowDialog()
