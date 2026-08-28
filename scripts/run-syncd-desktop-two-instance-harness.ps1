param(
  [switch]$Clean
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir "..")
$tmpRoot = Join-Path $projectRoot "tmp\syncd-desktop-two-instance"
$hostRoot = Join-Path $tmpRoot "host"
$joinerRoot = Join-Path $tmpRoot "joiner"
$statePath = Join-Path $tmpRoot "harness-processes.json"

function Remove-ProcessTree {
  param([int]$Pid)
  try {
    Stop-Process -Id $Pid -Force -ErrorAction Stop
  } catch {
  }
}

function Start-EpigraphInstance {
  param(
    [string]$Name,
    [int]$Port,
    [string]$Root
  )

  $localAppData = Join-Path $Root "LocalAppData"
  $desktopStateDir = Join-Path $Root "syncd-desktop-state"
  $stdoutPath = Join-Path $Root "tauri.stdout.log"
  $stderrPath = Join-Path $Root "tauri.stderr.log"

  New-Item -ItemType Directory -Force -Path $localAppData | Out-Null
  New-Item -ItemType Directory -Force -Path $desktopStateDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stdoutPath) | Out-Null

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "cmd.exe"
  $psi.Arguments = "/c npm run tauri:dev:gate"
  $psi.WorkingDirectory = $projectRoot
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.Environment["LOCALAPPDATA"] = $localAppData
  $psi.Environment["EPIGRAPH_SYNCD_PORT"] = "$Port"
  $psi.Environment["EPIGRAPH_SYNCD_DESKTOP_STATE_DIR"] = $desktopStateDir

  $stdoutWriter = [System.IO.StreamWriter]::new($stdoutPath, $false)
  $stderrWriter = [System.IO.StreamWriter]::new($stderrPath, $false)

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  $process.add_OutputDataReceived({
    param($sender, $args)
    if ($null -ne $args.Data) {
      $stdoutWriter.WriteLine($args.Data)
      $stdoutWriter.Flush()
    }
  })
  $process.add_ErrorDataReceived({
    param($sender, $args)
    if ($null -ne $args.Data) {
      $stderrWriter.WriteLine($args.Data)
      $stderrWriter.Flush()
    }
  })

  $null = $process.Start()
  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()

  return @{
    Name = $Name
    Port = $Port
    Root = $Root
    LocalAppData = $localAppData
    DesktopStateDir = $desktopStateDir
    StdoutPath = $stdoutPath
    StderrPath = $stderrPath
    Process = $process
    StdoutWriter = $stdoutWriter
    StderrWriter = $stderrWriter
  }
}

if ($Clean -and (Test-Path $tmpRoot)) {
  Remove-Item -LiteralPath $tmpRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

$host = $null
$joiner = $null

try {
  $host = Start-EpigraphInstance -Name "host" -Port 4877 -Root $hostRoot
  $joiner = Start-EpigraphInstance -Name "joiner" -Port 4977 -Root $joinerRoot

  $summary = [ordered]@{
    startedAt = (Get-Date).ToString("o")
    host = @{
      port = $host.Port
      localAppData = $host.LocalAppData
      desktopStateDir = $host.DesktopStateDir
      stdoutPath = $host.StdoutPath
      stderrPath = $host.StderrPath
      pid = $host.Process.Id
    }
    joiner = @{
      port = $joiner.Port
      localAppData = $joiner.LocalAppData
      desktopStateDir = $joiner.DesktopStateDir
      stdoutPath = $joiner.StdoutPath
      stderrPath = $joiner.StderrPath
      pid = $joiner.Process.Id
    }
  }

  $summary | ConvertTo-Json -Depth 5 | Set-Content -Path $statePath

  Write-Host ''
  Write-Host 'Trilha do Syncd - Two-instance desktop harness'
  Write-Host ('Host pid:   {0}  port: {1}' -f $host.Process.Id, $host.Port)
  Write-Host ('Joiner pid: {0}  port: {1}' -f $joiner.Process.Id, $joiner.Port)
  Write-Host ''
  Write-Host 'Manual proof steps:'
  Write-Host '1. In the host desktop window, open Settings > Security > Sync host.'
  Write-Host '2. Start host pairing and either copy the bootstrap bundle or save the QR image.'
  Write-Host '3. In the joiner desktop window, open Settings > Security > Sync connect.'
  Write-Host '4. Discover the host or load the QR image / paste the bootstrap bundle.'
  Write-Host '5. Approve or reject on the host card and watch the live state update.'
  Write-Host '6. Restart the joiner instance and use the persisted session revalidation flow.'
  Write-Host ''
  Write-Host ('Process metadata saved to: {0}' -f $statePath)
  Write-Host 'Press Enter to stop both desktop instances...'
  Read-Host | Out-Null
}
finally {
  foreach ($instance in @($host, $joiner)) {
    if ($null -eq $instance) {
      continue
    }
    if ($instance.Process -and -not $instance.Process.HasExited) {
      Remove-ProcessTree -Pid $instance.Process.Id
    }
    try { $instance.StdoutWriter.Dispose() } catch {}
    try { $instance.StderrWriter.Dispose() } catch {}
  }
}
