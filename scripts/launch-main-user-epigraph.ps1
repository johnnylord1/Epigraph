$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$releaseExe = Join-Path $projectRoot "src-tauri\target\release\epigraph.exe"
$mainPort = 4567
$devPort = 1420

. (Join-Path $scriptDir "EpigraphSessionTools.ps1")

function Get-PortListener {
  param(
    [Parameter(Mandatory)]
    [int]$Port
  )

  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq $Port } |
    Select-Object -First 1
}

function Get-EpigraphMainWindowProcess {
  $windowed = Get-Process epigraph -ErrorAction SilentlyContinue |
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

function Focus-EpigraphMainWindow {
  Use-EpigraphWindowInterop

  $proc = Get-EpigraphMainWindowProcess
  if (-not $proc) { return $false }

  $hwnd = [System.IntPtr]$proc.MainWindowHandle
  if ($hwnd -eq [System.IntPtr]::Zero) { return $false }

  [EpigraphWindow]::ShowWindowAsync($hwnd, 9) | Out-Null
  Start-Sleep -Milliseconds 250
  [EpigraphWindow]::SetForegroundWindow($hwnd) | Out-Null
  return $true
}

function Stop-StaleEpigraphViteListener {
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
  $isEpigraphVite =
    $proc.Name -eq "node.exe" -and
    $cmd -match "vite\.js --host 127\.0\.0\.1 --port 1420"

  if (-not $isEpigraphVite) {
    return $false
  }

  & taskkill.exe /PID $ownerPid /T /F | Out-Null
  Start-Sleep -Seconds 1
  return $true
}

if (-not (Test-Path -LiteralPath $releaseExe)) {
  throw "Release executable not found at $releaseExe. Build the app first."
}

Stop-EpigraphManagedProcesses -ProjectRoot $projectRoot -Kinds @("DevUi", "BuildAutomation", "SyncdPhaseGate", "SyncdHarness") | Out-Null

$devListener = Get-PortListener -Port $devPort
if ($devListener) {
  if (Stop-StaleEpigraphViteListener -Listener $devListener) {
    $devListener = Get-PortListener -Port $devPort
  }
}

if ($devListener) {
  throw "Port $devPort is still busy after cleaning the MAIN session."
}

$existingMainProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -eq "epigraph.exe" -and
    [string]$_.CommandLine -match " --main(?:\s|$)"
  }
foreach ($proc in $existingMainProcesses) {
  if ([int]$proc.ProcessId -gt 0) {
    Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction SilentlyContinue
  }
}

$existingJavaProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -in @("java.exe", "javaw.exe") -and
    [string]$_.CommandLine -match "4567|epigraph-main|epigraph-main-profile|Epigraph MAIN"
  }
foreach ($proc in $existingJavaProcesses) {
  if ([int]$proc.ProcessId -gt 0) {
    Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction SilentlyContinue
  }
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
      if ($proc.Name -in @("java.exe", "javaw.exe", "node.exe", "epigraph.exe", "cargo.exe") -and $cmd -match "epigraph-main|--main|4567") {
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

$env:EPIGRAPH_LAUNCH_PROFILE = "MAIN"
if (-not $env:EPIGRAPH_STARTUP_DIAGNOSTICS) {
  $env:EPIGRAPH_STARTUP_DIAGNOSTICS = "0"
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
  throw "Epigraph MAIN profile did not start on port $mainPort."
}

$windowDeadline = (Get-Date).AddSeconds(90)
do {
  if (Focus-EpigraphMainWindow) {
    exit 0
  }
  Start-Sleep -Seconds 1
} until ((Get-Date) -gt $windowDeadline)

exit 0
