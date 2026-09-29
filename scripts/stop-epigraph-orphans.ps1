param([string]$RunId, [switch]$Stop)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'EpigraphSessionTools.ps1')
$root=(Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$records=@(Get-EpigraphSessionRecords | Where-Object { $_.Project -ieq $root -and (!$RunId -or $_.RunId -ceq $RunId) })
if ($Stop -and (!$RunId -or $records.Count -ne 1)) { throw 'Stopping requires one exact recorded RunId for this project' }
foreach ($record in $records) {
  $request=@{Project=$root;Profile=$record.Profile;RunId=$record.RunId;Build=$record.Build}
  if ($Stop) { Stop-EpigraphOwnedSession $request }
  else { Get-EpigraphOwnedInspection $request | Where-Object RunId -eq $record.RunId | Select-Object RunId,Pid,Classification }
}
