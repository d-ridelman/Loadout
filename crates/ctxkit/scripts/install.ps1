#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'

# ctxkit лежит в Cargo-воркспейсе Loadout (crates/ctxkit): lock и target — в корне репозитория
$CrateRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent (Split-Path -Parent $CrateRoot)
Push-Location $RepoRoot
try {
  if (Test-Path (Join-Path $RepoRoot 'Cargo.lock')) {
    cargo build --release --offline -p ctxkit
  } else {
    cargo build --release -p ctxkit
  }
} finally {
  Pop-Location
}

$Bin = Join-Path $RepoRoot 'target\release\ctxkit.exe'
$HookDir = Join-Path $env:USERPROFILE '.claude\hooks'
$LocalBin = Join-Path $env:USERPROFILE '.local\bin'

New-Item -ItemType Directory -Force $HookDir, $LocalBin | Out-Null
Copy-Item -Force $Bin (Join-Path $HookDir 'ctxkit.exe')
Copy-Item -Force $Bin (Join-Path $LocalBin 'ctxkit.exe')

$InstalledExe = Join-Path $LocalBin 'ctxkit.exe'
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$Segments = @($UserPath -split ';' | Where-Object { $_.Trim() -ne '' })
if ($Segments -notcontains $LocalBin) {
  $NextPath = if ($UserPath -and -not $UserPath.EndsWith(';')) { "$UserPath;$LocalBin" } elseif ($UserPath) { "$UserPath$LocalBin" } else { $LocalBin }
  [Environment]::SetEnvironmentVariable('Path', $NextPath, 'User')
  Write-Host "Added $LocalBin to User PATH (restart terminal to invoke 'ctxkit' directly)."
}

Write-Host "Installed:"
Write-Host "  $(Join-Path $HookDir 'ctxkit.exe')"
Write-Host "  $InstalledExe"
Write-Host "Next:"
Write-Host "  & `"$InstalledExe`" setup --dry-run"
Write-Host "  & `"$InstalledExe`" setup --with-rules --desktop --antigravity"
