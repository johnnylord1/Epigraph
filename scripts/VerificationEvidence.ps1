# Thin adapter: schema, hashing, redaction and receipt state live in one module.
$script:VerificationEvidenceTool=Join-Path $PSScriptRoot 'verification-evidence.mjs'
function Invoke-VerificationEvidence {
  param([string]$Action,[string]$Receipt,$Data=@{})
  if($Action -ne 'create' -and !$Data.ContainsKey('project') -and (Get-Variable VerificationEvidenceProject -Scope Script -ErrorAction SilentlyContinue)){
    $Data.project=$script:VerificationEvidenceProject
  }
  $payload=$Data|ConvertTo-Json -Depth 20 -Compress
  $OutputEncoding=[Text.UTF8Encoding]::new($false)
  $output=@($payload | & node $script:VerificationEvidenceTool $Action $Receipt)
  if($LASTEXITCODE -ne 0){throw "Verification evidence operation failed: $Action"}
  return ($output -join "`n")
}
function New-VerificationEvidence {
  param([string]$Project,[string]$Runner,$Stages,$Scope,[string]$Root=$env:EPIGRAPH_VERIFICATION_ROOT)
  $data=@{project=$Project;runner=$Runner;stages=@($Stages);scope=$Scope}
  $script:VerificationEvidenceProject=$Project
  if($Root){$data.evidenceRoot=$Root}
  $receipt=Invoke-VerificationEvidence create '' $data
  $created=Get-Content -LiteralPath $receipt -Raw|ConvertFrom-Json
  $env:EPIGRAPH_VERIFICATION_ID=$created.verificationId
  $env:EPIGRAPH_VERIFICATION_ROOT=Split-Path -Parent (Split-Path -Parent $receipt)
  return $receipt
}
function Set-VerificationStage {
  param([string]$Receipt,[string]$Id,[string]$Status,[string]$Reason='',[Nullable[int]]$ExitCode=$null)
  $null=Invoke-VerificationEvidence stage $Receipt @{id=$Id;status=$Status;detail=@{reason=$Reason;exitCode=$ExitCode}}
}
function Assert-VerificationArtifact {
  param([string]$Receipt,[string]$BuildReceipt,[string]$App)
  if(!$BuildReceipt){throw 'A B1 build receipt is required for native verification'}
  $build=Get-Content -LiteralPath $BuildReceipt -Raw|ConvertFrom-Json
  $null=Invoke-VerificationEvidence bind $Receipt @{receiptPath=$BuildReceipt;profile=$build.profile;mode=$build.mode}
  if($App -and [IO.Path]::GetFullPath($App) -ine [IO.Path]::GetFullPath($build.executable)){throw 'Requested application differs from the B1 build receipt'}
  $env:EPIGRAPH_BUILD_RECEIPT=[IO.Path]::GetFullPath($BuildReceipt)
  return $build.executable
}
