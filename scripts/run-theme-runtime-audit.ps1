$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$cdpEndpoint = "http://127.0.0.1:9223"

 . (Join-Path $scriptDir 'EpigraphSessionTools.ps1')
$reply=Start-EpigraphDesktop -ProjectRoot $projectRoot -Mode dev
if(!$reply.runId){throw 'Exact run acknowledgement required'}
$record=@(Get-EpigraphSessionRecords | Where-Object RunId -CEQ $reply.runId)
if($record.Count -ne 1){throw 'Ambiguous run record'}
$request=@{Project=$record[0].Project;Profile=$record[0].Profile;Build=$record[0].Build;RunId=$reply.runId}
$env:EPIGRAPH_AUDIT_SESSION_RECORD=$record[0].RecordPath

$deadline = (Get-Date).AddSeconds(120)
do {
  try {
    Assert-EpigraphOwnedEndpoint $request 9223
    $targets = Invoke-RestMethod "$cdpEndpoint/json" -TimeoutSec 2
    if ($targets | Where-Object { $_.type -eq "page" -and $_.title -like "Epigraph*" }) {
      break
    }
  } catch {
    Start-Sleep -Milliseconds 500
  }
} while ((Get-Date) -lt $deadline)

if ((Get-Date) -ge $deadline) {
  throw "Epigraph did not expose a stable WebView2 CDP page within 120 seconds."
}

Push-Location $projectRoot
try {
  Assert-EpigraphOwnedEndpoint $request 9223
  & node (Join-Path $scriptDir "theme-runtime-audit.mjs") @args
  if ($LASTEXITCODE -ne 0) {
    throw "Theme runtime audit failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
