param()

$ErrorActionPreference = "Stop"
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
  Set-Content -Path $StdoutPath -Value "stdout capture disabled in pairing phase-gate harness" -NoNewline
  Set-Content -Path $StderrPath -Value "stderr capture disabled in pairing phase-gate harness" -NoNewline

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
$tmpRoot = Join-Path $projectRoot "tmp\syncd-pairing-phase-gate"
$dataDir = Join-Path $tmpRoot "data"
$stdoutPath = Join-Path $tmpRoot "syncd.stdout.log"
$stderrPath = Join-Path $tmpRoot "syncd.stderr.log"
$port = "47773"
$endpoint = "https://127.0.0.1:$port"
$syncdBinary = Join-Path $projectRoot "src-tauri\target\debug\epigraph-syncd.exe"
$syncd = $null
$currentStep = "initialization"

function Stop-SyncdProcessTree {
  param($Process)
  if ($null -eq $Process) { return }
  try {
    & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
  } catch {}
  if (-not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
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
  Write-Host "[pairing-gate] building syncd"
  cargo build --manifest-path src-tauri/Cargo.toml --bin epigraph-syncd

  $envMap = @{
    EPIGRAPH_SYNCD_ENABLE_AUDIT_ROUTES = "1"
    EPIGRAPH_SYNCD_DATA_DIR = $dataDir
    EPIGRAPH_SYNCD_BIND_HOST = "127.0.0.1"
    EPIGRAPH_SYNCD_PORT = $port
    EPIGRAPH_LOCAL_SERVER_MAIN_ROOT = Join-Path $tmpRoot "suwayomi-main"
    EPIGRAPH_LOCAL_SERVER_TEST_ROOT = Join-Path $tmpRoot "suwayomi-test"
  }
  $currentStep = "start syncd"
  Write-Host "[pairing-gate] starting syncd"
  $syncd = Start-ManagedProcess `
    -FilePath $syncdBinary `
    -WorkingDirectory $projectRoot `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath `
    -Environment $envMap

  $currentStep = "wait for health"
  Wait-ForHealthy -Endpoint $endpoint -TimeoutSeconds 30
  Write-Host "[pairing-gate] syncd healthy at $endpoint"

  $currentStep = "main pairing flow"
  $createMainSession = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/pairing-session" -Headers $authHeaders -Body @{
    sessionId = "pair-main"
    profileId = "main"
    pairingCode = "111111"
    expiresAtMs = [int64](Get-Date).ToUniversalTime().AddMinutes(5).Subtract([datetime]'1970-01-01').TotalMilliseconds
  }
  Assert-Status $createMainSession 200 "create main pairing session"

  $claimMainPending = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/pairing/claim" -Body @{
    sessionId = "pair-main"
    pairingCode = "111111"
    deviceId = "android-shared"
    deviceName = "Pixel"
    platform = "android"
    clientVersion = "0.1.0"
    clientProtocolVersion = 1
  }
  Assert-Status $claimMainPending 200 "claim main pairing pending"
  Set-Content -Path (Join-Path $tmpRoot "claim-main-pending.json") -Value $claimMainPending.Raw -NoNewline
  if ($claimMainPending.Json.status -ne "pending_approval") {
    throw "main pairing claim did not remain pending before approval"
  }

  $approveMain = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/pairing-session/approve" -Headers $authHeaders -Body @{
    sessionId = "pair-main"
  }
  Assert-Status $approveMain 200 "approve main pairing session"

  $claimMainApproved = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/pairing/claim" -Body @{
    sessionId = "pair-main"
    pairingCode = "111111"
    deviceId = "android-shared"
    deviceName = "Pixel"
    platform = "android"
    clientVersion = "0.1.0"
    clientProtocolVersion = 1
  }
  Assert-Status $claimMainApproved 200 "claim main pairing approved"
  Set-Content -Path (Join-Path $tmpRoot "claim-main-approved.json") -Value $claimMainApproved.Raw -NoNewline
  if ($claimMainApproved.Json.status -ne "approved" -or $claimMainApproved.Json.token.grantedVia -ne "qr") {
    throw "main pairing approval did not issue the expected QR-bound token"
  }
  $mainAccessToken = [string]$claimMainApproved.Json.token.accessToken

  $mainBooks = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?scopeId=books%3Aglobal&sinceVersion=0" -Headers @{
    "Authorization" = "Bearer $mainAccessToken"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  }
  Assert-Status $mainBooks 200 "main token books scope"

  $mainNovelsAllowed = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?scopeId=novels%3Aprofile%3Amain&sinceVersion=0" -Headers @{
    "Authorization" = "Bearer $mainAccessToken"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  }
  Assert-Status $mainNovelsAllowed 200 "main token novels:profile:main"

  $mainNovelsForbidden = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?scopeId=novels%3Aprofile%3Atest&sinceVersion=0" -Headers @{
    "Authorization" = "Bearer $mainAccessToken"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  }
  Assert-Status $mainNovelsForbidden 403 "main token forbidden novels:profile:test"

  $currentStep = "rejected pairing flow"
  $createRejectedSession = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/pairing-session" -Headers $authHeaders -Body @{
    sessionId = "pair-rejected"
    profileId = "main"
    pairingCode = "222222"
    expiresAtMs = [int64](Get-Date).ToUniversalTime().AddMinutes(5).Subtract([datetime]'1970-01-01').TotalMilliseconds
  }
  Assert-Status $createRejectedSession 200 "create rejected pairing session"

  $null = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/pairing/claim" -Body @{
    sessionId = "pair-rejected"
    pairingCode = "222222"
    deviceId = "android-rejected"
    deviceName = "Pixel Reject"
    platform = "android"
    clientVersion = "0.1.0"
    clientProtocolVersion = 1
  }

  $rejectSession = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/pairing-session/reject" -Headers $authHeaders -Body @{
    sessionId = "pair-rejected"
  }
  Assert-Status $rejectSession 200 "reject pairing session"

  $claimRejected = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/pairing/claim" -Body @{
    sessionId = "pair-rejected"
    pairingCode = "222222"
    deviceId = "android-rejected"
    deviceName = "Pixel Reject"
    platform = "android"
    clientVersion = "0.1.0"
    clientProtocolVersion = 1
  }
  Assert-Status $claimRejected 200 "claim rejected pairing session"
  Set-Content -Path (Join-Path $tmpRoot "claim-rejected.json") -Value $claimRejected.Raw -NoNewline
  if ($claimRejected.Json.status -ne "rejected") {
    throw "rejected pairing session did not stay rejected"
  }

  $currentStep = "expired pairing flow"
  $createExpiredSession = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/pairing-session" -Headers $authHeaders -Body @{
    sessionId = "pair-expired"
    profileId = "main"
    pairingCode = "333333"
    expiresAtMs = [int64](Get-Date).ToUniversalTime().AddMinutes(-1).Subtract([datetime]'1970-01-01').TotalMilliseconds
  }
  Assert-Status $createExpiredSession 200 "create expired pairing session"

  $claimExpired = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/pairing/claim" -Body @{
    sessionId = "pair-expired"
    pairingCode = "333333"
    deviceId = "android-expired"
    deviceName = "Pixel Expired"
    platform = "android"
    clientVersion = "0.1.0"
    clientProtocolVersion = 1
  }
  Assert-Status $claimExpired 410 "claim expired pairing session"
  Set-Content -Path (Join-Path $tmpRoot "claim-expired.json") -Value $claimExpired.Raw -NoNewline

  $currentStep = "trusted-pool pairing flow"
  $createTestSession = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/pairing-session" -Headers $authHeaders -Body @{
    sessionId = "pair-test"
    profileId = "test"
    pairingCode = "444444"
    expiresAtMs = [int64](Get-Date).ToUniversalTime().AddMinutes(5).Subtract([datetime]'1970-01-01').TotalMilliseconds
  }
  Assert-Status $createTestSession 200 "create trusted-pool pairing session"

  $claimTestPending = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/pairing/claim" -Body @{
    sessionId = "pair-test"
    pairingCode = "444444"
    deviceId = "android-shared"
    deviceName = "Pixel"
    platform = "android"
    clientVersion = "0.1.0"
    clientProtocolVersion = 1
  }
  Assert-Status $claimTestPending 200 "claim trusted-pool pairing pending"
  if ($claimTestPending.Json.status -ne "pending_approval") {
    throw "trusted-pool candidate session did not start pending"
  }

  $approveTest = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/pairing-session/approve" -Headers $authHeaders -Body @{
    sessionId = "pair-test"
  }
  Assert-Status $approveTest 200 "approve trusted-pool pairing session"

  $claimTestApproved = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/pairing/claim" -Body @{
    sessionId = "pair-test"
    pairingCode = "444444"
    deviceId = "android-shared"
    deviceName = "Pixel"
    platform = "android"
    clientVersion = "0.1.0"
    clientProtocolVersion = 1
  }
  Assert-Status $claimTestApproved 200 "claim trusted-pool pairing approved"
  Set-Content -Path (Join-Path $tmpRoot "claim-test-approved.json") -Value $claimTestApproved.Raw -NoNewline
  if ($claimTestApproved.Json.status -ne "approved" -or $claimTestApproved.Json.token.grantedVia -ne "trusted-pool") {
    throw "trusted-pool approval did not issue the expected trusted-pool token"
  }
  $testAccessToken = [string]$claimTestApproved.Json.token.accessToken

  $testBooks = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?scopeId=books%3Aglobal&sinceVersion=0" -Headers @{
    "Authorization" = "Bearer $testAccessToken"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  }
  Assert-Status $testBooks 200 "trusted-pool token books scope"

  $testNovelsAllowed = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?scopeId=novels%3Aprofile%3Atest&sinceVersion=0" -Headers @{
    "Authorization" = "Bearer $testAccessToken"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  }
  Assert-Status $testNovelsAllowed 200 "trusted-pool token novels:profile:test"

  $testNovelsForbidden = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?scopeId=novels%3Aprofile%3Amain&sinceVersion=0" -Headers @{
    "Authorization" = "Bearer $testAccessToken"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  }
  Assert-Status $testNovelsForbidden 403 "trusted-pool token forbidden novels:profile:main"

  $currentStep = "revoked-token flow"
  $revokeTestToken = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/revoke-token" -Headers $authHeaders -Body @{
    rawToken = $testAccessToken
  }
  Assert-Status $revokeTestToken 200 "revoke trusted-pool token"

  $revokedUse = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?scopeId=books%3Aglobal&sinceVersion=0" -Headers @{
    "Authorization" = "Bearer $testAccessToken"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  }
  Assert-Status $revokedUse 401 "revoked token denied"
  Set-Content -Path (Join-Path $tmpRoot "revoked-token-use.json") -Value $revokedUse.Raw -NoNewline

  $currentStep = "expired-token flow"
  $expireMainToken = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/expire-token" -Headers $authHeaders -Body @{
    rawToken = $mainAccessToken
  }
  Assert-Status $expireMainToken 200 "expire main token"

  $expiredUse = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?scopeId=books%3Aglobal&sinceVersion=0" -Headers @{
    "Authorization" = "Bearer $mainAccessToken"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  }
  Assert-Status $expiredUse 401 "expired token denied"
  Set-Content -Path (Join-Path $tmpRoot "expired-token-use.json") -Value $expiredUse.Raw -NoNewline

  Write-Host "Pairing phase-gate completed successfully."
  Write-Host "Endpoint: $endpoint"
}
catch {
  Write-Host "[pairing-gate] failed during: $currentStep"
  Write-Host "[pairing-gate] exception: $($_.Exception.Message)"
  if ($_.ScriptStackTrace) {
    Write-Host $_.ScriptStackTrace
  }
  throw
}
finally {
  Stop-SyncdProcessTree $syncd
  Pop-Location
}
