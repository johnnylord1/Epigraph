#requires -RunAsAdministrator

[CmdletBinding(SupportsShouldProcess)]

$ErrorActionPreference = "Stop"

function Test-LegacyFirewallProgram {
  param([AllowNull()][string]$Program)

  if ([string]::IsNullOrWhiteSpace($Program)) {
    return $false
  }

  $path = $Program.Trim().ToLowerInvariant()
  # These are paths created by the former Aethon installation and by the
  # repository's disposable Aethon-named test targets.  Do not match the
  # canonical Epigraph install or arbitrary third-party programs.
  return (
    $path -like "*\appdata\local\aethon\*" -or
    $path -like "*\appdata\local\temp\aethon-*" -or
    $path -like "*\documents\projetos\forkmoku\aethon\src-tauri\target\*aethon*.exe" -or
    $path -like "*\documents\projetos\aethon-core-*\*aethon*.exe" -or
    $path -like "*\wt\aethon-core-mobile\*aethon*.exe" -or
    $path -like "*\wt\cargo-target\aethon-*\*aethon*.exe" -or
    $path -like "*\documents\temp\aethon-*\*aethon*.exe"
  )
}

function Get-LegacyFirewallRules {
  $matches = @()
  foreach ($filter in @(Get-NetFirewallApplicationFilter)) {
    if (-not (Test-LegacyFirewallProgram -Program $filter.Program)) {
      continue
    }
    foreach ($rule in @(Get-NetFirewallRule -AssociatedNetFirewallApplicationFilter $filter)) {
      $matches += [pscustomobject]@{
        Name = $rule.Name
        DisplayName = $rule.DisplayName
        Program = $filter.Program
      }
    }
  }
  $matches | Sort-Object Name -Unique
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $env:TEMP "epigraph-firewall-before-$timestamp.wfw"
& netsh.exe advfirewall export $backup | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $backup)) {
  throw "Não foi possível exportar a política do Firewall; nenhuma regra foi alterada."
}

$legacyRules = @(Get-LegacyFirewallRules)
Write-Output "Backup do Firewall: $backup"
Write-Output "Regras legadas encontradas: $($legacyRules.Count)"

if ($legacyRules.Count -gt 0 -and $PSCmdlet.ShouldProcess(
    "$($legacyRules.Count) regras de Firewall associadas a Aethon",
    "Remover")) {
  Remove-NetFirewallRule -Name @($legacyRules.Name)
  Write-Output "Regras legadas removidas: $($legacyRules.Count)"
}

$runPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$canonicalCore = Join-Path $env:LOCALAPPDATA "Epigraph\epigraph-syncd.exe"
if (-not (Test-Path -LiteralPath $canonicalCore)) {
  throw "Core Epigraph não encontrado em $canonicalCore"
}

if ($PSCmdlet.ShouldProcess("$runPath\Epigraph Core", "Apontar para o Core Epigraph")) {
  New-Item -Path $runPath -Force | Out-Null
  Set-ItemProperty -Path $runPath -Name "Epigraph Core" -Value ('"{0}" serve --lan' -f $canonicalCore)
  Remove-ItemProperty -Path $runPath -Name "Aethon Core" -ErrorAction SilentlyContinue
}

Write-Output "Binários legados não são apagados automaticamente; permanecem como .legacy para rollback."

Write-Output "Identidade Epigraph aplicada. Reinicie o Windows para validar o autostart, se necessário."
