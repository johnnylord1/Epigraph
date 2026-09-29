$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'EpigraphSessionTools.ps1')
Use-EpigraphProcessInterop
$fixture=Join-Path $env:TEMP ('epigraph-b1-control-'+[guid]::NewGuid())
$null=New-Item -ItemType Directory -Path $fixture
$shell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$passed=0
function Assert($Name,$Value){if(!$Value){throw $Name};$script:passed++;Write-Output "PASS $Name"}
function SpawnFixture([string]$Code) {
  $request=@{Project=$fixture;Profile='control-test';Build=('a'*64);RunId=[guid]::NewGuid().ToString()}
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Code))
  $record=Start-EpigraphOwnedProcess $request $shell $shell ('-NoProfile -EncodedCommand '+$encoded) $fixture
  return $script:EpigraphTickets[$request.RunId]
}
function ServerCode([string]$PipeRun,[string]$Ready) {
  return @'
$ErrorActionPreference='Stop'
$run='__RUN__';if(!$run){$run=$env:EPIGRAPH_SESSION_RUN}
$pipe=[IO.Pipes.NamedPipeServerStream]::new(('Epigraph-'+$run),[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous)
try {
  $pending=$pipe.BeginWaitForConnection($null,$null)
  [IO.File]::WriteAllText('__READY__','ready')
  if(!$pending.AsyncWaitHandle.WaitOne(8000)){exit 0}
  $pipe.EndWaitForConnection($pending)
  $reader=[IO.StreamReader]::new($pipe);$writer=[IO.StreamWriter]::new($pipe);$writer.AutoFlush=$true;$writer.NewLine="`n"
  $request=$reader.ReadLine()
  if($request){$writer.WriteLine('ack:'+ $request)}
  Start-Sleep -Milliseconds 1200
}finally{$pipe.Dispose()}
'@.Replace('__RUN__',$PipeRun).Replace('__READY__',$Ready.Replace("'","''"))
}
function WaitReady($Path){$until=[DateTime]::UtcNow.AddSeconds(8);while(!(Test-Path $Path) -and [DateTime]::UtcNow -lt $until){Start-Sleep -Milliseconds 50};Assert 'disposable endpoint ready' (Test-Path $Path)}
$tickets=@()
try {
  $ready=Join-Path $fixture 'positive-ready'
  $ticket=SpawnFixture (ServerCode '' $ready);$tickets+=,$ticket;WaitReady $ready
  $run=$ticket.Identity.Job.Substring('Local\Epigraph-'.Length)
  $connection=[EpigraphProcessNative+ControlConnection]::Open($run,$ticket.Identity,1500)
  try {
    $reply=$connection.Exchange('nonce-fixture',1500)
    Assert 'actual connected pipe belongs to retained validated process' ($reply -ceq 'ack:nonce-fixture')
    Assert 'acknowledgement does not mean process exit' (!$connection.WaitForExit(5))
    Assert 'later completion uses same retained process object' ($connection.WaitForExit(5000))
  }finally{$connection.Dispose()}
  $target=SpawnFixture 'Start-Sleep -Seconds 10';$tickets+=,$target
  $targetRun=$target.Identity.Job.Substring('Local\Epigraph-'.Length)
  $ready=Join-Path $fixture 'foreign-ready'
  $foreign=SpawnFixture (ServerCode $targetRun $ready);$tickets+=,$foreign;WaitReady $ready
  $rejected=$false
  try{$bad=[EpigraphProcessNative+ControlConnection]::Open($targetRun,$target.Identity,1500);$bad.Dispose()}catch{$rejected=$true}
  Assert 'correct pipe name hosted by another process is rejected' $rejected
  Assert 'rejection preserves intended process' (!$target.RootExitConfirmed())
  Assert 'rejection preserves foreign endpoint process' (!$foreign.RootExitConfirmed())
  Assert 'session metadata retained' (@(Get-ChildItem -LiteralPath $fixture -Filter '*.json').Count -eq 3)
}finally{
  # These capabilities came directly from the disposable fixture spawn, never PID lookup.
  foreach($ticket in $tickets){if(!$ticket.RootExitConfirmed()){$null=$ticket.Abort()};$ticket.Dispose()}
}

# A nonempty kernel job must not become completed through an incomplete inventory.
$known=@{Pid=42;Created='133700000000000001';Executable='core.exe'}
Assert 'nonempty job plus empty inventory cannot confirm cleanup' (!(Test-EpigraphJobRemainder @($known) @() 1))
Assert 'missing job member cannot confirm cleanup' (!(Test-EpigraphJobRemainder @($known) @($known) 2))
Assert 'unavailable kernel accounting cannot confirm cleanup' (!(Test-EpigraphJobRemainder @($known) @() -1))
Assert 'positively empty kernel job permits completion' (Test-EpigraphJobRemainder @($known) @() 0)
Assert 'exact known preserved service remains explicitly accounted for' (Test-EpigraphJobRemainder @($known) @($known) 1)
$reused=@{Pid=42;Created='133700000000000002';Executable='core.exe'}
Assert 'same PID and name with another creation identity is not a preserved service' (!(Test-EpigraphJobRemainder @($known) @($reused) 1))

# Selection regression: do not infer exact compiled artifact from equal source hash.
$script:exchangeCount=0
function Get-EpigraphOwnedInspection {param($Request,$SessionDirectory);return $script:entries}
function Invoke-EpigraphSessionControl {param($Request,$Action,$SessionDirectory);$script:exchangeCount++;return @{runId=$Request.RunId;nonce='returned-ack'}}
$request=@{Project=$fixture;Profile='control-test';Build=('a'*64);ArtifactSha256=('b'*64);BuildId='requested-build'}
$entry=[pscustomobject]@{Classification='MATCHING';RunId='fixture-run';Candidate=@{Executable='fixture.exe';Window=0};Record=@{AppExe='fixture.exe';ArtifactSha256=('c'*64);BuildId='other-build'}}
$script:entries=@($entry)
Assert 'same source but different artifact is never focused' (!(Focus-EpigraphWindow $request $fixture) -and $script:exchangeCount -eq 0)
$entry.Record.ArtifactSha256=$request.ArtifactSha256;$entry.Record.BuildId=$request.BuildId
$ack=Focus-EpigraphWindow $request $fixture
Assert 'exact artifact uses native control without HWND authority and returns acknowledgement' ($ack.nonce -ceq 'returned-ack' -and $script:exchangeCount -eq 1)
$script:entries=@($entry,$entry)
Assert 'ambiguous exact candidates are refused' (!(Focus-EpigraphWindow $request $fixture) -and $script:exchangeCount -eq 1)
Write-Output "RESULT $passed passed; evidence: $fixture"
