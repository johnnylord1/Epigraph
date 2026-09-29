$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'EpigraphSessionTools.ps1')
Use-EpigraphProcessInterop
$fixture=Join-Path $env:TEMP ('epigraph-b1-job-'+[guid]::NewGuid())
$null=New-Item -ItemType Directory -Path $fixture
$shell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$tools=Join-Path $PSScriptRoot 'EpigraphSessionTools.ps1'
function Encoded([string]$Code){[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Code))}
function Assert($Name,$Value){if(!$Value){throw $Name};Write-Output "PASS $Name"}
foreach($anchor in @($false,$true)) {
  $run=[guid]::NewGuid().ToString();$dir=Join-Path $fixture $run;$null=New-Item -ItemType Directory -Path $dir
  $recordPath=Join-Path $dir ($run+'.json');$ready=Join-Path $dir 'ready'
  $child=@'
$ErrorActionPreference='Stop'
. '__TOOLS__'
Use-EpigraphProcessInterop
$record=Get-Content -LiteralPath $env:EPIGRAPH_SESSION_RECORD -Raw | ConvertFrom-Json
$identity=[EpigraphProcessNative+Identity]::new()
$identity.Pid=$record.RootPid;$identity.Created=$record.RootCreated;$identity.Executable=$record.RootExecutable;$identity.Job=$record.Job
$anchor=$null
if(__ANCHOR__){$anchor=[EpigraphProcessNative]::Observe($identity)}
if(__ANCHOR__){
  $nestedRequest=@{Project=$record.Project;Profile='nested-fixture';Build=('b'*64);RunId=[guid]::NewGuid().ToString()}
  $nested=Start-EpigraphOwnedProcess $nestedRequest $record.AppExe $record.AppExe '-NoProfile -Command "Start-Sleep -Seconds 2"' (Split-Path -Parent $env:EPIGRAPH_SESSION_RECORD)
  $member=@([EpigraphProcessNative]::Snapshot($nested.Job) | Where-Object Pid -eq $nested.RootPid)[0]
  $inner=[EpigraphProcessNative]::Observe($member)
  $member.Job=$record.Job
  $outer=[EpigraphProcessNative]::Observe($member)
  try {
    [IO.File]::WriteAllText('__READY__.nested',([pscustomobject]@{innerAndOuterMembership=$true;creation=$member.Created;recordedCreation=$nested.RootCreated;jobProperties=[EpigraphProcessNative]::InspectJob($nested.Job)} | ConvertTo-Json))
    if(!$inner.Wait(6000)){throw 'Nested fixture exit not confirmed'}
  }finally{$outer.Dispose();$inner.Dispose();$script:EpigraphTickets[$nestedRequest.RunId].Dispose()}
}
[IO.File]::WriteAllText('__READY__','ready')
try{Start-Sleep -Seconds 12}finally{if($anchor){$anchor.Dispose()}}
'@
  $child=$child.Replace('__TOOLS__',$tools.Replace("'","''")).Replace('__READY__',$ready.Replace("'","''")).Replace('__ANCHOR__',('$'+$anchor.ToString().ToLowerInvariant()))
  $arguments='-NoProfile -EncodedCommand '+(Encoded $child)
  $hostCode=@'
$ErrorActionPreference='Stop'
. '__TOOLS__'
$request=@{Project='__PROJECT__';Profile='disposable-job';Build=('a'*64);RunId='__RUN__'}
$null=Start-EpigraphOwnedProcess $request '__SHELL__' '__SHELL__' '__ARGUMENTS__' '__DIRECTORY__'
Start-Sleep -Seconds 25
'@
  $hostCode=$hostCode.Replace('__TOOLS__',$tools).Replace('__PROJECT__',$fixture).Replace('__RUN__',$run).Replace('__SHELL__',$shell).Replace('__ARGUMENTS__',$arguments).Replace('__DIRECTORY__',$dir)
  $hostProcess=Start-Process -FilePath $shell -WindowStyle Hidden -ArgumentList @('-NoProfile','-EncodedCommand',(Encoded $hostCode)) -PassThru
  $childProcess=$null;$observation=$null
  try {
    $deadline=[DateTime]::UtcNow.AddSeconds(10)
    while(!(Test-Path $ready) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
    Assert 'child resumed after exact record publication' (Test-Path $ready)
    if($anchor){
      $nested=Get-Content ($ready+'.nested') -Raw | ConvertFrom-Json
      Assert 'actual nested launch belongs to both jobs with recorded creation' ($nested.innerAndOuterMembership -and $nested.creation -ceq $nested.recordedCreation)
      Assert 'nested launch has no kill-on-close or breakaway after resume' ($nested.jobProperties.StartsWith('flags=0 '))
    }
    $record=Get-Content $recordPath -Raw | ConvertFrom-Json
    Assert 'persisted job derives from canonical run UUID' ($record.Job -ceq "Local\Epigraph-$run")
    $properties=[EpigraphProcessNative]::InspectJob($record.Job)
    Assert 'kill-on-close and both breakaway flags disabled after resume' ($properties.StartsWith('flags=0 '))
    Write-Output $properties
    $snapshot=@([EpigraphProcessNative]::Snapshot($record.Job));$identity=@($snapshot | Where-Object Pid -eq $record.RootPid)[0]
    Assert 'published birth identity matches candidate handle' ($identity.Created -ceq $record.RootCreated)
    $childProcess=[Diagnostics.Process]::GetProcessById($record.RootPid)
    $null=$childProcess.Handle # Read-only retained wait; this object never authorizes termination.
    $wrong=[EpigraphProcessNative+Identity]::new();$wrong.Pid=$identity.Pid;$wrong.Created='133700000000000001';$wrong.Executable=$identity.Executable;$wrong.Job=$identity.Job
    $rejected=$false;try{$bad=[EpigraphProcessNative]::Observe($wrong);$bad.Dispose()}catch{$rejected=$true}
    Assert 'same job plus wrong creation identity rejected' $rejected
    Assert 'terminate only retained disposable hidden host' ([EpigraphProcessNative]::StopRetained($hostProcess))
    Assert 'published child survives run-host death' (!$childProcess.HasExited)
    $reopened=$false
    try{$observation=[EpigraphProcessNative]::Observe($identity);$reopened=$true}catch{}
    Assert "recovery availability agrees with retained existing job anchor=$anchor" ($reopened -eq $anchor)
    if($observation){Assert 'recovery validates candidate membership through retained process handle' (!$observation.Wait(0))}
    Assert 'child natural exit confirmed through retained OS object' ($childProcess.WaitForExit(18000))
    if($observation){Assert 'recovered process handle confirms same object exited' ($observation.Wait(0))}
    Assert 'ownership evidence preserved' (Test-Path $recordPath)
  } finally {
    if($observation){$observation.Dispose()};if($childProcess){$childProcess.Dispose()}
    if(!$hostProcess.HasExited){$null=[EpigraphProcessNative]::StopRetained($hostProcess)};$hostProcess.Dispose()
  }
}
Write-Output "Job recovery evidence: $fixture"
