import { useCallback, useEffect, useState } from 'react'
import type { CtxkitDoctor, CtxkitReport, CtxkitStatus, FindingSeverity, SetupOptions, SetupResult, WriteLevel } from '../../shared/model'
import { getLang, t } from '../../shared/i18n'
import { chars, daysDesc, pct, segments, stopGateOff, summarize } from '../ctxkit-stats'

// t() только во время рендера: язык выбирается до первой отрисовки, а не при импорте модуля
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

/** Язык хуков по умолчанию — язык интерфейса (потом настройка независима); функция, а не константа: язык выбирается после импорта. */
const defaults = (): SetupOptions => ({ withRules: true, desktop: false, antigravity: false, dsh: false, noStopGate: false, lang: getLang(), advisor: 'fable' })

type Loaded<T> = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; data: T }

function useLoaded<T>(load: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, deps: unknown[]): [Loaded<T>, () => void] {
  const [s, setS] = useState<Loaded<T>>({ status: 'loading' })
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    setS((p) => (p.status === 'ready' ? p : { status: 'loading' }))
    load().then(
      (r) => alive && setS(r.ok ? { status: 'ready', data: r.data } : { status: 'error', error: r.error }),
      (e: unknown) => alive && setS({ status: 'error', error: e instanceof Error ? e.message : t('не удалось', 'failed') }),
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n])
  return [s, () => setN((x) => x + 1)]
}

interface Props {
  level: WriteLevel
  onNotice: (message: string) => void
}

