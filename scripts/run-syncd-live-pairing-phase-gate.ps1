param()

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'EpigraphSessionTools.ps1')
Set-StrictMode -Version Latest

function Invoke-JsonRequest {
  param(
    [string]$Method,
    [string]$Uri,
    [hashtable]$Headers = @{},
    $Body = $null
  )

  $responseFile = Join-Path $tmpRoot ("curl-response-" + [guid]::NewGuid().ToString() + ".txt")
  $requestFile = $null
  $curlArgs = @("-k", "-sS", "-X", $Method.ToUpperInvariant(), "-o", $responseFile, "-w", "%{http_code}")

  foreach ($key in $Headers.Keys) {
    $curlArgs += @("-H", "${key}: $($Headers[$key])")
  }

  if ($null -ne $Body) {
    $requestFile = Join-Path $tmpRoot ("curl-request-" + [guid]::NewGuid().ToString() + ".json")
    $json = $Body | ConvertTo-Json -Depth 20 -Compress
    Set-Content -Path $requestFile -Value $json -NoNewline
    $curlArgs += @("-H", "Content-Type: application/json", "--data-binary", "@$requestFile")
  }

  $curlArgs += $Uri

  try {
    $status = (& curl.exe @curlArgs).Trim()
    $raw = if (Test-Path $responseFile) { Get-Content $responseFile -Raw } else { "" }
    $jsonBody = $null
    if ($raw) {
      try { $jsonBody = $raw | ConvertFrom-Json } catch {}
    }
    return @{
      StatusCode = [int]$status
      Raw = $raw
      Json = $jsonBody
    }
  }
  finally {
    if ($requestFile -and (Test-Path $requestFile)) { Remove-Item $requestFile -Force }
    if (Test-Path $responseFile) { Remove-Item $responseFile -Force }
  }
}

function Assert-Status {
  param($Response, [int]$Expected, [string]$Label)
  if ($Response.StatusCode -ne $Expected) {
    throw "$Label expected HTTP $Expected, got $($Response.StatusCode): $($Response.Raw)"
  }
}

function Wait-ForHealthy {
  param([string]$Endpoint, [int]$TimeoutSeconds = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-JsonRequest -Method Get -Uri "$Endpoint/healthz"
      if ($response.StatusCode -eq 200) { return }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for syncd health at $Endpoint"
}

function Wait-ForPath {
  param([string]$Path, [int]$TimeoutSeconds = 10)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $Path) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "Timed out waiting for path $Path"
}

