$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'EpigraphSessionTools.ps1')
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('epigraph-b1-'+[guid]::NewGuid())
$null=New-Item -ItemType Directory -Path $testRoot
$exe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$requests=@()
$passed=0
$listeners=@()
$persistentRequest=$null
$desktopRequest=$null
function Assert($Name,$Condition) { if(!$Condition){throw $Name}; $script:passed++;Write-Output "PASS $Name" }
try {
  foreach($port in @(1420,4667,9223)) {
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port)
    try { $listener.Start(); $listeners+=,$listener }
    catch { Write-Output "SKIP disposable listener $port (already occupied; preserved)" }
  }
  foreach($profile in @('owned','foreign-profile','foreign-worktree')) {
    $request=@{Project=$(if($profile -eq 'foreign-worktree'){$PSScriptRoot}else{$testRoot});Profile=$profile;Build='a'*64;RunId=[guid]::NewGuid().ToString()}
    $requests+=,$request
    $null=Start-EpigraphOwnedProcess $request $exe $exe '-NoProfile -Command "Start-Sleep -Seconds 120"' $testRoot
  }
  $owned=@(Get-EpigraphOwnedInspection $requests[0] $testRoot | Where-Object Classification -eq 'MATCHING')
  Assert 'run host retains kernel job capability for discovery' ($owned.Count -eq 1)
  $stale=$owned[0].Candidate.Native.Created
  $owned[0].Candidate.Native.Created='133700000000000001'
  Assert 'same PID with stale creation cannot be terminated' (!(Invoke-EpigraphOwnedAction $owned[0] 'stop' $requests[0]))
  $owned[0].Candidate.Native.Created=$stale
  $recordPath=$owned[0].Record.RecordPath
  $recordBytes=[IO.File]::ReadAllBytes($recordPath)
  try {
    [IO.File]::WriteAllText($recordPath,'{malformed')
    Assert 'malformed replacement record rejects destructive action' (!(Invoke-EpigraphOwnedAction $owned[0] 'stop' $requests[0]))
    Assert 'malformed evidence is retained' ([IO.File]::ReadAllText($recordPath) -ceq '{malformed')
  } finally { [IO.File]::WriteAllBytes($recordPath,$recordBytes) }
  Assert 'rejected metadata leaves the process alive' (@(Get-EpigraphOwnedInspection $requests[0] $testRoot | Where-Object Classification -eq 'MATCHING').Count -eq 1)
  Stop-EpigraphOwnedSession $requests[0] $testRoot
  Assert 'owned root terminated' (@(Get-EpigraphOwnedInspection $requests[0] $testRoot | Where-Object Classification -eq 'MATCHING').Count -eq 0)
  foreach($listener in $listeners) {
    $port=$listener.LocalEndpoint.Port
    $client=[Net.Sockets.TcpClient]::new()
    try { $client.Connect('127.0.0.1',$port); Assert "unrelated listener $port survives cleanup" $client.Connected }
    finally { $client.Dispose() }
  }
  foreach($request in $requests[1..2]) {
    Assert "$($request.Profile) survives other run cleanup" (@(Get-EpigraphOwnedInspection $request $testRoot | Where-Object Classification -eq 'MATCHING').Count -eq 1)
  }
  Stop-EpigraphOwnedSession $requests[0] $testRoot
  Assert 'repeated cleanup preserves evidence' (Test-Path -LiteralPath (Join-Path $testRoot "$($requests[0].RunId).json"))

  $request=@{Project=$testRoot;Profile='descendants';Build='a'*64;RunId=[guid]::NewGuid().ToString()};$requests+=,$request
  $command="Start-Process -FilePath '$exe' -WindowStyle Hidden -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 120' | Out-Null; Start-Sleep -Seconds 2"
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $null=Start-EpigraphOwnedProcess $request $exe $exe "-NoProfile -EncodedCommand $encoded" $testRoot
  Start-Sleep -Seconds 3
  Assert 'descendant remains owned after root exit' (@(Get-EpigraphOwnedInspection $request $testRoot | Where-Object Classification -eq 'MATCHING').Count -ge 1)
  Stop-EpigraphOwnedSession $request $testRoot
  Assert 'owned descendants cleaned after interrupted root' (@(Get-EpigraphOwnedInspection $request $testRoot | Where-Object Classification -eq 'MATCHING').Count -eq 0)

  # Closing the startup capability before publication must stop only the
  # suspended fixture root. A read-only process handle confirms its exit.
  $ticket=[EpigraphProcessNative]::StartSuspended($exe,'-NoProfile -Command "Start-Sleep -Seconds 120"',$testRoot,('Local\Epigraph-'+[guid]::NewGuid()))
  $observer=[Diagnostics.Process]::GetProcessById($ticket.Identity.Pid)
  $null=$observer.Handle
  $ticket.Dispose()
  try { Assert 'interruption before publication confirms suspended root exit' ($observer.WaitForExit(5000)) }
  finally { $observer.Dispose() }

  $fakeCore=Join-Path $testRoot 'epigraph-syncd.exe'
  Add-Type -OutputAssembly $fakeCore -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.Diagnostics;
