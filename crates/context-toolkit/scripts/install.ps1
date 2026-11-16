#!/usr/bin/env pwsh
# -DryRun: builds nothing, copies nothing, changes no PATH; only prints what would happen.
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'user-path.ps1')

# Инструменты контекста лежат в Cargo-воркспейсе Loadout (crates/context-toolkit): lock и target — в корне репозитория
$CrateRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent (Split-Path -Parent $CrateRoot)

$Bin = Join-Path $RepoRoot 'target\release\context-toolkit.exe'
$HookDir = Join-Path $env:USERPROFILE '.claude\hooks'
$LocalBin = Join-Path $env:USERPROFILE '.local\bin'
$InstalledExe = Join-Path $LocalBin 'context-toolkit.exe'

if ($DryRun) {
  Write-Host "[dry-run] would build $Bin"
  Write-Host "[dry-run] would copy it to $(Join-Path $HookDir 'context-toolkit.exe') and $InstalledExe"
  [void](Add-UserPathSegment -Segment $LocalBin -DryRun)
  return
}

Push-Location $RepoRoot
try {
  if (Test-Path (Join-Path $RepoRoot 'Cargo.lock')) {
    cargo build --release --offline -p context-toolkit
  } else {
    cargo build --release -p context-toolkit
  }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force $HookDir, $LocalBin | Out-Null
Copy-Item -Force $Bin (Join-Path $HookDir 'context-toolkit.exe')
Copy-Item -Force $Bin $InstalledExe

if (Add-UserPathSegment -Segment $LocalBin) {
  Write-Host "Added $LocalBin to User PATH (restart terminal to invoke 'context-toolkit' directly)."
}

Write-Host "Installed:"
Write-Host "  $(Join-Path $HookDir 'context-toolkit.exe')"
Write-Host "  $InstalledExe"
Write-Host "Next:"
Write-Host "  & `"$InstalledExe`" setup --dry-run"
Write-Host "  & `"$InstalledExe`" setup --with-rules --desktop --antigravity"
