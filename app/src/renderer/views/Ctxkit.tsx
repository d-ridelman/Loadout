import { useCallback, useEffect, useState } from 'react'
import type { CtxkitDoctor, CtxkitReport, CtxkitStatus, FindingSeverity, SetupOptions, SetupResult, WriteLevel } from '../../shared/model'
import { chars, daysDesc, pct, segments, summarize } from '../ctxkit-stats'

const SEV: Record<FindingSeverity, { ch: string; label: string; cls: string }> = {
  ok: { ch: '●', label: 'в порядке', cls: 's-on' },
  info: { ch: '○', label: 'к сведению', cls: 's-off' },
  warn: { ch: '◐', label: 'внимание', cls: 's-stale' },
  error: { ch: '✕', label: 'ошибка', cls: 's-broken' },
}

const COPY: Record<CtxkitStatus['hook'], string> = {
  same: '● совпадает со встроенным',
  different: '◐ отличается от встроенной: «Применить» заменит её встроенной (это может быть и откат на более старую)',
  missing: '✕ нет: «Применить» установит',
}

const SEG_COLOR = { sonnet: 'var(--green)', haiku: 'var(--cyan)', opusFable: 'var(--orange)', other: 'var(--deco)' } as const

const DEFAULTS: SetupOptions = { withRules: true, desktop: false, antigravity: false, dsh: false, lang: 'ru', advisor: 'fable' }

type Loaded<T> = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; data: T }

