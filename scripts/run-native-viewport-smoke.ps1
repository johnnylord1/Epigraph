param(
  [string]$App,
  [string]$NativeDriver
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$tauriDriver = Join-Path $HOME ".cargo\bin\tauri-driver.exe"
$appPath = if ($App) { $App } else { Join-Path $projectRoot "src-tauri\target\release\aethon.exe" }

function Get-FreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}

function Resolve-EdgeDriver {
  $candidates = [System.Collections.Generic.List[string]]::new()
  if ($NativeDriver) { $candidates.Add($NativeDriver) }
  if ($env:AETHON_EDGE_DRIVER) { $candidates.Add($env:AETHON_EDGE_DRIVER) }
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
  throw "msedgedriver was not found. Install Microsoft Edge WebDriver or set AETHON_EDGE_DRIVER."
}

if (-not (Test-Path $tauriDriver)) { throw "tauri-driver was not found at $tauriDriver" }
if (-not (Test-Path $appPath)) { throw "Automation build was not found at $appPath" }

$edgeDriver = Resolve-EdgeDriver
$driverPort = Get-FreePort
$nativePort = Get-FreePort
$driverUrl = "http://127.0.0.1:$driverPort"
$logRoot = Join-Path ([System.IO.Path]::GetTempPath()) "aethon-release-driver"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$stdout = Join-Path $logRoot "tauri-driver-$driverPort.stdout.log"
$stderr = Join-Path $logRoot "tauri-driver-$driverPort.stderr.log"
$driverProcess = $null

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
  & node (Join-Path $scriptDir "smoke-native-viewports.mjs") "--driver-url=$driverUrl" "--app=$appPath"
  if ($LASTEXITCODE -ne 0) { throw "Native viewport smoke failed" }
} finally {
  if ($driverProcess -and -not $driverProcess.HasExited) {
    Stop-Process -Id $driverProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
