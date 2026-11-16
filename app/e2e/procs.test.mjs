import { describe, expect, it } from 'vitest'
import { ownCoreProcesses } from './procs.mjs'

const PROFILE = 'D:\\Data\\Projects\\Loadout\\state\\loadout-qa'

const list = [
  // ядро этого прогона (окно передаёт каталог бэкапов внутри профиля)
  { ProcessId: 1, Name: 'loadout.exe', CommandLine: `"D:\\Data\\Projects\\Loadout\\target\\release\\loadout.exe" serve --backups ${PROFILE}\\backups --lang ru --home C:\\Temp\\loadout-e2e-1` },
  // то же, но другие регистр и слэши
  { ProcessId: 2, Name: 'Loadout.EXE', CommandLine: 'loadout.exe serve --backups d:/data/projects/loadout/state/LOADOUT-QA/backups' },
  // установленный Loadout владельца: профиль в %APPDATA%, ядро из resources
  { ProcessId: 10, Name: 'loadout.exe', CommandLine: '"C:\\Users\\u\\AppData\\Local\\Programs\\Loadout\\resources\\loadout.exe" serve --backups C:\\Users\\u\\AppData\\Roaming\\Loadout\\backups --lang ru' },
  // проверка упакованной сборки и соседняя копия репозитория: свои профили
  { ProcessId: 11, Name: 'loadout.exe', CommandLine: `loadout.exe serve --backups D:\\Data\\Projects\\Loadout\\state\\loadout-qa-pack\\backups` },
  { ProcessId: 12, Name: 'loadout.exe', CommandLine: 'loadout.exe serve --backups D:\\Data\\Projects\\Loadout\\.claude\\worktrees\\x\\state\\loadout-qa\\backups' },
  // `loadout scan` у владельца в консоли, процесс без командной строки (нет доступа), чужое имя образа
  { ProcessId: 13, Name: 'loadout.exe', CommandLine: 'loadout scan --json' },
  { ProcessId: 14, Name: 'loadout.exe', CommandLine: null },
  { ProcessId: 15, Name: 'node.exe', CommandLine: `node x --backups ${PROFILE}\\backups` },
]

describe('ownCoreProcesses', () => {
  it('считает только ядро, запущенное с профилем этого прогона', () => {
    expect(ownCoreProcesses(list, PROFILE).map((p) => p.ProcessId)).toEqual([1, 2])
  })
  it('профиль с общим началом имени и с завершающим слэшем различаются верно', () => {
    expect(ownCoreProcesses(list, `${PROFILE}-pack`).map((p) => p.ProcessId)).toEqual([11])
    expect(ownCoreProcesses(list, `${PROFILE}\\`).map((p) => p.ProcessId)).toEqual([1, 2])
  })
  it('пустой список и отсутствие своих процессов дают пустой результат', () => {
    expect(ownCoreProcesses([], PROFILE)).toEqual([])
    expect(ownCoreProcesses(list.filter((p) => p.ProcessId >= 10 && p.ProcessId <= 15 && p.ProcessId !== 11 && p.ProcessId !== 12 && p.ProcessId !== 15), PROFILE)).toEqual([])
  })
})
