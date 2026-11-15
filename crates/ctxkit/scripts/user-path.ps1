# Adds one folder to the User PATH without touching the other entries.
# [Environment]::GetEnvironmentVariable expands %USERPROFILE% and friends, and writing that value back
# would turn every such entry into a fixed path. So the value is read from the registry as it is stored
# (DoNotExpandEnvironmentNames) and written back as REG_EXPAND_SZ.

function Normalize-PathSegment([string]$Segment) {
  $Segment.Trim().Trim('"').TrimEnd('\', '/').ToLowerInvariant()
}

# Returns $true when the folder was (or, with -DryRun, would be) added, $false when it is already there.
function Add-UserPathSegment {
  param(
    [Parameter(Mandatory)][string]$Segment,
    [string]$KeyPath = 'HKCU:\Environment',
    [switch]$DryRun
  )
  $key = Get-Item -LiteralPath $KeyPath
  $raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $want = Normalize-PathSegment $Segment
  $present = $false
  foreach ($s in ($raw -split ';')) {
    if ($s.Trim() -eq '') { continue }
    # An entry counts as the same folder both as stored (%USERPROFILE%\.local\bin) and expanded.
    $same = (Normalize-PathSegment $s) -eq $want -or
      (Normalize-PathSegment ([Environment]::ExpandEnvironmentVariables($s))) -eq $want
    if ($same) { $present = $true; break }
  }
  if ($present) { return $false }
  if ($DryRun) {
    Write-Host "[dry-run] would add $Segment to User PATH ($KeyPath), other entries unchanged."
    return $true
  }
  $next = if ($raw -and -not $raw.EndsWith(';')) { "$raw;$Segment" } elseif ($raw) { "$raw$Segment" } else { $Segment }
  Set-ItemProperty -LiteralPath $KeyPath -Name 'Path' -Value $next -Type ExpandString
  if ($KeyPath -eq 'HKCU:\Environment') { Send-EnvironmentChange }
  return $true
}

# A direct registry write does not tell running programs; [Environment]::SetEnvironmentVariable does.
function Send-EnvironmentChange {
  if (-not ('CtxkitNative.Broadcast' -as [type])) {
    Add-Type -Namespace CtxkitNative -Name Broadcast -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);
'@
  }
  $result = [UIntPtr]::Zero
  # HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG
  [void][CtxkitNative.Broadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
}
