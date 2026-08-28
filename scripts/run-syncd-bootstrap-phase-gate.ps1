param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-JsonRequest {
  param(
    [string]$Method,
    [string]$Uri,
    [hashtable]$Headers = @{},
    $Body = $null,
    [string]$HeadersPath = $null
  )

  $responseFile = Join-Path $tmpRoot ("curl-response-" + [guid]::NewGuid().ToString() + ".txt")
  $headerFile = if ($HeadersPath) { $HeadersPath } else { Join-Path $tmpRoot ("curl-headers-" + [guid]::NewGuid().ToString() + ".txt") }
  $requestFile = $null
  $curlArgs = @("-k", "-sS", "-X", $Method.ToUpperInvariant(), "-D", $headerFile, "-o", $responseFile, "-w", "%{http_code}")

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
    $rawHeaders = if (Test-Path $headerFile) { Get-Content $headerFile -Raw } else { "" }
    $jsonBody = $null
    $headerMap = @{}
    if ($rawHeaders) {
      foreach ($line in ($rawHeaders -split "`r?`n")) {
        if ($line -match '^\s*([^:]+):\s*(.+?)\s*$') {
          $headerMap[$matches[1].Trim().ToLowerInvariant()] = $matches[2].Trim()
        }
      }
    }
    if ($raw) {
      try { $jsonBody = $raw | ConvertFrom-Json } catch {}
    }
    return @{
      StatusCode = [int]$status
      Raw = $raw
      RawHeaders = $rawHeaders
      Headers = $headerMap
      Json = $jsonBody
    }
  }
  finally {
    if ($requestFile -and (Test-Path $requestFile)) { Remove-Item $requestFile -Force }
    if (Test-Path $responseFile) { Remove-Item $responseFile -Force }
    if (-not $HeadersPath -and (Test-Path $headerFile)) { Remove-Item $headerFile -Force }
  }
}

function Assert-Status {
  param($Response, [int]$Expected, [string]$Label)
  if ($Response.StatusCode -ne $Expected) {
    throw "$Label expected HTTP $Expected, got $($Response.StatusCode): $($Response.Raw)"
  }
}

