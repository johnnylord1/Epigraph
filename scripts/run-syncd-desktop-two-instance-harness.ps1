param(
  [switch]$Clean,
  # A built app, which carries its own frontend. Two `tauri dev` runs would share one Vite port and one build lock.
  [string]$AppPath
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'EpigraphSessionTools.ps1')

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir "..")
$tmpRoot = Join-Path $projectRoot "tmp\syncd-desktop-two-instance"
$hostRoot = Join-Path $tmpRoot "host"
$joinerRoot = Join-Path $tmpRoot "joiner"
$statePath = Join-Path $tmpRoot "harness-processes.json"

if (-not $AppPath) {
  $AppPath = Join-Path $projectRoot "src-tauri\target\release\epigraph.exe"
}
$coreExe = Join-Path (Split-Path -Parent $AppPath) "epigraph-syncd.exe"
foreach ($binary in @($AppPath, $coreExe)) {
  if (-not (Test-Path -LiteralPath $binary)) {
    throw "Build the desktop first, or pass -AppPath; not found: $binary"
  }
}

function Start-EpigraphInstance {
  param(
    [string]$Name,
    [int]$Port,
    [int]$MainServerPort,
    [int]$TestServerPort,
    [string]$Root
  )

  $localAppData = Join-Path $Root "LocalAppData"
  $desktopStateDir = Join-Path $Root "syncd-desktop-state"

  New-Item -ItemType Directory -Force -Path $localAppData | Out-Null
  New-Item -ItemType Directory -Force -Path $desktopStateDir | Out-Null

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $AppPath
  $psi.Arguments = "`"--local-app-data-dir=$localAppData`" --syncd-port=$Port"
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.Environment["EPIGRAPH_SYNCD_DESKTOP_STATE_DIR"] = $desktopStateDir
  # Without these an instance would attach to the Suwayomi server of an installed Epigraph.
  $psi.Environment["EPIGRAPH_LOCAL_SERVER_MAIN_PORT"] = "$MainServerPort"
  $psi.Environment["EPIGRAPH_LOCAL_SERVER_TEST_PORT"] = "$TestServerPort"
  $psi.Environment["WEBVIEW2_USER_DATA_FOLDER"] = Join-Path $Root "WebView2"

  return @{
    Name = $Name
    Port = $Port
    Root = $Root
    LocalAppData = $localAppData
    DesktopStateDir = $desktopStateDir
    CoreDataDir = Join-Path $localAppData "Epigraph\syncd"
    Process = [System.Diagnostics.Process]::Start($psi)
  }
}

function Stop-EpigraphInstance {
  param($Instance)

  if ($Instance.Process -and -not $Instance.Process.HasExited) {
    $null = $Instance.Process.CloseMainWindow()
    if (-not $Instance.Process.WaitForExit(15000)) {
      Stop-EpigraphRetainedProcess -Process $Instance.Process
    }
  }

  # Closing the app can leave its Core running for a connected device. This is the Core's authenticated
  # shutdown for this instance's own profile, and it succeeds when no Core is running.
  & $coreExe shutdown --data-dir $Instance.CoreDataDir --timeout-seconds 30
  if ($LASTEXITCODE -ne 0) {
    throw "$($Instance.Name): Epigraph Core did not confirm it stopped. Its profile is in $($Instance.Root)"
  }
}

if ($Clean -and (Test-Path $tmpRoot)) {
  throw "Legacy harness evidence must be reconciled before profile deletion; preserved: $tmpRoot"
}

New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

# Not $host: that is PowerShell's read-only automatic variable.
$hostInstance = $null
$joinerInstance = $null

try {
  $hostInstance = Start-EpigraphInstance -Name "host" -Port 4877 -MainServerPort 4878 -TestServerPort 4879 -Root $hostRoot
  $joinerInstance = Start-EpigraphInstance -Name "joiner" -Port 4977 -MainServerPort 4978 -TestServerPort 4979 -Root $joinerRoot

  $summary = [ordered]@{
    startedAt = (Get-Date).ToString("o")
    host = @{
      port = $hostInstance.Port
      localAppData = $hostInstance.LocalAppData
      desktopStateDir = $hostInstance.DesktopStateDir
      pid = $hostInstance.Process.Id
    }
    joiner = @{
      port = $joinerInstance.Port
      localAppData = $joinerInstance.LocalAppData
      desktopStateDir = $joinerInstance.DesktopStateDir
      pid = $joinerInstance.Process.Id
    }
  }

  $summary | ConvertTo-Json -Depth 5 | Set-Content -Path $statePath

  Write-Host ''
  Write-Host 'Trilha do Syncd - Two-instance desktop harness'
  Write-Host ('Host pid:   {0}  port: {1}' -f $hostInstance.Process.Id, $hostInstance.Port)
  Write-Host ('Joiner pid: {0}  port: {1}' -f $joinerInstance.Process.Id, $joinerInstance.Port)
  Write-Host ''
  Write-Host 'Manual proof steps:'
  Write-Host '1. In the host desktop window, open Settings > Security > Sync host.'
  Write-Host '2. Start host pairing and either copy the bootstrap bundle or save the QR image.'
  Write-Host '3. In the joiner desktop window, open Settings > Security > Sync connect.'
  Write-Host '4. Discover the host or load the QR image / paste the bootstrap bundle.'
  Write-Host '5. Approve or reject on the host card and watch the live state update.'
  Write-Host '6. Restart the joiner instance and use the persisted session revalidation flow.'
  Write-Host ''
  Write-Host ('Process metadata saved to: {0}' -f $statePath)
  Write-Host 'Press Enter to stop both desktop instances...'
  Read-Host | Out-Null
}
finally {
  foreach ($instance in @($hostInstance, $joinerInstance)) {
    if ($null -ne $instance) {
      Stop-EpigraphInstance -Instance $instance
    }
  }
}
