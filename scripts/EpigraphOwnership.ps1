# Pure decisions. Discovery supplies kernel job membership, never a port/name guess.
function Test-EpigraphJobRemainder {
  param($Preserved,$Remaining,[int]$ActiveProcesses)
  if($ActiveProcesses -lt 0 -or @($Remaining).Count -ne $ActiveProcesses){return $false}
  foreach($candidate in @($Remaining)){
    $matching=@($Preserved | Where-Object {
      $_.Pid -eq $candidate.Pid -and $_.Created -ceq $candidate.Created -and $_.Executable -ieq $candidate.Executable
    })
    if($matching.Count -ne 1){return $false}
  }
  return $true
}
function Get-EpigraphOwnershipDecision {
  param($Record, $Request, $Candidate)
  if (!$Record -or !$Request -or !$Candidate) { return 'UNVERIFIABLE' }
  $run = [guid]::Empty
  if ($Record.Schema -ne 1 -or ![guid]::TryParse([string]$Record.RunId, [ref]$run) -or $run -eq [guid]::Empty -or
      !$Record.Project -or !$Record.Profile -or !$Record.AppExe -or !$Record.RootPid -or
      [string]$Record.RootCreated -notmatch '^[1-9][0-9]+$' -or [string]$Record.Build -notmatch '^[a-fA-F0-9]{64}$' -or
      $Record.Job -cne "Local\Epigraph-$($Record.RunId)" -or !$Candidate.IdentityVerified -or
      !$Candidate.Pid -or !$Candidate.Executable -or [string]$Candidate.Created -notmatch '^[1-9][0-9]+$' -or !$Candidate.Job) { return 'UNVERIFIABLE' }
  if ($Record.Project -ine $Request.Project -or $Record.Profile -cne $Request.Profile -or
      ($Request.RunId -and $Record.RunId -cne $Request.RunId) -or $Record.Build -cne $Request.Build -or
      $Candidate.Job -cne $Record.Job -or $Candidate.Persistent) { return 'FOREIGN' }
  if ($Candidate.RootPid -ne $Record.RootPid -or $Candidate.RootCreated -cne $Record.RootCreated -or
      [uint64]$Candidate.Created -lt [uint64]$Record.RootCreated) { return 'STALE' }
  return 'MATCHING'
}

function Select-EpigraphOwnedWindow {
  param($Records, $Request, $Candidates)
  $matches = @()
  foreach ($record in $Records) {
    foreach ($candidate in $Candidates) {
      if ((Get-EpigraphOwnershipDecision $record $Request $candidate) -eq 'MATCHING' -and $candidate.Window -gt 0 -and $candidate.Executable -eq $record.AppExe) {
        $matches += $candidate
      }
    }
  }
  if ($matches.Count -eq 1) { return $matches[0] }
  return $null
}
