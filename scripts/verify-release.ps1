param([string]$BuildReceipt,[switch]$EvidenceWorker,[string]$Receipt,[switch]$ListStages)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
. (Join-Path $scriptDir 'VerificationEvidence.ps1')
$appPath = Join-Path $projectRoot "src-tauri\target\release\epigraph.exe"
$runId = "epigraph-release-verify-$([guid]::NewGuid())"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) $runId
$results = [System.Collections.Generic.List[object]]::new()

function Test-GitWhitespace {
  & git diff --check
  if ($LASTEXITCODE -ne 0) { throw "Unstaged whitespace check failed" }
  & git diff --cached --check
  if ($LASTEXITCODE -ne 0) { throw "Staged whitespace check failed" }
}

function Invoke-ReleaseStep([string]$Name, [scriptblock]$Command, [string]$Kind='verification') {
  Write-Host "`n[release:verify] $Name" -ForegroundColor Cyan
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  $null=Invoke-VerificationEvidence begin $Receipt @{id=$Name}
  try {
    $global:LASTEXITCODE=0
    & $Command
    $exitCode=$LASTEXITCODE
    if($exitCode -ne 0){throw "$Name failed with exit code $exitCode"}
    Set-VerificationStage $Receipt $Name PASS '' $exitCode
  } catch {
    Set-VerificationStage $Receipt $Name FAIL $_.ToString()
    $null=Invoke-VerificationEvidence diagnostic $Receipt @{label=$Name;value=$_.ToString()}
    throw
  }
  $timer.Stop()
  $results.Add([pscustomobject]@{
    name = $Name
    durationMs = $timer.ElapsedMilliseconds
    status = "passed"
  })
}

# Read the actual calls, including their preparation/verification kind.
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($PSCommandPath,[ref]$tokens,[ref]$parseErrors)
$declarations=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Invoke-ReleaseStep'},$true)|ForEach-Object {
  $kind='verification';$elements=$_.CommandElements
  for($i=0;$i -lt $elements.Count-1;$i++){if($elements[$i] -is [Management.Automation.Language.CommandParameterAst] -and $elements[$i].ParameterName -eq 'Kind'){$kind=$elements[$i+1].Value}}
  @{id=$elements[1].Value;name=$elements[1].Value;kind=$kind;required=$true}
})
if($ListStages){$declarations|ConvertTo-Json -Depth 5;return}
Push-Location $projectRoot
try {
  if(!$EvidenceWorker){
    $Receipt=New-VerificationEvidence $projectRoot 'verify-release.ps1' $declarations @{environment='local-verification';journeys=@('Declared deterministic gates','Books local-data round trips','Home/Library/Settings viewports','Declared navigation budgets');backend=@{kind='mixed';reason='Fixture-backed native gates; no broad live-runtime certification'}}
    Write-Host "Durable verification receipt: $Receipt"
    $shell=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $args=@('-NoProfile','-File',$PSCommandPath,'-EvidenceWorker','-Receipt',$Receipt)
    if($BuildReceipt){$args+=@('-BuildReceipt',[IO.Path]::GetFullPath($BuildReceipt))}
    $payload=@{project=$projectRoot;command=$shell;args=$args}|ConvertTo-Json -Depth 5 -Compress
    $payload|& node $script:VerificationEvidenceTool supervise $Receipt
    if($LASTEXITCODE -ne 0){throw "Verification did not pass; durable evidence: $Receipt"}
    return
  }
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
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
  Invoke-ReleaseStep "Frontend production build" { & pnpm build } -Kind preparation
  Invoke-ReleaseStep "Builtin theme generation" { & pnpm theme:generate-builtins } -Kind preparation
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
  Invoke-ReleaseStep "Release prerequisite contracts" { & node --test scripts/prepare-suwayomi-bundle.test.mjs }
  Invoke-ReleaseStep "Suwayomi bundle prerequisites" { & pnpm suwayomi:prepare-bundle:windows } -Kind preparation
  Invoke-ReleaseStep "Syncd sidecar build" { & pnpm syncd:prepare-sidecar:release } -Kind preparation
  Invoke-ReleaseStep "External integration contracts" {
    & pnpm release:certify-integrations
  }
  Invoke-ReleaseStep "Bundle budgets" { & pnpm release:check-bundles }
  Invoke-ReleaseStep "Rust test suite" { & cargo test --locked --manifest-path src-tauri/Cargo.toml --jobs 1 -- --test-threads=1 }
  Invoke-ReleaseStep "Attested candidate preparation or validation" {
    if(!$BuildReceipt){
      . (Join-Path $scriptDir 'EpigraphSessionTools.ps1')
      $candidate=Join-Path ([IO.Path]::GetTempPath()) ('epigraph-b6-candidate-'+[guid]::NewGuid())
      & (Join-Path $scriptDir 'build-epigraph-candidate.ps1') -ProjectRoot $projectRoot -Mode main -Profile (Get-EpigraphLaunchProfileIdentity main) -OutputDirectory $candidate
      $script:BuildReceipt=Join-Path $candidate 'receipt.json'
    }
    $script:appPath=Assert-VerificationArtifact $Receipt $BuildReceipt ''
  } -Kind preparation
  Invoke-ReleaseStep "Local data round trips" { & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-local-data-release-certification.ps1 -App $appPath -BuildReceipt $BuildReceipt }
  Invoke-ReleaseStep "Native viewport smoke" { & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-native-viewport-smoke.ps1 -App $appPath -BuildReceipt $BuildReceipt }
  Invoke-ReleaseStep "Native navigation budgets" { & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-native-viewport-smoke.ps1 -App $appPath -BuildReceipt $BuildReceipt -NodeScript check-navigation-performance.mjs }
  Invoke-ReleaseStep "Whitespace check" { Test-GitWhitespace }

  Write-Host "`n[release:verify] executed $($results.Count) stages; final evidence follows"
  $results | Format-Table -AutoSize
} finally {
  if($EvidenceWorker){
    try {
      $resolved=[IO.Path]::GetFullPath($tempRoot)
      $expected=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
      if(!(Split-Path $resolved -Leaf).StartsWith('epigraph-release-verify-') -or !$resolved.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase)){throw 'Scratch cleanup target invalid'}
      if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop}
      $null=Invoke-VerificationEvidence cleanup $Receipt @{result=@{status='PASS'}}
    } catch {$null=Invoke-VerificationEvidence cleanup $Receipt @{result=@{status='FAIL';reason=$_.ToString()}}}
    $final=Invoke-VerificationEvidence finish $Receipt @{}|ConvertFrom-Json
    Write-Host "Verification $($final.receiptState): $($final.outcome); $Receipt"
    if($final.outcome -ne 'PASS'){$global:LASTEXITCODE=1}
  }
  Pop-Location
}
if($EvidenceWorker -and $final.outcome -ne 'PASS'){exit 1}
