#!/usr/bin/env pwsh
# Checks Add-UserPathSegment on a throwaway registry key. The real User PATH is never opened for writing.
# Run: pwsh -NoProfile -File scripts/user-path.test.ps1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'user-path.ps1')

$KeyPath = "HKCU:\Software\ctxkit-path-test-$PID"
$failed = 0
function Check($ok, $what) {
  if (-not $ok) { $script:failed++; Write-Host "FAIL: $what" } else { Write-Host "ok: $what" }
}
function Stored { (Get-Item -LiteralPath $KeyPath).GetValue('Path', '', 'DoNotExpandEnvironmentNames') }
function Kind { (Get-Item -LiteralPath $KeyPath).GetValueKind('Path').ToString() }

New-Item -Path $KeyPath -Force | Out-Null
try {
  $bin = 'C:\Users\someone\.local\bin'

  # Entries with %VARS% survive as they are, the folder is appended, the kind is REG_EXPAND_SZ.
  $before = '%USERPROFILE%\go\bin;C:\Tools;%SystemRoot%\system32'
  Set-ItemProperty -LiteralPath $KeyPath -Name Path -Value $before -Type ExpandString
  Check ((Add-UserPathSegment -Segment $bin -KeyPath $KeyPath) -eq $true) 'a missing folder is added'
  Check ((Stored) -ceq "$before;$bin") "other entries stay unexpanded (got: $(Stored))"
  Check ((Kind) -eq 'ExpandString') 'value kind is ExpandString'

  # A second run changes nothing.
  Check ((Add-UserPathSegment -Segment $bin -KeyPath $KeyPath) -eq $false) 'a present folder is not added again'
  Check ((Stored) -ceq "$before;$bin") 'value is unchanged by the second run'

  # The folder stored as %USERPROFILE%\... counts as present, in any case and with a trailing slash.
  Set-ItemProperty -LiteralPath $KeyPath -Name Path -Value '%USERPROFILE%\.LOCAL\bin\;C:\x' -Type ExpandString
  $profileBin = Join-Path $env:USERPROFILE '.local\bin'
  Check ((Add-UserPathSegment -Segment $profileBin -KeyPath $KeyPath) -eq $false) 'the %USERPROFILE% form counts as present'

  # A plain REG_SZ value keeps its text and becomes REG_EXPAND_SZ; a trailing ; is not doubled.
  Set-ItemProperty -LiteralPath $KeyPath -Name Path -Value 'C:\a;C:\b;' -Type String
  [void](Add-UserPathSegment -Segment $bin -KeyPath $KeyPath)
  Check ((Stored) -ceq "C:\a;C:\b;$bin") "trailing ; is not doubled (got: $(Stored))"
  Check ((Kind) -eq 'ExpandString') 'REG_SZ becomes ExpandString'

  # -DryRun reports and writes nothing.
  Set-ItemProperty -LiteralPath $KeyPath -Name Path -Value '%USERPROFILE%\go\bin' -Type ExpandString
  Check ((Add-UserPathSegment -Segment $bin -KeyPath $KeyPath -DryRun) -eq $true) '-DryRun says it would add'
  Check ((Stored) -ceq '%USERPROFILE%\go\bin') '-DryRun does not write'

  # No Path value at all: the folder becomes the whole value.
  Remove-ItemProperty -LiteralPath $KeyPath -Name Path
  [void](Add-UserPathSegment -Segment $bin -KeyPath $KeyPath)
  Check ((Stored) -ceq $bin) 'an empty PATH gets just the folder'
}
finally {
  Remove-Item -LiteralPath $KeyPath -Recurse -Force -ErrorAction SilentlyContinue
}
if ($failed) { Write-Host "$failed FAILED"; exit 1 }
Write-Host 'ALL PASSED'
