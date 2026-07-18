param(
  [switch]$SkipBuild,
  [string]$NativeDriver = ""
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir "..")
$tmpRoot = Join-Path $projectRoot "tmp\syncd-native-two-instance-automation"
$artifactsRoot = Join-Path $tmpRoot "artifacts"
$driverStdout = Join-Path $tmpRoot "tauri-driver.stdout.log"
$driverStderr = Join-Path $tmpRoot "tauri-driver.stderr.log"
$driverPort = 4554
$nativePort = 4555
$driverUrl = "http://127.0.0.1:$driverPort"
$appBasePath = Join-Path $projectRoot "src-tauri\target\release\aethon.exe"
$syncdBuiltExe = Join-Path $projectRoot "src-tauri\target\release\aethon-syncd.exe"
$syncdSidecarExe = Join-Path $projectRoot "src-tauri\binaries\aethon-syncd-x86_64-pc-windows-msvc.exe"
$bundledJava = Join-Path $projectRoot "src-tauri\binaries\suwayomi-bundle\jre\bin\java.exe"
$reportPath = Join-Path $artifactsRoot "syncd-native-two-instance-report.json"
$failurePath = Join-Path $artifactsRoot "syncd-native-two-instance-failure.json"
$buildLogsRoot = Join-Path $tmpRoot "build-logs"

function Get-ProtectedProcessIds {
  $protected = [System.Collections.Generic.HashSet[uint32]]::new()
  $currentId = [uint32]$PID
  $null = $protected.Add($currentId)

  $cursor = Get-CimInstance Win32_Process -Filter "ProcessId = $currentId" -ErrorAction SilentlyContinue
  while ($cursor -and $cursor.ParentProcessId -and $cursor.ParentProcessId -gt 0) {
    $parentId = [uint32]$cursor.ParentProcessId
    if (-not $protected.Add($parentId)) {
      break
    }
    $cursor = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId" -ErrorAction SilentlyContinue
  }

  return $protected
}

$protectedProcessIds = Get-ProtectedProcessIds

function Get-MatchingProcesses {
  param(
    [string[]]$Patterns
  )

  $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    if ($protectedProcessIds.Contains([uint32]$_.ProcessId)) {
      return $false
    }
    $name = $_.Name
    $executablePath = $_.ExecutablePath
    $commandLine = $_.CommandLine
    foreach ($pattern in $Patterns) {
      $isNodeCommandPattern = $pattern -like '*tauri.js*' -or $pattern -like '*vite.js*' -or $pattern -like '*tauri:dev:gate*'
      if ($executablePath -and $executablePath -like $pattern) {
        return $true
      }
      if ($commandLine -and $commandLine -like $pattern) {
        if ($isNodeCommandPattern -and $name -ne 'node.exe') {
          continue
        }
        return $true
      }
    }
    return $false
  }

  return @($processes)
}

function Stop-ProcessByPathPattern {
  param(
    [string[]]$Patterns
  )

  $processes = Get-MatchingProcesses -Patterns $Patterns
  foreach ($process in $processes) {
    try {
      $location = if ($process.ExecutablePath) { $process.ExecutablePath } elseif ($process.CommandLine) { $process.CommandLine } else { "<unknown>" }
      Write-Host "Stopping $($process.Name) [$($process.ProcessId)] at $location"
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    } catch {
      Write-Host "Warning: could not stop process $($process.Name) [$($process.ProcessId)]"
    }
  }
}

