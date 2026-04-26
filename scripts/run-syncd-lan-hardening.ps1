param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Wait-ForPath {
  param([string]$Path, [int]$TimeoutSeconds = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $Path) { return }
    Start-Sleep -Milliseconds 200
  }
  throw "Timed out waiting for path: $Path"
}

function Wait-ForFileContains {
  param([string]$Path, [string]$Needle, [int]$TimeoutSeconds = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path $Path) -and ((Get-Content $Path -Raw) -match [regex]::Escape($Needle))) {
      return
    }
    Start-Sleep -Milliseconds 200
  }
  throw "Timed out waiting for '$Needle' in $Path"
}

function Start-AppWithEnv {
  param(
    [string]$ProjectRoot,
    [string]$AppBinaryPath,
    [hashtable]$EnvMap,
    [string]$StdoutPath,
    [string]$StderrPath
  )

  $previous = @{}
  foreach ($key in $EnvMap.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, $EnvMap[$key], "Process")
  }

  try {
    return Start-Process $AppBinaryPath `
      -WorkingDirectory $ProjectRoot `
      -RedirectStandardOutput $StdoutPath `
      -RedirectStandardError $StderrPath `
      -PassThru
  }
  finally {
    foreach ($key in $EnvMap.Keys) {
      [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
    }
  }
}

function Stop-LingeringRepoSuwayomi {
  param([string]$ProjectRoot)

  $bundleRoot = (Join-Path $ProjectRoot "src-tauri\target\debug\binaries\suwayomi-bundle").ToLowerInvariant()
  $targets = Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "java.exe" -and
      $_.CommandLine -and
      $_.CommandLine.ToLowerInvariant().Contains($bundleRoot)
    }

  foreach ($target in $targets) {
    Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Stop-App {
  param(
    $Process,
    [string]$ExitSentinelPath,
    [int]$TimeoutSeconds = 25
  )

  New-Item -ItemType File -Force -Path $ExitSentinelPath | Out-Null
  if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $Process.Id -Force
    throw "App did not exit after sentinel request"
  }
}

function Write-ServerConf {
  param([string]$Root, [string]$ServerIp, [int]$Port)
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  @"
server.ip = "$ServerIp"
server.port = $Port
server.webUIEnabled = false
server.initialOpenInBrowserEnabled = false
server.systemTrayEnabled = false
"@ | Set-Content -Path (Join-Path $Root "server.conf")
}

function Read-SessionPath {
  param([string]$Root)
  return (Join-Path $Root "suwayomi-lan-session.json")
}

$projectRoot = "C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon"
$tmpRoot = Join-Path $projectRoot "tmp\syncd-lan-hardening"
$mainRoot = Join-Path $tmpRoot "main-root"
$testRoot = Join-Path $tmpRoot "test-root"
$exitSentinel = Join-Path $tmpRoot "exit.sentinel"
$stdoutPath = Join-Path $tmpRoot "aethon.stdout.log"
$stderrPath = Join-Path $tmpRoot "aethon.stderr.log"
$appBinaryPath = Join-Path $projectRoot "src-tauri\target\debug\aethon.exe"

