param([Parameter(Mandatory)][string]$LaunchPath,[string]$SessionDirectory)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'EpigraphSessionTools.ps1')
$launch=Get-Content -LiteralPath $LaunchPath -Raw | ConvertFrom-Json
if(!$SessionDirectory){$SessionDirectory=Get-EpigraphSessionDirectory}
$record=Start-EpigraphOwnedProcess $launch.Request $launch.AppExe $launch.Executable $launch.Arguments $SessionDirectory
try {
  while ($true) {
    Start-Sleep -Seconds 2
    try { $members=@([EpigraphProcessNative]::Snapshot($record.Job)) }
    catch { continue } # Preserve the capability when inventory cannot be proven.
    if (!$members.Count) { break }
  }
} finally { $script:EpigraphTickets[$record.RunId].Dispose() }
