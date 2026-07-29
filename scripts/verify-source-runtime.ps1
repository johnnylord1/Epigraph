param(
  [switch]$ContractOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$results = [System.Collections.Generic.List[object]]::new()

function Invoke-SourceRuntimeStep([string]$Name, [scriptblock]$Command) {
  Write-Host "`n[source-runtime] $Name" -ForegroundColor Cyan
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

function Test-SourceRuntimeWhitespace {
  & git diff --check
  if ($LASTEXITCODE -ne 0) { throw "Unstaged whitespace check failed" }
  & git diff --cached --check
  if ($LASTEXITCODE -ne 0) { throw "Staged whitespace check failed" }
}

function Test-NoResidualCandidates {
  $temporaryRoots = @(
    Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Directory -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -like "aethon-suwayomi-certification-*" -or
        $_.Name -like "aethon-suwayomi-migration-*" -or
        $_.Name -like "aethon-suwayomi-workflow-*"
      }
  )
  if ($temporaryRoots.Count -gt 0) {
    throw "Residual Suwayomi certification directories remain in the operating-system temp root."
  }

  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    $candidateProcesses = @(
      Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
          $_.Name -in @("java.exe", "javaw.exe") -and
          $_.CommandLine -match "aethon-suwayomi-(certification|migration|workflow)-"
        }
    )
    if ($candidateProcesses.Count -gt 0) {
      throw "Residual Suwayomi certification JVMs remain active."
    }
  }
}

Push-Location $projectRoot
try {
  $env:CI = "true"
  $env:CARGO_BUILD_JOBS = "1"
  $env:NODE_OPTIONS = if ($env:NODE_OPTIONS) { $env:NODE_OPTIONS } else { "--max-old-space-size=3072" }

  Invoke-SourceRuntimeStep "Initial cleanup and whitespace" {
    Test-NoResidualCandidates
    Test-SourceRuntimeWhitespace
  }
  Invoke-SourceRuntimeStep "Certification contracts" { & pnpm test:suwayomi-certification }
  Invoke-SourceRuntimeStep "Adapter, extension health, and anti-bot contracts" {
    & pnpm exec vitest run --project unit src/lib/manga/runtime src/lib/flaresolverr.test.ts src/lib/sourceAccess.test.ts src/lib/library/updateRuntime.test.ts --maxWorkers=1 --minWorkers=1
  }

  if (-not $ContractOnly) {
    Invoke-SourceRuntimeStep "Deterministic extension and Local Source workflow" {
      & node scripts/certify-suwayomi-extension-workflows.mjs
    }
    Invoke-SourceRuntimeStep "Svelte diagnostics" { & pnpm exec svelte-check --tsconfig ./tsconfig.json }
    Invoke-SourceRuntimeStep "Rust runtime, updater, Core, and Syncd contracts" {
      & cargo test --locked --manifest-path src-tauri/Cargo.toml --jobs 1 -- --test-threads=1
    }
    Invoke-SourceRuntimeStep "Frontend production build" { & pnpm build }
  }

  Invoke-SourceRuntimeStep "Final cleanup and whitespace" {
    Test-NoResidualCandidates
    Test-SourceRuntimeWhitespace
  }

  Write-Host "`n[source-runtime] all $($results.Count) gates passed" -ForegroundColor Green
  $results | Format-Table -AutoSize
} finally {
  Pop-Location
}
