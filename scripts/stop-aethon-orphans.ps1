param(
  [string[]]$Kinds = @("DevUi", "BuildAutomation", "SyncdPhaseGate", "SyncdHarness")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir

. (Join-Path $scriptDir "AethonSessionTools.ps1")

$targets = @(Get-AethonManagedProcesses -ProjectRoot $projectRoot -Kinds $Kinds -ExcludePids @($PID))
if (-not $targets) {
  Write-Host "No managed Aethon session processes found."
  exit 0
}

$targets |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine |
  Format-Table -Wrap -AutoSize

Stop-AethonManagedProcesses -ProjectRoot $projectRoot -Kinds $Kinds -ExcludePids @($PID) | Out-Null

$extraTargets = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 1420, 4667, 9223 } |
  Select-Object -ExpandProperty OwningProcess -Unique

foreach ($targetPid in $extraTargets) {
  if ([int]$targetPid -gt 0 -and [int]$targetPid -ne $PID) {
    Stop-Process -Id ([int]$targetPid) -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "Stopped $($targets.Count) managed Aethon session process(es)."
