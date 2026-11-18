import { useCallback, useEffect, useRef, useState } from 'react'
import type { CtxkitDoctor, CtxkitReport, CtxkitStatus, FindingSeverity, Level, SetupOptions, SetupResult, WriteLevel } from '../../shared/model'
import { MAX_BUILD_SLOTS } from '../../shared/model'
import { count, fmtTime, getLang, t } from '../../shared/i18n'
import { chars, daysDesc, fixPatch, NO_POLICIES, pct, policiesNow, policySet, segments, stopGateOff, summarize, tickPolicy } from '../ctxkit-stats'
import type { PolicySet } from '../ctxkit-stats'
import { clientNow, ctxClients } from '../ctxkit-clients'
import { PageHead, Rich } from '../ui'
import type { Notify } from '../ui'

// t() only during render: the language is chosen before the first render, not when the module is imported
const sev = (s: FindingSeverity): { ch: string; label: string; cls: string } =>
  ({
    ok: { ch: '●', label: t('в порядке', 'ok'), cls: 's-on' },
    info: { ch: '○', label: t('к сведению', 'info'), cls: 's-off' },
    warn: { ch: '◐', label: t('внимание', 'warning'), cls: 's-stale' },
    error: { ch: '✕', label: t('ошибка', 'error'), cls: 's-broken' },
  })[s]

const copyText = (k: CtxkitStatus['hook']): string =>
  ({
    same: t('● совпадает со встроенным', '● matches the bundled one'),
    different: t(
      '◐ отличается от встроенной: «Применить» заменит её встроенной (это может быть и откат на более старую)',
      '◐ differs from the bundled one: “Apply” will replace it with the bundled one (this may be a downgrade)',
    ),
    missing: t('✕ нет: «Применить» установит', '✕ missing: “Apply” will install it'),
  })[k]

const SEG_COLOR = { sonnet: 'var(--green)', haiku: 'var(--cyan)', opusFable: 'var(--orange)', other: 'var(--deco)' } as const

/** The default hook language is the interface language (the setting is independent afterwards); a function, not a constant: the language is chosen after import. */
const defaults = (): SetupOptions => ({
  withRules: true, desktop: false, antigravity: false, dsh: false, codex: false, opencode: false, noStopGate: false, lang: getLang(), advisor: 'keep', mainModel: 'keep', effort: 'keep',
  // "Protections": by default context-toolkit.json is left alone; what is ticked counts only if "Enable selected" is chosen
  policyMode: 'keep', commitHygiene: false, confirmIrreversible: false, strayFiles: false, buildSlots: false, buildSlotsN: 2,
})

/** What Context Toolkit is doing right now: determines which button is busy. */
type Busy = 'preview' | 'apply' | 'undoPreview' | 'undo'

const BUSY_TEXT: Record<Busy, () => string> = {
  preview: () => t('Считаю предпросмотр: ничего не пишу…', 'Working out the preview: writing nothing…'),
  apply: () => t('Применяю: Инструменты контекста пишут хуки и настройки…', 'Applying: Context Toolkit is writing hooks and settings…'),
  undoPreview: () => t('Считаю предпросмотр отката: ничего не пишу…', 'Working out the rollback preview: writing nothing…'),
  undo: () => t('Откатываю: Инструменты контекста убирают хуки, блок правил и бинарь…', 'Rolling back: Context Toolkit is removing hooks, the rules block and the binary…'),
}

type Loaded<T> = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; data: T }

