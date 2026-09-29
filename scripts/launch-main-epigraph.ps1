param([switch]$Inspect)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'EpigraphSessionTools.ps1')
Start-EpigraphDesktop -ProjectRoot (Split-Path -Parent $PSScriptRoot) -Mode 'main' -Inspect:$Inspect
