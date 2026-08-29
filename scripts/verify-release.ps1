$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$appPath = Join-Path $projectRoot "src-tauri\target\release\epigraph.exe"
$runId = "epigraph-release-verify-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))-$PID"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) $runId
$initialFingerprint = $null
$results = [System.Collections.Generic.List[object]]::new()

function Get-WorktreeFingerprint([string]$Label) {
  $trackedPatch = Join-Path $tempRoot "$Label-tracked.patch"
  $untrackedManifest = Join-Path $tempRoot "$Label-untracked.txt"
  & git diff --binary HEAD "--output=$trackedPatch" --
  if ($LASTEXITCODE -ne 0) { throw "Could not snapshot tracked worktree content" }

  $entries = [System.Collections.Generic.List[string]]::new()
  $untrackedPaths = @(& git ls-files --others --exclude-standard)
  if ($LASTEXITCODE -ne 0) { throw "Could not enumerate untracked worktree content" }
  foreach ($relativePath in $untrackedPaths) {
    $absolutePath = Join-Path $projectRoot $relativePath
    if (Test-Path -LiteralPath $absolutePath -PathType Leaf) {
      $hash = Get-Sha256 $absolutePath
      $entries.Add("$relativePath`t$hash")
    }
  }
  [System.IO.File]::WriteAllLines($untrackedManifest, $entries, [System.Text.Encoding]::UTF8)
  $trackedHash = Get-Sha256 $trackedPatch
  $untrackedHash = Get-Sha256 $untrackedManifest
  return "$trackedHash`:$untrackedHash"
}

function Get-Sha256([string]$Path) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $algorithm.Dispose()
  }
}

function Test-GitWhitespace {
  & git diff --check
  if ($LASTEXITCODE -ne 0) { throw "Unstaged whitespace check failed" }
  & git diff --cached --check
  if ($LASTEXITCODE -ne 0) { throw "Staged whitespace check failed" }
}

function Invoke-ReleaseStep([string]$Name, [scriptblock]$Command) {
  Write-Host "`n[release:verify] $Name" -ForegroundColor Cyan
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  & $Command
  $exitCode = $LASTEXITCODE
  $timer.Stop()
  if ($null -ne $exitCode -and $exitCode -ne 0) {
    throw "$Name failed with exit code $exitCode"
  }
  $results.Add([pscustomobject]@{
    name = $Name
    durationMs = $timer.ElapsedMilliseconds
    status = "passed"
  })
}

Push-Location $projectRoot
try {
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
  $initialFingerprint = Get-WorktreeFingerprint "initial"
  $env:CI = "true"
  $env:CARGO_BUILD_JOBS = "1"
  $env:NODE_OPTIONS = if ($env:NODE_OPTIONS) { $env:NODE_OPTIONS } else { "--max-old-space-size=3072" }
  $env:EPIGRAPH_NATIVE_SMOKE_OUTPUT_DIR = Join-Path $tempRoot "native-viewports"
  $env:EPIGRAPH_NAVIGATION_OUTPUT_DIR = Join-Path $tempRoot "navigation"
  $env:EPIGRAPH_BROWSER_SCREENSHOT_DIR = Join-Path $tempRoot "browser-provider"
  $env:EPIGRAPH_WEBDRIVER_WINDOW_X = "1980"
  $env:EPIGRAPH_WEBDRIVER_WINDOW_Y = "80"
  $env:EPIGRAPH_WEBDRIVER_WINDOW_WIDTH = "1280"
  $env:EPIGRAPH_WEBDRIVER_WINDOW_HEIGHT = "800"
  Remove-Item Env:EPIGRAPH_WEBDRIVER_SHOW_WINDOW -ErrorAction SilentlyContinue
  Remove-Item Env:EPIGRAPH_SUWAYOMI_LIVE_ENDPOINT -ErrorAction SilentlyContinue
  Remove-Item Env:EPIGRAPH_SUWAYOMI_LIVE_PROFILE -ErrorAction SilentlyContinue
  Remove-Item Env:EPIGRAPH_RELEASE_SMOKE_LIVE -ErrorAction SilentlyContinue
  Remove-Item Env:EPIGRAPH_LIVE_SUWAYOMI_URL -ErrorAction SilentlyContinue
  Remove-Item Env:EPIGRAPH_LIVE_FLARESOLVERR_URL -ErrorAction SilentlyContinue

  Invoke-ReleaseStep "Initial whitespace check" { Test-GitWhitespace }
  Invoke-ReleaseStep "Svelte diagnostics" { & pnpm exec svelte-check --tsconfig ./tsconfig.json }
  Invoke-ReleaseStep "Unit and jsdom tests" { & pnpm exec vitest run --project unit --project shell-jsdom --maxWorkers=1 --minWorkers=1 }
  Invoke-ReleaseStep "Browser component tests" {
    & pnpm exec vitest run --project browser-components --maxWorkers=1 --minWorkers=1
  }
  Invoke-ReleaseStep "Builtin theme generation check" { & pnpm theme:check-builtins }
  Invoke-ReleaseStep "Theme runtime contract" { & pnpm theme:test-runtime-audit }
  Invoke-ReleaseStep "Source runtime compatibility" {
    & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-source-runtime.ps1 -SkipProjectGates
  }
  Invoke-ReleaseStep "External integration contracts" {
    $env:EPIGRAPH_SKIP_SUWAYOMI_CERTIFICATION = "1"
    try { & pnpm release:certify-integrations }
    finally { Remove-Item Env:EPIGRAPH_SKIP_SUWAYOMI_CERTIFICATION -ErrorAction SilentlyContinue }
  }
  Invoke-ReleaseStep "Bundle budgets" { & pnpm release:check-bundles }
  Invoke-ReleaseStep "Rust test suite" { & cargo test --locked --manifest-path src-tauri/Cargo.toml --jobs 1 -- --test-threads=1 }
  Invoke-ReleaseStep "Frontend production build" { & pnpm build }
  Invoke-ReleaseStep "Tauri automation build" { & pnpm tauri -- build --no-bundle --config src-tauri/tauri.automation.conf.json }
  Invoke-ReleaseStep "Local data round trips" { & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-local-data-release-certification.ps1 -App $appPath }
  Invoke-ReleaseStep "Native viewport smoke" { & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-native-viewport-smoke.ps1 -App $appPath }
  Invoke-ReleaseStep "Native navigation budgets" { & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-native-viewport-smoke.ps1 -App $appPath -NodeScript check-navigation-performance.mjs }
  Invoke-ReleaseStep "Whitespace check" { Test-GitWhitespace }

  $finalFingerprint = Get-WorktreeFingerprint "final"
  if ($finalFingerprint -ne $initialFingerprint) {
    throw "Release verification changed the worktree. Inspect generated artifacts before committing."
  }

  Write-Host "`n[release:verify] all $($results.Count) blocking gates passed" -ForegroundColor Green
  $results | Format-Table -AutoSize
} finally {
  Pop-Location
  [System.IO.Directory]::Delete($tempRoot, $true)
}
