$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/EpigraphOwnership.ps1"
$script:passed = 0
function Check($Name, $Actual, $Expected) {
  if ($Actual -ne $Expected) { throw "$Name expected=$Expected actual=$Actual" }
  $script:passed++; Write-Output "PASS $Name"
}
function Fixture {
  $r = @{ Schema=1; Project='C:\a'; Profile='test'; RunId='12ab34cd-1234-4567-89ab-0123456789ab'; Build='a'*64; Job='Local\Epigraph-12ab34cd-1234-4567-89ab-0123456789ab'; AppExe='C:\a\epigraph.exe'; RootPid=41; RootCreated='133700000000000001' }
  $q = @{ Project='C:\a'; Profile='test'; RunId=$r.RunId; Build='a'*64 }
  $p = @{ Pid=42; Created='133700000000000002'; Executable=$r.AppExe; Job=$r.Job; IdentityVerified=$true; Persistent=$false; Window=99; RootPid=41; RootCreated=$r.RootCreated }
  return @($r,$q,$p)
}
$r,$q,$p = Fixture
Check 'owned descendant' (Get-EpigraphOwnershipDecision $r $q $p) 'MATCHING'
foreach ($port in @(1420,4667,9223)) {
  $r,$q,$p = Fixture; $p.Job=''; $p.Port=$port
  Check "foreign listener $port" (Get-EpigraphOwnershipDecision $r $q $p) 'UNVERIFIABLE'
}
foreach ($case in @('project','worktree','profile','stale','PID reuse','missing','corrupted','foreign descendant','persistent Core','disappeared','build','wrong root','missing creation')) {
  $r,$q,$p = Fixture; $expected='UNVERIFIABLE'
  switch ($case) {
    'project' { $r.Project='C:\other'; $expected='FOREIGN' }
    'worktree' { $r.Project='C:\a-other'; $expected='FOREIGN' }
    'profile' { $r.Profile='other'; $expected='FOREIGN' }
    'stale' { $p.RootCreated='133799999999999999'; $expected='STALE' }
    'PID reuse' { $p.RootCreated='133700000000000003'; $expected='STALE' }
    'missing' { $r.RunId='' }
    'corrupted' { $r.Schema=0 }
    'foreign descendant' { $p.Job='Local\another'; $expected='FOREIGN' }
    'persistent Core' { $p.Persistent=$true; $expected='FOREIGN' }
    'disappeared' { $p.IdentityVerified=$false }
    'build' { $q.Build='b'*64; $expected='FOREIGN' }
    'wrong root' { $p.RootPid=98; $expected='STALE' }
    'missing creation' { $p.Created='' }
  }
  Check $case (Get-EpigraphOwnershipDecision $r $q $p) $expected
}
$r,$q,$p = Fixture; $other=$p.Clone(); $other.Job='foreign'; $other.Window=100
Check 'later foreign window never selected' (Select-EpigraphOwnedWindow @($r) $q @($other,$p)).Window 99
$other=$p.Clone();$other.Window=100
Check 'two matching windows are ambiguous' ($null -eq (Select-EpigraphOwnedWindow @($r) $q @($p,$other))) $true
$r2=$r.Clone();$r2.RunId='22ab34cd-1234-4567-89ab-0123456789ab';$r2.Job="Local\Epigraph-$($r2.RunId)"
$other=$p.Clone();$other.Job=$r2.Job;$other.Window=101
Check 'two legitimate runs select requested run' (Select-EpigraphOwnedWindow @($r,$r2) $q @($other,$p)).Window 99
Write-Output "RESULT $script:passed passed"
