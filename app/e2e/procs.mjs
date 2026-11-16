// Pure functions for the window checks (test: procs.test.mjs). No calls into the system.

const norm = (s) => String(s).replaceAll('\\', '/').toLowerCase()

/**
 * Core processes (`loadout*.exe`) started by the window with this check profile. The window always calls the core with
 * `--backups <profile>/backups`, so the marker is the profile directory in the command line, with a boundary (`…/loadout-qa/`):
 * the `loadout-qa-pack` profile and the owner's installed Loadout (its profile in %APPDATA%) do not match.
 * `procs` is a list of `{ ProcessId, Name, CommandLine }`.
 */
export function ownCoreProcesses(procs, profileDir) {
  const needle = `${norm(profileDir).replace(/\/+$/, '')}/`
  return procs.filter((p) => /^loadout[^\\/]*\.exe$/i.test(p.Name ?? '') && p.CommandLine != null && norm(p.CommandLine).includes(needle))
}
