import { describe, expect, it } from 'vitest'
import { ownCoreProcesses } from './procs.mjs'

const PROFILE = 'D:\\Data\\Projects\\Loadout\\state\\loadout-qa'

const list = [
  // the core of this run (the window passes the backups directory inside the profile)
  { ProcessId: 1, Name: 'loadout.exe', CommandLine: `"D:\\Data\\Projects\\Loadout\\target\\release\\loadout.exe" serve --backups ${PROFILE}\\backups --lang ru --home C:\\Temp\\loadout-e2e-1` },
  // same, but different case and slashes
  { ProcessId: 2, Name: 'Loadout.EXE', CommandLine: 'loadout.exe serve --backups d:/data/projects/loadout/state/LOADOUT-QA/backups' },
  // the owner's installed Loadout: profile in %APPDATA%, core from resources
  { ProcessId: 10, Name: 'loadout.exe', CommandLine: '"C:\\Users\\u\\AppData\\Local\\Programs\\Loadout\\resources\\loadout.exe" serve --backups C:\\Users\\u\\AppData\\Roaming\\Loadout\\backups --lang ru' },
  // packaged-build check and a neighbouring repository copy: their own profiles
  { ProcessId: 11, Name: 'loadout.exe', CommandLine: `loadout.exe serve --backups D:\\Data\\Projects\\Loadout\\state\\loadout-qa-pack\\backups` },
  { ProcessId: 12, Name: 'loadout.exe', CommandLine: 'loadout.exe serve --backups D:\\Data\\Projects\\Loadout\\.claude\\worktrees\\x\\state\\loadout-qa\\backups' },
  // `loadout scan` in the owner's console, a process without a command line (no access), a foreign image name
  { ProcessId: 13, Name: 'loadout.exe', CommandLine: 'loadout scan --json' },
  { ProcessId: 14, Name: 'loadout.exe', CommandLine: null },
  { ProcessId: 15, Name: 'node.exe', CommandLine: `node x --backups ${PROFILE}\\backups` },
]

describe('ownCoreProcesses', () => {
  it('counts only the core started with the profile of this run', () => {
    expect(ownCoreProcesses(list, PROFILE).map((p) => p.ProcessId)).toEqual([1, 2])
  })
  it('profiles sharing a name prefix and with a trailing slash are told apart correctly', () => {
    expect(ownCoreProcesses(list, `${PROFILE}-pack`).map((p) => p.ProcessId)).toEqual([11])
    expect(ownCoreProcesses(list, `${PROFILE}\\`).map((p) => p.ProcessId)).toEqual([1, 2])
  })
  it('an empty list and no own processes give an empty result', () => {
    expect(ownCoreProcesses([], PROFILE)).toEqual([])
    expect(ownCoreProcesses(list.filter((p) => p.ProcessId >= 10 && p.ProcessId <= 15 && p.ProcessId !== 11 && p.ProcessId !== 12 && p.ProcessId !== 15), PROFILE)).toEqual([])
  })
})
