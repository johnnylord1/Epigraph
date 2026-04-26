$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$releaseExe = Join-Path $projectRoot "src-tauri\target\release\aethon.exe"
$mainPort = 4567
$devPort = 1420

. (Join-Path $scriptDir "AethonSessionTools.ps1")

function Get-PortListener {
  param(
    [Parameter(Mandatory)]
    [int]$Port
  )

  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq $Port } |
    Select-Object -First 1
}

function Get-AethonMainWindowProcess {
  $windowed = Get-Process aethon -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -or $_.MainWindowTitle }

  if (-not $windowed) {
    return $null
  }

  $windowIds = @($windowed | ForEach-Object { [int]$_.Id })
  $processMeta = @{}

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $windowIds -contains [int]$_.ProcessId } |
    ForEach-Object {
      $processMeta[[int]$_.ProcessId] = $_
    }

  $windowed |
    Where-Object {
      $meta = $processMeta[[int]$_.Id]
      $cmd = if ($null -ne $meta) { [string]$meta.CommandLine } else { "" }
      $title = [string]$_.MainWindowTitle
      ($cmd -match " --main(?:\s|$)" -or $title -match "\[MAIN\]") -and
        $cmd -notmatch "--webdriver-automation"
    } |
    Select-Object -First 1
}

function Focus-AethonMainWindow {
  Use-AethonWindowInterop

  $proc = Get-AethonMainWindowProcess
  if (-not $proc) { return $false }

  $hwnd = [System.IntPtr]$proc.MainWindowHandle
  if ($hwnd -eq [System.IntPtr]::Zero) { return $false }

  [AethonWindow]::ShowWindowAsync($hwnd, 9) | Out-Null
  Start-Sleep -Milliseconds 250
  [AethonWindow]::SetForegroundWindow($hwnd) | Out-Null
  return $true
}

function Move-AethonMainWindowToMonitor3 {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AethonWin32 {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
}
"@ -ErrorAction SilentlyContinue

  $proc = Get-AethonMainWindowProcess
  if (-not $proc) { return $false }

  $screen = [System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Bounds.X -eq 1920 } | Select-Object -First 1
  if (-not $screen) {
    $screen = [System.Windows.Forms.Screen]::AllScreens | Sort-Object { $_.Bounds.X } | Select-Object -Last 1
  }

  if (-not $screen) { return $false }

  $bounds = $screen.Bounds
  [AethonWin32]::MoveWindow(
    [System.IntPtr]$proc.MainWindowHandle,
    $bounds.X,
    $bounds.Y,
    $bounds.Width,
    $bounds.Height,
    $true
  ) | Out-Null
  return $true
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

  & taskkill.exe /PID $ownerPid /T /F | Out-Null
  Start-Sleep -Seconds 1
  return $true
}

if (-not (Test-Path -LiteralPath $releaseExe)) {
  throw "Release executable not found at $releaseExe. Build the app first."
}

Stop-AethonManagedProcesses -ProjectRoot $projectRoot -Kinds @("DevUi", "BuildAutomation", "SyncdPhaseGate", "SyncdHarness") | Out-Null

$devListener = Get-PortListener -Port $devPort
if ($devListener) {
  if (Stop-StaleAethonViteListener -Listener $devListener) {
    $devListener = Get-PortListener -Port $devPort
  }
}

if ($devListener) {
  throw "Port $devPort is still busy after cleaning the MAIN session."
}

$listener = Get-PortListener -Port $mainPort
if ($listener) {
  $ownerPid = [int]$listener.OwningProcess
  if ($ownerPid -gt 0 -and $ownerPid -ne $PID) {
    $proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { [int]$_.ProcessId -eq $ownerPid } |
      Select-Object -First 1
    if ($proc) {
      $cmd = [string]$proc.CommandLine
      if ($proc.Name -in @("java.exe", "node.exe", "aethon.exe", "cargo.exe") -and $cmd -match "aethon-main|--main|4567") {
        Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
      }
    }
  }
}

$listener = Get-PortListener -Port $mainPort
if ($listener) {
  throw "Port $mainPort is still busy after cleaning the MAIN session."
}

$env:AETHON_LAUNCH_PROFILE = "MAIN"
if (-not $env:AETHON_STARTUP_DIAGNOSTICS) {
  $env:AETHON_STARTUP_DIAGNOSTICS = "0"
}

Start-Process `
  -FilePath $releaseExe `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -ArgumentList @("--main") | Out-Null

$listenerDeadline = (Get-Date).AddSeconds(90)
do {
  Start-Sleep -Seconds 1
  $listener = Get-PortListener -Port $mainPort
} until ($listener -or (Get-Date) -gt $listenerDeadline)

if (-not $listener) {
  throw "Aethon MAIN profile did not start on port $mainPort."
}

$windowDeadline = (Get-Date).AddSeconds(90)
do {
  if (Focus-AethonMainWindow) {
    Move-AethonMainWindowToMonitor3 | Out-Null
    exit 0
  }
  Start-Sleep -Seconds 1
} until ((Get-Date) -gt $windowDeadline)

Move-AethonMainWindowToMonitor3 | Out-Null
exit 0
