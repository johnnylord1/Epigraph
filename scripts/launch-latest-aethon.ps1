$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$port = 1420

. (Join-Path $scriptDir "AethonSessionTools.ps1")

function Get-PortListener {
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq $port } |
    Select-Object -First 1
}

function Stop-StaleAethonViteListener {
  param(
    [Parameter(Mandatory)]
    $Listener
  )

  $ownerPid = [int]$Listener.OwningProcess
  if ($ownerPid -le 0) {
    return $false
  }

  $proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { [int]$_.ProcessId -eq $ownerPid } |
    Select-Object -First 1

  if (-not $proc) {
    return $false
  }

  $cmd = [string]$proc.CommandLine
  $isAethonVite =
    $proc.Name -eq "node.exe" -and
    $cmd -match "vite\.js --host 127\.0\.0\.1 --port 1420"

  if (-not $isAethonVite) {
    return $false
  }

  Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  return $true
}

if (Focus-AethonWindow) {
  exit 0
}

$listener = Get-PortListener
$devProcesses = @(Get-AethonManagedProcesses -ProjectRoot $projectRoot -Kinds @("DevUi") -ExcludePids @($PID))
if ($listener -or $devProcesses) {
  $windowDeadline = (Get-Date).AddSeconds(12)
  do {
    if (Focus-AethonWindow) {
      exit 0
    }
    Start-Sleep -Milliseconds 600
  } until ((Get-Date) -gt $windowDeadline)
}

$managedKinds = @("DevUi", "BuildAutomation", "SyncdPhaseGate", "SyncdHarness")
$managedProcesses = @(Get-AethonManagedProcesses -ProjectRoot $projectRoot -Kinds $managedKinds -ExcludePids @($PID))
if ($listener -or $managedProcesses) {
  Stop-AethonManagedProcesses -ProjectRoot $projectRoot -Kinds $managedKinds -ExcludePids @($PID) | Out-Null
  Start-Sleep -Seconds 1
}

$listener = Get-PortListener
if ($listener) {
  if (Stop-StaleAethonViteListener -Listener $listener) {
    $listener = Get-PortListener
  }
}

if ($listener) {
  throw "Port $port is still busy after cleaning the Aethon session."
}

Start-Process `
  -FilePath "powershell.exe" `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command", "npm exec pnpm -- tauri:dev:gate"
  ) | Out-Null

$listenerDeadline = (Get-Date).AddSeconds(90)
do {
  Start-Sleep -Seconds 2
  $listener = Get-PortListener
} until ($listener -or (Get-Date) -gt $listenerDeadline)

if (-not $listener) {
  throw "Aethon dev server did not start on port $port."
}

$windowDeadline = (Get-Date).AddSeconds(90)
do {
  if (Focus-AethonWindow) {
    exit 0
  }
  Start-Sleep -Seconds 2
} until ((Get-Date) -gt $windowDeadline)

$runningApp = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -eq "aethon.exe" -and
    ([string]$_.CommandLine) -notmatch "--webdriver-automation"
  } |
  Select-Object -First 1

if ($listener -or $runningApp) {
  exit 0
}

throw "Aethon did not start correctly."
