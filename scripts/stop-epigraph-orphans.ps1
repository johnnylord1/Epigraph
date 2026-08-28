param(
  [string[]]$Kinds = @("DevUi", "BuildAutomation", "SyncdPhaseGate", "SyncdHarness")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir

. (Join-Path $scriptDir "EpigraphSessionTools.ps1")

$targets = @(Get-EpigraphManagedProcesses -ProjectRoot $projectRoot -Kinds $Kinds -ExcludePids @($PID))
if (-not $targets) {
  Write-Host "No managed Epigraph session processes found."
  exit 0
}

$targets |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine |
  Format-Table -Wrap -AutoSize

Stop-EpigraphManagedProcesses -ProjectRoot $projectRoot -Kinds $Kinds -ExcludePids @($PID) | Out-Null

$extraTargets = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 1420, 4667, 9223 } |
  Select-Object -ExpandProperty OwningProcess -Unique

foreach ($targetPid in $extraTargets) {
  if ([int]$targetPid -gt 0 -and [int]$targetPid -ne $PID) {
    Stop-Process -Id ([int]$targetPid) -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "Stopped $($targets.Count) managed Epigraph session process(es)."
