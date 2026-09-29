param()

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'EpigraphSessionTools.ps1')
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

function Normalize-MdnsServiceType {
  param([AllowNull()][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  return $Value.Trim().TrimEnd(".").ToLowerInvariant()
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
  Set-Content -Path $StdoutPath -Value "stdout capture disabled in discovery phase-gate harness" -NoNewline
  Set-Content -Path $StderrPath -Value "stderr capture disabled in discovery phase-gate harness" -NoNewline

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

function Stop-ManagedProcess {
  param($Process)
  if ($null -eq $Process) { return }
  if (-not $Process.HasExited) {
    Stop-EpigraphRetainedProcess -Process $Process
  }
  try { $null = $Process.WaitForExit(5000) } catch {}
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tmpRoot = Join-Path $projectRoot "tmp\syncd-discovery-phase-gate"
$dataDir = Join-Path $tmpRoot "data"
$invalidDataDir = Join-Path $tmpRoot "invalid-data"
$stdoutPath = Join-Path $tmpRoot "syncd.stdout.log"
$stderrPath = Join-Path $tmpRoot "syncd.stderr.log"
$invalidStdoutPath = Join-Path $tmpRoot "syncd-invalid.stdout.log"
$invalidStderrPath = Join-Path $tmpRoot "syncd-invalid.stderr.log"
$port = "47778"
$endpoint = "https://127.0.0.1:$port"
$advertisedEndpoint = "https://127.0.0.1:$port"
$manualEndpoint = "https://localhost:$port"
$invalidPort = "47779"
$invalidEndpoint = "https://127.0.0.1:$invalidPort"
$invalidAdvertisedEndpoint = "https://127.0.0.1:$invalidPort"
$syncdBinary = Join-Path $projectRoot "src-tauri\target\debug\epigraph-syncd.exe"
$syncd = $null
$currentStep = "initialization"

if (Test-Path $tmpRoot) { Remove-Item $tmpRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
New-Item -ItemType Directory -Force -Path $invalidDataDir | Out-Null

Push-Location $projectRoot
try {
  $currentStep = "build syncd"
  Write-Host "[discovery-gate] building syncd"
  cargo build --manifest-path src-tauri/Cargo.toml --bin epigraph-syncd

  $envMap = @{
    EPIGRAPH_SYNCD_ENABLE_AUDIT_ROUTES = "1"
    EPIGRAPH_SYNCD_DATA_DIR = $dataDir
    EPIGRAPH_SYNCD_BIND_HOST = "127.0.0.1"
    EPIGRAPH_SYNCD_PORT = $port
    EPIGRAPH_SYNCD_ADVERTISED_BASE_URL = $advertisedEndpoint
    EPIGRAPH_SYNCD_DISCOVERY_MDNS_PORT = "5460"
    EPIGRAPH_SYNCD_EFFECTIVE_DISCOVERY_POLICY = "manual-preferred"
    EPIGRAPH_SYNCD_MANUAL_PROVIDER = "enabled"
    EPIGRAPH_SYNCD_MANUAL_ORIGINS = "https://localhost:$port/,https://localhost:$port,https://[::1]:$port"
    EPIGRAPH_LOCAL_SERVER_MAIN_ROOT = Join-Path $tmpRoot "suwayomi-main"
    EPIGRAPH_LOCAL_SERVER_TEST_ROOT = Join-Path $tmpRoot "suwayomi-test"
  }

  $currentStep = "start syncd"
  Write-Host "[discovery-gate] starting syncd"
  $syncd = Start-ManagedProcess `
    -FilePath $syncdBinary `
    -WorkingDirectory $projectRoot `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath `
    -Environment $envMap

  $currentStep = "wait for health"
  Wait-ForHealthy -Endpoint $endpoint -TimeoutSeconds 30
  Write-Host "[discovery-gate] syncd healthy at $endpoint"

  $currentStep = "fetch discovery descriptor"
  $descriptor = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/discovery/descriptor" -HeadersPath (Join-Path $tmpRoot "discovery-descriptor.headers.txt")
  Assert-Status $descriptor 200 "fetch discovery descriptor"
  Set-Content -Path (Join-Path $tmpRoot "discovery-descriptor.json") -Value $descriptor.Raw -NoNewline
  if ($descriptor.Json.descriptorVersion -ne 1) {
    throw "discovery descriptor version mismatch"
  }
  if (-not $descriptor.Json.serverId) {
    throw "discovery descriptor missing serverId"
  }
  if ($descriptor.Json.advertisedOrigin.baseUrl -ne $manualEndpoint) {
    throw "discovery descriptor did not switch to the preferred manual endpoint"
  }
  if ($descriptor.Json.advertisedOrigin.policyName -ne "manual-preferred") {
    throw "discovery descriptor did not report manual-preferred policy"
  }
  if (-not $descriptor.Json.capabilities.supportsBootstrapSessionCreate) {
    throw "discovery descriptor did not advertise bootstrap session create support"
  }
  if (-not $descriptor.Json.capabilities.supportsBootstrapSessionFetch) {
    throw "discovery descriptor did not advertise bootstrap session fetch support"
  }
  if (-not $descriptor.Json.capabilities.supportsLivePairingStatus) {
    throw "discovery descriptor did not advertise live pairing status support"
  }
  if (-not $descriptor.Json.capabilities.hasAdvertisedEndpoint) {
    throw "discovery descriptor did not advertise endpoint presence"
  }
  if ($descriptor.Raw -match "accessToken" -or $descriptor.Raw -match '"token"\s*:') {
    throw "discovery descriptor must not leak trust-bearing token material"
  }

  $currentStep = "fetch discovery client contract"
  $clientContract = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/discovery/client-contract" -HeadersPath (Join-Path $tmpRoot "discovery-client-contract.headers.txt")
  Assert-Status $clientContract 200 "fetch discovery client contract"
  Set-Content -Path (Join-Path $tmpRoot "discovery-client-contract.json") -Value $clientContract.Raw -NoNewline
  if ($clientContract.Json.contractVersion -ne 1) {
    throw "client discovery contract version mismatch"
  }
  if ($clientContract.Json.effectiveOrigin -ne $descriptor.Json.advertisedOrigin.baseUrl) {
    throw "client discovery contract effective origin drifted from descriptor"
  }
  if ($clientContract.Json.effectiveSource -ne "manual-endpoint") {
    throw "client discovery contract did not report manual-endpoint as the effective source"
  }
  if ($clientContract.Json.effectivePolicy -ne "manual-preferred") {
    throw "client discovery contract did not report manual-preferred policy"
  }
  if (-not $clientContract.Json.capabilities.supportsBootstrapSessionCreate) {
    throw "client discovery contract did not advertise bootstrap session create support"
  }
  if (-not $clientContract.Json.capabilities.supportsBootstrapSessionFetch) {
    throw "client discovery contract did not advertise bootstrap session fetch support"
  }
  if (-not $clientContract.Json.capabilities.supportsLivePairingStatus) {
    throw "client discovery contract did not advertise live pairing status support"
  }
  if ($clientContract.Json.candidates.Count -ne 3) {
    throw "client discovery contract did not expose the expected candidate set"
  }
  if ($clientContract.Json.candidates[0].baseUrl -ne $manualEndpoint) {
    throw "client discovery contract did not mark the manual endpoint as canonical"
  }
  if ($clientContract.Json.candidates[0].usageHint -ne "canonical") {
    throw "client discovery contract did not label the canonical candidate correctly"
  }
  if ($clientContract.Json.candidates[0].providers[0] -ne "manual-endpoint") {
    throw "client discovery contract did not preserve manual provider metadata on canonical candidate"
  }
  if ($clientContract.Json.candidates[0].providers[1] -ne "lan-publication") {
    throw "client discovery contract did not preserve lan-publication provider metadata on canonical candidate"
  }
  if ($clientContract.Json.candidates[1].usageHint -ne "fallback" -or $clientContract.Json.candidates[2].usageHint -ne "fallback") {
    throw "client discovery contract did not label fallback candidates correctly"
  }
  if ($clientContract.Raw -match "accessToken" -or $clientContract.Raw -match '"token"\s*:') {
    throw "client discovery contract must not leak trust-bearing token material"
  }

  $currentStep = "fetch discovery client guidance"
  $clientGuidance = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/discovery/client-guidance" -HeadersPath (Join-Path $tmpRoot "discovery-client-guidance.headers.txt")
  Assert-Status $clientGuidance 200 "fetch discovery client guidance"
  Set-Content -Path (Join-Path $tmpRoot "discovery-client-guidance.json") -Value $clientGuidance.Raw -NoNewline
  if ($clientGuidance.Json.guidanceVersion -ne 1) {
    throw "client discovery guidance version mismatch"
  }
  if ($clientGuidance.Json.contractVersion -ne $clientContract.Json.contractVersion) {
    throw "client discovery guidance drifted from client contract version"
  }
  if ($clientGuidance.Json.effectiveOrigin -ne $clientContract.Json.effectiveOrigin) {
    throw "client discovery guidance effective origin drifted from client contract"
  }
  if ($clientGuidance.Json.canonicalAttempt.origin -ne $clientContract.Json.effectiveOrigin) {
    throw "client discovery guidance canonical attempt drifted from effective origin"
  }
  if ($clientGuidance.Json.canonicalAttempt.source -ne $clientContract.Json.effectiveSource) {
    throw "client discovery guidance canonical attempt source drifted from effective source"
  }
  if ($clientGuidance.Json.canonicalAttempt.usageHint -ne "canonical") {
    throw "client discovery guidance did not label the canonical attempt correctly"
  }
  if (-not $clientGuidance.Json.canonicalAttempt.bootstrapEligible) {
    throw "client discovery guidance canonical attempt was not bootstrap-eligible"
  }
  if (-not $clientGuidance.Json.canonicalAttempt.livePairingEligible) {
    throw "client discovery guidance canonical attempt was not live-pairing-eligible"
  }
  if ($clientGuidance.Json.canonicalAttempt.informationalOnly) {
    throw "client discovery guidance canonical attempt must not be informational-only"
  }
  if (-not $clientGuidance.Json.candidatesAreNormalizedAndDeduped) {
    throw "client discovery guidance did not confirm normalized/deduped candidates"
  }
  if (-not $clientGuidance.Json.behavior.continueOnConnectionFailure) {
    throw "client discovery guidance should continue on connection failure when fallbacks exist"
  }
  if ($clientGuidance.Json.behavior.continueOnTlsMismatch) {
    throw "client discovery guidance must not continue on TLS mismatch"
  }
  if ($clientGuidance.Json.behavior.continueOnBootstrapRejection) {
    throw "client discovery guidance must not continue on bootstrap rejection"
  }
  if ($clientGuidance.Json.behavior.continueOnNotFoundOrExpired) {
    throw "client discovery guidance must not continue on not-found/expired by default"
  }
  if ($clientGuidance.Json.fallbackAttempts.Count -ne 2) {
    throw "client discovery guidance did not expose the expected ordered fallback attempts"
  }
  if ($clientGuidance.Json.fallbackAttempts[0].origin -ne "https://[::1]:$port") {
    throw "client discovery guidance did not preserve fallback attempt order"
  }
  if ($clientGuidance.Json.fallbackAttempts[1].origin -ne $advertisedEndpoint) {
    throw "client discovery guidance did not preserve advertised fallback attempt"
  }
  if ($clientGuidance.Raw -match "accessToken" -or $clientGuidance.Raw -match '"token"\s*:') {
    throw "client discovery guidance must not leak trust-bearing token material"
  }

  $currentStep = "fetch discovery provider status"
  $discoveryStatus = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/discovery/status" -HeadersPath (Join-Path $tmpRoot "discovery-status.headers.txt")
  Assert-Status $discoveryStatus 200 "fetch discovery provider status"
  Set-Content -Path (Join-Path $tmpRoot "discovery-status.json") -Value $discoveryStatus.Raw -NoNewline
  if ($discoveryStatus.Json.providerMode -ne "lan-publication") {
    throw "discovery provider mode did not report lan-publication"
  }
  if ($discoveryStatus.Json.lifecycle -ne "active") {
    throw "discovery provider did not reach active state"
  }
  if ($discoveryStatus.Json.publication.providerKind -ne "lan-publication") {
    throw "discovery provider did not report lan publication metadata"
  }
  $expectedServiceType = Normalize-MdnsServiceType "_epigraph-sync._tcp.local."
  $actualServiceType = Normalize-MdnsServiceType ([string]$discoveryStatus.Json.publication.serviceType)
  if ($actualServiceType -ne $expectedServiceType) {
    throw "discovery provider reported an unexpected service type: $($discoveryStatus.Json.publication.serviceType)"
  }
  if ($discoveryStatus.Json.publication.port -ne [int]$port) {
    throw "discovery provider reported an unexpected publication port"
  }
  if ($discoveryStatus.Json.effectiveOrigin.baseUrl -ne $manualEndpoint) {
    throw "discovery status did not report the manual endpoint as effective"
  }
  if ($discoveryStatus.Json.effectiveOrigin.source -ne "manual-endpoint") {
    throw "discovery status did not report manual-endpoint as the effective source"
  }
  if ($discoveryStatus.Json.effectiveOrigin.policy -ne "manual-preferred") {
    throw "discovery status did not report manual-preferred as the effective policy"
  }
  if ($discoveryStatus.Json.effectiveOrigin.candidates.Count -ne 3) {
    throw "discovery status did not dedupe effective candidates correctly"
  }
  if ($discoveryStatus.Json.publication.descriptor.advertisedOrigin.baseUrl -ne $descriptor.Json.advertisedOrigin.baseUrl) {
    throw "discovery provider publication drifted from descriptor advertised origin"
  }
  if ($discoveryStatus.Json.publication.txtRecords.advertisedBaseUrl -ne $descriptor.Json.advertisedOrigin.baseUrl) {
    throw "discovery provider TXT metadata drifted from descriptor advertised origin"
  }
  if (-not $discoveryStatus.Json.publication.txtRecords.supportsDescriptor) {
    throw "discovery provider TXT metadata did not advertise descriptor support"
  }
  if ($discoveryStatus.Json.manualProvider.providerMode -ne "enabled") {
    throw "manual discovery provider mode did not report enabled"
  }
  if ($discoveryStatus.Json.manualProvider.lifecycle -ne "active") {
    throw "manual discovery provider did not reach active state"
  }
  if ($discoveryStatus.Json.manualProvider.publication.providerKind -ne "manual-endpoint") {
    throw "manual discovery provider did not report manual endpoint metadata"
  }
  if ($discoveryStatus.Json.manualProvider.publication.origins[0].baseUrl -ne $manualEndpoint) {
    throw "manual discovery provider did not normalize localhost origin"
  }
  if ($discoveryStatus.Json.manualProvider.publication.origins[1].baseUrl -ne $manualEndpoint) {
    throw "manual discovery provider did not preserve duplicate normalized localhost origin"
  }
  if ($discoveryStatus.Json.manualProvider.publication.origins[2].baseUrl -ne "https://[::1]:$port") {
    throw "manual discovery provider did not preserve IPv6 literal origin"
  }
  if ($discoveryStatus.Raw -match "accessToken" -or $discoveryStatus.Raw -match '"token"\s*:') {
    throw "discovery provider status must not leak trust-bearing token material"
  }

  $currentStep = "create bootstrap session"
  $bootstrapCreated = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/bootstrap/session" -HeadersPath (Join-Path $tmpRoot "bootstrap-created.headers.txt") -Body @{
    profileId = "main"
  }
  Assert-Status $bootstrapCreated 200 "create bootstrap session"
  Assert-NoStoreHeaders $bootstrapCreated "create bootstrap session"
  Set-Content -Path (Join-Path $tmpRoot "bootstrap-created.json") -Value $bootstrapCreated.Raw -NoNewline
  if ($bootstrapCreated.Json.syncdBaseUrl -ne $descriptor.Json.advertisedOrigin.baseUrl) {
    throw "bootstrap payload syncdBaseUrl does not match discovery descriptor advertised origin"
  }
  if ($bootstrapCreated.Json.syncdBaseUrl -ne $clientContract.Json.effectiveOrigin) {
    throw "bootstrap payload syncdBaseUrl does not match the client discovery contract effective origin"
  }
  if ($bootstrapCreated.Json.syncdBaseUrl -ne $clientGuidance.Json.canonicalAttempt.origin) {
    throw "bootstrap payload syncdBaseUrl does not match the client discovery guidance canonical attempt"
  }
  if ($bootstrapCreated.Json.claimUrl -ne "$manualEndpoint/v1/pairing/claim") {
    throw "bootstrap payload claimUrl does not match the effective discovery origin"
  }
  if ($bootstrapCreated.Raw -match "accessToken" -or $bootstrapCreated.Raw -match '"token"\s*:') {
    throw "bootstrap payload must not contain final token material"
  }

  $currentStep = "fetch bootstrap session"
  $bootstrapFetched = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/bootstrap/session/$($bootstrapCreated.Json.pairingSessionId)" -HeadersPath (Join-Path $tmpRoot "bootstrap-fetched.headers.txt")
  Assert-Status $bootstrapFetched 200 "fetch bootstrap session"
  Assert-NoStoreHeaders $bootstrapFetched "fetch bootstrap session"
  Set-Content -Path (Join-Path $tmpRoot "bootstrap-fetched.json") -Value $bootstrapFetched.Raw -NoNewline
  if ($bootstrapFetched.Json.syncdBaseUrl -ne $descriptor.Json.advertisedOrigin.baseUrl) {
    throw "fetched bootstrap payload drifted from discovery descriptor advertised origin"
  }

  $currentStep = "restart with invalid manual provider config"
  Stop-ManagedProcess $syncd
  $syncd = $null
  $invalidEnvMap = @{
    EPIGRAPH_SYNCD_ENABLE_AUDIT_ROUTES = "1"
    EPIGRAPH_SYNCD_DATA_DIR = $invalidDataDir
    EPIGRAPH_SYNCD_BIND_HOST = "127.0.0.1"
    EPIGRAPH_SYNCD_PORT = $invalidPort
    EPIGRAPH_SYNCD_ADVERTISED_BASE_URL = $invalidAdvertisedEndpoint
    EPIGRAPH_SYNCD_DISCOVERY_MDNS_PORT = "5462"
    EPIGRAPH_SYNCD_EFFECTIVE_DISCOVERY_POLICY = "manual-preferred"
    EPIGRAPH_SYNCD_MANUAL_PROVIDER = "enabled"
    EPIGRAPH_SYNCD_MANUAL_ORIGINS = "http://localhost:$invalidPort"
    EPIGRAPH_LOCAL_SERVER_MAIN_ROOT = Join-Path $tmpRoot "suwayomi-invalid-main"
    EPIGRAPH_LOCAL_SERVER_TEST_ROOT = Join-Path $tmpRoot "suwayomi-invalid-test"
  }
  $syncd = Start-ManagedProcess `
    -FilePath $syncdBinary `
    -WorkingDirectory $projectRoot `
    -StdoutPath $invalidStdoutPath `
    -StderrPath $invalidStderrPath `
    -Environment $invalidEnvMap
  Wait-ForHealthy -Endpoint $invalidEndpoint -TimeoutSeconds 30

  $currentStep = "fetch invalid manual client contract"
  $invalidClientContract = Invoke-JsonRequest -Method Get -Uri "$invalidEndpoint/v1/discovery/client-contract" -HeadersPath (Join-Path $tmpRoot "discovery-client-contract-invalid-manual.headers.txt")
  Assert-Status $invalidClientContract 200 "fetch invalid manual client discovery contract"
  Set-Content -Path (Join-Path $tmpRoot "discovery-client-contract-invalid-manual.json") -Value $invalidClientContract.Raw -NoNewline
  if ($invalidClientContract.Json.effectiveOrigin -ne $invalidAdvertisedEndpoint) {
    throw "client discovery contract did not fall back to advertised origin when manual provider failed"
  }
  if ($invalidClientContract.Json.effectiveSource -ne "advertised-endpoint") {
    throw "client discovery contract did not report advertised-endpoint as fallback source"
  }
  if ($invalidClientContract.Json.candidates.Count -ne 1) {
    throw "client discovery contract did not collapse to a single canonical candidate after manual failure"
  }
  if ($invalidClientContract.Json.candidates[0].usageHint -ne "canonical") {
    throw "client discovery contract did not preserve canonical hint after manual failure"
  }

  $currentStep = "fetch invalid manual client guidance"
  $invalidClientGuidance = Invoke-JsonRequest -Method Get -Uri "$invalidEndpoint/v1/discovery/client-guidance" -HeadersPath (Join-Path $tmpRoot "discovery-client-guidance-invalid-manual.headers.txt")
  Assert-Status $invalidClientGuidance 200 "fetch invalid manual client discovery guidance"
  Set-Content -Path (Join-Path $tmpRoot "discovery-client-guidance-invalid-manual.json") -Value $invalidClientGuidance.Raw -NoNewline
  if ($invalidClientGuidance.Json.effectiveOrigin -ne $invalidAdvertisedEndpoint) {
    throw "client discovery guidance did not fall back to advertised origin when manual provider failed"
  }
  if ($invalidClientGuidance.Json.canonicalAttempt.origin -ne $invalidAdvertisedEndpoint) {
    throw "client discovery guidance canonical attempt did not fall back to advertised origin"
  }
  if ($invalidClientGuidance.Json.fallbackAttempts.Count -ne 0) {
    throw "client discovery guidance should not expose fallback attempts after manual provider failure collapsed candidates"
  }
  if ($invalidClientGuidance.Json.behavior.continueOnConnectionFailure) {
    throw "client discovery guidance must not continue on connection failure when no fallback attempts exist"
  }

  $currentStep = "fetch invalid manual provider status"
  $invalidStatus = Invoke-JsonRequest -Method Get -Uri "$invalidEndpoint/v1/discovery/status" -HeadersPath (Join-Path $tmpRoot "discovery-status-invalid-manual.headers.txt")
  Assert-Status $invalidStatus 200 "fetch invalid manual discovery provider status"
  Set-Content -Path (Join-Path $tmpRoot "discovery-status-invalid-manual.json") -Value $invalidStatus.Raw -NoNewline
  if ($invalidStatus.Json.lifecycle -ne "active") {
    throw "lan publication should remain active when manual provider config is bad"
  }
  if ($invalidStatus.Json.manualProvider.providerMode -ne "enabled") {
    throw "manual discovery provider mode should still report enabled on bad config"
  }
  if ($invalidStatus.Json.manualProvider.lifecycle -ne "failed") {
    throw "manual discovery provider did not report failed state for bad config"
  }
  if ($invalidStatus.Json.manualProvider.failure.code -ne "MANUAL_DISCOVERY_PROVIDER_START_FAILED") {
    throw "manual discovery provider reported unexpected failure code"
  }
  if ($invalidStatus.Json.effectiveOrigin.baseUrl -ne $invalidAdvertisedEndpoint) {
    throw "effective discovery origin did not fall back to advertised origin when manual provider failed"
  }
  if ($invalidStatus.Json.effectiveOrigin.source -ne "advertised-endpoint") {
    throw "effective discovery source did not fall back to advertised-endpoint when manual provider failed"
  }

  $currentStep = "create bootstrap session with invalid manual config"
  $invalidBootstrapCreated = Invoke-JsonRequest -Method Post -Uri "$invalidEndpoint/v1/bootstrap/session" -HeadersPath (Join-Path $tmpRoot "bootstrap-created-invalid-manual.headers.txt") -Body @{
    profileId = "main"
  }
  Assert-Status $invalidBootstrapCreated 200 "create bootstrap session with invalid manual provider"
  Assert-NoStoreHeaders $invalidBootstrapCreated "create bootstrap session with invalid manual provider"
  Set-Content -Path (Join-Path $tmpRoot "bootstrap-created-invalid-manual.json") -Value $invalidBootstrapCreated.Raw -NoNewline
  if ($invalidBootstrapCreated.Json.syncdBaseUrl -ne $invalidAdvertisedEndpoint) {
    throw "bootstrap payload drifted when manual provider config failed"
  }
  if ($invalidBootstrapCreated.Json.syncdBaseUrl -ne $invalidClientContract.Json.effectiveOrigin) {
    throw "bootstrap payload did not match client discovery contract after manual provider failure"
  }
  if ($invalidBootstrapCreated.Json.syncdBaseUrl -ne $invalidClientGuidance.Json.canonicalAttempt.origin) {
    throw "bootstrap payload did not match client discovery guidance after manual provider failure"
  }

  Write-Host "Discovery phase-gate completed successfully."
  Write-Host "Endpoint: $endpoint"
}
catch {
  Write-Host "[discovery-gate] failed during: $currentStep"
  Write-Host "[discovery-gate] exception: $($_.Exception.Message)"
  if ($_.ScriptStackTrace) {
    Write-Host $_.ScriptStackTrace
  }
  throw
}
finally {
  Stop-ManagedProcess $syncd
  Pop-Location
}
