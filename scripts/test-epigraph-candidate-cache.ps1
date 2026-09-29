$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/EpigraphCandidateCache.ps1"
$script:passed = 0
function Check($Name, $Actual, $Expected) {
  if ($Actual -ne $Expected) { throw "$Name expected=$Expected actual=$Actual" }
  $script:passed++; Write-Output "PASS $Name"
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('epigraph-candidate-cache-' + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $fixture
$previousJobs = $env:EPIGRAPH_BUILD_JOBS; $previousReceipt = $env:EPIGRAPH_CANDIDATE_RECEIPT
$process = $null; $held = @()
try {
  $env:EPIGRAPH_CANDIDATE_RECEIPT = $null
  $env:EPIGRAPH_BUILD_JOBS = $null
  Check 'explicit jobs win' (Get-EpigraphBuildJobs 3) 3
  $auto = Get-EpigraphBuildJobs
  Check 'automatic jobs are bounded' ($auto -ge 1 -and $auto -le [Environment]::ProcessorCount) $true
  $env:EPIGRAPH_BUILD_JOBS = '1'
  Check 'serial opt-in' (Get-EpigraphBuildJobs) 1
  $env:EPIGRAPH_BUILD_JOBS = 'many'; $refused = $false
  try { $null = Get-EpigraphBuildJobs } catch { $refused = $true }
  Check 'invalid job count refused' $refused $true
  $env:EPIGRAPH_BUILD_JOBS = $null

  # Lease: one build at a time writes to the per-worktree cache target.
  $cacheRoot = Join-Path $fixture 'build-cache'; $project = Join-Path $fixture 'worktree'
  $null = New-Item -ItemType Directory -Path $project
  $private = { param($n) Join-Path $fixture "c$n\target" }
  $lease = Enter-EpigraphTargetLease $project (& $private 1) -CacheRoot $cacheRoot
  Check 'lease selects the stable cache target' ($lease.Lock -and $lease.Target -eq (Join-Path $lease.Directory 'target')) $true
  Check 'lease records its worktree' (Get-Content -LiteralPath (Join-Path $lease.Directory 'worktree.txt') -Raw) $project
  $null = New-Item -ItemType Directory -Path $lease.Target; Set-Content -LiteralPath (Join-Path $lease.Target 'dep.rlib') 'compiled'
  $contender = Enter-EpigraphTargetLease $project (& $private 2) -CacheRoot $cacheRoot -WaitMinutes 0 3>$null
  Check 'concurrent build compiles privately' ((!$contender.Lock) -and $contender.Target -eq (& $private 2)) $true
  Exit-EpigraphTargetLease $contender
  Check 'contender cannot release a lease it does not hold' ($null -eq (Open-EpigraphExclusiveFile (Join-Path $lease.Directory 'lease.lock'))) $true
  Exit-EpigraphTargetLease $lease
  Check 'lease released' ($null -eq $lease.Lock) $true
  # A killed build's OS lock is released with its process; the next build proceeds.
  $lease = Enter-EpigraphTargetLease $project (& $private 3) -CacheRoot $cacheRoot
  Check 'next build reuses dependencies at the same path' ((Test-Path (Join-Path $lease.Target 'dep.rlib')) -and [bool]$lease.Lock) $true
  Exit-EpigraphTargetLease $lease
  $other = Enter-EpigraphTargetLease (Join-Path $fixture 'other-worktree') (& $private 4) -CacheRoot $cacheRoot
  Check 'worktrees never share a cache' ($other.Directory -ne $lease.Directory) $true
  Exit-EpigraphTargetLease $other
  $currentCache = $lease.Directory

  # Candidate retention.
  $root = Join-Path $fixture 'candidates'; $null = New-Item -ItemType Directory -Path $root
  $make = {
    param([int]$AgeHours, [switch]$Receipt, [switch]$Lock)
    $d = New-Item -ItemType Directory -Path (Join-Path $root ([guid]::NewGuid()))
    Set-Content -LiteralPath (Join-Path $d.FullName 'inputs.json') '{}'
    if ($Receipt) { Set-Content -LiteralPath (Join-Path $d.FullName 'receipt.json') '{}' }
    if ($Lock) { Set-Content -LiteralPath (Join-Path $d.FullName 'build.lock') '' }
    $d.CreationTimeUtc = [DateTime]::UtcNow.AddHours(-$AgeHours)
    $d.FullName
  }
  $newest = & $make 1 -Receipt -Lock; $second = & $make 2 -Receipt -Lock
  $old = & $make 30 -Receipt -Lock; $legacy = & $make 40 -Receipt
  $failed = & $make 3 -Lock; $oldFailed = & $make 30 -Lock; $freshLegacy = & $make 1; $oldLegacy = & $make 48
  $building = & $make 50 -Lock
  $held += [IO.File]::Open((Join-Path $building 'build.lock'), 'Open', 'ReadWrite', 'None')
  $excluded = & $make 60 -Receipt -Lock
  $running = & $make 70 -Receipt -Lock
  $image = Join-Path $running 'ping.exe'; Copy-Item (Join-Path $env:SystemRoot 'System32\PING.EXE') $image
  $process = Start-Process $image -ArgumentList '-n 30 127.0.0.1' -WindowStyle Hidden -PassThru
  $linked = & $make 80 -Receipt -Lock
  $sentinel = Join-Path $fixture 'project-node_modules'; $null = New-Item -ItemType Directory -Path $sentinel
  Set-Content -LiteralPath (Join-Path $sentinel 'keep.txt') 'user dependency'
  $null = New-Item -ItemType Directory -Path (Join-Path $linked 'source')
  $null = New-Item -ItemType Junction -Path (Join-Path $linked 'source\node_modules') -Target $sentinel
  $null = New-Item -ItemType Directory -Path (Join-Path $root 'notes')
  $leftover = New-Item -ItemType Directory -Path (Join-Path $root "$([guid]::NewGuid()).removing")

  Remove-EpigraphStaleCandidates -Root $root -Keep 2 -Exclude @($excluded)
  $exists = { param($p) Test-Path -LiteralPath $p }
  Check 'newest receipted candidates kept' ((& $exists $newest) -and (& $exists $second)) $true
  Check 'older receipted candidate removed' (& $exists $old) $false
  Check 'legacy receipted candidate removed' (& $exists $legacy) $false
  Check 'recent failed candidate kept for diagnosis' (& $exists $failed) $true
  Check 'old failed candidate removed' (& $exists $oldFailed) $false
  Check 'recent lockless candidate preserved' (& $exists $freshLegacy) $true
  Check 'old lockless candidate removed' (& $exists $oldLegacy) $false
  Check 'candidate with live build lock preserved' (& $exists $building) $true
  Check 'excluded candidate preserved' (& $exists $excluded) $true
  Check 'candidate with running image preserved' (& $exists $running) $true
  Check 'junction candidate removed' (& $exists $linked) $false
  Check 'junction target untouched' (Get-Content -LiteralPath (Join-Path $sentinel 'keep.txt')) 'user dependency'
  Check 'unrelated directory untouched' (& $exists (Join-Path $root 'notes')) $true
  Check 'interrupted removal completed' (& $exists $leftover.FullName) $false
  Check 'no rename residue' (@(Get-ChildItem -LiteralPath $root -Directory | Where-Object Name -like '*.removing').Count) 0

  # Build-cache retention.
  $cache = { param($Worktree, [int]$AgeDays)
    $d = New-Item -ItemType Directory -Path (Join-Path $cacheRoot ([guid]::NewGuid().ToString('N').Substring(0, 16)))
    Set-Content -LiteralPath (Join-Path $d.FullName 'worktree.txt') $Worktree
    $lockFile = Join-Path $d.FullName 'lease.lock'; Set-Content -LiteralPath $lockFile ''
    (Get-Item $lockFile).LastWriteTimeUtc = [DateTime]::UtcNow.AddDays(-$AgeDays)
    $d.FullName
  }
  $recent = & $cache $project 1; $unused = & $cache $project 45
  $orphan = & $cache (Join-Path $fixture 'deleted-worktree') 1; $orphanLeased = & $cache (Join-Path $fixture 'gone') 1
  $held += [IO.File]::Open((Join-Path $orphanLeased 'lease.lock'), 'Open', 'ReadWrite', 'None')
  Remove-EpigraphStaleBuildCaches -Root $cacheRoot -Current $currentCache
  Check 'current cache kept' (Test-Path (Join-Path $currentCache 'target\dep.rlib')) $true
  Check 'recently used cache kept' (& $exists $recent) $true
  Check 'long-unused cache removed' (& $exists $unused) $false
  Check 'cache of deleted worktree removed' (& $exists $orphan) $false
  Check 'leased cache preserved' (& $exists $orphanLeased) $true
  Write-Output "candidate cache: $script:passed checks passed"
} finally {
  foreach ($h in $held) { $h.Dispose() }
  if ($process -and !$process.HasExited) { $process.Kill(); $process.WaitForExit() }
  $env:EPIGRAPH_BUILD_JOBS = $previousJobs; $env:EPIGRAPH_CANDIDATE_RECEIPT = $previousReceipt
  $link = Get-ChildItem -LiteralPath $fixture -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue
  foreach ($l in $link) { [IO.Directory]::Delete($l.FullName, $false) }
  [IO.Directory]::Delete($fixture, $true)
}