Push-Location $projectRoot
try {
  New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $mainRoot, $testRoot
  if (Test-Path $exitSentinel) { Remove-Item $exitSentinel -Force }
  Stop-LingeringRepoSuwayomi -ProjectRoot $projectRoot

  Write-Host "[lan-hardening] building desktop binary"
  cargo build --manifest-path src-tauri/Cargo.toml --bin aethon

  Write-ServerConf -Root $mainRoot -ServerIp "0.0.0.0" -Port 4567
  Write-ServerConf -Root $testRoot -ServerIp "0.0.0.0" -Port 4667

  $baseEnv = @{
    AETHON_LOCAL_SERVER_MAIN_ROOT = $mainRoot
    AETHON_LOCAL_SERVER_TEST_ROOT = $testRoot
    AETHON_SYNCD_PHASE_GATE_EXIT_SENTINEL = $exitSentinel
  }

  Write-Host "[lan-hardening] verifying default startup collapses to loopback"
  $app = Start-AppWithEnv `
    -ProjectRoot $projectRoot `
    -AppBinaryPath $appBinaryPath `
    -EnvMap $baseEnv `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath
  Wait-ForFileContains -Path (Join-Path $mainRoot "server.conf") -Needle 'server.ip = "127.0.0.1"'
  Wait-ForFileContains -Path (Join-Path $testRoot "server.conf") -Needle 'server.ip = "127.0.0.1"'
  Stop-App -Process $app -ExitSentinelPath $exitSentinel
  Stop-LingeringRepoSuwayomi -ProjectRoot $projectRoot

  Write-Host "[lan-hardening] verifying temporary session enable + cleanup"
  $tempEnv = $baseEnv.Clone()
  $tempEnv["AETHON_PHASE_GATE_TEMPORARY_LAN_PROFILE"] = "main"
  $tempEnv["AETHON_PHASE_GATE_TEMPORARY_LAN_TTL_SECONDS"] = "3"
  $tempEnv["AETHON_PHASE_GATE_TEMPORARY_LAN_HOST"] = "192.168.0.10"
  $tempEnv["AETHON_PHASE_GATE_TEMPORARY_LAN_REASON"] = "phase-gate"

  $app2 = Start-AppWithEnv `
    -ProjectRoot $projectRoot `
    -AppBinaryPath $appBinaryPath `
    -EnvMap $tempEnv `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath
  $mainSessionPath = Read-SessionPath -Root $mainRoot
  Wait-ForPath -Path $mainSessionPath
  Wait-ForFileContains -Path (Join-Path $mainRoot "server.conf") -Needle 'server.ip = "0.0.0.0"'
  Wait-ForFileContains -Path (Join-Path $testRoot "server.conf") -Needle 'server.ip = "127.0.0.1"'
  Start-Sleep -Seconds 4
  Wait-ForFileContains -Path (Join-Path $mainRoot "server.conf") -Needle 'server.ip = "127.0.0.1"' -TimeoutSeconds 15
  if (Test-Path $mainSessionPath) {
    throw "Temporary LAN session file still exists after TTL expiry"
  }
  Stop-App -Process $app2 -ExitSentinelPath $exitSentinel
  Stop-LingeringRepoSuwayomi -ProjectRoot $projectRoot

  Write-Host "[lan-hardening] verifying stale invalid session cleanup on restart"
  $staleSession = @{
    profileKey = "main"
    bindHost = "0.0.0.0"
    advertisedHost = "192.168.0.10"
    startedAtMs = 1
    expiresAtMs = 2
    ownerAppPid = 999999
    reason = "stale"
  } | ConvertTo-Json -Compress
  $mainSessionPath = Read-SessionPath -Root $mainRoot
  Set-Content -Path $mainSessionPath -Value $staleSession
  Write-ServerConf -Root $mainRoot -ServerIp "0.0.0.0" -Port 4567

  $app3 = Start-AppWithEnv `
    -ProjectRoot $projectRoot `
    -AppBinaryPath $appBinaryPath `
    -EnvMap $baseEnv `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath
  Wait-ForFileContains -Path (Join-Path $mainRoot "server.conf") -Needle 'server.ip = "127.0.0.1"'
  Stop-App -Process $app3 -ExitSentinelPath $exitSentinel
  Stop-LingeringRepoSuwayomi -ProjectRoot $projectRoot
  if (Test-Path $mainSessionPath) {
    throw "Stale session file was not removed on startup"
  }

  Write-Host "[lan-hardening] verifying profile-mismatch cleanup"
  $mismatchSessionPath = Read-SessionPath -Root $testRoot
  $mismatchSession = @{
    profileKey = "main"
    bindHost = "0.0.0.0"
    advertisedHost = "192.168.0.10"
    startedAtMs = 1
    expiresAtMs = ((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds + 60000
    ownerAppPid = 999999
    reason = "mismatch"
  } | ConvertTo-Json -Compress
  Set-Content -Path $mismatchSessionPath -Value $mismatchSession
  Write-ServerConf -Root $testRoot -ServerIp "0.0.0.0" -Port 4667

  $app4 = Start-AppWithEnv `
    -ProjectRoot $projectRoot `
    -AppBinaryPath $appBinaryPath `
    -EnvMap $baseEnv `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath
  Wait-ForFileContains -Path (Join-Path $testRoot "server.conf") -Needle 'server.ip = "127.0.0.1"'
  Stop-App -Process $app4 -ExitSentinelPath $exitSentinel
  Stop-LingeringRepoSuwayomi -ProjectRoot $projectRoot
  if (Test-Path $mismatchSessionPath) {
    throw "Profile-mismatch session file was not removed on startup"
  }

  Write-Host "LAN hardening runtime audit completed successfully."
}
catch {
  Write-Error $_
  throw
}
finally {
  Pop-Location
}