function Start-ManagedProcess {
  param(
    [string]$FilePath,
    [string]$WorkingDirectory,
    [string[]]$ArgumentList = @(),
    [string]$StdoutPath,
    [string]$StderrPath,
    [hashtable]$Environment = @{}
  )

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  if ($ArgumentList.Count -gt 0) {
    $psi.Arguments = [string]::Join(" ", ($ArgumentList | ForEach-Object {
      if ($_ -match '[\s"]') {
        '"' + ($_ -replace '"', '\"') + '"'
      } else {
        $_
      }
    }))
  }
  Set-Content -Path $StdoutPath -Value "stdout capture disabled in live pairing phase-gate harness" -NoNewline
  Set-Content -Path $StderrPath -Value "stderr capture disabled in live pairing phase-gate harness" -NoNewline

  $previous = @{}
  foreach ($key in $Environment.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], "Process")
  }

  try {
    $process = [System.Diagnostics.Process]::Start($psi)
    if ($null -eq $process) {
      throw "Failed to start managed process: $FilePath"
    }
    return $process
  }
  finally {
    foreach ($key in $Environment.Keys) {
      [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
    }
  }
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tmpRoot = Join-Path $projectRoot "tmp\syncd-live-pairing-phase-gate"
$dataDir = Join-Path $tmpRoot "data"
$stdoutPath = Join-Path $tmpRoot "syncd.stdout.log"
$stderrPath = Join-Path $tmpRoot "syncd.stderr.log"
$wsStdoutPath = Join-Path $tmpRoot "pairing-ws.stdout.log"
$wsStderrPath = Join-Path $tmpRoot "pairing-ws.stderr.log"
$wsOutputPath = Join-Path $tmpRoot "pairing-live-events.json"
$wsReadyPath = Join-Path $tmpRoot "pairing-live-ready.txt"
$port = "47776"
$endpoint = "https://127.0.0.1:$port"
$advertisedEndpoint = "https://127.0.0.1:$port"
$syncdBinary = Join-Path $projectRoot "src-tauri\target\debug\epigraph-syncd.exe"
$wsScript = Join-Path $projectRoot "scripts\capture-syncd-pairing-ws.mjs"
$syncd = $null
$wsCapture = $null
$currentStep = "initialization"

function Stop-SyncdProcessTree {
  param($Process)
  if ($null -eq $Process) { return }
  if (-not $Process.HasExited) {
    Stop-EpigraphRetainedProcess -Process $Process
  }
  try { $null = $Process.WaitForExit(5000) } catch {}
}

if (Test-Path $tmpRoot) { Remove-Item $tmpRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$authHeaders = @{
  "X-Epigraph-Client-Version" = "0.1.0"
  "X-Epigraph-Client-Protocol-Version" = "1"
}

Push-Location $projectRoot
try {
  $currentStep = "build syncd"
  Write-Host "[live-pairing-gate] building syncd"
  cargo build --manifest-path src-tauri/Cargo.toml --bin epigraph-syncd

  $envMap = @{
    EPIGRAPH_SYNCD_ENABLE_AUDIT_ROUTES = "1"
    EPIGRAPH_SYNCD_DATA_DIR = $dataDir
    EPIGRAPH_SYNCD_BIND_HOST = "127.0.0.1"
    EPIGRAPH_SYNCD_PORT = $port
    EPIGRAPH_SYNCD_ADVERTISED_BASE_URL = $advertisedEndpoint
    EPIGRAPH_SYNCD_DISCOVERY_MDNS_PORT = "5461"
    EPIGRAPH_SYNCD_EFFECTIVE_DISCOVERY_POLICY = "manual-preferred"
    EPIGRAPH_SYNCD_MANUAL_PROVIDER = "enabled"
    EPIGRAPH_SYNCD_MANUAL_ORIGINS = "https://localhost:$port/,https://[::1]:$port"
    EPIGRAPH_LOCAL_SERVER_MAIN_ROOT = Join-Path $tmpRoot "suwayomi-main"
    EPIGRAPH_LOCAL_SERVER_TEST_ROOT = Join-Path $tmpRoot "suwayomi-test"
  }

  $currentStep = "start syncd"
  Write-Host "[live-pairing-gate] starting syncd"
  $syncd = Start-ManagedProcess `
    -FilePath $syncdBinary `
    -WorkingDirectory $projectRoot `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath `
    -Environment $envMap

  $currentStep = "wait for health"
  Wait-ForHealthy -Endpoint $endpoint -TimeoutSeconds 30
  Write-Host "[live-pairing-gate] syncd healthy at $endpoint"

  $currentStep = "create bootstrap session"
  $bootstrapCreated = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/bootstrap/session" -Body @{
    profileId = "main"
  }
  Assert-Status $bootstrapCreated 200 "create bootstrap session"
  Set-Content -Path (Join-Path $tmpRoot "bootstrap-created.json") -Value $bootstrapCreated.Raw -NoNewline
  if ($bootstrapCreated.Json.syncdBaseUrl -ne "https://localhost:$port") {
    throw "bootstrap payload did not follow the manual-preferred effective discovery policy"
  }

  $sessionId = [string]$bootstrapCreated.Json.pairingSessionId
  $pairingCode = [string]$bootstrapCreated.Json.pairingCode
  $claimUrl = [string]$bootstrapCreated.Json.claimUrl

  $currentStep = "start pairing live websocket capture"
  $wsCapture = Start-ManagedProcess `
    -FilePath "node" `
    -WorkingDirectory $projectRoot `
    -ArgumentList @(
      $wsScript,
      "--endpoint", [string]$bootstrapCreated.Json.syncdBaseUrl,
      "--sessionId", $sessionId,
      "--pairingCode", $pairingCode,
      "--outputPath", $wsOutputPath,
      "--readyPath", $wsReadyPath,
      "--timeoutSeconds", "20",
      "--maxEvents", "6"
    ) `
    -StdoutPath $wsStdoutPath `
    -StderrPath $wsStderrPath
  Wait-ForPath -Path $wsReadyPath -TimeoutSeconds 10

  $currentStep = "claim pending"
  $claimPending = Invoke-JsonRequest -Method Post -Uri $claimUrl -Body @{
    sessionId = $sessionId
    pairingCode = $pairingCode
    deviceId = "android-live"
    deviceName = "Pixel Live"
    platform = "android"
    clientVersion = "0.1.0"
    clientProtocolVersion = 1
  }
  Assert-Status $claimPending 200 "pairing live claim pending"
  Set-Content -Path (Join-Path $tmpRoot "claim-pending.json") -Value $claimPending.Raw -NoNewline
  if ($claimPending.Json.status -ne "pending_approval") {
    throw "pairing live pending claim did not stay pending"
  }
  if ($claimPending.Raw -match "accessToken") {
    throw "pairing live pending claim must not include the final token"
  }

  $currentStep = "approve session"
  $approve = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/pairing-session/approve" -Headers $authHeaders -Body @{
    sessionId = $sessionId
  }
  Assert-Status $approve 200 "approve pairing live session"

  $currentStep = "wait for websocket capture"
  if (-not $wsCapture.WaitForExit(20000)) {
    throw "pairing websocket capture did not terminate after terminal status"
  }
  if ($wsCapture.ExitCode -ne 0) {
    throw "pairing websocket capture failed with exit code $($wsCapture.ExitCode)"
  }

  $events = Get-Content -Path $wsOutputPath -Raw | ConvertFrom-Json
  if ($events.Count -ne 6) {
    throw "expected 6 pairing live events, got $($events.Count)"
  }
  $expectedTypes = @("hello", "subscribed", "status_changed", "status_changed", "approved", "final_token_ready")
  for ($index = 0; $index -lt $expectedTypes.Count; $index += 1) {
    if ($events[$index].type -ne $expectedTypes[$index]) {
      throw "unexpected pairing live event at index ${index}: expected $($expectedTypes[$index]), got $($events[$index].type)"
    }
  }
  if ($events[2].status -ne "claimed") {
    throw "claimed transition was not observed on the live pairing channel"
  }
  if ($events[3].status -ne "approved" -or $events[4].status -ne "approved" -or $events[5].status -ne "approved") {
    throw "approval sequence did not stay in approved status"
  }
  $rawEvents = Get-Content -Path $wsOutputPath -Raw
  if ($rawEvents -match "accessToken") {
    throw "pairing live websocket must not carry final token material"
  }

  $currentStep = "claim after approval"
  $claimApproved = Invoke-JsonRequest -Method Post -Uri $claimUrl -Body @{
    sessionId = $sessionId
    pairingCode = $pairingCode
    deviceId = "android-live"
    deviceName = "Pixel Live"
    platform = "android"
    clientVersion = "0.1.0"
    clientProtocolVersion = 1
  }
  Assert-Status $claimApproved 200 "pairing live claim approved"
  Set-Content -Path (Join-Path $tmpRoot "claim-approved.json") -Value $claimApproved.Raw -NoNewline
  if ($claimApproved.Json.status -ne "approved") {
    throw "pairing live approved claim did not reach approved status"
  }
  if (-not $claimApproved.Json.token.accessToken) {
    throw "pairing live approved claim did not issue the final token"
  }

  Write-Host "Live pairing phase-gate completed successfully."
  Write-Host "Endpoint: $endpoint"
}
catch {
  Write-Host "[live-pairing-gate] failed during: $currentStep"
  Write-Host "[live-pairing-gate] exception: $($_.Exception.Message)"
  if ($_.ScriptStackTrace) {
    Write-Host $_.ScriptStackTrace
  }
  throw
}
finally {
  if ($wsCapture -and -not $wsCapture.HasExited) {
    Stop-EpigraphRetainedProcess -Process $wsCapture
  }
  Stop-SyncdProcessTree $syncd
  Pop-Location
}