public class B1DisposableCore {
  public static void Main() {
    var start=new ProcessStartInfo("powershell.exe","-NoProfile -Command Start-Sleep -Seconds 30");
    start.UseShellExecute=false; start.CreateNoWindow=true;
    using(var child=Process.Start(start)) { child.WaitForExit(); }
  }
}
'@
  $persistentRequest=@{Project=$testRoot;Profile='persistent-exclusion';Build='a'*64;RunId=[guid]::NewGuid().ToString()}
  $command="Start-Process -FilePath '$fakeCore' -WindowStyle Hidden | Out-Null; Start-Sleep -Seconds 30"
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $null=Start-EpigraphOwnedProcess $persistentRequest $exe $exe "-NoProfile -EncodedCommand $encoded" $testRoot
  Start-Sleep -Seconds 2
  $before=@(Get-EpigraphOwnedInspection $persistentRequest $testRoot | Where-Object RunId -eq $persistentRequest.RunId)
  $protected=@($before | Where-Object { $_.Classification -eq 'FOREIGN' -and [IO.Path]::GetFileName($_.Candidate.Executable) -in @('epigraph-syncd.exe','powershell.exe') })
  Assert 'persistent Core and its allowed-name descendant are excluded' ($protected.Count -eq 2)
  Stop-EpigraphOwnedSession $persistentRequest $testRoot
  $after=@(Get-EpigraphOwnedInspection $persistentRequest $testRoot | Where-Object { $_.RunId -eq $persistentRequest.RunId -and $_.Classification -eq 'FOREIGN' })
  Assert 'persistent Core and descendant survive desktop cleanup' (@($after | Where-Object Pid -in $protected.Pid).Count -eq 2)

  $unknown=@{Project=$testRoot;Profile='unknown';Build='a'*64;RunId=[guid]::NewGuid().ToString()}
  $rejected=$false
  try { Stop-EpigraphOwnedSession $unknown $testRoot } catch { $rejected=$true }
  Assert 'missing run evidence cannot report successful cleanup' $rejected

  $fakeDesktop=Join-Path $testRoot 'epigraph.exe'
  Add-Type -OutputAssembly $fakeDesktop -OutputType ConsoleApplication -TypeDefinition @'
public class B1DisposableDesktop {
  public static void Main() { System.Threading.Thread.Sleep(30000); }
}
'@
  $desktopRequest=@{Project=$testRoot;Profile='desktop-refusal';Build='a'*64;RunId=[guid]::NewGuid().ToString()}
  $null=Start-EpigraphOwnedProcess $desktopRequest $fakeDesktop $fakeDesktop '' $testRoot
  $desktop=@(Get-EpigraphOwnedInspection $desktopRequest $testRoot | Where-Object Classification -eq 'MATCHING')[0]
  $rejected=$false
  try { Stop-EpigraphOwnedSession $desktopRequest $testRoot } catch { $rejected=$true }
  Assert 'managed desktop force-stop is refused' $rejected
  Assert 'native action also refuses a desktop born after preflight' (![EpigraphProcessNative]::Act($desktop.Candidate.Native,'stop'))
  Assert 'refused desktop remains alive' ([EpigraphProcessNative]::Act($desktop.Candidate.Native,'verify'))
  Write-Output "RESULT $script:passed passed; evidence $testRoot"
} finally {
  foreach($listener in $listeners) { $listener.Stop() }
  # These are exclusively the disposable fake-Core fixture's job members.
  # Test teardown has explicit authority over that fixture, unlike app cleanup.
  if($persistentRequest) {
    foreach($member in [EpigraphProcessNative]::Snapshot("Local\Epigraph-$($persistentRequest.RunId)")) {
      $null=[EpigraphProcessNative]::Act($member,'stop')
    }
  }
  if($desktopRequest) { $null=$script:EpigraphTickets[$desktopRequest.RunId].Abort() }
  foreach($request in $requests) { Stop-EpigraphOwnedSession $request $testRoot }
}
