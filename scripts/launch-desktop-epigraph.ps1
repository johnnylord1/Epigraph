$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$port = 1420

. (Join-Path $scriptDir "EpigraphSessionTools.ps1")

function Get-PortListener {
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq $port } |
    Select-Object -First 1
}

function Stop-OrphanRuntimeIfNeeded {
  if (Get-EpigraphWindowProcess) {
    return
  }

  $candidatePorts = @(1420, 4667, 9223)
  $allowedNames = @("node.exe", "java.exe", "javaw.exe", "epigraph.exe", "cargo.exe")

  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in $candidatePorts } |
    Select-Object -Unique OwningProcess |
    ForEach-Object {
      $ownerPid = [int]$_.OwningProcess
      if ($ownerPid -le 0 -or $ownerPid -eq $PID) {
        return
      }

      $proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { [int]$_.ProcessId -eq $ownerPid } |
        Select-Object -First 1

      if (-not $proc) {
        return
      }

      if ($allowedNames -contains $proc.Name) {
        Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
      }
    }

  Start-Sleep -Seconds 1
}

if (Focus-EpigraphWindow) {
  exit 0
}

$managedKinds = @("DevUi", "BuildAutomation", "SyncdPhaseGate", "SyncdHarness")
Stop-EpigraphManagedProcesses -ProjectRoot $projectRoot -Kinds $managedKinds -ExcludePids @($PID) | Out-Null
Start-Sleep -Seconds 1
Stop-OrphanRuntimeIfNeeded

Start-Process `
  -FilePath "powershell.exe" `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command", "npm exec pnpm -- tauri:dev:gate"
  ) | Out-Null

exit 0
