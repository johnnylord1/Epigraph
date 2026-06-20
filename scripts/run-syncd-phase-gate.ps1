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
    $json = $Body | ConvertTo-Json -Depth 10 -Compress
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

function Wait-ForPath {
  param([string]$Path, [int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $Path) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for path: $Path"
}

function Wait-ForText {
  param([string]$Path, [string]$Needle, [int]$TimeoutSeconds = 10)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path $Path) -and ((Get-Content $Path -Raw) -match [regex]::Escape($Needle))) {
      return
    }
    Start-Sleep -Milliseconds 200
  }
  throw "Timed out waiting for '$Needle' in $Path"
}

function Assert-Status {
  param($Response, [int]$Expected, [string]$Label)
  if ($Response.StatusCode -ne $Expected) {
    throw "$Label expected HTTP $Expected, got $($Response.StatusCode): $($Response.Raw)"
  }
}

function Start-AethonPhaseGateApp {
  param(
    [string]$ProjectRoot,
    [string]$AppBinaryPath,
    [string]$DataDir,
    [string]$StatusPath,
    [string]$ExitSentinelPath,
    [string]$StdoutPath,
    [string]$StderrPath,
    [string]$Port
  )

  $envMap = @{
    AETHON_SYNCD_PHASE_GATE_AUTOSTART = "1"
    AETHON_SYNCD_ENABLE_AUDIT_ROUTES = "1"
    AETHON_SYNCD_DATA_DIR = $DataDir
    AETHON_SYNCD_BIND_HOST = "127.0.0.1"
    AETHON_SYNCD_PORT = $Port
    AETHON_SYNCD_PHASE_GATE_STATUS_PATH = $StatusPath
    AETHON_SYNCD_PHASE_GATE_EXIT_SENTINEL = $ExitSentinelPath
  }

  if (Test-Path $StatusPath) { Remove-Item $StatusPath -Force }
  if (Test-Path $ExitSentinelPath) { Remove-Item $ExitSentinelPath -Force }
  $previous = @{}
  foreach ($key in $envMap.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, $envMap[$key], "Process")
  }

  try {
    return Start-Process $AppBinaryPath `
      -WorkingDirectory $ProjectRoot `
      -RedirectStandardOutput $StdoutPath `
      -RedirectStandardError $StderrPath `
      -PassThru
  }
  finally {
    foreach ($key in $envMap.Keys) {
      [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
    }
  }
}

function Stop-AethonPhaseGateApp {
  param(
    $Process,
    [string]$ExitSentinelPath,
    [int]$TimeoutSeconds = 25
  )

  New-Item -ItemType File -Force -Path $ExitSentinelPath | Out-Null
  if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $Process.Id -Force
    throw "Aethon phase-gate app did not exit after sentinel request"
  }
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tmpRoot = Join-Path $projectRoot "tmp\syncd-phase-gate"
$dataDir = Join-Path $tmpRoot "data"
$statusPath = Join-Path $tmpRoot "status.json"
$exitSentinel = Join-Path $tmpRoot "exit.sentinel"
$stdoutPath = Join-Path $tmpRoot "aethon.stdout.log"
$stderrPath = Join-Path $tmpRoot "aethon.stderr.log"
$port = "47771"
$appBinaryPath = Join-Path $projectRoot "src-tauri\target\debug\aethon.exe"

