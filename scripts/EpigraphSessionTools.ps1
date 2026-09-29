$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'EpigraphOwnership.ps1')
$script:EpigraphTickets = @{}
function Use-EpigraphProcessInterop {
  if (-not ('EpigraphProcessNative' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'EpigraphProcessNative.cs') }
}
function Get-EpigraphSessionDirectory {
  Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Epigraph\launcher-sessions'
}
function Get-EpigraphBuildIdentity {
  param([string]$ProjectRoot, [string]$AppExe, [string]$Mode)
  $parts = @($Mode, (& git --no-optional-locks -C $ProjectRoot rev-parse HEAD), ((& git --no-optional-locks -C $ProjectRoot diff --binary HEAD -- 2>$null) -join "`n"))
  if ($LASTEXITCODE -ne 0) { throw 'Cannot establish worktree identity' }
  foreach ($file in (& git --no-optional-locks -C $ProjectRoot ls-files --others --exclude-standard)) {
    $parts += "$file $((Get-FileHash -LiteralPath (Join-Path $ProjectRoot $file) -Algorithm SHA256).Hash)"
  }
  if ($Mode -eq 'main') { $parts += (Get-FileHash -LiteralPath $AppExe -Algorithm SHA256).Hash }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($parts -join "`n"))))).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Get-EpigraphSessionRecords {
  param([string]$SessionDirectory = (Get-EpigraphSessionDirectory))
  if (!(Test-Path -LiteralPath $SessionDirectory)) { return }
  foreach ($file in Get-ChildItem -LiteralPath $SessionDirectory -Filter '*.json' -File) {
    try {
      $record = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
      if ($file.BaseName -cne $record.RunId) { continue }
      $record | Add-Member NoteProperty RecordPath $file.FullName
      $record | Add-Member NoteProperty RecordHash (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
      $record
    } catch { Write-Warning "Unverifiable session record preserved: $($file.Name)" }
  }
}
function Get-EpigraphSessionCandidates {
  param($Record)
  Use-EpigraphProcessInterop
  $snapshot = @([EpigraphProcessNative]::Snapshot($Record.Job))
  $root = @($snapshot | Where-Object Pid -eq $Record.RootPid)
  $rootExe = if ($root.Count -eq 1) { $root[0].Executable } else { $Record.RootExecutable }
  $rootAllowed = [IO.Path]::GetFileName($rootExe) -match '^(epigraph|node|cmd|powershell|pwsh|cargo|rustc|msedgewebview2|tauri-driver|msedgedriver)\.exe$'
  foreach ($native in $snapshot) {
    $name = [IO.Path]::GetFileName($native.Executable)
    # Desktop cleanup does not own persistent Core or runtime servers. The app's
    # own validated runtime cleanup handles its ephemeral Java child on close.
    $allowed = $name -match '^(epigraph|node|cmd|powershell|pwsh|cargo|rustc|msedgewebview2|tauri-driver|msedgedriver)\.exe$'
    # A permitted basename is only an exclusion filter, never ownership proof.
    # Preserve descendants of persistent/unknown services, including orphaned
    # descendants whose missing intermediate parent makes provenance ambiguous.
    $cursor=$native; $visited=@{}; $chain=$rootAllowed
    while ($cursor.Pid -ne $Record.RootPid) {
      if ($visited.ContainsKey($cursor.Pid)) { $chain=$false; break }
      $visited[$cursor.Pid]=$true
      if ($cursor.ParentPid -eq $Record.RootPid) { break }
      $parents=@($snapshot | Where-Object Pid -eq $cursor.ParentPid)
      if ($parents.Count -ne 1 -or [uint64]$parents[0].Created -gt [uint64]$cursor.Created) { $chain=$false; break }
      $cursor=$parents[0]
      if ([IO.Path]::GetFileName($cursor.Executable) -notmatch '^(epigraph|node|cmd|powershell|pwsh|cargo|rustc|msedgewebview2|tauri-driver|msedgedriver)\.exe$') { $chain=$false; break }
    }
    [pscustomobject]@{
      Pid=$native.Pid; Created=$native.Created; Executable=$native.Executable; Job=$native.Job
      IdentityVerified=$true; Persistent=(!$allowed -or !$chain); Window=$native.Window
      RootPid=$Record.RootPid; RootCreated=$(if ($root.Count -eq 1) { $root[0].Created } else { $Record.RootCreated })
      Native=$native
    }
  }
}
function Get-EpigraphOwnedInspection {
  param($Request, [string]$SessionDirectory = (Get-EpigraphSessionDirectory))
  foreach ($record in @(Get-EpigraphSessionRecords $SessionDirectory)) {
    try { $candidates = @(Get-EpigraphSessionCandidates $record) }
    catch { [pscustomobject]@{RunId=$record.RunId;Pid=$record.RootPid;Classification='UNVERIFIABLE';Record=$record;Candidate=$null}; continue }
    if (!$candidates.Count) { [pscustomobject]@{RunId=$record.RunId; Pid=$record.RootPid; Classification='STALE'; Record=$record; Candidate=$null} }
    foreach ($candidate in $candidates) {
      [pscustomobject]@{ RunId=$record.RunId; Pid=$candidate.Pid; Classification=(Get-EpigraphOwnershipDecision $record $Request $candidate); Record=$record; Candidate=$candidate }
    }
  }
}
function Invoke-EpigraphOwnedAction {
  param($Entry, [ValidateSet('focus','stop')] [string]$Action, $Request)
  if (!$Entry.Candidate -or (Get-EpigraphOwnershipDecision $Entry.Record $Request $Entry.Candidate) -ne 'MATCHING') { return $false }
  if (!(Test-Path -LiteralPath $Entry.Record.RecordPath) -or
      (Get-FileHash -LiteralPath $Entry.Record.RecordPath -Algorithm SHA256).Hash -cne $Entry.Record.RecordHash) { return $false }
  return [EpigraphProcessNative]::Act($Entry.Candidate.Native, $Action)
}
function Focus-EpigraphWindow {
  param($Request, [string]$SessionDirectory = (Get-EpigraphSessionDirectory))
  $entries = @(Get-EpigraphOwnedInspection $Request $SessionDirectory | Where-Object {
    $_.Classification -eq 'MATCHING' -and $_.Candidate.Executable -ieq $_.Record.AppExe -and
      (!$Request.ArtifactSha256 -or ($_.Record.ArtifactSha256 -ceq $Request.ArtifactSha256 -and $_.Record.BuildId -ceq $Request.BuildId))
  })
  if ($entries.Count -ne 1) { return $false }
  $exact=@{Project=$Request.Project;Profile=$Request.Profile;Build=$Request.Build;RunId=$entries[0].RunId}
  try { return (Invoke-EpigraphSessionControl $exact 'focus' $SessionDirectory) }
  catch { Write-Verbose $_; return $false }
}
function Invoke-EpigraphSessionControl {
  param($Request,[ValidateSet('attest','shutdown','focus','focus-main','challenge','verify-page')][string]$Action,
    [string]$SessionDirectory=(Get-EpigraphSessionDirectory),[int]$TimeoutMilliseconds=30000,[string]$Challenge,[string]$Proof)
  Use-EpigraphProcessInterop
  if(!$Request.RunId){throw 'Control requires an exact run UUID'}
  $records=@(Get-EpigraphSessionRecords $SessionDirectory | Where-Object RunId -CEQ $Request.RunId)
  if($records.Count -ne 1){throw 'Missing or ambiguous run evidence; preserved'}
  $record=$records[0]
  if($record.Schema -ne 1 -or $record.ControlVersion -ne 1 -or $record.Project -ine $Request.Project -or
    $record.Profile -cne $Request.Profile -or $record.Build -cne $Request.Build -or
    $record.Capability -notmatch '^[a-f0-9]{64}$' -or $record.ArtifactSha256 -notmatch '^[a-f0-9]{64}$' -or
    $record.RootExecutable -ine $record.AppExe){throw 'Legacy, foreign or incomplete control evidence; preserved'}
  # Prevent replacement of the evidence throughout the request and OS exit wait.
  $evidence=[IO.File]::Open($record.RecordPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $connection=$null
  $descendants=@();$preserved=@()
  try {
    if((Get-FileHash -LiteralPath $record.RecordPath -Algorithm SHA256).Hash -cne $record.RecordHash){throw 'Run evidence changed'}
    $identity=[EpigraphProcessNative+Identity]::new()
    $identity.Pid=$record.RootPid; $identity.Created=$record.RootCreated; $identity.Executable=$record.RootExecutable; $identity.Job=$record.Job
    $connection=[EpigraphProcessNative+ControlConnection]::Open($record.RunId,$identity,[Math]::Min(5000,$TimeoutMilliseconds))
    if($Action -eq 'shutdown') {
      foreach($entry in @(Get-EpigraphOwnedInspection $Request $SessionDirectory | Where-Object RunId -CEQ $Request.RunId)) {
        if($entry.Classification -eq 'UNVERIFIABLE' -or $entry.Classification -eq 'STALE'){throw 'Descendant evidence is ambiguous; shutdown refused'}
        if($entry.Classification -eq 'MATCHING' -and $entry.Pid -ne $record.RootPid){$descendants+=,[EpigraphProcessNative]::Observe($entry.Candidate.Native)}
        elseif($entry.Candidate -and $entry.Pid -ne $record.RootPid){$preserved+=,$entry.Candidate.Native}
      }
    }
    $nonce=[guid]::NewGuid().ToString()
    $message=@{version=1;runId=$record.RunId;nonce=$nonce;project=$record.Project;profile=$record.Profile;build=$record.Build;
      recordHash=$record.RecordHash.ToLowerInvariant();capability=$record.Capability;action=$Action;challenge=$Challenge;proof=$Proof}
    $reply=$connection.Exchange(($message | ConvertTo-Json -Compress),$TimeoutMilliseconds) | ConvertFrom-Json
    if(!$reply.accepted -or $reply.version -ne 1 -or $reply.runId -cne $record.RunId -or $reply.nonce -cne $nonce -or
      $reply.action -cne $Action -or $reply.recordHash -cne $record.RecordHash.ToLowerInvariant() -or
      $reply.build -cne $record.Build -or $reply.artifactSha256 -cne $record.ArtifactSha256 -or $reply.buildId -cne $record.BuildId -or
      $reply.pid -ne $record.RootPid -or $reply.created -cne $record.RootCreated){throw "Control acknowledgement rejected; evidence retained ($($reply.detail))"}
    if($Action -eq 'shutdown') {
      if(!$connection.WaitForExit($TimeoutMilliseconds)){throw 'Exact process exit timed out; evidence retained'}
      foreach($child in $descendants){if(!$child.Wait($TimeoutMilliseconds)){throw 'Owned descendant exit unconfirmed; session evidence retained'}}
      if(!$connection.JobEmpty()) {
        $remaining=@([EpigraphProcessNative]::Snapshot($record.Job))
        if(!(Test-EpigraphJobRemainder $preserved $remaining ($connection.JobActiveProcesses()))){throw 'New, missing or unverifiable job member; session cleanup not confirmed'}
      }
      # Append-only completion evidence. Acknowledgement alone never grants cleanup.
      $receiptPath=$record.RecordPath+'.closed-'+$nonce
      $receipt=@{version=1;runId=$record.RunId;recordHash=$record.RecordHash;ack=$reply;exitConfirmed=$true;observedOwnedDescendantsConfirmed=$true;preservedServices=$preserved} | ConvertTo-Json -Depth 6
      $bytes=[Text.Encoding]::UTF8.GetBytes($receipt)
      $stream=[IO.File]::Open($receiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
      try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    }
    return $reply
  } finally { foreach($child in $descendants){$child.Dispose()};if($connection){$connection.Dispose()};$evidence.Dispose() }
}
function Stop-EpigraphOwnedSession {
  param($Request, [string]$SessionDirectory = (Get-EpigraphSessionDirectory), [int]$TimeoutSeconds=15)
  if (!$Request.RunId) { throw 'Cleanup requires an explicit run identity' }
  $records=@(Get-EpigraphSessionRecords $SessionDirectory | Where-Object RunId -CEQ $Request.RunId)
  if ($records.Count -ne 1 -or $records[0].Project -ine $Request.Project -or
      $records[0].Profile -cne $Request.Profile -or $records[0].Build -cne $Request.Build) { throw 'Missing, ambiguous or foreign run evidence; cleanup refused' }
  $inventory=@(Get-EpigraphOwnedInspection $Request $SessionDirectory | Where-Object RunId -CEQ $Request.RunId)
  $desktop=@($inventory | Where-Object { $_.Classification -eq 'MATCHING' -and [IO.Path]::GetFileName($_.Candidate.Executable) -ieq 'epigraph.exe' })
  if($desktop.Count) {
    # A desktop can create a runtime immediately after an inventory check.
    # Only application acknowledgement can make force-stop safe for its children.
    $null=Invoke-EpigraphSessionControl $Request 'shutdown' $SessionDirectory ($TimeoutSeconds*1000)
    return
  }
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $confirmedActions=0
  $entries = @(Get-EpigraphOwnedInspection $Request $SessionDirectory | Where-Object Classification -eq 'MATCHING')
  # Re-enumeration never widens scope; each action opens, validates, terminates and
  # waits on one process handle. Evidence files are retained, including on failure.
  do {
    $entries = @(Get-EpigraphOwnedInspection $Request $SessionDirectory | Where-Object Classification -eq 'MATCHING')
    foreach ($entry in $entries | Sort-Object { [uint64]$_.Candidate.Created } -Descending) {
      if ([DateTime]::UtcNow -ge $deadline) { break }
      if(Invoke-EpigraphOwnedAction $entry 'stop' $Request){$confirmedActions++}
    }
  } while ($entries.Count -and [DateTime]::UtcNow -lt $deadline)
  $remaining = @(Get-EpigraphOwnedInspection $Request $SessionDirectory | Where-Object Classification -eq 'MATCHING')
  $unknown=@(Get-EpigraphOwnedInspection $Request $SessionDirectory | Where-Object { $_.RunId -ceq $Request.RunId -and $_.Classification -eq 'UNVERIFIABLE' })
  if ($remaining.Count -or $unknown.Count) { throw 'Owned cleanup incomplete or unverifiable; process evidence retained' }
  $retained=$script:EpigraphTickets[$Request.RunId]
  if($confirmedActions -eq 0 -and (!$retained -or $retained.Identity.Created -cne $records[0].RootCreated -or !$retained.RootExitConfirmed())) {
    throw 'No retained exit proof; empty inventory does not confirm cleanup'
  }
}
function Start-EpigraphOwnedProcess {
  param($Request, [string]$AppExe, [string]$Executable, [string]$Arguments, [string]$SessionDirectory = (Get-EpigraphSessionDirectory))
  Use-EpigraphProcessInterop
  $run=[guid]::Empty
  if (![guid]::TryParse([string]$Request.RunId,[ref]$run) -or $run -eq [guid]::Empty -or
      $Request.RunId -cne $run.ToString() -or !$Request.Project -or !$Request.Profile -or
      $Request.Build -notmatch '^[a-fA-F0-9]{64}$' -or !$AppExe) { throw 'Launch requires complete scope and a canonical unique run identity' }
  $null = New-Item -ItemType Directory -Force -Path $SessionDirectory
  $recordPath = Join-Path $SessionDirectory "$($Request.RunId).json"
  if (Test-Path -LiteralPath $recordPath) { throw 'Run evidence already exists' }
  $artifact=$null
  if($Request.ArtifactSha256) {
    $validated=& node (Join-Path $PSScriptRoot 'epigraph-build-receipt.mjs') validate $Request.ReceiptPath $Request.Project $Request.Profile $Request.Mode
    if($LASTEXITCODE -ne 0){throw 'Build receipt rejected before spawn'}
    $validated=$validated | ConvertFrom-Json
    if($validated.executable -ine $AppExe -or $validated.executableSha256 -cne $Request.ArtifactSha256 -or
      $validated.buildId -cne $Request.BuildId -or $validated.sourceFingerprint -cne $Request.Build){throw 'Receipt and launch request disagree'}
    $artifact=[IO.File]::Open($AppExe,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    if((Get-FileHash -LiteralPath $AppExe -Algorithm SHA256).Hash -ine $Request.ArtifactSha256) {
      $artifact.Dispose();throw 'Artifact replaced before process creation; launch refused'
    }
  }
  $previousRecord=$env:EPIGRAPH_SESSION_RECORD; $previousRun=$env:EPIGRAPH_SESSION_RUN
  try {
    $env:EPIGRAPH_SESSION_RECORD=$recordPath; $env:EPIGRAPH_SESSION_RUN=$Request.RunId
    $ticket = [EpigraphProcessNative]::StartSuspended($Executable,$Arguments,$Request.Project,"Local\Epigraph-$($Request.RunId)")
  } finally { $env:EPIGRAPH_SESSION_RECORD=$previousRecord; $env:EPIGRAPH_SESSION_RUN=$previousRun; if($artifact){$artifact.Dispose()} }
  try {
    $record = [ordered]@{ Schema=1; Project=$Request.Project; Profile=$Request.Profile; RunId=$Request.RunId; Build=$Request.Build
      Job="Local\Epigraph-$($Request.RunId)"; AppExe=$AppExe; RootPid=$ticket.Identity.Pid; RootCreated=$ticket.Identity.Created; RootExecutable=$ticket.Identity.Executable }
    if($Request.ArtifactSha256) {
      $record.ControlVersion=1; $record.Capability=([guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N'))
      $record.ArtifactSha256=$Request.ArtifactSha256; $record.BuildId=$Request.BuildId; $record.ReceiptPath=$Request.ReceiptPath
      $record.CoreSha256=$validated.coreSha256
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json))
    $temporary = "$recordPath.new"
    $stream = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    [IO.File]::Move($temporary,$recordPath)
    $ticket.Resume()
    $script:EpigraphTickets[$Request.RunId] = $ticket
    return [pscustomobject]$record
  } catch {
    if (!$ticket.Abort()) { Write-Warning 'Interrupted launch could not confirm process exit; evidence retained' }
    throw
  } finally { if (!$script:EpigraphTickets.ContainsKey($Request.RunId)) { $ticket.Dispose() } }
}
function Start-EpigraphDesktop {
  param([string]$ProjectRoot, [ValidateSet('dev','main')][string]$Mode='dev', [switch]$Inspect, [string]$ReceiptPath)
  $root=(Resolve-Path -LiteralPath $ProjectRoot).Path
  $profile=Get-EpigraphLaunchProfileIdentity $Mode
  $receiptTool=Join-Path $PSScriptRoot 'epigraph-build-receipt.mjs'
  if(!$ReceiptPath){$ReceiptPath=$env:EPIGRAPH_CANDIDATE_RECEIPT}
  if(!$ReceiptPath -and !$Inspect) {
    $built=@(& (Join-Path $PSScriptRoot 'build-epigraph-candidate.ps1') -ProjectRoot $root -Mode $Mode -Profile $profile)
    $ReceiptPath=[string]$built[-1]
  }
  if(!$ReceiptPath){
    $request=@{Project=$root;Profile=$profile;Build=('0'*64);RunId=$null}
    Get-EpigraphOwnedInspection $request | Select-Object RunId,Pid,Classification
    return
  }
  $receiptJson=& node $receiptTool validate $ReceiptPath $root $profile $Mode
  if($LASTEXITCODE -ne 0){throw 'Candidate receipt rejected; existing processes preserved'}
  $receipt=$receiptJson | ConvertFrom-Json
  $app=$receipt.executable
  $request=@{Project=$root;Profile=$profile;Build=$receipt.sourceFingerprint;RunId=$null;
    ArtifactSha256=$receipt.executableSha256;BuildId=$receipt.buildId;ReceiptPath=$ReceiptPath;Mode=$Mode}
  if($Inspect){Get-EpigraphOwnedInspection $request | Select-Object RunId,Pid,Classification;return}
  $focused=Focus-EpigraphWindow $request; if($focused){return $focused}
  $matching=@(Get-EpigraphOwnedInspection $request | Where-Object Classification -eq 'MATCHING')
  if($matching.Count){throw 'Matching run is starting or ambiguous; preserved'}
  $request.RunId=[guid]::NewGuid().ToString()
  $sessionDirectory=Get-EpigraphSessionDirectory
  $null=New-Item -ItemType Directory -Force -Path $sessionDirectory
  $launchPath=Join-Path $sessionDirectory "$($request.RunId).launch.json"
  $arguments=if($Mode -eq 'main'){'--main'}else{'--test'}
  @{Request=$request;AppExe=$app;Executable=$app;Arguments=$arguments} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $launchPath -Encoding UTF8
  $hostExe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $hostScript=Join-Path $PSScriptRoot 'run-epigraph-session.ps1'
  $null=Start-Process -FilePath $hostExe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$hostScript+'"'),'-LaunchPath',('"'+$launchPath+'"')) -PassThru
  $deadline=[DateTime]::UtcNow.AddSeconds(90)
  do {
    try {
      $action=if($Mode -eq 'main'){'focus-main'}else{'focus'}
      $reply=Invoke-EpigraphSessionControl $request $action $sessionDirectory 10000
      return $reply
    } catch { Start-Sleep -Milliseconds 500 }
  } while([DateTime]::UtcNow -lt $deadline)
  throw "Run $($request.RunId) did not acknowledge readiness; processes and evidence preserved."
}

function Get-EpigraphLaunchProfileIdentity {
  param([ValidateSet('dev','main')][string]$Mode)
  # Bind selection to the environment actually inherited by the run host.
  # Hash scope settings so diagnostic records do not contain their raw values.
  $parts=@($Mode,[Environment]::GetFolderPath('LocalApplicationData'),[Environment]::GetFolderPath('ApplicationData'))
  foreach($name in @('LOCALAPPDATA','APPDATA','EPIGRAPH_LAUNCH_PROFILE','EPIGRAPH_LOCAL_SERVER_MAIN_ROOT','EPIGRAPH_LOCAL_SERVER_TEST_ROOT','EPIGRAPH_SYNCD_DESKTOP_STATE_DIR','EPIGRAPH_SYNCD_DATA_DIR','EPIGRAPH_SYNCD_PORT','EPIGRAPH_SYNCD_OWNERSHIP','AETHON_SYNCD_OWNERSHIP')) {
    $parts+=$name+'='+[Environment]::GetEnvironmentVariable($name)
  }
  $sha=[Security.Cryptography.SHA256]::Create()
  try { return $Mode+'|'+([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($parts -join "`n"))))).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Assert-EpigraphOwnedEndpoint {
  param($Request,[int]$Port)
  $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  if($listeners.Count -ne 1) { throw 'Endpoint ownership is missing or ambiguous; connection refused' }
  $entries=@(Get-EpigraphOwnedInspection $Request | Where-Object { $_.Classification -eq 'MATCHING' -and $_.Pid -eq $listeners[0] })
  if($entries.Count -ne 1 -or ![EpigraphProcessNative]::Act($entries[0].Candidate.Native,'verify')) {
    throw 'Endpoint is not a verified member of the requested run; connection refused'
  }
}

function Stop-EpigraphRetainedProcess {
  param([Parameter(Mandatory)][System.Diagnostics.Process]$Process)
  Use-EpigraphProcessInterop
  if (![EpigraphProcessNative]::StopRetained($Process)) { throw 'Retained process termination unconfirmed' }
}
