$ErrorActionPreference = "Stop"

function Use-EpigraphWindowInterop {
  if (-not ([System.Management.Automation.PSTypeName]'EpigraphWindow').Type) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class EpigraphWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
  }
}

function Get-EpigraphWindowProcess {
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
      $cmd -notmatch "--webdriver-automation"
    } |
    Select-Object -First 1
}

function Focus-EpigraphWindow {
  Use-EpigraphWindowInterop

  $proc = Get-EpigraphWindowProcess
  if (-not $proc) { return $false }

  $hwnd = [System.IntPtr]$proc.MainWindowHandle
  if ($hwnd -eq [System.IntPtr]::Zero) { return $false }

  [EpigraphWindow]::ShowWindowAsync($hwnd, 9) | Out-Null
  Start-Sleep -Milliseconds 250
  [EpigraphWindow]::SetForegroundWindow($hwnd) | Out-Null
  return $true
}

function Get-EpigraphProcessSnapshot {
  param(
    [int[]]$ExcludePids = @()
  )

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $ExcludePids -notcontains [int]$_.ProcessId }
}

function Get-EpigraphManagedSeeds {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot,
    [string[]]$Kinds = @("DevUi", "BuildAutomation", "SyncdPhaseGate", "SyncdHarness"),
    [int[]]$ExcludePids = @($PID)
  )

  $resolvedRoot = (Resolve-Path $ProjectRoot).Path
  $escapedRoot = [regex]::Escape($resolvedRoot)
  $debugExe = Join-Path $resolvedRoot "src-tauri\target\debug\epigraph.exe"
  $releaseExe = Join-Path $resolvedRoot "src-tauri\target\release\epigraph.exe"
  $debugSyncdExe = Join-Path $resolvedRoot "src-tauri\target\debug\epigraph-syncd.exe"
  $releaseSyncdExe = Join-Path $resolvedRoot "src-tauri\target\release\epigraph-syncd.exe"
  $all = Get-EpigraphProcessSnapshot -ExcludePids $ExcludePids

  $includeAll = $Kinds -contains "All"
  function Has-Kind([string]$Kind) {
    return $includeAll -or ($Kinds -contains $Kind)
  }

  $all | Where-Object {
    $proc = $_
    $name = [string]$proc.Name
    $cmd = [string]$proc.CommandLine
    $exe = [string]$proc.ExecutablePath
    $isSeed = $false

    if (Has-Kind "DevUi") {
      if (
        $name -in @("powershell.exe", "cmd.exe", "node.exe", "wscript.exe") -and
        $cmd -and
        $cmd -match $escapedRoot -and
        (
          $cmd -match "tauri:dev(?::gate)?" -or
          $cmd -match "tauri\.js""?\s+dev" -or
          $cmd -match "vite\.js --host 127\.0\.0\.1 --port 1420" -or
          $cmd -match "launch-latest-epigraph"
        )
      ) {
        $isSeed = $true
      }
      elseif (
        $name -eq "epigraph.exe" -and
        (
          ($exe -and $exe -ieq $debugExe) -or
          ($cmd -and $cmd -match [regex]::Escape($debugExe))
        ) -and
        ($cmd -notmatch "--webdriver-automation")
      ) {
        $isSeed = $true
      }
    }

    if (-not $isSeed -and (Has-Kind "BuildAutomation")) {
      if (
        $name -in @("powershell.exe", "cmd.exe", "node.exe") -and
        $cmd -and
        $cmd -match $escapedRoot -and
        (
          $cmd -match "tauri\.automation\.conf\.json" -or
          $cmd -match "tauri\s+build" -or
          $cmd -match "cargo\s+build" -or
          $cmd -match "cargo\s+check" -or
          $cmd -match "target-classification-check"
        )
      ) {
        $isSeed = $true
      }
    }

    if (-not $isSeed -and (Has-Kind "SyncdPhaseGate")) {
      if (
        $name -in @("powershell.exe", "cmd.exe", "node.exe") -and
        $cmd -and
        $cmd -match $escapedRoot -and
        (
          $cmd -match "run-syncd-(?!desktop-two-instance-harness|native-two-instance-automation).*\.ps1" -or
          $cmd -match "capture-syncd-sse" -or
          $cmd -match "capture-syncd-pairing-ws" -or
          $cmd -match "prepare-syncd-sidecar"
        )
      ) {
        $isSeed = $true
      }
      elseif (
        $name -eq "epigraph-syncd.exe" -and
        (
          ($exe -and ($exe -ieq $debugSyncdExe -or $exe -ieq $releaseSyncdExe)) -or
          ($cmd -and ($cmd -match [regex]::Escape($debugSyncdExe) -or $cmd -match [regex]::Escape($releaseSyncdExe)))
        )
      ) {
        $isSeed = $true
      }
    }

    if (-not $isSeed -and (Has-Kind "SyncdHarness")) {
      if (
        $name -in @("powershell.exe", "cmd.exe", "node.exe") -and
        $cmd -and
        $cmd -match $escapedRoot -and
        (
          $cmd -match "run-syncd-desktop-two-instance-harness\.ps1" -or
          $cmd -match "run-syncd-native-two-instance-automation" -or
          $cmd -match "--webdriver-automation"
        )
      ) {
        $isSeed = $true
      }
      elseif (
        $name -eq "epigraph.exe" -and
        (
          ($cmd -and $cmd -match "--webdriver-automation") -or
          ($cmd -and $cmd -match [regex]::Escape("\tmp\syncd-")) -or
          ($exe -and $exe -ieq $releaseExe -and $cmd -and $cmd -match "--local-app-data-dir")
        )
      ) {
        $isSeed = $true
      }
    }

    $isSeed
  }
}

function Get-EpigraphManagedProcesses {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot,
    [string[]]$Kinds = @("DevUi", "BuildAutomation", "SyncdPhaseGate", "SyncdHarness"),
    [int[]]$ExcludePids = @($PID)
  )

  $all = Get-EpigraphProcessSnapshot -ExcludePids $ExcludePids
  $seedIds = New-Object 'System.Collections.Generic.HashSet[int]'

  foreach ($proc in Get-EpigraphManagedSeeds -ProjectRoot $ProjectRoot -Kinds $Kinds -ExcludePids $ExcludePids) {
    [void]$seedIds.Add([int]$proc.ProcessId)
  }

  if ($seedIds.Count -eq 0) {
    return @()
  }

  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($proc in $all) {
      if ($seedIds.Contains([int]$proc.ParentProcessId) -and -not $seedIds.Contains([int]$proc.ProcessId)) {
        [void]$seedIds.Add([int]$proc.ProcessId)
        $changed = $true
      }
    }
  }

  $all |
    Where-Object { $seedIds.Contains([int]$_.ProcessId) } |
    Sort-Object ProcessId
}

function Stop-EpigraphManagedProcesses {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot,
    [string[]]$Kinds = @("DevUi", "BuildAutomation", "SyncdPhaseGate", "SyncdHarness"),
    [int[]]$ExcludePids = @($PID),
    [int]$TimeoutSeconds = 15
  )

  $targets = @(Get-EpigraphManagedProcesses -ProjectRoot $ProjectRoot -Kinds $Kinds -ExcludePids $ExcludePids)
  if (-not $targets) {
    return @()
  }

  foreach ($proc in ($targets | Sort-Object ProcessId -Descending)) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 400
    $remaining = @(Get-EpigraphManagedProcesses -ProjectRoot $ProjectRoot -Kinds $Kinds -ExcludePids $ExcludePids)
  } until ((-not $remaining) -or (Get-Date) -gt $deadline)

  return $targets
}
