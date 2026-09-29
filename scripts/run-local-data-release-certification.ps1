param(
  [string]$App,
  [string]$BuildReceipt=$env:EPIGRAPH_BUILD_RECEIPT,
  [string]$NativeDriver,
  [switch]$KeepArtifacts
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'EpigraphSessionTools.ps1')
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$tauriDriver = Join-Path $HOME ".cargo\bin\tauri-driver.exe"
$appPath = if ($App) { $App } else { Join-Path $projectRoot "src-tauri\target\release\epigraph.exe" }

function Get-FreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}

function Resolve-EdgeDriver {
  $candidates = [System.Collections.Generic.List[string]]::new()
  if ($NativeDriver) { $candidates.Add($NativeDriver) }
  if ($env:EPIGRAPH_EDGE_DRIVER) { $candidates.Add($env:EPIGRAPH_EDGE_DRIVER) }
  $command = Get-Command "msedgedriver.exe" -ErrorAction SilentlyContinue
  if ($command -and $command.Source) { $candidates.Add($command.Source) }
  $wingetRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (Test-Path $wingetRoot) {
    Get-ChildItem -Path $wingetRoot -Directory -Filter "Microsoft.EdgeDriver_*" -ErrorAction SilentlyContinue |
      Get-ChildItem -Recurse -File -Filter "msedgedriver.exe" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      ForEach-Object { $candidates.Add($_.FullName) }
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return (Resolve-Path $candidate).Path }
  }
  throw "msedgedriver was not found. Install Microsoft Edge WebDriver or set EPIGRAPH_EDGE_DRIVER."
}

 . (Join-Path $scriptDir 'VerificationEvidence.ps1')
$verification=New-VerificationEvidence $projectRoot 'run-local-data-release-certification.ps1' @(@{id='artifact';name='B1 artifact validation';kind='verification'},@{id='native';name='Requested native harness';kind='verification'}) @{environment='disposable';journeys=@('Books export/restart/restore/corruption rejection');backend=@{kind='mock';reason='Harness fixture, not live service certification'}}
$artifactLock=$null;$coreLock=$null;$verificationStage='artifact'
try {
  $null=Invoke-VerificationEvidence begin $verification @{id='artifact'}
  $appPath=Assert-VerificationArtifact $verification $BuildReceipt $App
  $artifactLock=[IO.File]::Open($appPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $bound=Get-Content $BuildReceipt -Raw|ConvertFrom-Json
  $coreLock=[IO.File]::Open($bound.coreExecutable,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $null=Assert-VerificationArtifact $verification $BuildReceipt $appPath
  Set-VerificationStage $verification artifact PASS
  $verificationStage='native'
  $null=Invoke-VerificationEvidence begin $verification @{id='native'}
if (-not (Test-Path $tauriDriver)) { throw "tauri-driver was not found at $tauriDriver" }
if (-not (Test-Path $appPath)) { throw "Automation build was not found at $appPath" }

$edgeDriver = Resolve-EdgeDriver
$driverPort = Get-FreePort
$nativePort = Get-FreePort
$driverUrl = "http://127.0.0.1:$driverPort"
$logRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("epigraph-release-driver-"+[guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$stdout = Join-Path $logRoot "tauri-driver-$driverPort.stdout.log"
$stderr = Join-Path $logRoot "tauri-driver-$driverPort.stderr.log"
$driverProcess = $null
$completed = $false

function Remove-DriverLog([string]$Path) {
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try {
      [System.IO.File]::Delete($Path)
      return
    } catch [System.IO.IOException] {
      Start-Sleep -Milliseconds 100
    }
  }
  throw "Could not remove released driver log"
}

try {
  $driverProcess = Start-Process -FilePath $tauriDriver `
    -ArgumentList @("--port", "$driverPort", "--native-port", "$nativePort", "--native-driver", $edgeDriver) `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Hidden

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    try {
      $status = Invoke-WebRequest -UseBasicParsing -Uri "$driverUrl/status" -TimeoutSec 2
      if ($status.StatusCode -eq 200) { break }
    } catch {}
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  if ([DateTime]::UtcNow -ge $deadline) { throw "tauri-driver did not become ready" }
  $arguments = @(
    (Join-Path $scriptDir "certify-local-data.mjs"),
    "--driver-url=$driverUrl",
    "--app=$appPath"
  )
  if ($KeepArtifacts) { $arguments += "--keep-artifacts=true" }
  & node @arguments
  if ($LASTEXITCODE -ne 0) { throw "Local data release certification failed" }
  $completed = $true
  Set-VerificationStage $verification native PASS
  $verificationStage=$null
} catch {
  if($verificationStage){Set-VerificationStage $verification $verificationStage FAIL $_.ToString()}
  $null=Invoke-VerificationEvidence diagnostic $verification @{label='failure before cleanup';value=$_.ToString()}
  $verificationStage=$null
  throw
} finally {
  try {
  if ($driverProcess -and -not $driverProcess.HasExited) {
    Stop-EpigraphRetainedProcess -Process $driverProcess
    [void]$driverProcess.WaitForExit(5000)
  }
  # Durable sanitized stage failures precede scratch-log cleanup.
  if (Test-Path -LiteralPath $stdout) {
    Remove-DriverLog $stdout
  }
  if (Test-Path -LiteralPath $stderr) {
    Remove-DriverLog $stderr
  }
    $null=Invoke-VerificationEvidence cleanup $verification @{result=@{status='PASS'}}
  } catch {
    $null=Invoke-VerificationEvidence cleanup $verification @{result=@{status='FAIL';reason=$_.ToString()}}
  }

}

} catch {
  if($verificationStage){Set-VerificationStage $verification $verificationStage FAIL $_.ToString()}
  $null=Invoke-VerificationEvidence diagnostic $verification @{label='native runner failure';value=$_.ToString()}
  throw
} finally {
  if($artifactLock){$artifactLock.Dispose()};if($coreLock){$coreLock.Dispose()}
  $final=Invoke-VerificationEvidence finish $verification @{}|ConvertFrom-Json
  Write-Host "Verification receipt: $verification"
}
if($final.outcome -ne 'PASS'){exit 1}
