$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'VerificationEvidence.ps1')
$root=Join-Path $env:TEMP ('epigraph-b6-powershell-'+[guid]::NewGuid())
$project=Join-Path $root 'repo'
$evidenceRoot=if($env:EPIGRAPH_VERIFICATION_ROOT){Join-Path $env:EPIGRAPH_VERIFICATION_ROOT (Split-Path $root -Leaf)}else{Join-Path $root 'evidence'}
$null=New-Item -ItemType Directory -Path $project
$cases=[Collections.Generic.List[object]]::new()
function Assert-B6($Name,$Passed){$cases.Add(@{case=$Name;status=$(if($Passed){'PASS'}else{'FAIL'})});if(!$Passed){throw $Name};Write-Host "PASS $Name"}
$oldId=$env:EPIGRAPH_VERIFICATION_ID;$oldRoot=$env:EPIGRAPH_VERIFICATION_ROOT
Push-Location $project
try {
  & git init --quiet
  & git config user.email fixture@example.invalid
  & git config user.name Fixture
  [IO.File]::WriteAllText((Join-Path $project 'source.txt'),'initial')
  & git add -- source.txt
  & git commit --quiet -m fixture
  $stages=@(@{id='gate';name='Fixture gate only';kind='verification'})
  $receipt=New-VerificationEvidence $project 'PowerShell-success-fixture' $stages @{environment='disposable';journeys=@('Evidence fixture only')} $evidenceRoot
  $running=Get-Content $receipt -Raw|ConvertFrom-Json
  Assert-B6 'RUNNING receipt precedes PowerShell gate' ($running.receiptState -eq 'RUNNING' -and $running.outcome -ne 'PASS')
  $null=Invoke-VerificationEvidence begin $receipt @{id='gate'}
  Set-VerificationStage $receipt gate PASS
  $final=Invoke-VerificationEvidence finish $receipt @{}|ConvertFrom-Json
  Assert-B6 'PowerShell success finalized with both tree fingerprints' ($final.outcome -eq 'PASS' -and $final.tree.initial.digest -eq $final.tree.final.digest)

  $env:EPIGRAPH_VERIFICATION_ID=$null
  $failed=New-VerificationEvidence $project 'PowerShell-failure-fixture' $stages @{environment='disposable'} $evidenceRoot
  $scratch=Join-Path $root 'disposable';$null=New-Item -ItemType Directory $scratch
  try {throw 'intentional gate failure'} catch {Set-VerificationStage $failed gate FAIL $_.ToString()}
  $resolved=(Resolve-Path -LiteralPath $scratch).Path
  if($resolved -ne [IO.Path]::GetFullPath((Join-Path $root 'disposable'))){throw 'Fixture cleanup scope mismatch'}
  Remove-Item -LiteralPath $resolved -Recurse -Force
  $null=Invoke-VerificationEvidence cleanup $failed @{result=@{status='PASS'}}
  $result=Invoke-VerificationEvidence finish $failed @{}|ConvertFrom-Json
  Assert-B6 'failure survives actual disposable cleanup' ((Test-Path $failed) -and !(Test-Path $scratch) -and $result.outcome -eq 'FAIL' -and $result.tree.final.digest)

  $env:EPIGRAPH_VERIFICATION_ID=$null
  $cleanup=New-VerificationEvidence $project 'PowerShell-cleanup-failure' $stages @{environment='disposable'} $evidenceRoot
  Set-VerificationStage $cleanup gate PASS
  $null=Invoke-VerificationEvidence cleanup $cleanup @{result=@{status='FAIL';reason='injected cleanup failure'}}
  $result=Invoke-VerificationEvidence finish $cleanup @{}|ConvertFrom-Json
  Assert-B6 'cleanup failure does not erase passing gate or report overall PASS' ($result.stages[0].status -eq 'PASS' -and $result.cleanup.status -eq 'FAIL' -and $result.outcome -eq 'FAIL')
  Assert-B6 'rerun keeps prior failure at its original identity' ($cleanup -ne $failed -and (Get-Content $failed -Raw|ConvertFrom-Json).outcome -eq 'FAIL')

  $env:EPIGRAPH_VERIFICATION_ID=$null
  $interrupted=New-VerificationEvidence $project 'PowerShell-interruption-fixture' $stages @{environment='disposable'} $evidenceRoot
  $null=Invoke-VerificationEvidence begin $interrupted @{id='gate'}
  $worker=Join-Path $root 'exit-worker.ps1';[IO.File]::WriteAllText($worker,'exit 17')
  $shell=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $payload=@{project=$project;command=$shell;args=@('-NoProfile','-File',$worker)}|ConvertTo-Json -Compress
  $null=$payload|& node $script:VerificationEvidenceTool supervise $interrupted
  $result=Get-Content $interrupted -Raw|ConvertFrom-Json
  Assert-B6 'supervisor marks unfinalized PowerShell worker INTERRUPTED' ($result.receiptState -eq 'INTERRUPTED' -and $result.outcome -ne 'PASS' -and $result.tree.final.digest)

  # Exercise the real release runner's AST inventory, supervisor, catch/finally
  # and exit-code behavior. Only its gate command blocks are substituted.
  $scripts=Join-Path $project 'scripts';$null=New-Item -ItemType Directory $scripts
  foreach($name in @('VerificationEvidence.ps1','verification-evidence.mjs','epigraph-build-receipt.mjs')){
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $scripts $name)
  }
  $runnerSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'verify-release.ps1'))
  $tokens=$null;$errorsFound=$null
  $ast=[Management.Automation.Language.Parser]::ParseInput($runnerSource,[ref]$tokens,[ref]$errorsFound)
  $calls=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Invoke-ReleaseStep'},$true))
  foreach($mode in @('success','gate-failure','cleanup-failure')){
    $source=$runnerSource
    foreach($call in ($calls|Sort-Object {$_.Extent.StartOffset} -Descending)){
      $block=@($call.CommandElements|Where-Object {$_ -is [Management.Automation.Language.ScriptBlockExpressionAst]})[0]
      $replacement='{ $global:LASTEXITCODE=0 }'
      if($mode -eq 'gate-failure' -and $call.CommandElements[1].Value -eq 'Frontend production build'){$replacement='{ throw "intentional substituted gate failure" }'}
      if($mode -eq 'cleanup-failure' -and $call.CommandElements[1].Value -eq 'Initial whitespace check'){
        $replacement='{ $script:fixtureLock=[IO.File]::Open((Join-Path $tempRoot "locked.txt"),[IO.FileMode]::Create,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $global:LASTEXITCODE=0 }'
      }
      $source=$source.Substring(0,$block.Extent.StartOffset)+$replacement+$source.Substring($block.Extent.EndOffset)
    }
    $runner=Join-Path $scripts 'verify-release.ps1';[IO.File]::WriteAllText($runner,$source)
    & git add -- scripts
    & git commit --quiet -m "runner fixture $mode"
    $env:EPIGRAPH_VERIFICATION_ID=$null;$env:EPIGRAPH_VERIFICATION_ROOT=Join-Path $evidenceRoot $mode
    $previousPreference=$ErrorActionPreference;$ErrorActionPreference='Continue'
    & $shell -NoProfile -File $runner *> (Join-Path $root "$mode-runner-output.txt")
    $code=$LASTEXITCODE;$ErrorActionPreference=$previousPreference
    $files=@(Get-ChildItem -LiteralPath $env:EPIGRAPH_VERIFICATION_ROOT -Filter receipt.json -Recurse)
    Assert-B6 "$mode real runner produces one durable receipt" ($files.Count -eq 1)
    $r=Get-Content $files[0].FullName -Raw|ConvertFrom-Json
    Assert-B6 "$mode runner captures both tree fingerprints" ($r.tree.initial.digest -and $r.tree.final.digest -and $r.tree.comparison -eq 'PASS')
    if($mode -eq 'success'){Assert-B6 'real runner success exits zero and FINALIZED PASS' ($code -eq 0 -and $r.receiptState -eq 'FINALIZED' -and $r.outcome -eq 'PASS')}
    if($mode -eq 'gate-failure'){Assert-B6 'real gate failure remains FAIL with later stages NOT_RUN after cleanup' ($code -ne 0 -and $r.outcome -eq 'FAIL' -and $r.stages[1].status -eq 'FAIL' -and $r.stages[2].status -eq 'NOT_RUN' -and $r.cleanup.status -eq 'PASS')}
    if($mode -eq 'cleanup-failure'){Assert-B6 'real locked-file cleanup failure is recorded separately and exits nonzero' ($code -ne 0 -and $r.cleanup.status -eq 'FAIL' -and $r.outcome -eq 'FAIL' -and @($r.stages|Where-Object status -ne PASS).Count -eq 0)}
  }
  foreach($native in @('run-native-viewport-smoke.ps1','run-local-data-release-certification.ps1')){
    $env:EPIGRAPH_VERIFICATION_ID=$null;$env:EPIGRAPH_VERIFICATION_ROOT=Join-Path $evidenceRoot $native
    $previousPreference=$ErrorActionPreference;$ErrorActionPreference='Continue'
    & $shell -NoProfile -File (Join-Path $PSScriptRoot $native) -BuildReceipt (Join-Path $root 'missing-receipt.json') *> (Join-Path $root "$native-output.txt")
    $code=$LASTEXITCODE;$ErrorActionPreference=$previousPreference
    $files=@(Get-ChildItem $env:EPIGRAPH_VERIFICATION_ROOT -Filter receipt.json -Recurse)
    Assert-B6 "$native rejected missing artifact before native launch" ($files.Count -eq 1 -and $code -ne 0)
    $r=Get-Content $files[0].FullName -Raw|ConvertFrom-Json
    Assert-B6 "$native failure finalized with verification NOT_RUN" ($r.receiptState -eq 'FINALIZED' -and $r.stages[0].status -eq 'FAIL' -and $r.stages[1].status -eq 'NOT_RUN' -and $r.tree.final.digest)
  }
} finally {
  Pop-Location
  $env:EPIGRAPH_VERIFICATION_ID=$oldId;$env:EPIGRAPH_VERIFICATION_ROOT=$oldRoot
  $cases|ConvertTo-Json -Depth 6|Set-Content (Join-Path $root 'results.json') -Encoding UTF8
  Write-Host "B6 PowerShell evidence: $root"
}