/** Data, reload and the "counting in progress" flag: on a repeated request the previous data stays on screen, but busy is visible. */
function useLoaded<T>(load: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, deps: unknown[]): [Loaded<T>, () => void, boolean, Date | null] {
  const [s, setS] = useState<Loaded<T>>({ status: 'loading' })
  const [n, setN] = useState(0)
  const [busy, setBusy] = useState(true)
  const [at, setAt] = useState<Date | null>(null)
  useEffect(() => {
    let alive = true
    setBusy(true)
    setS((p) => (p.status === 'ready' ? p : { status: 'loading' }))
    load().then(
      (r) => {
        if (!alive) return
        setS(r.ok ? { status: 'ready', data: r.data } : { status: 'error', error: r.error })
        setBusy(false)
        setAt(new Date())
      },
      (e: unknown) => {
        if (!alive) return
        setS({ status: 'error', error: e instanceof Error ? e.message : t('не удалось', 'failed') })
        setBusy(false)
      },
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n])
  return [s, () => setN((x) => x + 1), busy, at]
}

interface Props {
  level: WriteLevel
  onNotice: Notify
  /** Asks for a write level (the confirmation window); true when it is granted. */
  ensureLevel: (need: Level) => Promise<boolean>
}

/** Built-in Context Toolkit (CONCEPT.md §13): install and apply, diagnostics, effectiveness from transcript counters. */
export function Ctxkit({ level, onNotice, ensureLevel }: Props) {
  const [status, reloadStatus] = useLoaded<CtxkitStatus>(() => window.loadout.ctxkitStatus(), [])
  const [doctor, reloadDoctor, doctorBusy] = useLoaded<CtxkitDoctor>(() => window.loadout.ctxkitDoctor(), [])
  const [days, setDays] = useState<7 | 14 | 30>(14)
  const [report, reloadReport, reportBusy, reportAt] = useLoaded<CtxkitReport>(() => window.loadout.ctxkitReport(days), [days])
  const [opts, setOpts] = useState<SetupOptions>(defaults)
  // one current preview: a key with the action kind ("setup:..." or "uninstall:..."), as in main
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const [result, setResult] = useState<(SetupResult & { kind: 'setup' | 'uninstall' }) | null>(null)
  const [busy, setBusy] = useState<Busy | null>(null)
  const undoPreviewRef = useRef<HTMLButtonElement>(null)
  const previewRef = useRef<HTMLButtonElement>(null)
  const [refocus, setRefocus] = useState(false)
  useEffect(() => {
    if (!refocus || busy) return
    undoPreviewRef.current?.focus() // the red button disappeared along with the focus
    setRefocus(false)
  }, [refocus, busy])
  /** The last failure, shown in the card of the action that failed (apply or rollback). */
  const [error, setError] = useState<{ text: string; kind: 'setup' | 'uninstall' } | null>(null)

  // The Stop gate checkbox takes its initial value from the profile (gate off: "Apply" must not silently turn it on),
  // but does not overwrite a choice the user has already made.
  const [gateTouched, setGateTouched] = useState(false)
  useEffect(() => {
    if (doctor.status !== 'ready' || gateTouched) return
    const off = stopGateOff(doctor.data)
    if (off !== null) setOpts((o) => (o.noStopGate === off ? o : { ...o, noStopGate: off }))
  }, [doctor, gateTouched])

  const key = `setup:${JSON.stringify(opts)}`
  // rollback depends only on the integrations it removes, per checkbox
  const undoOpts = { antigravity: opts.antigravity, dsh: opts.dsh, codex: opts.codex, opencode: opts.opencode }
  const undoKey = `uninstall:${JSON.stringify(undoOpts)}`
  const change = (patch: Partial<SetupOptions>) => {
    setOpts({ ...opts, ...patch })
    setPreviewKey(null) // different settings mean a different preview
  }
  // policies on now (from the doctor): what the checkboxes show under "keep", and where a first tick starts from
  const nowPolicies = doctor.status === 'ready' ? policySet(doctor.data) : null
  const shownPolicies: PolicySet = opts.policyMode === 'on' ? opts : opts.policyMode === 'off' ? NO_POLICIES : (nowPolicies ?? opts)
  // under "keep" a tick must start from the real state: while the doctor is answering, the checkboxes wait
  // (if it failed, they start from nothing on: setup itself refuses a broken policy file)
  const policyWait = opts.policyMode === 'keep' && doctor.status === 'loading'
  const tick = (patch: Partial<PolicySet>) => {
    setOpts(tickPolicy(opts, patch, nowPolicies))
    setPreviewKey(null)
  }

  const run = useCallback(
    async (kind: 'setup' | 'uninstall', dryRun: boolean) => {
      setBusy(kind === 'setup' ? (dryRun ? 'preview' : 'apply') : dryRun ? 'undoPreview' : 'undo')
      setError(null)
      setPreviewKey(null) // both the preview and the action consume the previous preview (main does the same)
      const call = kind === 'setup' ? window.loadout.ctxkitSetup(opts, dryRun) : window.loadout.ctxkitUninstall(undoOpts, dryRun)
      const r = await call.catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : t('не удалось', 'failed') }))
      setBusy(null)
      if (!r.ok) return setError({ text: r.error, kind })
      setResult({ ...r.data, kind })
      // a real run may have written some files even with a non-zero exit code: re-read the status and diagnostics in any case
      if (!dryRun) {
        reloadStatus()
        reloadDoctor()
      }
      if (r.data.code !== 0) return setError({ text: t(`Инструменты контекста завершились с кодом ${r.data.code}: подробности в выводе ниже`, `Context Toolkit exited with code ${r.data.code}: see the output below`), kind })
      if (dryRun) setPreviewKey(kind === 'setup' ? key : undoKey)
      else {
        onNotice(
          kind === 'setup'
            ? t('Инструменты контекста применены: хуки и настройки записаны, копии прежних файлов — в папках backups рядом с ними', 'Context Toolkit applied: hooks and settings written, copies of the previous files are in backups folders next to them')
            : t('Откат Инструментов контекста выполнен: хуки и блок правил убраны, бинарь смотрите в блоке «Установка»; модель, советник, effort, пресеты и агенты оставлены (список и бэкап в выводе)', 'Context Toolkit rollback done: hooks and rules block removed, see “Installation” for the binary; model, advisor, effort, presets and agents left as is (list and backup in the output)'),
        )
        // the red button disappears along with the focus: return it to the rollback preview button
        if (kind === 'uninstall') setRefocus(true)
      }
    },
    [opts, key, undoKey, onNotice, reloadStatus, reloadDoctor], // undoOpts comes from opts
  )

  const sum = report.status === 'ready' ? summarize(report.data) : null
  // the level is not a precondition here: the button asks for R2 itself (the confirmation window), like every other write
  const canApply = previewKey === key && !busy
  const canUndo = previewKey === undoKey && !busy
  const askFirst = t('Сначала Loadout спросит разрешение на запись в окне подтверждения', 'Loadout asks for permission to write first, in a confirmation window')
  const spin = (b: Busy, text: string) => (busy === b ? <><span className="spin" aria-hidden="true" />{text}</> : null)

  return (
    <>
      <PageHead
        title={t('Инструменты контекста', 'Context Toolkit')}
        topic="ctxkit"
        sub={t(
          'Хуки, которые не дают ИИ-агентам тратить лимиты впустую: Claude Code, Codex, Antigravity и DeepSeek Harness. Здесь их ставят, проверяют и убирают.',
          'Hooks that keep AI agents from wasting their limits: Claude Code, Codex, Antigravity and DeepSeek Harness. Install, check and remove them here.',
        )}
      />
      <section className="hud card" aria-label={t('Что это и с чего начать', 'What it is and where to start')}>
        <h3>{t('Что это и с чего начать', 'What it is and where to start')}</h3>
        <p>
          {t(
            'Агент быстрее всего расходует лимиты, когда читает большой файл целиком или вываливает в разговор длинный лог сборки. Хук — маленькая программа, которую клиент сам запускает перед каждым действием агента. Хук Инструментов контекста останавливает такое действие и подсказывает агенту, как взять только нужный кусок. Он работает на этом компьютере и ничего не отправляет в сеть.',
            'An agent burns through its limits fastest when it reads a large file whole or dumps a long build log into the conversation. A hook is a small program the client runs by itself before each agent action. The Context Toolkit hook stops such an action and tells the agent how to take only the part it needs. It runs on this computer and sends nothing anywhere.',
          )}
        </p>
        <ol className="steps">
          <li>{t('Ниже, в «Куда поставить», отметьте клиенты, которыми пользуетесь. Claude Code настраивается всегда.', 'Below, under “Where to install”, tick the clients you use. Claude Code is always set up.')}</li>
          <li>{t('Нажмите «Предпросмотр»: окно покажет, какие файлы изменятся, и ничего не запишет.', 'Press Preview: the window shows which files will change and writes nothing.')}</li>
          <li>{t('Нажмите «Применить». Остальные настройки можно не трогать: по умолчанию модели и защиты не меняются.', 'Press Apply. You can leave the other settings alone: by default models and safeguards are not changed.')}</li>
        </ol>
        <p className="mute small">
          {t(
            'Перед записью делается копия каждого файла. Убрать всё — карточкой «Откат» ниже. Клиент подхватит хуки после перезапуска.',
            'Every file is copied before it is written. To remove everything, use the Rollback card below. A client picks the hooks up after a restart.',
          )}
        </p>
      </section>

      <section className="hud card" aria-label={t('Установка', 'Installation')}>
        <h3>{t('Установка', 'Installation')}</h3>
        {status.status === 'loading' ? (
          <p className="mute" role="status">{t('Проверяю…', 'Checking…')}</p>
        ) : status.status === 'error' ? (
          <p className="s-broken" role="alert">{status.error}</p>
        ) : !status.data.available ? (
          <p className="s-broken">{t('Инструменты контекста не входят в эту сборку приложения.', 'Context Toolkit is not included in this build of the app.')}</p>
        ) : (
          <dl className="kv">
            <dt>{t('встроенный', 'bundled')}</dt><dd>context-toolkit {status.data.version ?? '?'}</dd>
            <dt>{t('хуки', 'hooks')}</dt><dd className={status.data.hook === 'same' ? 's-on' : status.data.hook === 'different' ? 's-stale' : 's-broken'}>~/.claude/hooks/context-toolkit.exe: {copyText(status.data.hook)}</dd>
            <dt>{t('в PATH', 'in PATH')}</dt><dd className={status.data.bin === 'same' ? 's-on' : 's-stale'}>~/.local/bin/context-toolkit.exe: {copyText(status.data.bin)}</dd>
          </dl>
        )}
        {status.status === 'ready' && status.data.available && status.data.legacy ? (
          status.data.hook === 'same' ? (
            <p className="s-stale small">
              {t(
                'Остался бинарь прежней версии ~/.claude/hooks/ctxkit.exe: его ещё запускают хуки другого клиента или его не дал удалить запущенный процесс (причина — в выводе «Применить»). Повторное «Применить» уберёт его, когда он станет не нужен.',
                'A binary of the earlier version is left: ~/.claude/hooks/ctxkit.exe. Hooks of another client still run it, or a running process kept it from being deleted (the reason is in the output of “Apply”). Applying again removes it once nothing needs it.',
              )}
            </p>
          ) : (
            <div className="legacy-note" role="note">
              <p className="s-stale">
                {t('Установлена прежняя версия (ctxkit): нажмите «Применить», чтобы перейти на «Инструменты контекста»', 'An earlier version (ctxkit) is installed: press Apply to switch to Context Toolkit')}
              </p>
              <p className="mute small">
                {t(
                  'Хуки, блок правил, файл политик и язык переедут на новое имя, а старый ctxkit.exe удалится, если его больше ничто не запускает; чужие хуки и ваши файлы останутся. Сначала предпросмотр, затем «Применить».',
                  'Hooks, the rules block, the policy file and the language move to the new name, and the old ctxkit.exe is deleted once nothing runs it any more; foreign hooks and your own files stay. Preview first, then “Apply”.',
                )}
              </p>
              <button type="button" disabled={!!busy} aria-busy={busy === 'preview'} onClick={() => void run('setup', true)}>
                {spin('preview', t('Считаю…', 'Working…')) ?? t('Предпросмотр перехода', 'Preview the switch')}
              </button>
            </div>
          )
        ) : null}
      </section>

      <section className="hud card" aria-label={t('Применение', 'Apply')}>
        <h3>{t('Применить', 'Apply')}</h3>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            void run('setup', true)
          }}
        >
          <fieldset className="choices">
            <legend className="mute small">{t('1. Куда поставить — отметьте клиенты, которыми пользуетесь', '1. Where to install: tick the clients you use')}</legend>
            <table className="left ctx-clients" aria-label={t('Клиенты Инструментов контекста', 'Context Toolkit clients')}>
              <thead>
                <tr>
                  <th scope="col">{t('Клиент', 'Client')}</th>
                  <th scope="col">{t('Что получает', 'What it gets')}</th>
                  <th scope="col">{t('Сейчас', 'Now')}</th>
                </tr>
              </thead>
              <tbody>
                {ctxClients().map((c) => {
                  const now = clientNow(c.id, status.status === 'ready' ? status.data.clients : undefined)
                  const flag = c.flag
                  return (
                    <tr key={c.id}>
                      <td className="nw">
                        <label>
                          <input
                            type="checkbox"
                            checked={flag ? opts[flag] : c.id === 'claude'}
                            disabled={!flag}
                            onChange={flag ? (e) => change({ [flag]: e.target.checked }) : undefined}
                          />{' '}
                          {c.name}
                        </label>
                      </td>
                      <td>
                        {c.gets}
                        {c.lacks ? <span className="mute small"> {c.lacks}</span> : null}
                      </td>
                      <td className={`nw ${now.cls}`}>{now.text}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </fieldset>
          <fieldset className="choices">
            <legend className="mute small">{t('2. Что ещё включить (рекомендуется оставить как есть)', '2. What else to turn on (best left as is)')}</legend>
            <label><input type="checkbox" checked={!opts.noStopGate} onChange={(e) => { setGateTouched(true); change({ noStopGate: !e.target.checked }) }} /> {t('Шлюз Stop (только Claude Code): если агент поправил код и не позвал проверку (агента checker или советника), шлюз один раз вернёт его доделать', 'Stop gate (Claude Code only): if the agent edited code and did not call a review (the checker agent or the advisor), the gate sends it back once to finish')}</label>
            <label><input type="checkbox" checked={opts.withRules} onChange={(e) => change({ withRules: e.target.checked })} /> {t('Блок правил — короткая памятка агенту, как экономить контекст: в CLAUDE.md, а для отмеченных Codex, DeepSeek Harness и OpenCode — в их AGENTS.md (у OpenCode — только в уже существующий)', 'Rules block, a short note telling the agent how to save context: in CLAUDE.md, and in the AGENTS.md of Codex, DeepSeek Harness and OpenCode when they are ticked (for OpenCode only into an existing one)')}</label>
          </fieldset>
          <fieldset className="choices" aria-describedby="ctx-policy-hint">
            <legend className="mute small">{t('3. Защиты — можно не трогать (context-toolkit.json)', '3. Safeguards: can be left alone (context-toolkit.json)')}</legend>
            <div className="field">
              <label htmlFor="ctx-policy">{t('Политики', 'Policies')}</label>
              <select
                id="ctx-policy"
                value={opts.policyMode}
                disabled={policyWait}
                onChange={(e) => {
                  const mode = e.target.value as SetupOptions['policyMode']
                  // "Turn on the selected" starts from what is on now, like a first tick: nothing is switched off unseen
                  if (mode === 'on') tick({})
                  else change({ policyMode: mode })
                }}
              >
                <option value="keep">{t('Не менять (по умолчанию)', 'Keep as is (default)')}</option>
                <option value="on">{t('Включить выбранные', 'Turn on the selected')}</option>
                <option value="off">{t('Выключить все', 'Turn all off')}</option>
              </select>
              <span id="ctx-policy-hint" className="mute small">
                {t(
                  'Политики живут в context-toolkit.json профиля. Пока выбрано «Не менять», галочки показывают, что включено сейчас; любая галочка сама переключает список на «Включить выбранные», и тогда включёнными останутся ровно отмеченные. Ключи файла, написанные вами, сохраняются. Предпросмотр покажет по строке на каждую политику (выкл -> вкл).',
                  'The policies live in the profile context-toolkit.json. While “Keep as is” is selected, the checkboxes show what is on now; any tick switches the list to “Turn on the selected” by itself, and then exactly the ticked ones stay on. Keys of the file you wrote yourself are kept. The preview shows one line per policy (off -> on).',
                )}
                {(() => {
                  const now = doctor.status === 'ready' ? policiesNow(doctor.data) : null
                  if (!now) return doctor.status === 'ready' ? ` ${t('Сейчас: файла политик нет, все политики выключены.', 'Now: there is no policy file, every policy is off.')}` : ''
                  return now.broken ? ` ${t('Сейчас:', 'Now:')} ${now.text}` : ` ${t('Сейчас включены:', 'Currently on:')} ${now.text}`
                })()}
              </span>
            </div>
            <label><input type="checkbox" disabled={policyWait} checked={shownPolicies.commitHygiene} onChange={(e) => tick({ commitHygiene: e.target.checked })} /> {t('Гигиена коммитов: хук блокирует коммит со строками Co-Authored-By и Generated with', 'Commit hygiene: the hook blocks a commit with Co-Authored-By or Generated with lines')}</label>
            <label><input type="checkbox" disabled={policyWait} checked={shownPolicies.confirmIrreversible} onChange={(e) => tick({ confirmIrreversible: e.target.checked })} /> {t('Подтверждение необратимого: хук спрашивает перед git push, reset --hard, rm -rf и подобным', 'Confirm irreversible commands: the hook asks before git push, reset --hard, rm -rf and the like')}</label>
            <label><input type="checkbox" disabled={policyWait} checked={shownPolicies.strayFiles} onChange={(e) => tick({ strayFiles: e.target.checked })} /> {t('Неожиданные файлы-отчёты: хук спрашивает перед записью report*.md, summary*.md и подобных в корень проекта', 'Stray report files: the hook asks before a report*.md, summary*.md or similar is written at the project root')}</label>
            <div className="inline-row">
              <label><input type="checkbox" disabled={policyWait} checked={shownPolicies.buildSlots} onChange={(e) => tick({ buildSlots: e.target.checked })} /> {t('Лимит параллельных сборок: context-toolkit check запускает не больше N сборок и тестов одновременно', 'Parallel build limit: context-toolkit check runs at most N builds and tests at once')}</label>
              <input
                type="number"
                min={1}
                max={MAX_BUILD_SLOTS}
                step={1}
                value={shownPolicies.buildSlotsN}
                disabled={policyWait || !shownPolicies.buildSlots}
                aria-label={t('Лимит параллельных сборок, от 1 до 8', 'Parallel build limit, 1 to 8')}
                onChange={(e) => {
                  const n = Math.trunc(Number(e.target.value))
                  if (Number.isFinite(n)) tick({ buildSlotsN: Math.min(MAX_BUILD_SLOTS, Math.max(1, n)) })
                }}
              />
            </div>
          </fieldset>
          <fieldset className="choices">
            <legend className="mute small">{t('4. Модели Claude Code — можно не трогать', '4. Claude Code models: can be left alone')}</legend>
            <label><input type="checkbox" checked={opts.desktop} onChange={(e) => change({ desktop: e.target.checked })} /> {t('Пресеты Claude Desktop: поставить им модель Sonnet (и effort, если он выбран ниже); закройте Claude Desktop перед применением', 'Claude Desktop presets: set them to Sonnet (and the effort if it is chosen below); quit Claude Desktop before applying')}</label>
          </fieldset>
          <div className="field">
            <label htmlFor="ctx-lang">{t('Язык подсказок, хуков и вывода Инструментов контекста', 'Language of prompts, hooks and Context Toolkit output')}</label>
            <select id="ctx-lang" value={opts.lang} onChange={(e) => change({ lang: e.target.value as SetupOptions['lang'] })}>
              <option value="ru">{t('русский', 'Russian')}</option>
              <option value="en">{t('английский', 'English')}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="ctx-main">{t('Основная модель', 'Main model')}</label>
            <select id="ctx-main" aria-describedby="ctx-main-hint" value={opts.mainModel} onChange={(e) => change({ mainModel: e.target.value as SetupOptions['mainModel'] })}>
              <option value="keep">{t('Не менять (по умолчанию)', 'Keep as is (default)')}</option>
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
              <option value="haiku">Haiku</option>
            </select>
            <span id="ctx-main-hint" className="mute small">{t('Пишет model в settings.json профиля Claude Code; прежнее значение предпросмотр покажет строкой «было -> стало».', 'Writes model into the Claude Code profile settings.json; the preview shows the previous value as a “was -> became” line.')}</span>
          </div>
          <div className="field">
            <label htmlFor="ctx-effort">{t('Усилие модели (effort)', 'Model effort')}</label>
            <select id="ctx-effort" aria-describedby="ctx-effort-hint" value={opts.effort} onChange={(e) => change({ effort: e.target.value as SetupOptions['effort'] })}>
              <option value="keep">{t('Не менять (по умолчанию)', 'Keep as is (default)')}</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
            <span id="ctx-effort-hint" className="mute small">{t('Effort пишется для основной модели: modelSettings.<модель>.effortLevel (модель берётся из выбора выше или из уже стоящей model; нужен Claude Code 2.1.251 или новее) и верхний effortLevel. Без известной модели пишется только верхний effortLevel. С галочкой Claude Desktop effort пишется и в его пресеты.', 'Effort is written for the main model: modelSettings.<model>.effortLevel (the model comes from the choice above or from the model already set; needs Claude Code 2.1.251 or newer) and the top-level effortLevel. Without a known model only the top-level effortLevel. With the Claude Desktop checkbox effort is written into its presets too.')}</span>
          </div>
          <div className="field">
            <label htmlFor="ctx-advisor">{t('Модель-советник', 'Advisor model')}</label>
            <select id="ctx-advisor" aria-describedby="ctx-advisor-hint" value={opts.advisor} onChange={(e) => change({ advisor: e.target.value as SetupOptions['advisor'] })}>
              <option value="keep">{t('Не менять (по умолчанию)', 'Keep as is (default)')}</option>
              <option value="fable">Fable</option>
              <option value="opus">Opus</option>
              <option value="none">{t('без советника', 'no advisor')}</option>
            </select>
            <span id="ctx-advisor-hint" className="mute small">{t('advisorModel ставится только если выбрать модель здесь; «без советника» убирает его.', 'advisorModel is set only if you pick a model here; “no advisor” removes it.')}</span>
          </div>
          <div className="actions">
            <button type="submit" ref={previewRef} disabled={!!busy} aria-busy={busy === 'preview'}>
              {spin('preview', t('Считаю…', 'Working…')) ?? t('Предпросмотр (ничего не пишет)', 'Preview (writes nothing)')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!canApply}
              aria-busy={busy === 'apply'}
              title={previewKey !== key ? t('Сначала предпросмотр с этими настройками', 'Preview these settings first') : level !== 'R2' ? askFirst : t('Установить бинарь, прописать хуки и настройки', 'Install the binary, register hooks and settings')}
              onClick={() => void ensureLevel('R2').then((ok) => (ok ? run('setup', false) : undefined))}
            >
              {spin('apply', t('Применяю…', 'Applying…')) ?? t('Применить: установить или обновить', 'Apply: install or update')}
            </button>
          </div>
          <p className="mute small status-line" role="status">{busy === 'preview' || busy === 'apply' ? BUSY_TEXT[busy]() : ''}</p>
        </form>
        {error?.kind === 'setup' ? <p className="s-broken" role="alert">{error.text}</p> : null}
        {result?.kind === 'setup' ? (
          <>
            <p className="mute small">
              {result.dryRun ? t('Предпросмотр: файлы не менялись.', 'Preview: no files were changed.') : t('Применено.', 'Applied.')}{' '}
              {t('Вывод Инструментов контекста:', 'Context Toolkit output:')}
            </p>
            <pre className="out" aria-label={t('Вывод Инструментов контекста', 'Context Toolkit output')} tabIndex={0}>{result.output || t('(пусто)', '(empty)')}</pre>
          </>
        ) : null}
        <p className="mute small">{t('Перед записью Инструменты контекста сами делают копии изменяемых файлов в каталог backups рядом с ними. Применение повторяемо: уже настроенное они не трогают.', 'Before writing, Context Toolkit copies the files it changes into a backups folder next to them. Applying is repeatable: anything already configured is left alone.')}</p>
      </section>

      {/* the rollback is a card of its own, below "Apply": the red button never sits next to the main one */}
      <section className="hud card" aria-label={t('Откат', 'Rollback')}>
        <h3>{t('Откат: убрать Инструменты контекста', 'Rollback: remove Context Toolkit')}</h3>
        <p className="small">
          {t(
            'Откат убирает только то, что поставил «Применить»: хуки Инструментов контекста (и шлюз Stop), блок правил в CLAUDE.md и бинарь хуков; у Codex, Antigravity и DeepSeek Harness — только если они отмечены в «Куда поставить» выше (отметьте те, у кого в столбце «Сейчас» написано «стоят»). Чужие хуки остаются. Если без наших частей файл совпадает с копией, сделанной до установки, он возвращается к ней байт в байт; иначе (например, установка поменяла модель или effort, или вы правили файл) из него вырезаются только наши части.',
            'The rollback removes only what “Apply” installed: the Context Toolkit hooks (and the Stop gate), the rules block in CLAUDE.md and the hooks binary; for Codex, Antigravity and DeepSeek Harness only if they are ticked under “Where to install” above (tick the ones whose “Now” column says “installed”). Foreign hooks stay. If the file without our parts matches the copy made before the install, it goes back to that copy byte for byte; otherwise (the install changed the model or effort, or you edited the file) only our parts are cut out.',
          )}
        </p>
        <p className="mute small">
          {t(
            'Модель, советник, effort, пресеты Claude Desktop и агенты Explore и checker откат не возвращает: прежние значения ему неизвестны. В выводе будут их текущие значения и путь к копии settings.json, из которой их можно вернуть вручную. Чтобы только выключить защиты и оставить хуки, выберите выше в «Политиках» «Выключить все» и нажмите «Применить».',
            'The model, advisor, effort, Claude Desktop presets and the Explore and checker agents are not restored: the rollback does not know their previous values. The output lists their current values and the path to the settings.json backup you can restore them from by hand. To only turn the safeguards off and keep the hooks, pick “Turn all off” under Policies above and press Apply.',
          )}
        </p>
        {(() => {
          // the rollback removes the hooks binary always, but other clients' hooks only when ticked: name the ones it would orphan
          const left = status.status === 'ready' ? ctxClients().filter((c) => c.flag && status.data.clients[c.id] === 'on' && !opts[c.flag]).map((c) => c.name) : []
          return left.length ? (
            <p className="s-stale small" role="note">
              {t(
                `Хуки стоят и в: ${left.join(', ')}. Отметьте их выше в «Куда поставить», иначе откат их не уберёт и они будут вызывать удалённую программу.`,
                `Hooks are also installed in: ${left.join(', ')}. Tick them above under “Where to install”, otherwise the rollback leaves them in place, calling a removed program.`,
              )}
            </p>
          ) : null
        })()}
        <div className="actions">
          <button type="button" ref={undoPreviewRef} disabled={!!busy} aria-busy={busy === 'undoPreview'} onClick={() => void run('uninstall', true)}>
            {spin('undoPreview', t('Считаю…', 'Working…')) ?? t('Показать, что уберёт откат', 'Show what the rollback removes')}
          </button>
          {previewKey === undoKey || busy === 'undo' ? (
            <button
              type="button"
              className="danger"
              disabled={!canUndo}
              aria-busy={busy === 'undo'}
              title={level !== 'R2' ? askFirst : t('Убрать хуки Инструментов контекста, блок правил в CLAUDE.md и бинарь хуков', 'Remove the Context Toolkit hooks, the CLAUDE.md rules block and the hooks binary')}
              onClick={() => void ensureLevel('R2').then((ok) => (ok ? run('uninstall', false) : undefined))}
            >
              {spin('undo', t('Откатываю…', 'Rolling back…')) ?? t('Откатить: убрать хуки, блок правил и бинарь', 'Roll back: remove hooks, rules block and binary')}
            </button>
          ) : null}
        </div>
        <p className="mute small status-line" role="status">{busy === 'undoPreview' || busy === 'undo' ? BUSY_TEXT[busy]() : ''}</p>
        {error?.kind === 'uninstall' ?<p className="s-broken" role="alert">{error.text}</p> : null}
        {result?.kind === 'uninstall' ? (
          <>
            <p className="mute small">
              {result.dryRun ? t('Предпросмотр отката: файлы не менялись.', 'Rollback preview: no files were changed.') : t('Откат выполнен.', 'Rolled back.')}{' '}
              {t('Вывод Инструментов контекста:', 'Context Toolkit output:')}
            </p>
            <pre className="out" aria-label={t('Вывод Инструментов контекста', 'Context Toolkit output')} tabIndex={0}>{result.output || t('(пусто)', '(empty)')}</pre>
          </>
        ) : null}
      </section>

      <section className="hud card" aria-label={t('Диагностика', 'Diagnostics')}>
        <h3>{t('Диагностика', 'Diagnostics')}</h3>
        {doctor.status === 'loading' ? (
          <p className="mute" role="status">{t('Спрашиваю Инструменты контекста…', 'Asking Context Toolkit…')}</p>
        ) : doctor.status === 'error' ? (
          <p className="s-broken" role="alert">{doctor.error}</p>
        ) : (
          <ul className="plist all" aria-label={t('Находки диагностики', 'Diagnostic findings')} aria-busy={doctorBusy}>
            {doctor.data.findings.map((f) => {
              // a fix that is a plain `context-toolkit setup ...` is an action of this window: a button fills the form
              const patch = fixPatch(f.fix)
              return (
                <li key={f.id} className="pitem">
                  <span>
                    <span className={sev(f.severity).cls}>{sev(f.severity).ch} {sev(f.severity).label}</span> · <Rich text={f.message} />
                    {f.detail ? <span className="mute"> (<Rich text={f.detail} />)</span> : null}
                    {f.fix && !patch ? <span className="fix"> {t('Как исправить:', 'How to fix:')} <Rich text={f.fix} /></span> : null}
                  </span>
                  {patch ? (
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => {
                        change(patch)
                        previewRef.current?.scrollIntoView({ block: 'center' })
                        previewRef.current?.focus()
                      }}
                    >
                      {t('Исправить: настроить форму «Применить»', 'Fix: set up the Apply form')}
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
        <div className="actions col">
          <button onClick={reloadDoctor} disabled={doctorBusy} aria-busy={doctorBusy}>
            {doctorBusy ? <><span className="spin" aria-hidden="true" />{t('Проверяю…', 'Checking…')}</> : t('Обновить диагностику', 'Refresh diagnostics')}
          </button>
        </div>
      </section>

      <section className="hud card" aria-label={t('Эффективность', 'Efficiency')}>
        <h3>{t('Эффективность', 'Efficiency')}</h3>
        <div className="bar">
          <label>
            <span className="mute">{t('Период', 'Period')}</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value) as 7 | 14 | 30)} aria-label={t('Период отчёта', 'Report period')}>
              <option value={7}>{t('7 дней', '7 days')}</option>
              <option value={14}>{t('14 дней', '14 days')}</option>
              <option value={30}>{t('30 дней', '30 days')}</option>
            </select>
          </label>
          <button onClick={reloadReport} disabled={reportBusy} aria-busy={reportBusy}>
            {reportBusy ? <><span className="spin" aria-hidden="true" />{t('Считаю…', 'Counting…')}</> : t('Пересчитать', 'Recalculate')}
          </button>
          <span className="mute small" role="status">
            {reportBusy
              ? t(`Считаю по транскриптам за ${count(days, ['день', 'дня', 'дней'], ['day', 'days'])}, это может занять до минуты`, `Counting transcripts for ${count(days, ['день', 'дня', 'дней'], ['day', 'days'])}, this can take up to a minute`)
              : reportAt && report.status === 'ready'
                ? t(`Посчитано в ${fmtTime(reportAt)}`, `Counted at ${fmtTime(reportAt)}`)
                : ''}
          </span>
        </div>
        {report.status === 'loading' ? null : report.status === 'error' ? (
          <p className="s-broken" role="alert">{report.error}</p>
        ) : sum && sum.days === 0 ? (
          <p className="mute">{t('За этот период транскриптов Claude Code нет: считать нечего.', 'No Claude Code transcripts for this period: nothing to count.')}</p>
        ) : sum ? (
          <div className={reportBusy ? 'stale' : undefined} aria-busy={reportBusy}>
            <dl className="kv">
              <dt>{t('ходов основной сессии', 'main session turns')}</dt><dd>{sum.mainTurns}</dd>
              <dt>{t('на Sonnet и Haiku', 'on Sonnet and Haiku')}</dt><dd className="s-on">{pct(sum.cheapShare)}</dd>
              <dt>{t('на Opus и Fable', 'on Opus and Fable')}</dt><dd className={sum.expensiveShare !== null && sum.expensiveShare > 0.5 ? 's-stale' : ''}>{pct(sum.expensiveShare)}</dd>
              <dt>{t('ходов субагентов', 'subagent turns')}</dt><dd>{sum.subTurns} ({t(`${pct(sum.subShare)} от всех`, `${pct(sum.subShare)} of all`)})</dd>
              <dt>{t('вызовов советника', 'advisor calls')}</dt><dd>{sum.advisorCalls}</dd>
              <dt>{t('результатов инструментов', 'tool results')}</dt><dd>{t(`знаков: ${chars(sum.toolResultChars)}, из них чтения файлов ${chars(sum.readChars)}, осмотр оболочкой ${chars(sum.shellInspectChars)}`, `chars: ${chars(sum.toolResultChars)}, of which file reads ${chars(sum.readChars)}, shell inspection ${chars(sum.shellInspectChars)}`)}</dd>
              <dt>{t('чтений остановлено', 'reads blocked')}</dt><dd>{sum.readBlocked}</dd>
              <dt>{t('сжатых проверок (check)', 'compressed checks (check)')}</dt><dd>{t(`${count(sum.checkCalls, ['вызов', 'вызова', 'вызовов'], ['call', 'calls'])}, в контекст ушло знаков: ${chars(sum.checkChars)}`, `${count(sum.checkCalls, ['вызов', 'вызова', 'вызовов'], ['call', 'calls'])}, chars that went into context: ${chars(sum.checkChars)}`)}</dd>
            </dl>
            <p className="mute small">
              {t('Вызовы по агентам:', 'Calls by agent:')} {sum.agents.length ? sum.agents.map(([k, n]) => `${k} ×${n}`).join(', ') : t('нет', 'none')}.
            </p>
            <table className="left" aria-label={t('Ходы по дням', 'Turns by day')}>
              <thead>
                <tr>
                  <th scope="col">{t('День', 'Day')}</th>
                  <th scope="col">{t('Ходы основной сессии по моделям', 'Main session turns by model')}</th>
                  <th scope="col">{t('Советник', 'Advisor')}</th>
                  <th scope="col">{t('Остановлено', 'Blocked')}</th>
                </tr>
              </thead>
              <tbody>
                {daysDesc(report.data).map(([day, d]) => (
                  <tr key={day}>
                    <td className="mono nw">{day}</td>
                    <td className="vcell">
                      <div className="stack" role="img" aria-label={segments(d).map((s) => `${s.label} ${s.n}`).join(', ') || t('ходов не было', 'no turns')}>
                        {segments(d).map((s) => (
                          <span key={s.key} style={{ width: `${(s.w * 100).toFixed(1)}%`, background: SEG_COLOR[s.key] }} />
                        ))}
                      </div>
                      <div className="mute small mono">{segments(d).map((s) => `${s.label} ${s.n}`).join(' · ') || '—'}</div>
                    </td>
                    <td className="mono">{d.advisorCalls}</td>
                    <td className="mono">{d.readBlocked}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mute small">
              {t(
                'Это счётчики из транскриптов Claude Code (только числа, без текста и путей; дни по UTC); другие клиенты в отчёт не входят. Базовой линии «до Инструментов контекста» у отчёта нет, поэтому «сэкономлено» не считается: смотрите, как доля дешёвых моделей и остановленных чтений меняется по дням после применения.',
                'These are counters from Claude Code transcripts (numbers only, no text or paths; days are in UTC); other clients are not in the report. The report has no “before Context Toolkit” baseline, so “saved” is not computed: watch how the share of cheap models and blocked reads changes day by day after applying.',
              )}
            </p>
          </div>
        ) : null}
      </section>
    </>
  )
}