function useLoaded<T>(load: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, deps: unknown[]): [Loaded<T>, () => void] {
  const [s, setS] = useState<Loaded<T>>({ status: 'loading' })
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    setS((p) => (p.status === 'ready' ? p : { status: 'loading' }))
    load().then(
      (r) => alive && setS(r.ok ? { status: 'ready', data: r.data } : { status: 'error', error: r.error }),
      (e: unknown) => alive && setS({ status: 'error', error: e instanceof Error ? e.message : 'не удалось' }),
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
  const [opts, setOpts] = useState<SetupOptions>(DEFAULTS)
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const [result, setResult] = useState<SetupResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const key = JSON.stringify(opts)
  const change = (patch: Partial<SetupOptions>) => {
    setOpts({ ...opts, ...patch })
    setPreviewKey(null) // другие настройки — другой предпросмотр
  }

  const run = useCallback(
    async (dryRun: boolean) => {
      setBusy(true)
      setError(null)
      const r = await window.loadout.ctxkitSetup(opts, dryRun).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'не удалось' }))
      setBusy(false)
      if (!r.ok) return setError(r.error)
      setResult(r.data)
      if (r.data.code !== 0) return setError(`ctxkit вышел с кодом ${r.data.code}: подробности в выводе ниже`)
      if (dryRun) setPreviewKey(key)
      else {
        setPreviewKey(null)
        onNotice('ctxkit применён: хуки и настройки записаны, бэкапы ctxkit лежат в ~/.claude/backups')
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
        Встроенный набор, который держит контекст агентов в рамках: ограничивает чтение целых файлов, ловит битые экранирования, сжимает вывод сборок и переключает рутину на дешёвые модели. Хуки пишутся в настройки клиентов, поэтому применение требует уровня R2.
      </p>

      <section className="hud card" aria-label="Установка">
        <h3>Установка</h3>
        {status.status === 'loading' ? (
          <p className="mute" role="status">Проверяю…</p>
        ) : status.status === 'error' ? (
          <p className="s-broken" role="alert">{status.error}</p>
        ) : !status.data.available ? (
          <p className="s-broken">ctxkit не входит в эту сборку приложения.</p>
        ) : (
          <dl className="kv">
            <dt>встроенный</dt><dd>ctxkit {status.data.version ?? '?'}</dd>
            <dt>хуки</dt><dd className={status.data.hook === 'same' ? 's-on' : status.data.hook === 'different' ? 's-stale' : 's-broken'}>~/.claude/hooks/ctxkit.exe: {COPY[status.data.hook]}</dd>
            <dt>в PATH</dt><dd className={status.data.bin === 'same' ? 's-on' : 's-stale'}>~/.local/bin/ctxkit.exe: {COPY[status.data.bin]}</dd>
          </dl>
        )}
      </section>

      <section className="hud card" aria-label="Применение">
        <h3>Применить</h3>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            void run(true)
          }}
        >
          <fieldset className="choices">
            <legend className="mute small">Что настроить</legend>
            <label><input type="checkbox" checked disabled /> Claude Code: хуки, модели, агенты Explore и checker (всегда)</label>
            <label><input type="checkbox" checked={opts.withRules} onChange={(e) => change({ withRules: e.target.checked })} /> Блок правил в CLAUDE.md</label>
            <label><input type="checkbox" checked={opts.desktop} onChange={(e) => change({ desktop: e.target.checked })} /> Claude Desktop (пресеты; закройте его перед применением)</label>
            <label><input type="checkbox" checked={opts.antigravity} onChange={(e) => change({ antigravity: e.target.checked })} /> Antigravity</label>
            <label><input type="checkbox" checked={opts.dsh} onChange={(e) => change({ dsh: e.target.checked })} /> DeepSeek Harness</label>
          </fieldset>
          <label>
            Язык подсказок и хуков
            <select value={opts.lang} onChange={(e) => change({ lang: e.target.value as SetupOptions['lang'] })}>
              <option value="ru">русский</option>
              <option value="en">английский</option>
            </select>
          </label>
          <label>
            Модель-советник
            <select value={opts.advisor} onChange={(e) => change({ advisor: e.target.value as SetupOptions['advisor'] })}>
              <option value="fable">Fable (по умолчанию)</option>
              <option value="opus">Opus</option>
              <option value="none">без советника</option>
            </select>
          </label>
          <div className="actions col">
            <button type="submit" disabled={busy}>{busy && !previewKey ? 'Считаю…' : 'Предпросмотр (ничего не пишет)'}</button>
            <button
              type="button"
              disabled={!canApply}
              title={level !== 'R2' ? 'Включите уровень R2 в шапке окна' : previewKey !== key ? 'Сначала предпросмотр с этими настройками' : 'Установить бинарь, прописать хуки и настройки'}
              onClick={() => void run(false)}
            >
              Применить: установить или обновить
            </button>
          </div>
        </form>
        {error ? <p className="s-broken" role="alert">{error}</p> : null}
        {result ? (
          <>
            <p className="mute small">{result.dryRun ? 'Предпросмотр: файлы не менялись.' : 'Применено.'} Вывод ctxkit:</p>
            <pre className="out" aria-label="Вывод ctxkit" tabIndex={0}>{result.output || '(пусто)'}</pre>
          </>
        ) : null}
        <p className="mute small">Перед записью ctxkit сам делает копии изменяемых файлов в каталог backups рядом с ними. Применение повторяемо: уже настроенное он не трогает.</p>
      </section>

      <section className="hud card" aria-label="Диагностика">
        <h3>Диагностика</h3>
        {doctor.status === 'loading' ? (
          <p className="mute" role="status">Спрашиваю ctxkit…</p>
        ) : doctor.status === 'error' ? (
          <p className="s-broken" role="alert">{doctor.error}</p>
        ) : (
          <ul className="plist" aria-label="Находки диагностики">
            {doctor.data.findings.map((f) => (
              <li key={f.id} className="pitem">
                <span>
                  <span className={SEV[f.severity].cls}>{SEV[f.severity].ch} {SEV[f.severity].label}</span> · {f.message}
                  {f.detail ? <span className="mute"> ({f.detail})</span> : null}
                  {f.fix ? <span className="s-stale"> → {f.fix}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="actions col"><button onClick={reloadDoctor}>Обновить диагностику</button></div>
      </section>

      <section className="hud card" aria-label="Эффективность">
        <h3>Эффективность</h3>
        <label className="form">
          Период
          <select value={days} onChange={(e) => setDays(Number(e.target.value) as 7 | 14 | 30)} aria-label="Период отчёта">
            <option value={7}>7 дней</option>
            <option value={14}>14 дней</option>
            <option value={30}>30 дней</option>
          </select>
        </label>
        {report.status === 'loading' ? (
          <p className="mute" role="status">Считаю по транскриптам…</p>
        ) : report.status === 'error' ? (
          <p className="s-broken" role="alert">{report.error}</p>
        ) : sum && sum.days === 0 ? (
          <p className="mute">За этот период транскриптов Claude Code нет: считать нечего.</p>
        ) : sum ? (
          <>
            <dl className="kv">
              <dt>ходов основной сессии</dt><dd>{sum.mainTurns}</dd>
              <dt>на Sonnet и Haiku</dt><dd className="s-on">{pct(sum.cheapShare)}</dd>
              <dt>на Opus и Fable</dt><dd className={sum.expensiveShare !== null && sum.expensiveShare > 0.5 ? 's-stale' : ''}>{pct(sum.expensiveShare)}</dd>
              <dt>ходов субагентов</dt><dd>{sum.subTurns} ({pct(sum.subShare)} от всех)</dd>
              <dt>вызовов советника</dt><dd>{sum.advisorCalls}</dd>
              <dt>результатов инструментов</dt><dd>{chars(sum.toolResultChars)} знаков, из них чтения файлов {chars(sum.readChars)}, осмотр оболочкой {chars(sum.shellInspectChars)}</dd>
              <dt>чтений остановлено</dt><dd>{sum.readBlocked}</dd>
              <dt>сжатых проверок (check)</dt><dd>{sum.checkCalls} вызовов, в контекст ушло {chars(sum.checkChars)} знаков</dd>
            </dl>
            <p className="mute small">
              Вызовы по агентам: {sum.agents.length ? sum.agents.map(([k, n]) => `${k} ×${n}`).join(', ') : 'нет'}.
            </p>
            <table className="left" aria-label="Ходы по дням">
              <thead>
                <tr>
                  <th scope="col">ДЕНЬ</th>
                  <th scope="col">ХОДЫ ОСНОВНОЙ СЕССИИ ПО МОДЕЛЯМ</th>
                  <th scope="col">СОВЕТНИК</th>
                  <th scope="col">ОСТАНОВЛЕНО</th>
                </tr>
              </thead>
              <tbody>
                {daysDesc(report.data).map(([day, d]) => (
                  <tr key={day}>
                    <td className="mono nw">{day}</td>
                    <td className="vcell">
                      <div className="stack" role="img" aria-label={segments(d).map((s) => `${s.label} ${s.n}`).join(', ') || 'ходов не было'}>
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
              Это счётчики из транскриптов Claude Code (только числа, без текста и путей; дни по UTC). Базовой линии «до ctxkit» у отчёта нет, поэтому «сэкономлено» не считается: смотрите, как доля дешёвых моделей и остановленных чтений меняется по дням после применения.
            </p>
          </>
        ) : null}
        <div className="actions col"><button onClick={reloadReport}>Пересчитать</button></div>
      </section>
    </div>
  )
}
