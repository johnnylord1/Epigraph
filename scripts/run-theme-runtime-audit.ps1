$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$cdpEndpoint = "http://127.0.0.1:9223"

& (Join-Path $scriptDir "launch-desktop-epigraph.ps1")

$deadline = (Get-Date).AddSeconds(120)
do {
  try {
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
  & node (Join-Path $scriptDir "theme-runtime-audit.mjs") @args
  if ($LASTEXITCODE -ne 0) {
    throw "Theme runtime audit failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
