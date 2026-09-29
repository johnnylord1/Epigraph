param([string]$ProjectRoot=(Split-Path -Parent $PSScriptRoot),[ValidateSet('dev','main')][string]$Mode='dev',
  [string]$Profile,[string]$OutputDirectory,[string]$SeedTargetDirectory,[ValidateRange(0,1024)][int]$Jobs=0)
$ErrorActionPreference='Stop'
function Invoke-CandidateNative {
  param([string]$File,[string[]]$NativeArguments)
  $previousPreference=$ErrorActionPreference
  try {
    $ErrorActionPreference='Continue'
    # Callers capture the pipeline, so keep native output in the candidate for diagnosis.
    & $File @NativeArguments 2>&1 | ForEach-Object { $line=$_.ToString(); if($script:buildLog){[IO.File]::AppendAllText($script:buildLog,$line+[Environment]::NewLine)}; $line }
    $code=$LASTEXITCODE
  } finally { $ErrorActionPreference=$previousPreference }
  if($code -ne 0){throw "Candidate command failed with exit code $code$(if($script:buildLog){"; see $script:buildLog"})"}
}
. (Join-Path $PSScriptRoot 'EpigraphSessionTools.ps1')
. (Join-Path $PSScriptRoot 'EpigraphCandidateCache.ps1')
$ProjectRoot=(Resolve-Path -LiteralPath $ProjectRoot).Path
if(!$Profile){$Profile=Get-EpigraphLaunchProfileIdentity $Mode}
# 0 selects a memory-aware default; EPIGRAPH_BUILD_JOBS=1 opts into serial builds.
$Jobs=Get-EpigraphBuildJobs $Jobs
if(!$OutputDirectory){$OutputDirectory=Join-Path (Get-EpigraphCandidateRoot) ([guid]::NewGuid())}
$null=New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputDirectory)
$receiptTool=Join-Path $PSScriptRoot 'epigraph-build-receipt.mjs'
$state=& node $receiptTool snapshot $ProjectRoot $OutputDirectory $Profile $Mode
if($LASTEXITCODE -ne 0){throw 'Source snapshot failed'}
$state=$state | ConvertFrom-Json
$previous=@{};foreach($name in @('EPIGRAPH_BUILD_ID','EPIGRAPH_SOURCE_FINGERPRINT','CARGO_TARGET_DIR','TAURI_CONFIG')){$previous[$name]=[Environment]::GetEnvironmentVariable($name)}
$coreLock=$null;$buildLock=$null;$lease=$null;$script:buildLog=Join-Path $OutputDirectory 'build.log'
try {
  # Held until this build ends so retention never removes a candidate in progress.
  $buildLock=[IO.File]::Open((Join-Path $OutputDirectory 'build.lock'),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $target=Join-Path $OutputDirectory 'target'
  if($SeedTargetDirectory){
    # A copied target keeps absolute paths into its source (Tauri build outputs), so
    # a seeded build would read another target and break once that source is removed.
    Write-Warning '-SeedTargetDirectory is obsolete and ignored; dependencies come from the leased per-worktree build cache'
  }
  # Only dependency resolution is shared. Sources and frontend outputs are isolated.
  $null=New-Item -ItemType Junction -Path (Join-Path $state.source 'node_modules') -Target (Join-Path $ProjectRoot 'node_modules')
  Push-Location $state.source
  try {
    Invoke-CandidateNative node @((Join-Path $ProjectRoot 'node_modules\vite\bin\vite.js'),'build')
    $env:EPIGRAPH_BUILD_ID=$state.buildId; $env:EPIGRAPH_SOURCE_FINGERPRINT=$state.sourceFingerprint
    # A receipt must never select an output another concurrent build can replace.
    # Compile in the per-worktree cache only while holding its exclusive lease,
    # from the first cargo call until finish has copied and hashed the binaries
    # into this candidate. Tauri build outputs embed absolute target paths, so the
    # cache stays at one path. Without the lease this candidate compiles privately.
    $lease=Enter-EpigraphTargetLease $state.project $target;$target=$lease.Target
    $env:CARGO_TARGET_DIR=$target
    $env:TAURI_CONFIG='{"build":{"beforeBuildCommand":""}}'
    # Tauri's build script checks externalBin even when building Core itself.
    # Stage a bootstrap file only for that check; replace it with the newly
    # compiled Core before the desktop build and before publishing any receipt.
    $binaries=Join-Path $state.source 'src-tauri\binaries';$null=New-Item -ItemType Directory -Force -Path $binaries
    $bootstrap=Join-Path $ProjectRoot 'src-tauri\binaries\epigraph-syncd-x86_64-pc-windows-msvc.exe'
    if(!(Test-Path -LiteralPath $bootstrap)){$bootstrap=Join-Path $ProjectRoot 'src-tauri\target\debug\epigraph-syncd.exe'}
    Copy-Item -LiteralPath $bootstrap -Destination (Join-Path $binaries 'epigraph-syncd-x86_64-pc-windows-msvc.exe')
    # These ignored resources are required by the existing Windows bundle config.
    # Use the installed fixture as-is; this does not prepare or update the bundle.
    $runtimeBundle=Join-Path $ProjectRoot 'src-tauri\binaries\suwayomi-bundle'
    if(!(Test-Path -LiteralPath (Join-Path $runtimeBundle 'bin\Suwayomi-Server.jar'))){throw 'Existing runtime bundle is unavailable'}
    Copy-Item -LiteralPath $runtimeBundle -Destination $binaries -Recurse -Force
    if(!(Test-Path -LiteralPath (Join-Path $binaries 'suwayomi-bundle\bin\Suwayomi-Server.jar'))){throw 'Runtime fixture was not staged at the configured resource path'}
    $cargoArgs=@('build','--manifest-path','src-tauri/Cargo.toml','--locked','--jobs',[string]$Jobs,'--bin','epigraph-syncd')
    if($Mode -eq 'main'){$cargoArgs+='--release'}
    Invoke-CandidateNative cargo $cargoArgs
    $candidateBinaries=Join-Path $OutputDirectory 'binaries'
    $null=New-Item -ItemType Directory -Path $candidateBinaries
    Copy-Item -LiteralPath (Join-Path $binaries 'suwayomi-bundle') -Destination (Join-Path $candidateBinaries 'suwayomi-bundle') -Recurse
    $configuration=if($Mode -eq 'main'){'release'}else{'debug'}
    $core=Join-Path $env:CARGO_TARGET_DIR ($configuration+'\epigraph-syncd.exe')
    $binaries=Join-Path $state.source 'src-tauri\binaries';$null=New-Item -ItemType Directory -Force -Path $binaries
    Copy-Item -LiteralPath $core -Destination (Join-Path $binaries 'epigraph-syncd-x86_64-pc-windows-msvc.exe')
    # Tauri replaces its target-side copy during the desktop build. Retain the
    # freshly compiled SOURCE copy instead; Tauri only reads this locked file.
    $core=Join-Path $binaries 'epigraph-syncd-x86_64-pc-windows-msvc.exe'
    $coreLock=[IO.File]::Open($core,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $cargoArgs[$cargoArgs.IndexOf('epigraph-syncd')]='epigraph'
    Invoke-CandidateNative cargo $cargoArgs
    # The desktop must embed this build's identity, proving it came from this snapshot.
    $result=& node $receiptTool finish $OutputDirectory (Join-Path $env:CARGO_TARGET_DIR ($configuration+'\epigraph.exe')) $core --require-identity
    if($LASTEXITCODE -ne 0){throw 'Candidate changed during build; no valid receipt'}
    Write-Output (Join-Path $OutputDirectory 'receipt.json')
  } finally { Pop-Location }
} finally {
  if($coreLock){$coreLock.Dispose()}
  Exit-EpigraphTargetLease $lease
  if($buildLock){$buildLock.Dispose()}
  foreach($name in $previous.Keys){[Environment]::SetEnvironmentVariable($name,$previous[$name])}
  # Bound local growth. Retention never writes to the pipeline: callers read the
  # receipt path as the last output line.
  try { Remove-EpigraphStaleCandidates -Exclude $OutputDirectory; Remove-EpigraphStaleBuildCaches -Current $(if($lease){$lease.Directory}) }
  catch { Write-Warning "Candidate retention skipped: $($_.Exception.Message)" }
}