function Assert-NoMatchingProcesses {
  param(
    [string[]]$Patterns
  )

  $remaining = Get-MatchingProcesses -Patterns $Patterns
  if ($remaining.Count -gt 0) {
    $details = $remaining | ForEach-Object {
      $location = if ($_.ExecutablePath) { $_.ExecutablePath } elseif ($_.CommandLine) { $_.CommandLine } else { "<unknown>" }
      "$($_.Name) [$($_.ProcessId)] at $location"
    }
    throw "Residual automation processes remain:`n$($details -join "`n")"
  }
}

function Stop-ListeningPorts {
  param(
    [int[]]$Ports
  )

  foreach ($port in $Ports) {
    $listeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
    if (-not $listeners) {
      continue
    }

    foreach ($listenerPid in $listeners) {
      if ($protectedProcessIds.Contains([uint32]$listenerPid)) {
        continue
      }
      try {
        Write-Host "Stopping listener on port $port via PID $listenerPid"
        Stop-Process -Id $listenerPid -Force -ErrorAction Stop
      } catch {
        Write-Host "Warning: could not stop listener PID $listenerPid on port $port"
      }
    }
  }
}

function Stop-NativeAutomationResidue {
  Write-Host "Cleaning native automation residue"
  $patterns = @(
    "*\src-tauri\target\debug\aethon.exe",
    "*\src-tauri\target\release\aethon.exe",
    "*\src-tauri\target\debug\aethon-syncd.exe",
    "*\src-tauri\target\release\aethon-syncd.exe",
    "*\src-tauri\binaries\aethon-syncd-x86_64-pc-windows-msvc.exe",
    "*\src-tauri\target\debug\binaries\suwayomi-bundle\jre\bin\java.exe",
    "*\src-tauri\target\release\binaries\suwayomi-bundle\jre\bin\java.exe",
    "*\src-tauri\binaries\suwayomi-bundle\jre\bin\java.exe",
    "*\msedgedriver.exe",
    "*\tauri-driver.exe",
    "$projectRoot*tauri.js* dev *",
    "$projectRoot*vite.js*",
    "*tauri:dev:gate*"
  )

  Stop-ProcessByPathPattern -Patterns $patterns
  Start-Sleep -Milliseconds 750
  Stop-ProcessByPathPattern -Patterns $patterns
  Stop-ListeningPorts -Ports @(4554, 4555, 4668, 4768, 4868, 4968, 5068, 4877, 4977, 5077, 5177, 5277)
  Start-Sleep -Milliseconds 500
  Assert-NoMatchingProcesses -Patterns $patterns
}

function Sync-SidecarBinary {
  if (-not (Test-Path $syncdBuiltExe)) {
    throw "Expected built syncd binary at $syncdBuiltExe"
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $syncdSidecarExe) | Out-Null
  Copy-Item -LiteralPath $syncdBuiltExe -Destination $syncdSidecarExe -Force
}

function Invoke-NativeBuildCommand {
  param(
    [string]$Command,
    [string]$FailureMessage,
    [string]$LogSlug
  )

  $stdoutPath = Join-Path $buildLogsRoot "$LogSlug.stdout.log"
  $stderrPath = Join-Path $buildLogsRoot "$LogSlug.stderr.log"

  $runBuild = {
    param(
      [string]$InnerCommand,
      [string]$StdoutPath,
      [string]$StderrPath
    )

    if (Test-Path $StdoutPath) {
      Remove-Item -LiteralPath $StdoutPath -Force
    }
    if (Test-Path $StderrPath) {
      Remove-Item -LiteralPath $StderrPath -Force
    }

    $process = Start-Process `
      -FilePath "cmd.exe" `
      -ArgumentList @("/c", $InnerCommand) `
      -WorkingDirectory $projectRoot `
      -RedirectStandardOutput $StdoutPath `
      -RedirectStandardError $StderrPath `
      -PassThru `
      -Wait `
      -WindowStyle Hidden

    return $process.ExitCode
  }

  $exitCode = & $runBuild $Command $stdoutPath $stderrPath
  if ($exitCode -eq 0) {
    return
  }

  Write-Host ""
  Write-Host "Build step failed, retrying once after residue cleanup..."
  Stop-NativeAutomationResidue
  $exitCode = & $runBuild $Command $stdoutPath $stderrPath
  if ($exitCode -ne 0) {
    Write-Host "Build stdout: $stdoutPath"
    Write-Host "Build stderr: $stderrPath"
    throw "$FailureMessage (exit code $exitCode)"
  }
}

function Wait-HttpReady {
  param(
    [string]$Url,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
      return
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }

  throw "Timed out waiting for $Url"
}

Stop-NativeAutomationResidue

if (Test-Path $tmpRoot) {
  Remove-Item -LiteralPath $tmpRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $artifactsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $buildLogsRoot | Out-Null

Write-Host ""
Write-Host "Trilha do Syncd - preparing native desktop automation build"
if ($SkipBuild) {
  if (-not (Test-Path $appBasePath)) {
    throw "SkipBuild was requested, but the desktop binary was not found at $appBasePath"
  }
  if (-not (Test-Path $syncdBuiltExe)) {
    throw "SkipBuild was requested, but the syncd binary was not found at $syncdBuiltExe"
  }
  Write-Host "Skipping native rebuild and reusing existing release binaries."
} else {
  Invoke-NativeBuildCommand -Command "npm run build" -FailureMessage "npm run build failed." -LogSlug "01-npm-build"
  Invoke-NativeBuildCommand -Command "cargo build --manifest-path src-tauri/Cargo.toml --release --bin aethon-syncd" -FailureMessage "cargo build --release --bin aethon-syncd failed." -LogSlug "02-cargo-syncd-release"
  Invoke-NativeBuildCommand -Command "npm run tauri -- build --no-bundle --config src-tauri/tauri.automation.conf.json" -FailureMessage "tauri build --no-bundle failed." -LogSlug "03-tauri-build"
}

Sync-SidecarBinary

$tauriDriver = "C:\Users\jhow-\.cargo\bin\tauri-driver.exe"
$nativeDriver = if ($NativeDriver) {
  $NativeDriver
} elseif ($env:AETHON_EDGE_DRIVER) {
  $env:AETHON_EDGE_DRIVER
} else {
  "C:\Users\jhow-\AppData\Local\Microsoft\WinGet\Packages\Microsoft.EdgeDriver_Microsoft.Winget.Source_8wekyb3d8bbwe\msedgedriver.exe"
}

if (-not (Test-Path $tauriDriver)) {
  throw "tauri-driver was not found at $tauriDriver"
}
if (-not (Test-Path $nativeDriver)) {
  throw "msedgedriver was not found at $nativeDriver"
}

if (-not $env:AETHON_SYNCD_MIN_CLIENT_VERSION) {
  $packageMetadata = Get-Content (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
  $env:AETHON_SYNCD_MIN_CLIENT_VERSION = [string]$packageMetadata.version
}

$driverProcess = $null

try {
  $driverProcess = Start-Process `
    -FilePath $tauriDriver `
    -ArgumentList @("--port", "$driverPort", "--native-port", "$nativePort", "--native-driver", $nativeDriver) `
    -RedirectStandardOutput $driverStdout `
    -RedirectStandardError $driverStderr `
    -PassThru `
    -WindowStyle Hidden

  Wait-HttpReady -Url "$driverUrl/status"

  Write-Host ""
  Write-Host "Trilha do Syncd - running native two-instance automation"
  node `
    (Join-Path $scriptDir "run-syncd-native-two-instance-automation.mjs") `
    --project-root="$projectRoot" `
    --tmp-root="$tmpRoot" `
    --driver-url="$driverUrl" `
    --app="$appBasePath"

  if ($LASTEXITCODE -ne 0) {
    throw "Native two-instance automation failed."
  }

  Write-Host ""
  Write-Host "Trilha do Syncd - native automation finished"
  if (Test-Path $reportPath) {
    Write-Host "Report: $reportPath"
  }
}
finally {
  if ($driverProcess -and -not $driverProcess.HasExited) {
    Stop-Process -Id $driverProcess.Id -Force
  }

  if (Test-Path $failurePath) {
    Write-Host ""
    Write-Host "Failure artifact: $failurePath"
  }
}