/** Встроенный ctxkit (CONCEPT.md §13): установить и применить, диагностика, эффективность по счётчикам транскриптов. */
export function Ctxkit({ level, onNotice }: Props) {
  const [status, reloadStatus] = useLoaded<CtxkitStatus>(() => window.loadout.ctxkitStatus(), [])
  const [doctor, reloadDoctor] = useLoaded<CtxkitDoctor>(() => window.loadout.ctxkitDoctor(), [])
  const [days, setDays] = useState<7 | 14 | 30>(14)
  const [report, reloadReport] = useLoaded<CtxkitReport>(() => window.loadout.ctxkitReport(days), [days])
  const [opts, setOpts] = useState<SetupOptions>(defaults)
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const [result, setResult] = useState<SetupResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Галочка шлюза Stop берёт начальное значение из профиля (шлюз выключен — «Применить» не должен молча включить его),
  // но не затирает выбор, который пользователь уже сделал.
  const [gateTouched, setGateTouched] = useState(false)
  useEffect(() => {
    if (doctor.status !== 'ready' || gateTouched) return
    const off = stopGateOff(doctor.data)
    if (off !== null) setOpts((o) => (o.noStopGate === off ? o : { ...o, noStopGate: off }))
  }, [doctor, gateTouched])

  const key = JSON.stringify(opts)
  const change = (patch: Partial<SetupOptions>) => {
    setOpts({ ...opts, ...patch })
    setPreviewKey(null) // другие настройки — другой предпросмотр
  }

  const run = useCallback(
    async (dryRun: boolean) => {
      setBusy(true)
      setError(null)
      const r = await window.loadout.ctxkitSetup(opts, dryRun).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : t('не удалось', 'failed') }))
      setBusy(false)
      if (!r.ok) return setError(r.error)
      setResult(r.data)
      if (r.data.code !== 0) return setError(t(`ctxkit вышел с кодом ${r.data.code}: подробности в выводе ниже`, `ctxkit exited with code ${r.data.code}: see the output below`))
      if (dryRun) setPreviewKey(key)
      else {
        setPreviewKey(null)
        onNotice(t('ctxkit применён: хуки и настройки записаны, бэкапы ctxkit лежат в ~/.claude/backups', 'ctxkit applied: hooks and settings written, ctxkit backups are in ~/.claude/backups'))
        reloadStatus()
        reloadDoctor()
      }
    },
    [opts, key, onNotice, reloadStatus, reloadDoctor],
  )

  const sum = report.status === 'ready' ? summarize(report.data) : null
  const canApply = level === 'R2' && previewKey === key && !busy

  return (
    <div className="page">
      <h2>ctxkit</h2>
      <p className="mute small">
        {t(
          'Встроенный набор, который держит контекст агентов в рамках: ограничивает чтение целых файлов, ловит битые экранирования, сжимает вывод сборок и подсказывает агентам дешёвый поиск и независимую проверку. Основную модель и effort окно не меняет. Хуки пишутся в настройки клиентов, поэтому применение требует уровня R2.',
          'A bundled toolkit that keeps agent context in check: limits whole-file reads, catches broken escaping, compresses build output and points agents to cheap search and independent review. The window does not change the main model or effort. Hooks are written into client settings, so applying requires level R2.',
        )}
      </p>

      <section className="hud card" aria-label={t('Установка', 'Installation')}>
        <h3>{t('Установка', 'Installation')}</h3>
        {status.status === 'loading' ? (
          <p className="mute" role="status">{t('Проверяю…', 'Checking…')}</p>
        ) : status.status === 'error' ? (
          <p className="s-broken" role="alert">{status.error}</p>
        ) : !status.data.available ? (
          <p className="s-broken">{t('ctxkit не входит в эту сборку приложения.', 'ctxkit is not included in this build of the app.')}</p>
        ) : (
          <dl className="kv">
            <dt>{t('встроенный', 'bundled')}</dt><dd>ctxkit {status.data.version ?? '?'}</dd>
            <dt>{t('хуки', 'hooks')}</dt><dd className={status.data.hook === 'same' ? 's-on' : status.data.hook === 'different' ? 's-stale' : 's-broken'}>~/.claude/hooks/ctxkit.exe: {copyText(status.data.hook)}</dd>
            <dt>{t('в PATH', 'in PATH')}</dt><dd className={status.data.bin === 'same' ? 's-on' : 's-stale'}>~/.local/bin/ctxkit.exe: {copyText(status.data.bin)}</dd>
          </dl>
        )}
      </section>

      <section className="hud card" aria-label={t('Применение', 'Apply')}>
        <h3>{t('Применить', 'Apply')}</h3>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            void run(true)
          }}
        >
          <fieldset className="choices">
            <legend className="mute small">{t('Что настроить', 'What to configure')}</legend>
            <label><input type="checkbox" checked disabled /> {t('Claude Code: хуки, агенты Explore и checker (всегда); основная модель и effort не меняются', 'Claude Code: hooks, Explore and checker agents (always); main model and effort are not changed')}</label>
            <label><input type="checkbox" checked={!opts.noStopGate} onChange={(e) => { setGateTouched(true); change({ noStopGate: !e.target.checked }) }} /> {t('Шлюз Stop: один раз за ход возвращает модель, если правки кода остались без checker или советника', 'Stop gate: once per turn sends the model back if code edits were not followed by checker or the advisor')}</label>
            <label><input type="checkbox" checked={opts.withRules} onChange={(e) => change({ withRules: e.target.checked })} /> {t('Блок правил в CLAUDE.md', 'Rules block in CLAUDE.md')}</label>
            <label><input type="checkbox" checked={opts.desktop} onChange={(e) => change({ desktop: e.target.checked })} /> {t('Claude Desktop (пресеты; закройте его перед применением)', 'Claude Desktop (presets; close it before applying)')}</label>
            <label><input type="checkbox" checked={opts.antigravity} onChange={(e) => change({ antigravity: e.target.checked })} /> Antigravity</label>
            <label><input type="checkbox" checked={opts.dsh} onChange={(e) => change({ dsh: e.target.checked })} /> DeepSeek Harness</label>
          </fieldset>
          <label>
            {t('Язык подсказок и хуков', 'Language of prompts and hooks')}
            <select value={opts.lang} onChange={(e) => change({ lang: e.target.value as SetupOptions['lang'] })}>
              <option value="ru">{t('русский', 'Russian')}</option>
              <option value="en">{t('английский', 'English')}</option>
            </select>
          </label>
          <label>
            {t('Модель-советник (записывается в advisorModel при применении)', 'Advisor model (written to advisorModel when applied)')}
            <select value={opts.advisor} onChange={(e) => change({ advisor: e.target.value as SetupOptions['advisor'] })}>
              <option value="fable">{t('Fable (по умолчанию)', 'Fable (default)')}</option>
              <option value="opus">Opus</option>
              <option value="none">{t('без советника', 'no advisor')}</option>
            </select>
          </label>
          <div className="actions col">
            <button type="submit" disabled={busy}>{busy && !previewKey ? t('Считаю…', 'Working…') : t('Предпросмотр (ничего не пишет)', 'Preview (writes nothing)')}</button>
            <button
              type="button"
              disabled={!canApply}
              title={level !== 'R2' ? t('Включите уровень R2 в шапке окна', 'Enable level R2 in the window header') : previewKey !== key ? t('Сначала предпросмотр с этими настройками', 'Preview these settings first') : t('Установить бинарь, прописать хуки и настройки', 'Install the binary, register hooks and settings')}
              onClick={() => void run(false)}
            >
              {t('Применить: установить или обновить', 'Apply: install or update')}
            </button>
          </div>
        </form>
        {error ? <p className="s-broken" role="alert">{error}</p> : null}
        {result ? (
          <>
            <p className="mute small">{result.dryRun ? t('Предпросмотр: файлы не менялись.', 'Preview: no files were changed.') : t('Применено.', 'Applied.')} {t('Вывод ctxkit:', 'ctxkit output:')}</p>
            <pre className="out" aria-label={t('Вывод ctxkit', 'ctxkit output')} tabIndex={0}>{result.output || t('(пусто)', '(empty)')}</pre>
          </>
        ) : null}
        <p className="mute small">{t('Перед записью ctxkit сам делает копии изменяемых файлов в каталог backups рядом с ними. Применение повторяемо: уже настроенное он не трогает.', 'Before writing, ctxkit copies the files it changes into a backups folder next to them. Applying is repeatable: anything already configured is left alone.')}</p>
      </section>

      <section className="hud card" aria-label={t('Диагностика', 'Diagnostics')}>
        <h3>{t('Диагностика', 'Diagnostics')}</h3>
        {doctor.status === 'loading' ? (
          <p className="mute" role="status">{t('Спрашиваю ctxkit…', 'Asking ctxkit…')}</p>
        ) : doctor.status === 'error' ? (
          <p className="s-broken" role="alert">{doctor.error}</p>
        ) : (
          <ul className="plist" aria-label={t('Находки диагностики', 'Diagnostic findings')}>
            {doctor.data.findings.map((f) => (
              <li key={f.id} className="pitem">
                <span>
                  <span className={sev(f.severity).cls}>{sev(f.severity).ch} {sev(f.severity).label}</span> · {f.message}
                  {f.detail ? <span className="mute"> ({f.detail})</span> : null}
                  {f.fix ? <span className="s-stale"> → {f.fix}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="actions col"><button onClick={reloadDoctor}>{t('Обновить диагностику', 'Refresh diagnostics')}</button></div>
      </section>

      <section className="hud card" aria-label={t('Эффективность', 'Efficiency')}>
        <h3>{t('Эффективность', 'Efficiency')}</h3>
        <label className="form">
          {t('Период', 'Period')}
          <select value={days} onChange={(e) => setDays(Number(e.target.value) as 7 | 14 | 30)} aria-label={t('Период отчёта', 'Report period')}>
            <option value={7}>{t('7 дней', '7 days')}</option>
            <option value={14}>{t('14 дней', '14 days')}</option>
            <option value={30}>{t('30 дней', '30 days')}</option>
          </select>
        </label>
        {report.status === 'loading' ? (
          <p className="mute" role="status">{t('Считаю по транскриптам…', 'Counting from transcripts…')}</p>
        ) : report.status === 'error' ? (
          <p className="s-broken" role="alert">{report.error}</p>
        ) : sum && sum.days === 0 ? (
          <p className="mute">{t('За этот период транскриптов Claude Code нет: считать нечего.', 'No Claude Code transcripts for this period: nothing to count.')}</p>
        ) : sum ? (
          <>
            <dl className="kv">
              <dt>{t('ходов основной сессии', 'main session turns')}</dt><dd>{sum.mainTurns}</dd>
              <dt>{t('на Sonnet и Haiku', 'on Sonnet and Haiku')}</dt><dd className="s-on">{pct(sum.cheapShare)}</dd>
              <dt>{t('на Opus и Fable', 'on Opus and Fable')}</dt><dd className={sum.expensiveShare !== null && sum.expensiveShare > 0.5 ? 's-stale' : ''}>{pct(sum.expensiveShare)}</dd>
              <dt>{t('ходов субагентов', 'subagent turns')}</dt><dd>{sum.subTurns} ({t(`${pct(sum.subShare)} от всех`, `${pct(sum.subShare)} of all`)})</dd>
              <dt>{t('вызовов советника', 'advisor calls')}</dt><dd>{sum.advisorCalls}</dd>
              <dt>{t('результатов инструментов', 'tool results')}</dt><dd>{t(`${chars(sum.toolResultChars)} знаков, из них чтения файлов ${chars(sum.readChars)}, осмотр оболочкой ${chars(sum.shellInspectChars)}`, `${chars(sum.toolResultChars)} chars, of which file reads ${chars(sum.readChars)}, shell inspection ${chars(sum.shellInspectChars)}`)}</dd>
              <dt>{t('чтений остановлено', 'reads blocked')}</dt><dd>{sum.readBlocked}</dd>
              <dt>{t('сжатых проверок (check)', 'compressed checks (check)')}</dt><dd>{t(`${sum.checkCalls} вызовов, в контекст ушло ${chars(sum.checkChars)} знаков`, `${sum.checkCalls} calls, ${chars(sum.checkChars)} chars went into context`)}</dd>
            </dl>
            <p className="mute small">
              {t('Вызовы по агентам:', 'Calls by agent:')} {sum.agents.length ? sum.agents.map(([k, n]) => `${k} ×${n}`).join(', ') : t('нет', 'none')}.
            </p>
            <table className="left" aria-label={t('Ходы по дням', 'Turns by day')}>
              <thead>
                <tr>
                  <th scope="col">{t('ДЕНЬ', 'DAY')}</th>
                  <th scope="col">{t('ХОДЫ ОСНОВНОЙ СЕССИИ ПО МОДЕЛЯМ', 'MAIN SESSION TURNS BY MODEL')}</th>
                  <th scope="col">{t('СОВЕТНИК', 'ADVISOR')}</th>
                  <th scope="col">{t('ОСТАНОВЛЕНО', 'BLOCKED')}</th>
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
                'Это счётчики из транскриптов Claude Code (только числа, без текста и путей; дни по UTC). Базовой линии «до ctxkit» у отчёта нет, поэтому «сэкономлено» не считается: смотрите, как доля дешёвых моделей и остановленных чтений меняется по дням после применения.',
                'These are counters from Claude Code transcripts (numbers only, no text or paths; days are in UTC). The report has no “before ctxkit” baseline, so “saved” is not computed: watch how the share of cheap models and blocked reads changes day by day after applying.',
              )}
            </p>
          </>
        ) : null}
        <div className="actions col"><button onClick={reloadReport}>{t('Пересчитать', 'Recalculate')}</button></div>
      </section>
    </div>
  )
}
