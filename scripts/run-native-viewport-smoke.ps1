param(
  [string]$App,
  [string]$NativeDriver,
  [string]$NodeScript = "smoke-native-viewports.mjs",
  [switch]$ShowWindow
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

if (-not $App) {
  $productionInputs = @(
    Get-ChildItem -Path (Join-Path $projectRoot "src") -Recurse -File -Include *.ts,*.svelte,*.css,*.json |
      Where-Object { $_.FullName -notmatch '[\\/]src[\\/]test[\\/]' -and $_.Name -notmatch '\.(test|spec)\.' }
    Get-ChildItem -Path (Join-Path $projectRoot "src-tauri\src") -Recurse -File -Include *.rs
    Get-Item (Join-Path $projectRoot "package.json"), (Join-Path $projectRoot "vite.config.ts")
  )
  $latestInput = $productionInputs | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  $appFile = Get-Item $appPath
  if ($latestInput -and $appFile.LastWriteTimeUtc -lt $latestInput.LastWriteTimeUtc) {
    throw "Automation build is older than $($latestInput.FullName). Rebuild it or pass -App explicitly."
  }
}

$edgeDriver = Resolve-EdgeDriver
$driverPort = Get-FreePort
$nativePort = Get-FreePort
$driverUrl = "http://127.0.0.1:$driverPort"
$driverProcess = $null
$completed = $false

try {
  if ($ShowWindow) {
    $env:AETHON_WEBDRIVER_SHOW_WINDOW = "1"
    if (-not $env:AETHON_WEBDRIVER_WINDOW_X) { $env:AETHON_WEBDRIVER_WINDOW_X = "1980" }
    if (-not $env:AETHON_WEBDRIVER_WINDOW_Y) { $env:AETHON_WEBDRIVER_WINDOW_Y = "80" }
    if (-not $env:AETHON_WEBDRIVER_WINDOW_WIDTH) { $env:AETHON_WEBDRIVER_WINDOW_WIDTH = "1280" }
    if (-not $env:AETHON_WEBDRIVER_WINDOW_HEIGHT) { $env:AETHON_WEBDRIVER_WINDOW_HEIGHT = "800" }
  } else {
    Remove-Item Env:AETHON_WEBDRIVER_SHOW_WINDOW -ErrorAction SilentlyContinue
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
  if ($NodeScript -eq "smoke-native-viewports.mjs" -and $env:AETHON_NATIVE_SMOKE_OUTPUT_DIR) {
    $nodeArguments += "--out=$env:AETHON_NATIVE_SMOKE_OUTPUT_DIR"
  }
  & node @nodeArguments
  if ($LASTEXITCODE -ne 0) { throw "Native viewport smoke failed" }
  $completed = $true
} finally {
  if ($driverProcess -and -not $driverProcess.HasExited) {
    $driverProcess.Kill()
    [void]$driverProcess.WaitForExit(5000)
  }
}
