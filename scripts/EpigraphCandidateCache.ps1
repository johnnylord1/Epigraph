# Candidate build cache and retention. Dot-sourced by build-epigraph-candidate.ps1.
# A candidate always compiles into its own private target. Dependency artifacts are
# reused by moving one per-worktree cache into that target under an exclusive lease
# and moving it back afterwards, so no other build can write where a receipt reads.
function Get-EpigraphCandidateRoot { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Epigraph\candidates' }
function Get-EpigraphBuildCacheRoot { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Epigraph\build-cache' }

function Get-EpigraphBuildJobs {
  param([int]$Requested=0)
  if($Requested -lt 1 -and $env:EPIGRAPH_BUILD_JOBS) {
    if(![int]::TryParse($env:EPIGRAPH_BUILD_JOBS,[ref]$Requested) -or $Requested -lt 1){throw 'EPIGRAPH_BUILD_JOBS must be a positive integer'}
  }
  if($Requested -ge 1){return $Requested}
  # Budget about 2 GiB per rustc/linker job so heavy crates do not exhaust memory.
  $jobs=[Environment]::ProcessorCount
  try { $jobs=[Math]::Min($jobs,[int][Math]::Floor((Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory/2GB)) } catch {}
  return [int][Math]::Max(1,$jobs)
}

function Open-EpigraphExclusiveFile {
  param([string]$Path)
  # The OS releases this lock when its holder exits, so it never goes stale.
  try { return [IO.File]::Open($Path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
  catch [IO.IOException] { return $null }
  catch [UnauthorizedAccessException] { return $null }
}

function Enter-EpigraphTargetLease {
  param([string]$ProjectRoot,[string]$Fallback,[int]$WaitMinutes=90,[string]$CacheRoot=(Get-EpigraphBuildCacheRoot))
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $key=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ProjectRoot.ToLowerInvariant())))).Replace('-','').Substring(0,16).ToLowerInvariant() }
  finally { $sha.Dispose() }
  $directory=Join-Path $CacheRoot $key
  $lease=[pscustomobject]@{Directory=$directory;Target=$Fallback;Lock=$null}
  $deadline=[DateTime]::UtcNow.AddMinutes($WaitMinutes);$announced=$false
  while($true) {
    $null=New-Item -ItemType Directory -Force -Path $directory
    $lock=Open-EpigraphExclusiveFile (Join-Path $directory 'lease.lock')
    if($lock){break}
    if([DateTime]::UtcNow -ge $deadline){Write-Warning 'Build cache is still leased by another build; compiling in a private target';return $lease}
    if(!$announced){Write-Host 'Waiting for another candidate build of this worktree to release the build cache...';$announced=$true}
    Start-Sleep -Seconds 2
  }
  $lease.Lock=$lock
  # The stamp records last use for retention.
  $stamp=[Text.Encoding]::UTF8.GetBytes([DateTime]::UtcNow.ToString('o'))
  $lock.SetLength(0);$lock.Write($stamp,0,$stamp.Length);$lock.Flush()
  $worktree=Join-Path $directory 'worktree.txt'
  if(!(Test-Path -LiteralPath $worktree)){[IO.File]::WriteAllText($worktree,$ProjectRoot)}
  $lease.Target=Join-Path $directory 'target'
  Write-Host 'Candidate target: leased dependency cache'
  return $lease
}

function Exit-EpigraphTargetLease {
  param($Lease)
  if($Lease -and $Lease.Lock){$Lease.Lock.Dispose();$Lease.Lock=$null}
}