New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Push-Location $projectRoot
try {
  Write-Host "[phase-gate] building frontend"
  node .\node_modules\vite\bin\vite.js build
  Write-Host "[phase-gate] preparing sidecar"
  node .\scripts\prepare-syncd-sidecar.mjs
  Write-Host "[phase-gate] building desktop binary"
  cargo build --manifest-path src-tauri/Cargo.toml --bin aethon

  Write-Host "[phase-gate] starting desktop app"
  $app = Start-AethonPhaseGateApp `
    -ProjectRoot $projectRoot `
    -AppBinaryPath $appBinaryPath `
    -DataDir $dataDir `
    -StatusPath $statusPath `
    -ExitSentinelPath $exitSentinel `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath `
    -Port $port

  Wait-ForPath -Path $statusPath -TimeoutSeconds 90
  $status = Get-Content $statusPath -Raw | ConvertFrom-Json
  $endpoint = $status.endpoint
  Write-Host "[phase-gate] syncd ready at $endpoint"

  $missingHeaders = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/capabilities"
  Assert-Status $missingHeaders 400 "capabilities missing headers"

  $badProtocol = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/capabilities" -Headers @{
    "X-Aethon-Client-Version" = "0.1.0"
    "X-Aethon-Client-Protocol-Version" = "9"
  }
  Assert-Status $badProtocol 426 "capabilities bad protocol"

  $goodCapabilities = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/capabilities" -Headers @{
    "X-Aethon-Client-Version" = "0.1.0"
    "X-Aethon-Client-Protocol-Version" = "1"
  }
  Assert-Status $goodCapabilities 200 "capabilities ok"
  $fingerprint1 = $goodCapabilities.Json.tlsCertSha256
  Write-Host "[phase-gate] capabilities ok, fingerprint $fingerprint1"

  $auditHeaders = @{
    "X-Aethon-Client-Version" = "0.1.0"
    "X-Aethon-Client-Protocol-Version" = "1"
  }

  $null = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/ensure-token" -Headers $auditHeaders -Body @{
    deviceId = "device-main"
    profileId = "main"
    rawToken = "main-token"
    scopes = @("books:global", "novels:profile:main")
  }
  $null = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/ensure-token" -Headers $auditHeaders -Body @{
    deviceId = "device-test"
    profileId = "test"
    rawToken = "test-token"
    scopes = @("books:global", "novels:profile:test")
  }
  $null = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/ensure-token" -Headers $auditHeaders -Body @{
    deviceId = "device-revoked"
    profileId = "main"
    rawToken = "revoked-token"
    scopes = @("books:global", "novels:profile:main")
  }
  $null = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/ensure-token" -Headers $auditHeaders -Body @{
    deviceId = "device-expired"
    profileId = "main"
    rawToken = "expired-token"
    scopes = @("books:global", "novels:profile:main")
  }

  $beforeLastSeen = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/token-state" -Headers $auditHeaders -Body @{
    rawToken = "main-token"
  }

  $booksMain = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?sinceVersion=0&scopeId=books%3Aglobal" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Aethon-Client-Version" = "0.1.0"
    "X-Aethon-Client-Protocol-Version" = "1"
  }
  Assert-Status $booksMain 200 "books scope with main profile"

  $booksTest = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?sinceVersion=0&scopeId=books%3Aglobal" -Headers @{
    "Authorization" = "Bearer test-token"
    "X-Aethon-Client-Version" = "0.1.0"
    "X-Aethon-Client-Protocol-Version" = "1"
  }
  Assert-Status $booksTest 200 "books scope with test profile"

  $novelsMain = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?sinceVersion=0&scopeId=novels%3Aprofile%3Amain" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Aethon-Client-Version" = "0.1.0"
    "X-Aethon-Client-Protocol-Version" = "1"
  }
  Assert-Status $novelsMain 200 "novels main scope"

  $novelsForbidden = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?sinceVersion=0&scopeId=novels%3Aprofile%3Atest" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Aethon-Client-Version" = "0.1.0"
    "X-Aethon-Client-Protocol-Version" = "1"
  }
  Assert-Status $novelsForbidden 403 "novels profile isolation"

  $afterLastSeen = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/token-state" -Headers $auditHeaders -Body @{
    rawToken = "main-token"
  }
  if ([int64]$afterLastSeen.Json.lastSeenAtMs -lt [int64]$beforeLastSeen.Json.lastSeenAtMs) {
    throw "last_seen_at_ms did not move forward after successful authenticated request"
  }
  Write-Host "[phase-gate] auth and scope checks ok"

  $changesUnauthorized = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?sinceVersion=0&scopeId=books%3Aglobal" -Headers @{
    "X-Aethon-Client-Version" = "0.1.0"
    "X-Aethon-Client-Protocol-Version" = "1"
  }
  Assert-Status $changesUnauthorized 401 "changes unauthorized"

  $null = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/revoke-token" -Headers $auditHeaders -Body @{
    rawToken = "revoked-token"
  }
  $revokedEvents = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/events?scopeId=books%3Aglobal" -Headers @{
    "Authorization" = "Bearer revoked-token"
    "X-Aethon-Client-Version" = "0.1.0"
    "X-Aethon-Client-Protocol-Version" = "1"
  }
  Assert-Status $revokedEvents 401 "revoked token events"

  $null = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/expire-token" -Headers $auditHeaders -Body @{
    rawToken = "expired-token"
  }
  $expiredEvents = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/events?scopeId=books%3Aglobal" -Headers @{
    "Authorization" = "Bearer expired-token"
    "X-Aethon-Client-Version" = "0.1.0"
    "X-Aethon-Client-Protocol-Version" = "1"
  }
  Assert-Status $expiredEvents 401 "expired token events"

  $pingOutput = Join-Path $tmpRoot "events-ping.log"
  if (Test-Path $pingOutput) { Remove-Item $pingOutput -Force }
  $pingCapture = Start-Process node -ArgumentList @(
    (Join-Path $projectRoot "scripts\capture-syncd-sse.mjs"),
    "--endpoint", $endpoint,
    "--token", "main-token",
    "--scopeId", "books:global",
    "--outputPath", $pingOutput,
    "--maxEvents", "1",
    "--timeoutSeconds", "40"
  ) -WorkingDirectory $projectRoot -PassThru
  Wait-ForText -Path $pingOutput -Needle "event: ping" -TimeoutSeconds 40
  if (-not $pingCapture.HasExited) { $pingCapture | Stop-Process -Force }
  Write-Host "[phase-gate] ping keepalive ok"

  $null = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/append-change" -Headers $auditHeaders -Body @{
    scopeId = "books:global"
    profileId = $null
    entityType = "book.progress"
    entityId = "book-1"
    op = "merge"
    lamport = 1
    changedByDeviceId = "device-main"
    patch = @{ progressPercent = 0.2 }
  }

  $handoffOutput = Join-Path $tmpRoot "events-handoff.log"
  if (Test-Path $handoffOutput) { Remove-Item $handoffOutput -Force }
  $handoffCapture = Start-Process node -ArgumentList @(
    (Join-Path $projectRoot "scripts\capture-syncd-sse.mjs"),
    "--endpoint", $endpoint,
    "--token", "main-token",
    "--scopeId", "books:global",
    "--outputPath", $handoffOutput,
    "--lastEventId", "0",
    "--maxEvents", "3",
    "--timeoutSeconds", "10"
  ) -WorkingDirectory $projectRoot -PassThru

  Wait-ForText -Path $handoffOutput -Needle "id: 1" -TimeoutSeconds 10
  $null = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/append-change" -Headers $auditHeaders -Body @{
    scopeId = "books:global"
    profileId = $null
    entityType = "book.progress"
    entityId = "book-2"
    op = "merge"
    lamport = 2
    changedByDeviceId = "device-main"
    patch = @{ progressPercent = 0.4 }
  }
  Wait-ForText -Path $handoffOutput -Needle "id: 2" -TimeoutSeconds 10
  if (-not $handoffCapture.HasExited) { $handoffCapture | Stop-Process -Force }
  Write-Host "[phase-gate] backlog to live handoff ok"

  $null = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/append-change" -Headers $auditHeaders -Body @{
    scopeId = "books:global"
    profileId = $null
    entityType = "book.progress"
    entityId = "book-3"
    op = "merge"
    lamport = 3
    changedByDeviceId = "device-main"
    patch = @{ progressPercent = 0.6 }
  }
  $null = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/append-change" -Headers $auditHeaders -Body @{
    scopeId = "books:global"
    profileId = $null
    entityType = "book.progress"
    entityId = "book-4"
    op = "merge"
    lamport = 4
    changedByDeviceId = "device-main"
    patch = @{ progressPercent = 0.8 }
  }

  $reconnectOutput = Join-Path $tmpRoot "events-reconnect.log"
  if (Test-Path $reconnectOutput) { Remove-Item $reconnectOutput -Force }
  $reconnectCapture = Start-Process node -ArgumentList @(
    (Join-Path $projectRoot "scripts\capture-syncd-sse.mjs"),
    "--endpoint", $endpoint,
    "--token", "main-token",
    "--scopeId", "books:global",
    "--outputPath", $reconnectOutput,
    "--lastEventId", "2",
    "--maxEvents", "2",
    "--timeoutSeconds", "10"
  ) -WorkingDirectory $projectRoot -PassThru
  Wait-ForText -Path $reconnectOutput -Needle "id: 3" -TimeoutSeconds 10
  Wait-ForText -Path $reconnectOutput -Needle "id: 4" -TimeoutSeconds 10
  if (-not $reconnectCapture.HasExited) { $reconnectCapture | Stop-Process -Force }
  Write-Host "[phase-gate] reconnect replay ok"

  $null = Invoke-JsonRequest -Method Post -Uri "$endpoint/__audit/runtime" -Headers $auditHeaders -Body @{
    currentServerVersion = 10
    minReplayableServerVersion = 5
  }

  $oldChanges = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?sinceVersion=3&scopeId=books%3Aglobal" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Aethon-Client-Version" = "0.1.0"
    "X-Aethon-Client-Protocol-Version" = "1"
  }
  Assert-Status $oldChanges 409 "expired replay window via changes"

  $oldEvents = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/events?scopeId=books%3Aglobal" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Aethon-Client-Version" = "0.1.0"
    "X-Aethon-Client-Protocol-Version" = "1"
    "Last-Event-ID" = "3"
  }
  Assert-Status $oldEvents 409 "expired replay window via events"
  Write-Host "[phase-gate] expired replay window enforcement ok"

  Stop-AethonPhaseGateApp -Process $app -ExitSentinelPath $exitSentinel
  if (Get-Process -Id $status.pid -ErrorAction SilentlyContinue) {
    throw "syncd sidecar process $($status.pid) still alive after graceful app exit"
  }
  Write-Host "[phase-gate] first graceful shutdown ok"

  $app2 = Start-AethonPhaseGateApp `
    -ProjectRoot $projectRoot `
    -AppBinaryPath $appBinaryPath `
    -DataDir $dataDir `
    -StatusPath $statusPath `
    -ExitSentinelPath $exitSentinel `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath `
    -Port $port
  Wait-ForPath -Path $statusPath -TimeoutSeconds 90
  $status2 = Get-Content $statusPath -Raw | ConvertFrom-Json
  $goodCapabilities2 = Invoke-JsonRequest -Method Get -Uri "$($status2.endpoint)/v1/capabilities" -Headers @{
    "X-Aethon-Client-Version" = "0.1.0"
    "X-Aethon-Client-Protocol-Version" = "1"
  }
  Assert-Status $goodCapabilities2 200 "capabilities after restart"
  $fingerprint2 = $goodCapabilities2.Json.tlsCertSha256
  if ($fingerprint1 -ne $fingerprint2) {
    throw "TLS fingerprint changed across restart despite reusing the same syncd data dir"
  }
  Write-Host "[phase-gate] fingerprint stable across restart"

  Stop-AethonPhaseGateApp -Process $app2 -ExitSentinelPath $exitSentinel
  if (Get-Process -Id $status2.pid -ErrorAction SilentlyContinue) {
    throw "syncd sidecar process $($status2.pid) still alive after second graceful app exit"
  }

  Write-Host "Phase-gate runtime audit completed successfully."
  Write-Host "Endpoint: $endpoint"
  Write-Host "Fingerprint: $fingerprint1"
}
catch {
  Write-Error $_
  throw
}
finally {
  Pop-Location
}
