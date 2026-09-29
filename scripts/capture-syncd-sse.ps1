param(
  [Parameter(Mandatory = $true)][string]$Endpoint,
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$ScopeId,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [int]$TimeoutSeconds = 15,
  [string]$LastEventId = "",
  [int]$MaxEvents = 0
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'EpigraphSessionTools.ps1')
Set-StrictMode -Version Latest

if (Test-Path $OutputPath) {
  Remove-Item $OutputPath -Force
}

$stderrPath = "$OutputPath.stderr"
if (Test-Path $stderrPath) {
  Remove-Item $stderrPath -Force
}

$uri = "$Endpoint/v1/events?scopeId=$([Uri]::EscapeDataString($ScopeId))"
$arguments = @(
  "-k",
  "-N",
  "-sS",
  "-H", "Authorization: Bearer $Token",
  "-H", "X-Epigraph-Client-Version: 0.1.0",
  "-H", "X-Epigraph-Client-Protocol-Version: 1"
)
if ($LastEventId -ne "") {
  $arguments += @("-H", "Last-Event-ID: $LastEventId")
}
$arguments += $uri

$process = Start-Process `
  -FilePath "curl.exe" `
  -ArgumentList $arguments `
  -RedirectStandardOutput $OutputPath `
  -RedirectStandardError $stderrPath `
  -PassThru

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
try {
  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) {
      break
    }

    if ($MaxEvents -gt 0 -and (Test-Path $OutputPath)) {
      $eventCount = (Select-String -Path $OutputPath -Pattern '^event:' -AllMatches -ErrorAction SilentlyContinue).Count
      if ($eventCount -ge $MaxEvents) {
        break
      }
    }

    Start-Sleep -Milliseconds 100
  }
}
finally {
  if (-not $process.HasExited) {
    Stop-EpigraphRetainedProcess -Process $process
  }
}
