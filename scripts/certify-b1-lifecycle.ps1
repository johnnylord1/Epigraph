param([ValidateSet('dev','main')][string]$Mode='dev',[string]$Fixture,[string]$ReceiptPath,[string]$SeedTargetDirectory)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'EpigraphSessionTools.ps1')
$project=(Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
if(!$Fixture){$Fixture=Join-Path $env:TEMP ('epigraph-b1-desktop-'+[guid]::NewGuid())}
$Fixture=[IO.Path]::GetFullPath($Fixture)
$null=New-Item -ItemType Directory -Force -Path $Fixture
$names=@('APPDATA','LOCALAPPDATA','WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
  'EPIGRAPH_LOCAL_SERVER_MAIN_ROOT','EPIGRAPH_LOCAL_SERVER_TEST_ROOT','EPIGRAPH_SYNCD_DATA_DIR','EPIGRAPH_SYNCD_DESKTOP_STATE_DIR',
  'EPIGRAPH_SYNCD_PORT','EPIGRAPH_SYNCD_OWNERSHIP','EPIGRAPH_LAUNCH_PROFILE','EPIGRAPH_SESSION_RECORD','EPIGRAPH_SESSION_RUN')
$old=@{};foreach($name in $names){$old[$name]=[Environment]::GetEnvironmentVariable($name)}
$results=[Collections.Generic.List[object]]::new();$record=$null;$request=$null;$hostProcess=$null
function Result($Name,$Passed,$Detail=''){$results.Add(@{case=$Name;status=$(if($Passed){'PASS'}else{'FAIL'});detail=$Detail});if(!$Passed){throw $Name};Write-Output "PASS $Name"}
function FreePort{$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$l.Start();$port=$l.LocalEndpoint.Port;$l.Stop();return $port}
try {
  $env:APPDATA=Join-Path $Fixture 'roaming';$env:LOCALAPPDATA=Join-Path $Fixture 'local'
  $env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $Fixture 'webview'
  $env:EPIGRAPH_LOCAL_SERVER_MAIN_ROOT=Join-Path $Fixture 'main-runtime';$env:EPIGRAPH_LOCAL_SERVER_TEST_ROOT=Join-Path $Fixture 'test-runtime'
  $env:EPIGRAPH_SYNCD_DATA_DIR=Join-Path $Fixture 'core';$env:EPIGRAPH_SYNCD_DESKTOP_STATE_DIR=Join-Path $Fixture 'desktop-state'
  $env:EPIGRAPH_SYNCD_PORT=[string](FreePort);$env:EPIGRAPH_SYNCD_OWNERSHIP='persistent-attached'
  $env:EPIGRAPH_LAUNCH_PROFILE=$(if($Mode -eq 'main'){'MAIN'}else{'TEST'})
  $cdp=FreePort;$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$cdp"
  foreach($dir in @($env:APPDATA,$env:LOCALAPPDATA,$env:WEBVIEW2_USER_DATA_FOLDER,$env:EPIGRAPH_SYNCD_DESKTOP_STATE_DIR)){$null=New-Item -ItemType Directory -Force -Path $dir}
  $profile=Get-EpigraphLaunchProfileIdentity $Mode
  if(!$ReceiptPath){
    $output=Join-Path $Fixture 'candidate'
    & (Join-Path $PSScriptRoot 'build-epigraph-candidate.ps1') -ProjectRoot $project -Mode $Mode -Profile $profile -OutputDirectory $output -SeedTargetDirectory $SeedTargetDirectory *> (Join-Path $Fixture 'build.log')
    $ReceiptPath=Join-Path $output 'receipt.json'
  }
  $receipt=Get-Content $ReceiptPath -Raw | ConvertFrom-Json
  Result 'successful build receipt available' ($receipt.profile -ceq $profile)
  $request=@{Project=$project;Profile=$profile;Mode=$Mode;RunId=[guid]::NewGuid().ToString();Build=$receipt.sourceFingerprint;
    ArtifactSha256=$receipt.executableSha256;BuildId=$receipt.buildId;ReceiptPath=$ReceiptPath}
  $launch=Join-Path $Fixture 'launch.json'
  @{Request=$request;AppExe=$receipt.executable;Executable=$receipt.executable;Arguments=$(if($Mode -eq 'main'){'--main'}else{'--test'})} | ConvertTo-Json -Depth 5 | Set-Content $launch -Encoding UTF8
  # Use the actual run host; its launch payload carries a fixture session directory.
  $hostScript=Join-Path $PSScriptRoot 'run-epigraph-session.ps1'
  $shell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $hostProcess=Start-Process $shell -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-File',('"'+$hostScript+'"'),'-LaunchPath',('"'+$launch+'"'),'-SessionDirectory',('"'+$Fixture+'"'))
  $deadline=[DateTime]::UtcNow.AddSeconds(120);$ready=$null;$lastControlError='' 
  do{try{$ready=Invoke-EpigraphSessionControl $request attest $Fixture 3000;break}catch{$lastControlError=$_.ToString();Start-Sleep -Milliseconds 500}}while([DateTime]::UtcNow -lt $deadline)
  Result 'cold launch exact artifact and native run acknowledgement' ($null -ne $ready) $lastControlError
  $recordPath=Join-Path $Fixture ($request.RunId+'.json');$record=Get-Content $recordPath -Raw | ConvertFrom-Json
  $identity=[EpigraphProcessNative+Identity]::new();$identity.Pid=$record.RootPid;$identity.Created=$record.RootCreated;$identity.Executable=$record.RootExecutable;$identity.Job=$record.Job
  $observed=[EpigraphProcessNative]::Observe($identity)
  try {
    $foreign=$request.Clone();$foreign.Profile='foreign';$refused=$false
    try{$null=Invoke-EpigraphSessionControl $foreign shutdown $Fixture 1000}catch{$refused=$true}
    Result 'foreign profile cannot close actual application' ($refused -and !$observed.Wait(0))
    $foreign=$request.Clone();$foreign.Project=$Fixture;$refused=$false
    try{$null=Invoke-EpigraphSessionControl $foreign shutdown $Fixture 1000}catch{$refused=$true}
    Result 'foreign worktree cannot close actual application' ($refused -and !$observed.Wait(0))
    $null=[EpigraphProcessNative]::InspectJob($record.Job)
    Result 'only hidden run host terminated' ([EpigraphProcessNative]::StopRetained($hostProcess))
    Result 'actual application survives hidden host loss' (!$observed.Wait(0))
    $null=Invoke-EpigraphSessionControl $request attest $Fixture 10000
    Result 'existing job recovers exact actual application after host death' $true
    & node (Join-Path $PSScriptRoot 'certify-b1-lifecycle.mjs') $recordPath "http://127.0.0.1:$cdp" (Join-Path $Fixture 'interaction.json')
    Result 'actual CDP and focus lifecycle' ($LASTEXITCODE -eq 0)
    $null=Invoke-EpigraphSessionControl $request shutdown $Fixture 30000
    Result 'graceful close OS-confirmed on retained application object' ($observed.Wait(0))
    Result 'original session evidence retained after completion' (Test-Path $recordPath)
    # Relaunch the same attested artifact in the same disposable profile using a
    # fresh ownership run. Do not inherit the old desktop's run UUID or job.
    $nextRequest=$request.Clone();$nextRequest.RunId=[guid]::NewGuid().ToString()
    $nextRecord=Start-EpigraphOwnedProcess $nextRequest $receipt.executable $receipt.executable $(if($Mode -eq 'main'){'--main'}else{'--test'}) $Fixture
    $nextReady=$null;$until=[DateTime]::UtcNow.AddSeconds(120)
    do{try{$nextReady=Invoke-EpigraphSessionControl $nextRequest attest $Fixture 3000;break}catch{Start-Sleep -Milliseconds 500}}while([DateTime]::UtcNow -lt $until)
    Result 'fresh run relaunch in the same disposable profile' ($nextReady -and $nextReady.runId -cne $request.RunId)
    $null=Invoke-EpigraphSessionControl $nextRequest focus $Fixture 10000
    $null=Invoke-EpigraphSessionControl $nextRequest shutdown $Fixture 30000
    Result 'relaunched exact run exit confirmed' ($script:EpigraphTickets[$nextRequest.RunId].RootExitConfirmed())
    $script:EpigraphTickets[$nextRequest.RunId].Dispose()
  } finally {$observed.Dispose()}
} catch {
  $results.Add(@{case='certification';status='FAIL';detail=$_.ToString()})
  Write-Error -ErrorAction Continue $_
} finally {
  $results | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Fixture 'results.json') -Encoding UTF8
  foreach($name in $old.Keys){[Environment]::SetEnvironmentVariable($name,$old[$name])}
  if($hostProcess){$hostProcess.Dispose()} # Never force a desktop after failure.
  Write-Output "B1 lifecycle evidence: $Fixture"
}
if(@($results | Where-Object status -eq FAIL).Count){exit 1}
