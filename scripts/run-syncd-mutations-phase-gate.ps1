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
      if ($response.StatusCode -eq 200) {
        return
      }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for syncd health at $Endpoint"
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

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tmpRoot = Join-Path $projectRoot "tmp\syncd-mutations-phase-gate"
$dataDir = Join-Path $tmpRoot "data"
$stdoutPath = Join-Path $tmpRoot "syncd.stdout.log"
$stderrPath = Join-Path $tmpRoot "syncd.stderr.log"
$port = "47772"
$endpoint = "https://127.0.0.1:$port"
$syncdBinary = Join-Path $projectRoot "src-tauri\target\debug\epigraph-syncd.exe"
$syncd = $null

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
if (Test-Path $stdoutPath) { Remove-Item $stdoutPath -Force }
if (Test-Path $stderrPath) { Remove-Item $stderrPath -Force }

$auditHeaders = @{
  "X-Epigraph-Client-Version" = "0.1.0"
  "X-Epigraph-Client-Protocol-Version" = "1"
}

Push-Location $projectRoot
try {
  Write-Host "[mutations-gate] building syncd"
  cargo build --manifest-path src-tauri/Cargo.toml --bin epigraph-syncd

  $envMap = @{
    EPIGRAPH_SYNCD_ENABLE_AUDIT_ROUTES = "1"
    EPIGRAPH_SYNCD_DATA_DIR = $dataDir
    EPIGRAPH_SYNCD_BIND_HOST = "127.0.0.1"
    EPIGRAPH_SYNCD_PORT = $port
    EPIGRAPH_LOCAL_SERVER_MAIN_ROOT = Join-Path $tmpRoot "suwayomi-main"
    EPIGRAPH_LOCAL_SERVER_TEST_ROOT = Join-Path $tmpRoot "suwayomi-test"
  }
  $previous = @{}
  foreach ($key in $envMap.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, $envMap[$key], "Process")
  }

  try {
    Write-Host "[mutations-gate] starting syncd"
    $syncd = Start-Process $syncdBinary `
      -WorkingDirectory $projectRoot `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru
  }
  finally {
    foreach ($key in $envMap.Keys) {
      [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
    }
  }

  Wait-ForHealthy -Endpoint $endpoint -TimeoutSeconds 30
  Write-Host "[mutations-gate] syncd healthy at $endpoint"

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

  $bookAccepted = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/mutations" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  } -Body @{
    requestId = "runtime-book-progress-1"
    mutations = @(@{
      entityType = "book.progress"
      clientMutationId = "book-progress-1"
      scopeId = "books:global"
      entityId = "book-1"
      lamport = 1
      patch = @{
        renderer = "pdf"
        progressPercent = 0.4
        lastReadAtMs = 1000
        pageIndex = 12
        totalPages = 100
        sectionLabel = "Chapter 1"
      }
    })
  }
  Assert-Status $bookAccepted 200 "accepted book.progress"
  if ($bookAccepted.Json.results[0].status -ne "applied" -or $bookAccepted.Json.results[0].record.pageIndex -ne 12) {
    throw "accepted book.progress did not persist the expected canonical record"
  }
  $bookVersion = [int64]$bookAccepted.Json.results[0].appliedServerVersion

  $bookRegress = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/mutations" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  } -Body @{
    requestId = "runtime-book-progress-2"
    mutations = @(@{
      entityType = "book.progress"
      clientMutationId = "book-progress-2"
      scopeId = "books:global"
      entityId = "book-1"
      lamport = 99
      patch = @{
        renderer = "pdf"
        progressPercent = 0.1
        lastReadAtMs = 2000
        pageIndex = 5
      }
    })
  }
  Assert-Status $bookRegress 200 "non-regressing book.progress"
  if ($bookRegress.Json.results[0].record.pageIndex -ne 12) {
    throw "book.progress regressed pageIndex"
  }

  $novelAccepted = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/mutations" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  } -Body @{
    requestId = "runtime-novel-progress-1"
    mutations = @(@{
      entityType = "novel.progress"
      clientMutationId = "novel-progress-1"
      scopeId = "novels:profile:main"
      entityId = "novel-1"
      lamport = 2
      patch = @{
        chapterId = "c10"
        chapterTitle = "Ten"
        chapterOrderKey = 10
        progressPercent = 0.2
        locator = "/10#p2"
        locatorSortKey = 2
        updatedAtMs = 1500
      }
    })
  }
  Assert-Status $novelAccepted 200 "accepted novel.progress"
  if ([double]$novelAccepted.Json.results[0].record.chapterOrderKey -ne 10.0) {
    throw "accepted novel.progress did not persist the expected chapter order"
  }

  $novelRegress = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/mutations" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  } -Body @{
    requestId = "runtime-novel-progress-2"
    mutations = @(@{
      entityType = "novel.progress"
      clientMutationId = "novel-progress-2"
      scopeId = "novels:profile:main"
      entityId = "novel-1"
      lamport = 100
      patch = @{
        chapterId = "c9"
        chapterTitle = "Nine"
        chapterOrderKey = 9
        progressPercent = 0.9
        locator = "/9#p9"
        locatorSortKey = 9
        updatedAtMs = 2500
      }
    })
  }
  Assert-Status $novelRegress 200 "non-regressing novel.progress"
  if ([double]$novelRegress.Json.results[0].record.chapterOrderKey -ne 10.0) {
    throw "novel.progress regressed chapterOrderKey"
  }

  $invalidScope = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/mutations" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  } -Body @{
    requestId = "runtime-invalid-scope"
    mutations = @(@{
      entityType = "book.progress"
      clientMutationId = "invalid-scope-1"
      scopeId = "novels:profile:main"
      entityId = "book-bad"
      lamport = 1
      patch = @{
        renderer = "pdf"
        progressPercent = 0.1
        lastReadAtMs = 100
        pageIndex = 1
      }
    })
  }
  Assert-Status $invalidScope 200 "invalid scope rejection"
  if ($invalidScope.Json.results[0].status -ne "rejected" -or $invalidScope.Json.results[0].error.code -ne "INVALID_SCOPE_FOR_ENTITY") {
    throw "invalid scope rejection did not return the expected structured error"
  }

  $liveOutput = Join-Path $tmpRoot "events-live.log"
  if (Test-Path $liveOutput) { Remove-Item $liveOutput -Force }
  $liveCapture = Start-Process node -ArgumentList @(
    (Join-Path $projectRoot "scripts\capture-syncd-sse.mjs"),
    "--endpoint", $endpoint,
    "--token", "main-token",
    "--scopeId", "books:global",
    "--outputPath", $liveOutput,
    "--maxEvents", "2",
    "--timeoutSeconds", "10"
  ) -WorkingDirectory $projectRoot -PassThru

  Start-Sleep -Milliseconds 500
  $liveMutation = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/mutations" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  } -Body @{
    requestId = "runtime-book-progress-live"
    mutations = @(@{
      entityType = "book.progress"
      clientMutationId = "book-progress-live"
      scopeId = "books:global"
      entityId = "book-live"
      lamport = 10
      patch = @{
        renderer = "pdf"
        progressPercent = 0.7
        lastReadAtMs = 3000
        pageIndex = 30
      }
    })
  }
  Assert-Status $liveMutation 200 "live SSE book.progress"
  Wait-ForText -Path $liveOutput -Needle '"entityId":"book-live"' -TimeoutSeconds 10
  if (-not $liveCapture.HasExited) { Stop-EpigraphRetainedProcess -Process $liveCapture }

  $replayOutput = Join-Path $tmpRoot "events-replay-progress.log"
  if (Test-Path $replayOutput) { Remove-Item $replayOutput -Force }
  $replayCapture = Start-Process node -ArgumentList @(
    (Join-Path $projectRoot "scripts\capture-syncd-sse.mjs"),
    "--endpoint", $endpoint,
    "--token", "main-token",
    "--scopeId", "books:global",
    "--outputPath", $replayOutput,
    "--lastEventId", "$bookVersion",
    "--maxEvents", "1",
    "--timeoutSeconds", "10"
  ) -WorkingDirectory $projectRoot -PassThru
  Wait-ForText -Path $replayOutput -Needle '"entityId":"book-live"' -TimeoutSeconds 10
  if (-not $replayCapture.HasExited) { Stop-EpigraphRetainedProcess -Process $replayCapture }

  $bookBookmark = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/mutations" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  } -Body @{
    requestId = "runtime-book-bookmark-1"
    mutations = @(@{
      entityType = "book.bookmark"
      clientMutationId = "book-bookmark-1"
      scopeId = "books:global"
      entityId = "bookmark-1"
      lamport = 11
      patch = @{
        bookId = "book-1"
        pageIndex = 12
        progressPercent = 0.4
        label = "Bookmark"
        savedAtMs = 4000
      }
    })
  }
  Assert-Status $bookBookmark 200 "accepted book.bookmark"
  if ($bookBookmark.Json.results[0].status -ne "applied") {
    throw "book.bookmark was not applied"
  }
  $bookmarkVersion = [int64]$bookBookmark.Json.results[0].appliedServerVersion

  $bookBookmarkDelete = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/mutations" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  } -Body @{
    requestId = "runtime-book-bookmark-delete"
    mutations = @(@{
      entityType = "book.bookmark"
      clientMutationId = "book-bookmark-delete"
      scopeId = "books:global"
      entityId = "bookmark-1"
      op = "delete"
      lamport = 20
    })
  }
  Assert-Status $bookBookmarkDelete 200 "accepted book.bookmark delete"
  if ($bookBookmarkDelete.Json.results[0].status -ne "applied" -or $bookBookmarkDelete.Json.results[0].op -ne "delete") {
    throw "book.bookmark delete was not applied as delete"
  }
  $bookmarkDeleteVersion = [int64]$bookBookmarkDelete.Json.results[0].appliedServerVersion

  $staleBookmarkMerge = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/mutations" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  } -Body @{
    requestId = "runtime-book-bookmark-stale-merge"
    mutations = @(@{
      entityType = "book.bookmark"
      clientMutationId = "book-bookmark-stale-merge"
      scopeId = "books:global"
      entityId = "bookmark-1"
      lamport = 15
      patch = @{
        bookId = "book-1"
        pageIndex = 4
        progressPercent = 0.2
        label = "Too old"
        savedAtMs = 4100
      }
    })
  }
  Assert-Status $staleBookmarkMerge 200 "stale book.bookmark merge rejection"
  if ($staleBookmarkMerge.Json.results[0].status -ne "rejected" -or $staleBookmarkMerge.Json.results[0].error.code -ne "STALE_BOOKMARK_MUTATION") {
    throw "stale book.bookmark merge did not return the expected rejection"
  }

  $bookBookmarkResurrection = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/mutations" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  } -Body @{
    requestId = "runtime-book-bookmark-resurrection"
    mutations = @(@{
      entityType = "book.bookmark"
      clientMutationId = "book-bookmark-resurrection"
      scopeId = "books:global"
      entityId = "bookmark-1"
      lamport = 21
      patch = @{
        bookId = "book-1"
        location = "/epub/chapter-4.xhtml#frag"
        pageIndex = 14
        progressPercent = 0.6
        label = "Restored"
        savedAtMs = 5000
      }
    })
  }
  Assert-Status $bookBookmarkResurrection 200 "accepted book.bookmark resurrection"
  if ($bookBookmarkResurrection.Json.results[0].status -ne "applied" -or $bookBookmarkResurrection.Json.results[0].record.label -ne "Restored") {
    throw "book.bookmark resurrection did not persist the expected canonical record"
  }
  $bookBookmarkResurrectionVersion = [int64]$bookBookmarkResurrection.Json.results[0].appliedServerVersion

  $bookChangesSequence = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?scopeId=books%3Aglobal&sinceVersion=$($bookmarkVersion - 1)" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  }
  Assert-Status $bookChangesSequence 200 "book bookmark resurrection change sequence"
  $bookChangesSequencePath = Join-Path $tmpRoot "changes-bookmark-book-sequence.json"
  Set-Content -Path $bookChangesSequencePath -Value $bookChangesSequence.Raw -NoNewline
  $bookChanges = @($bookChangesSequence.Json.changes)
  if ($bookChanges.Count -ne 3) {
    throw "book bookmark resurrection should produce create/delete/resurrect sequence"
  }
  if ($bookChanges[0].op -ne "merge" -or $bookChanges[1].op -ne "delete" -or $bookChanges[2].op -ne "merge") {
    throw "book bookmark change sequence did not preserve merge/delete/merge ordering"
  }
  if ($bookChanges[2].patch.label -ne "Restored" -or $bookChanges[2].patch.location -ne "/epub/chapter-4.xhtml#frag") {
    throw "book bookmark resurrection final change did not contain the expected canonical patch"
  }

  $bookChangesPostDelete = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?scopeId=books%3Aglobal&sinceVersion=$bookmarkDeleteVersion" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  }
  Assert-Status $bookChangesPostDelete 200 "book bookmark post-delete resurrection state"
  $bookChangesPostDeletePath = Join-Path $tmpRoot "changes-bookmark-book-post-delete.json"
  Set-Content -Path $bookChangesPostDeletePath -Value $bookChangesPostDelete.Raw -NoNewline
  if (@($bookChangesPostDelete.Json.changes).Count -ne 1 -or $bookChangesPostDelete.Json.changes[0].patch.label -ne "Restored") {
    throw "book bookmark post-delete change feed did not converge to the resurrected truth"
  }

  $bookReplayResurrectionOutput = Join-Path $tmpRoot "events-replay-bookmark-resurrection-book.log"
  if (Test-Path $bookReplayResurrectionOutput) { Remove-Item $bookReplayResurrectionOutput -Force }
  $bookReplayResurrectionCapture = Start-Process node -ArgumentList @(
    (Join-Path $projectRoot "scripts\capture-syncd-sse.mjs"),
    "--endpoint", $endpoint,
    "--token", "main-token",
    "--scopeId", "books:global",
    "--outputPath", $bookReplayResurrectionOutput,
    "--lastEventId", "$($bookmarkVersion - 1)",
    "--maxEvents", "3",
    "--timeoutSeconds", "10"
  ) -WorkingDirectory $projectRoot -PassThru
  Wait-ForText -Path $bookReplayResurrectionOutput -Needle '"op":"delete"' -TimeoutSeconds 10
  Wait-ForText -Path $bookReplayResurrectionOutput -Needle '"label":"Restored"' -TimeoutSeconds 10
  if (-not $bookReplayResurrectionCapture.HasExited) { Stop-EpigraphRetainedProcess -Process $bookReplayResurrectionCapture }
  $bookReplayText = Get-Content $bookReplayResurrectionOutput -Raw
  if (([regex]::Matches($bookReplayText, '"entityId":"bookmark-1"')).Count -lt 3) {
    throw "book bookmark replay did not emit the expected create/delete/resurrect sequence"
  }

  $wrongScopeResurrection = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/mutations" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  } -Body @{
    requestId = "runtime-book-bookmark-wrong-scope-resurrection"
    mutations = @(@{
      entityType = "book.bookmark"
      clientMutationId = "book-bookmark-wrong-scope-resurrection"
      scopeId = "novels:profile:main"
      entityId = "bookmark-1"
      lamport = 30
      patch = @{
        bookId = "book-1"
        pageIndex = 30
        progressPercent = 0.9
        savedAtMs = 5200
      }
    })
  }
  Assert-Status $wrongScopeResurrection 200 "wrong-scope resurrection rejection"
  if ($wrongScopeResurrection.Json.results[0].status -ne "rejected" -or $wrongScopeResurrection.Json.results[0].error.code -ne "INVALID_SCOPE_FOR_ENTITY") {
    throw "wrong-scope resurrection did not return the expected structured rejection"
  }

  $bookLeakCheck = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?scopeId=novels%3Aprofile%3Amain&sinceVersion=$($bookmarkVersion - 1)" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  }
  Assert-Status $bookLeakCheck 200 "book bookmark cross-scope leak check"
  $bookLeakCheckPath = Join-Path $tmpRoot "changes-cross-scope-book-into-novels.json"
  Set-Content -Path $bookLeakCheckPath -Value $bookLeakCheck.Raw -NoNewline
  if (@($bookLeakCheck.Json.changes).Count -ne 0) {
    throw "book bookmark changes leaked into novels scope"
  }

  $novelBookmark = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/mutations" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  } -Body @{
    requestId = "runtime-novel-bookmark-1"
    mutations = @(@{
      entityType = "novel.bookmark"
      clientMutationId = "novel-bookmark-1"
      scopeId = "novels:profile:main"
      entityId = "novel-bookmark-1"
      lamport = 12
      patch = @{
        novelId = "novel-1"
        chapterId = "c10"
        chapterTitle = "Ten"
        chapterOrderKey = 10
        locator = "/10#p2"
        locatorSortKey = 2
        label = "Checkpoint"
        savedAtMs = 4500
      }
    })
  }
  Assert-Status $novelBookmark 200 "accepted novel.bookmark"
  if ($novelBookmark.Json.results[0].status -ne "applied") {
    throw "novel.bookmark was not applied"
  }
  $novelBookmarkVersion = [int64]$novelBookmark.Json.results[0].appliedServerVersion

  $novelBookmarkDelete = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/mutations" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  } -Body @{
    requestId = "runtime-novel-bookmark-delete"
    mutations = @(@{
      entityType = "novel.bookmark"
      clientMutationId = "novel-bookmark-delete"
      scopeId = "novels:profile:main"
      entityId = "novel-bookmark-1"
      op = "delete"
      lamport = 21
    })
  }
  Assert-Status $novelBookmarkDelete 200 "accepted novel.bookmark delete"
  if ($novelBookmarkDelete.Json.results[0].status -ne "applied" -or $novelBookmarkDelete.Json.results[0].op -ne "delete") {
    throw "novel.bookmark delete was not applied as delete"
  }
  $novelBookmarkDeleteVersion = [int64]$novelBookmarkDelete.Json.results[0].appliedServerVersion

  $novelBookmarkResurrection = Invoke-JsonRequest -Method Post -Uri "$endpoint/v1/mutations" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  } -Body @{
    requestId = "runtime-novel-bookmark-resurrection"
    mutations = @(@{
      entityType = "novel.bookmark"
      clientMutationId = "novel-bookmark-resurrection"
      scopeId = "novels:profile:main"
      entityId = "novel-bookmark-1"
      lamport = 22
      patch = @{
        novelId = "novel-1"
        chapterId = "c11"
        chapterTitle = "Eleven"
        chapterOrderKey = 11
        locator = "/11#p5"
        locatorSortKey = 5
        label = "Restored"
        savedAtMs = 5200
      }
    })
  }
  Assert-Status $novelBookmarkResurrection 200 "accepted novel.bookmark resurrection"
  if ($novelBookmarkResurrection.Json.results[0].status -ne "applied" -or $novelBookmarkResurrection.Json.results[0].record.chapterId -ne "c11") {
    throw "novel.bookmark resurrection did not persist the expected canonical record"
  }
  $novelBookmarkResurrectionVersion = [int64]$novelBookmarkResurrection.Json.results[0].appliedServerVersion

  $bookmarkReplayOutput = Join-Path $tmpRoot "events-replay-bookmark.log"
  if (Test-Path $bookmarkReplayOutput) { Remove-Item $bookmarkReplayOutput -Force }
  $bookmarkReplayCapture = Start-Process node -ArgumentList @(
    (Join-Path $projectRoot "scripts\capture-syncd-sse.mjs"),
    "--endpoint", $endpoint,
    "--token", "main-token",
    "--scopeId", "books:global",
    "--outputPath", $bookmarkReplayOutput,
    "--lastEventId", "$($bookmarkDeleteVersion - 1)",
    "--maxEvents", "1",
    "--timeoutSeconds", "10"
  ) -WorkingDirectory $projectRoot -PassThru
  Wait-ForText -Path $bookmarkReplayOutput -Needle '"op":"delete"' -TimeoutSeconds 10
  if (-not $bookmarkReplayCapture.HasExited) { Stop-EpigraphRetainedProcess -Process $bookmarkReplayCapture }

  $novelChangesSequence = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?scopeId=novels%3Aprofile%3Amain&sinceVersion=$($novelBookmarkVersion - 1)" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  }
  Assert-Status $novelChangesSequence 200 "novel bookmark resurrection change sequence"
  $novelChangesSequencePath = Join-Path $tmpRoot "changes-bookmark-novel-sequence.json"
  Set-Content -Path $novelChangesSequencePath -Value $novelChangesSequence.Raw -NoNewline
  $novelChanges = @($novelChangesSequence.Json.changes)
  if ($novelChanges.Count -ne 3) {
    throw "novel bookmark resurrection should produce create/delete/resurrect sequence"
  }
  if ($novelChanges[0].op -ne "merge" -or $novelChanges[1].op -ne "delete" -or $novelChanges[2].op -ne "merge") {
    throw "novel bookmark change sequence did not preserve merge/delete/merge ordering"
  }
  if ($novelChanges[2].patch.chapterId -ne "c11" -or $novelChanges[2].patch.label -ne "Restored") {
    throw "novel bookmark resurrection final change did not contain the expected canonical patch"
  }

  $novelChangesPostDelete = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?scopeId=novels%3Aprofile%3Amain&sinceVersion=$novelBookmarkDeleteVersion" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  }
  Assert-Status $novelChangesPostDelete 200 "novel bookmark post-delete resurrection state"
  $novelChangesPostDeletePath = Join-Path $tmpRoot "changes-bookmark-novel-post-delete.json"
  Set-Content -Path $novelChangesPostDeletePath -Value $novelChangesPostDelete.Raw -NoNewline
  if (@($novelChangesPostDelete.Json.changes).Count -ne 1 -or $novelChangesPostDelete.Json.changes[0].patch.chapterId -ne "c11") {
    throw "novel bookmark post-delete change feed did not converge to the resurrected truth"
  }

  $novelReplayResurrectionOutput = Join-Path $tmpRoot "events-replay-bookmark-resurrection-novel.log"
  if (Test-Path $novelReplayResurrectionOutput) { Remove-Item $novelReplayResurrectionOutput -Force }
  $novelReplayResurrectionCapture = Start-Process node -ArgumentList @(
    (Join-Path $projectRoot "scripts\capture-syncd-sse.mjs"),
    "--endpoint", $endpoint,
    "--token", "main-token",
    "--scopeId", "novels:profile:main",
    "--outputPath", $novelReplayResurrectionOutput,
    "--lastEventId", "$($novelBookmarkVersion - 1)",
    "--maxEvents", "3",
    "--timeoutSeconds", "10"
  ) -WorkingDirectory $projectRoot -PassThru
  Wait-ForText -Path $novelReplayResurrectionOutput -Needle '"op":"delete"' -TimeoutSeconds 10
  Wait-ForText -Path $novelReplayResurrectionOutput -Needle '"chapterId":"c11"' -TimeoutSeconds 10
  if (-not $novelReplayResurrectionCapture.HasExited) { Stop-EpigraphRetainedProcess -Process $novelReplayResurrectionCapture }
  $novelReplayText = Get-Content $novelReplayResurrectionOutput -Raw
  if (([regex]::Matches($novelReplayText, '"entityId":"novel-bookmark-1"')).Count -lt 3) {
    throw "novel bookmark replay did not emit the expected create/delete/resurrect sequence"
  }

  $novelLeakCheck = Invoke-JsonRequest -Method Get -Uri "$endpoint/v1/changes?scopeId=books%3Aglobal&sinceVersion=$($novelBookmarkVersion - 1)" -Headers @{
    "Authorization" = "Bearer main-token"
    "X-Epigraph-Client-Version" = "0.1.0"
    "X-Epigraph-Client-Protocol-Version" = "1"
  }
  Assert-Status $novelLeakCheck 200 "novel bookmark cross-scope leak check"
  $novelLeakCheckPath = Join-Path $tmpRoot "changes-cross-scope-novel-into-books.json"
  Set-Content -Path $novelLeakCheckPath -Value $novelLeakCheck.Raw -NoNewline
  if (@($novelLeakCheck.Json.changes).Count -ne 0) {
    throw "novel bookmark changes leaked into books:global"
  }

  if ($bookBookmarkResurrection.Json.results[0].record.label -ne $bookChanges[2].patch.label) {
    throw "book bookmark live mutation result and change feed final truth diverged"
  }
  if ($novelBookmarkResurrection.Json.results[0].record.chapterId -ne $novelChanges[2].patch.chapterId) {
    throw "novel bookmark live mutation result and change feed final truth diverged"
  }

  Write-Host "Mutations phase-gate completed successfully."
  Write-Host "Endpoint: $endpoint"
}
catch {
  Write-Error $_
  throw
}
finally {
  Stop-SyncdProcessTree $syncd
  Pop-Location
}
