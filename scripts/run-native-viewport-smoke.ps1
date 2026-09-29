param(
  [string]$App,
  [string]$BuildReceipt=$env:EPIGRAPH_BUILD_RECEIPT,
  [string]$NativeDriver,
  [string]$NodeScript = "smoke-native-viewports.mjs",
  [switch]$ShowWindow
)

$ErrorActionPreference = "Stop"
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
$verification=New-VerificationEvidence $projectRoot 'run-native-viewport-smoke.ps1' @(@{id='artifact';name='B1 artifact validation';kind='verification'},@{id='native';name='Requested native harness';kind='verification'}) @{environment='disposable';journeys=@('Requested NodeScript; detailed child receipt defines routes');backend=@{kind='mock';reason='Harness fixture, not live service certification'}}
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
$driverProcess = $null
$completed = $false

try {
  if ($ShowWindow) {
    $env:EPIGRAPH_WEBDRIVER_SHOW_WINDOW = "1"
    if (-not $env:EPIGRAPH_WEBDRIVER_WINDOW_X) { $env:EPIGRAPH_WEBDRIVER_WINDOW_X = "1980" }
    if (-not $env:EPIGRAPH_WEBDRIVER_WINDOW_Y) { $env:EPIGRAPH_WEBDRIVER_WINDOW_Y = "80" }
    if (-not $env:EPIGRAPH_WEBDRIVER_WINDOW_WIDTH) { $env:EPIGRAPH_WEBDRIVER_WINDOW_WIDTH = "1280" }
    if (-not $env:EPIGRAPH_WEBDRIVER_WINDOW_HEIGHT) { $env:EPIGRAPH_WEBDRIVER_WINDOW_HEIGHT = "800" }
  } else {
    Remove-Item Env:EPIGRAPH_WEBDRIVER_SHOW_WINDOW -ErrorAction SilentlyContinue
  }
  $driverStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $driverStartInfo.FileName = $tauriDriver
  $driverArgumentList = @(
    "--port", "$driverPort", "--native-port", "$nativePort", "--native-driver", $edgeDriver
  ) | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }
  $driverStartInfo.Arguments = $driverArgumentList -join " "
  $driverStartInfo.UseShellExecute = $false
  $driverStartInfo.CreateNoWindow = $true
  $driverProcess = [System.Diagnostics.Process]::new()
  $driverProcess.StartInfo = $driverStartInfo
  if (-not $driverProcess.Start()) { throw "tauri-driver could not be started" }

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    try {
      $status = Invoke-WebRequest -UseBasicParsing -Uri "$driverUrl/status" -TimeoutSec 2
      if ($status.StatusCode -eq 200) { break }
    } catch {}
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  if ([DateTime]::UtcNow -ge $deadline) { throw "tauri-driver did not become ready" }
  $nodeScriptPath = Join-Path $scriptDir $NodeScript
  if (-not (Test-Path $nodeScriptPath)) { throw "Native smoke script was not found at $nodeScriptPath" }
  $nodeArguments = @($nodeScriptPath, "--driver-url=$driverUrl", "--app=$appPath")
  if ($NodeScript -eq "smoke-native-viewports.mjs" -and $env:EPIGRAPH_NATIVE_SMOKE_OUTPUT_DIR) {
    $nodeArguments += "--out=$env:EPIGRAPH_NATIVE_SMOKE_OUTPUT_DIR"
  }
  & node @nodeArguments
  if ($LASTEXITCODE -ne 0) { throw "Native viewport smoke failed" }
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
    $driverProcess.Kill()
    [void]$driverProcess.WaitForExit(5000)
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
