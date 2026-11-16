// Чистые функции для проверок окна (тест: procs.test.mjs). Без обращений к системе.

const norm = (s) => String(s).replaceAll('\\', '/').toLowerCase()

/**
 * Процессы ядра (`loadout*.exe`), запущенные окном с этим проверочным профилем. Окно всегда зовёт ядро с
 * `--backups <profile>/backups`, поэтому признак — каталог профиля в командной строке, с границей (`…/loadout-qa/`):
 * профиль `loadout-qa-pack` и установленный у владельца Loadout (его профиль в %APPDATA%) сюда не попадают.
 * `procs` — список `{ ProcessId, Name, CommandLine }`.
 */
export function ownCoreProcesses(procs, profileDir) {
  const needle = `${norm(profileDir).replace(/\/+$/, '')}/`
  return procs.filter((p) => /^loadout[^\\/]*\.exe$/i.test(p.Name ?? '') && p.CommandLine != null && norm(p.CommandLine).includes(needle))
}