function Assert-NoStoreHeaders {
  param($Response, [string]$Label)
  if ($Response.Headers["cache-control"] -ne "no-store, max-age=0") {
    throw "$Label missing Cache-Control no-store header"
  }
  if ($Response.Headers["pragma"] -ne "no-cache") {
    throw "$Label missing Pragma no-cache header"
  }
  if ($Response.Headers["expires"] -ne "0") {
    throw "$Label missing Expires 0 header"
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

function Start-ManagedProcess {
  param(
    [string]$FilePath,
    [string]$WorkingDirectory,
    [string]$StdoutPath,
    [string]$StderrPath,
    [hashtable]$Environment = @{}
  )

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  Set-Content -Path $StdoutPath -Value "stdout capture disabled in bootstrap phase-gate harness" -NoNewline
  Set-Content -Path $StderrPath -Value "stderr capture disabled in bootstrap phase-gate harness" -NoNewline

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
$tmpRoot = Join-Path $projectRoot "tmp\syncd-bootstrap-phase-gate"
$dataDir = Join-Path $tmpRoot "data"
$stdoutPath = Join-Path $tmpRoot "syncd.stdout.log"
$stderrPath = Join-Path $tmpRoot "syncd.stderr.log"
$port = "47774"
$endpoint = "https://127.0.0.1:$port"
$advertisedEndpoint = "https://localhost:$port"
$syncdBinary = Join-Path $projectRoot "src-tauri\target\debug\epigraph-syncd.exe"
$syncd = $null
$currentStep = "initialization"

function Stop-SyncdProcessTree {
  param($Process)
  if ($null -eq $Process) { return }
  try { & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null } catch {}
  if (-not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  }
  try { $null = $Process.WaitForExit(5000) } catch {}
}

if (Test-Path $tmpRoot) { Remove-Item $tmpRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Push-Location $projectRoot
try {
  $currentStep = "build syncd"
  Write-Host "[bootstrap-gate] building syncd"
  cargo build --manifest-path src-tauri/Cargo.toml --bin epigraph-syncd

  $envMap = @{
    EPIGRAPH_SYNCD_ENABLE_AUDIT_ROUTES = "1"
    EPIGRAPH_SYNCD_DATA_DIR = $dataDir
    EPIGRAPH_SYNCD_BIND_HOST = "127.0.0.1"
    EPIGRAPH_SYNCD_PORT = $port
    EPIGRAPH_SYNCD_ADVERTISED_BASE_URL = $advertisedEndpoint
    EPIGRAPH_LOCAL_SERVER_MAIN_ROOT = Join-Path $tmpRoot "suwayomi-main"
    EPIGRAPH_LOCAL_SERVER_TEST_ROOT = Join-Path $tmpRoot "suwayomi-test"
  }

  $currentStep = "start syncd"
  Write-Host "[bootstrap-gate] starting syncd"
  $syncd = Start-ManagedProcess `
    -FilePath $syncdBinary `
    -WorkingDirectory $projectRoot `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath `
    -Environment $envMap

  $currentStep = "wait for health"
  Wait-ForHealthy -Endpoint $endpoint -TimeoutSeconds 30
  Write-Host "[bootstrap-gate] syncd healthy at $endpoint"

  $currentStep = "create bootstrap payload"
  $bootstrapCreated = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/bootstrap/session" -HeadersPath (Join-Path $tmpRoot "bootstrap-created.headers.txt") -Body @{
    profileId = "main"
  }
  Assert-Status $bootstrapCreated 200 "create bootstrap session"
  Assert-NoStoreHeaders $bootstrapCreated "create bootstrap session"
  Set-Content -Path (Join-Path $tmpRoot "bootstrap-created.json") -Value $bootstrapCreated.Raw -NoNewline
  if ($bootstrapCreated.Raw -match "accessToken" -or $bootstrapCreated.Raw -match '"token"\s*:') {
    throw "bootstrap payload must not contain final token material"
  }
  if ($bootstrapCreated.Json.profileId -ne "main") {
    throw "bootstrap payload did not bind to the requested profile"
  }
  if ($bootstrapCreated.Json.syncdBaseUrl -ne $advertisedEndpoint) {
    throw "bootstrap syncdBaseUrl did not use the advertised endpoint"
  }
  if ($bootstrapCreated.Json.claimUrl -ne "$advertisedEndpoint/v1/pairing/claim") {
    throw "bootstrap claimUrl did not point to the advertised syncd claim endpoint"
  }
  if (($bootstrapCreated.Json.PSObject.Properties.Name -contains "suwayomiHint") -and $null -ne $bootstrapCreated.Json.suwayomiHint) {
    throw "bootstrap payload should not include a Suwayomi hint without a valid temporary LAN session"
  }

  $bootstrapSessionId = [string]$bootstrapCreated.Json.pairingSessionId

  $currentStep = "fetch bootstrap payload"
  $bootstrapFetched = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/bootstrap/session/$bootstrapSessionId" -HeadersPath (Join-Path $tmpRoot "bootstrap-fetched.headers.txt")
  Assert-Status $bootstrapFetched 200 "fetch bootstrap session payload"
  Assert-NoStoreHeaders $bootstrapFetched "fetch bootstrap session payload"
  Set-Content -Path (Join-Path $tmpRoot "bootstrap-fetched.json") -Value $bootstrapFetched.Raw -NoNewline
  if ($bootstrapFetched.Raw -match "accessToken" -or $bootstrapFetched.Raw -match '"token"\s*:') {
    throw "fetched bootstrap payload must not contain final token material"
  }
  if ($bootstrapFetched.Json.pairingSessionId -ne $bootstrapCreated.Json.pairingSessionId) {
    throw "fetched bootstrap payload returned the wrong session id"
  }
  if ($bootstrapFetched.Json.syncdBaseUrl -ne $advertisedEndpoint) {
    throw "fetched bootstrap payload did not preserve the advertised endpoint"
  }
  if (($bootstrapFetched.Json.PSObject.Properties.Name -contains "suwayomiHint") -and $null -ne $bootstrapFetched.Json.suwayomiHint) {
    throw "fetched bootstrap payload should not include a Suwayomi hint without a valid temporary LAN session"
  }

  $pairingCode = [string]$bootstrapFetched.Json.pairingCode

  $currentStep = "claim from bootstrap payload"
  $bootstrapClaimPending = Invoke-JsonRequest -Method Post -Uri ([string]$bootstrapFetched.Json.claimUrl) -Body @{
    sessionId = $bootstrapSessionId
    pairingCode = $pairingCode
    deviceId = "android-bootstrap"
    deviceName = "Pixel Bootstrap"
    platform = "android"
    clientVersion = "0.1.0"
    clientProtocolVersion = 1
  }
  Assert-Status $bootstrapClaimPending 200 "bootstrap claim pending"
  Set-Content -Path (Join-Path $tmpRoot "bootstrap-claim-pending.json") -Value $bootstrapClaimPending.Raw -NoNewline
  if ($bootstrapClaimPending.Json.status -ne "pending_approval") {
    throw "bootstrap claim should remain pending until approval"
  }
  if ($bootstrapClaimPending.Raw -match "accessToken") {
    throw "pending bootstrap claim must not return a final token"
  }

  $currentStep = "approve pairing session"
  $approveBootstrap = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/pairing-session/approve" -Body @{
    sessionId = $bootstrapSessionId
  }
  Assert-Status $approveBootstrap 200 "approve bootstrap pairing session"

  $currentStep = "claim after approval"
  $bootstrapClaimApproved = Invoke-JsonRequest -Method Post -Uri ([string]$bootstrapFetched.Json.claimUrl) -Body @{
    sessionId = $bootstrapSessionId
    pairingCode = $pairingCode
    deviceId = "android-bootstrap"
    deviceName = "Pixel Bootstrap"
    platform = "android"
    clientVersion = "0.1.0"
    clientProtocolVersion = 1
  }
  Assert-Status $bootstrapClaimApproved 200 "bootstrap claim approved"
  Set-Content -Path (Join-Path $tmpRoot "bootstrap-claim-approved.json") -Value $bootstrapClaimApproved.Raw -NoNewline
  if ($bootstrapClaimApproved.Json.status -ne "approved") {
    throw "approved bootstrap claim did not reach approved status"
  }
  if (-not $bootstrapClaimApproved.Json.token.accessToken) {
    throw "approved bootstrap claim did not issue a final token"
  }

  $currentStep = "expired bootstrap payload"
  $expiredCreate = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/pairing-session" -Body @{
    sessionId = "bootstrap-expired"
    profileId = "main"
    pairingCode = "EXPIREDBOOT"
    expiresAtMs = [int64](Get-Date).ToUniversalTime().AddMinutes(-1).Subtract([datetime]'1970-01-01').TotalMilliseconds
  }
  Assert-Status $expiredCreate 200 "create expired bootstrap session"

  $bootstrapExpired = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/bootstrap/session/bootstrap-expired" -HeadersPath (Join-Path $tmpRoot "bootstrap-expired.headers.txt")
  Assert-Status $bootstrapExpired 410 "expired bootstrap session fetch"
  Assert-NoStoreHeaders $bootstrapExpired "expired bootstrap session fetch"
  Set-Content -Path (Join-Path $tmpRoot "bootstrap-expired.json") -Value $bootstrapExpired.Raw -NoNewline

  Write-Host "Bootstrap phase-gate completed successfully."
  Write-Host "Endpoint: $endpoint"
}
catch {
  Write-Host "[bootstrap-gate] failed during: $currentStep"
  Write-Host "[bootstrap-gate] exception: $($_.Exception.Message)"
  if ($_.ScriptStackTrace) {
    Write-Host $_.ScriptStackTrace
  }
  throw
}
finally {
  Stop-SyncdProcessTree $syncd
  Pop-Location
}