function Remove-EpigraphDirectoryTree {
  param([string]$Path)
  # Candidate sources link the project's node_modules. Unlink it first; the .NET
  # recursive delete removes reparse points without recursing through them.
  $link=Join-Path $Path 'source\node_modules'
  if((Test-Path -LiteralPath $link) -and ((Get-Item -LiteralPath $link -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){[IO.Directory]::Delete($link,$false)}
  [IO.Directory]::Delete($Path,$true)
}

function Remove-EpigraphRetiredDirectory {
  param([IO.DirectoryInfo]$Entry)
  $path=$Entry.FullName.TrimEnd('\')
  $removing=if($Entry.Name.EndsWith('.removing')){$path}else{"$path.removing"}
  # Rename first so a partially removed candidate or cache is never selectable.
  if($removing -ne $path){try{[IO.Directory]::Move($path,$removing)}catch{return}}
  try { Remove-EpigraphDirectoryTree $removing } catch { Write-Warning "Retired build directory not fully removed; retried on a later build: $removing" }
}

function Remove-EpigraphStaleCandidates {
  param([string]$Root=(Get-EpigraphCandidateRoot),[int]$Keep=3,[string[]]$Exclude=@(),[int]$UnreceiptedMinimumAgeHours=24)
  if(!(Test-Path -LiteralPath $Root -PathType Container)){return}
  # A running image (desktop, Core or bundled Java) inside a candidate proves use.
  try { $images=@(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { $_.ExecutablePath } | Where-Object { $_ }) }
  catch { Write-Warning 'Process inventory unavailable; stale candidates preserved';return }
  $excluded=@($Exclude | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') })
  if($env:EPIGRAPH_CANDIDATE_RECEIPT){$excluded+=[IO.Path]::GetFullPath((Split-Path -Parent $env:EPIGRAPH_CANDIDATE_RECEIPT)).TrimEnd('\')}
  $pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(\.removing)?$'
  $entries=@(Get-ChildItem -LiteralPath $Root -Directory -Force | Where-Object { $_.Name -match $pattern })
  $receipted={ Test-Path -LiteralPath (Join-Path $args[0].FullName 'receipt.json') }
  $kept=@($entries | Where-Object { !$_.Name.EndsWith('.removing') -and (& $receipted $_) } |
    Sort-Object CreationTimeUtc -Descending | Select-Object -First $Keep | ForEach-Object { $_.FullName })
  foreach($entry in $entries) {
    $path=$entry.FullName.TrimEnd('\')
    if($excluded -contains $path -or $kept -contains $entry.FullName){continue}
    if(@($images | Where-Object { $_.StartsWith($path+'\',[StringComparison]::OrdinalIgnoreCase) }).Count){continue}
    if(!$entry.Name.EndsWith('.removing')) {
      $lockPath=Join-Path $path 'build.lock'
      if(Test-Path -LiteralPath $lockPath) {
        # A build holds this lock until it finishes, successful or not.
        $lock=Open-EpigraphExclusiveFile $lockPath;if(!$lock){continue};$lock.Dispose()
      }
      # Failed builds keep their build.log for diagnosis for a while.
      if(!(& $receipted $entry) -and $entry.CreationTimeUtc -gt [DateTime]::UtcNow.AddHours(-$UnreceiptedMinimumAgeHours)){continue}
    }
    Remove-EpigraphRetiredDirectory $entry
  }
}

function Remove-EpigraphStaleBuildCaches {
  param([string]$Root=(Get-EpigraphBuildCacheRoot),[string]$Current,[int]$MaxAgeDays=30)
  if(!(Test-Path -LiteralPath $Root -PathType Container)){return}
  foreach($entry in @(Get-ChildItem -LiteralPath $Root -Directory -Force)) {
    if($Current -and $entry.FullName.TrimEnd('\') -ieq $Current.TrimEnd('\')){continue}
    if(!$entry.Name.EndsWith('.removing')) {
      $worktree=Join-Path $entry.FullName 'worktree.txt';$lockPath=Join-Path $entry.FullName 'lease.lock'
      $project=if(Test-Path -LiteralPath $worktree){(Get-Content -LiteralPath $worktree -Raw).Trim()}else{''}
      $lastUse=if(Test-Path -LiteralPath $lockPath){(Get-Item -LiteralPath $lockPath).LastWriteTimeUtc}else{$entry.CreationTimeUtc}
      $orphaned=!$project -or !(Test-Path -LiteralPath $project -PathType Container)
      if(!$orphaned -and $lastUse -gt [DateTime]::UtcNow.AddDays(-$MaxAgeDays)){continue}
      $lock=Open-EpigraphExclusiveFile $lockPath;if(!$lock){continue};$lock.Dispose()
    }
    Remove-EpigraphRetiredDirectory $entry
  }
}
