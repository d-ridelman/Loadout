import { useEffect, useRef, useState } from 'react'
import { t } from '../../shared/i18n'
import { BACKUP_DIR_HINT } from '../../shared/backups'
import type { EntityState } from '../../shared/model'
import { GLYPH } from '../aggregate'
import type { View } from '../keep'
import { Glyph, levelLabel } from '../ui'
import { Modal } from './Modal'

export type Fx = 'off' | 'low' | 'full'
export const fxLabel = (m: Fx): string => (m === 'off' ? t('выкл', 'off') : m === 'low' ? t('лёгкие', 'light') : t('полные', 'full'))

type Tab = 'start' | 'sections' | 'faq' | 'keys' | 'view'
/** A topic is a tab or a section of the window (then the "Sections" tab opens on that section). */
export type Topic = Tab | View

const tabs = (): { id: Tab; label: string }[] => [
  { id: 'start', label: t('С чего начать', 'Getting started') },
  { id: 'sections', label: t('Разделы', 'Sections') },
  { id: 'faq', label: t('Вопросы и ответы', 'Questions') },
  { id: 'keys', label: t('Клавиши', 'Shortcuts') },
  { id: 'view', label: t('Вид', 'Appearance') },
]

/** What each section is for, in one or two sentences; the same order and keys as the sidebar. */
export const sectionHelp = (): { id: View; key: string; name: string; text: string }[] => [
  { id: 'matrix', key: '1', name: t('Матрица', 'Matrix'), text: t('Главный экран: строка — запись (MCP-сервер, плагин, скил…), столбец — клиент. Нажмите на значок, справа откроются подробности и кнопки «Включить» / «Выключить».', 'The main screen: a row is an entry (MCP server, plugin, skill…), a column is a client. Click a mark to open the details and the Enable / Disable buttons on the right.') },
  { id: 'radar', key: '2', name: t('Радар', 'Radar'), text: t('Обзор по клиентам: сколько у каждого записей и проблем. Нажмите на клиента, чтобы показать в матрице только его.', 'An overview by client: how many entries and problems each has. Click a client to show only it in the matrix.') },
  { id: 'hooks', key: '3', name: t('Хуки', 'Hooks'), text: t('Команды, которые клиент запускает сам при событиях (начало сессии, вызов инструмента, конец ответа), по порядку.', 'Commands a client runs by itself on events (session start, a tool call, the end of a reply), in order.') },
  { id: 'doctor', key: '4', name: t('Доктор', 'Doctor'), text: t('Найденные проблемы: сломанные записи, разные версии, дубли, секреты в конфигах. У каждой — почему это плохо и как исправить.', 'Problems found: broken entries, version mismatches, duplicates, secrets in configs. Each says why it matters and how to fix it.') },
  { id: 'journal', key: '5', name: t('Журнал', 'Journal'), text: t('Что Loadout записал в конфиги клиентов. Запись откатывается отсюда, если файл с тех пор не меняли: окно покажет, что вернётся, и подождёт подтверждения. Плагины ставит сам claude, их здесь нет.', 'What Loadout wrote to client configs. A write rolls back from here if the file has not changed since: the window shows what comes back and waits for your confirmation. Plugins are installed by claude itself and are not here.') },
  { id: 'profiles', key: '6', name: t('Профили', 'Profiles'), text: t('Сохранённые наборы «что включено». Например, «работа» и «дом»: набор применяется одной кнопкой и откатывается целиком.', 'Saved sets of what is enabled, for example “work” and “home”: a set applies with one button and rolls back as a whole.') },
  { id: 'ctxkit', key: '7', name: t('Инструменты контекста', 'Context Toolkit'), text: t('Для опытных: набор хуков для Claude Code, которые экономят контекст модели. Можно не трогать — остальное работает и без них.', 'For advanced users: hooks for Claude Code that keep the model context small. You can leave it alone: everything else works without it.') },
]

const faq = (): { q: string; a: string }[] => [
  { q: t('Что такое MCP-сервер, плагин, скил и хук?', 'What are an MCP server, a plugin, a skill and a hook?'), a: t('MCP-сервер — программа, которая даёт ИИ-клиенту новые инструменты (например, доступ к GitHub). Плагин — пакет для Claude Code, внутри может быть всё сразу. Скил — папка с инструкцией, которую модель читает, когда она нужна. Хук — команда, которую клиент запускает сам при событии.', 'An MCP server is a program that gives an AI client new tools (for example, access to GitHub). A plugin is a package for Claude Code that may hold all of these. A skill is a folder with instructions the model reads when it needs them. A hook is a command the client runs by itself on an event.') },
  { q: t('Как выключить MCP-сервер или плагин?', 'How do I disable an MCP server or a plugin?'), a: t('В матрице нажмите на значок ● в столбце нужного клиента, справа нажмите «Выключить». Если запись ещё не разрешена, Loadout спросит разрешение в окне Windows. Потом покажет, что изменится в файле, и подождёт подтверждения.', 'In the matrix, click the ● mark in the column of the client, then press Disable on the right. If writing is not allowed yet, Loadout asks for permission in a Windows dialog. Then it shows what will change in the file and waits for your confirmation.') },
  { q: t('Зачем Loadout спрашивает разрешение на запись?', 'Why does Loadout ask for permission to write?'), a: t(`Чтобы ничего не менять случайно. Уровни записи: «${levelLabel('R0')}» — только смотреть; «${levelLabel('R1')}» — включать и выключать по флагу; «${levelLabel('R2')}» — ещё корзина, правка, добавление, профили и установка. Уровень меняется в шапке или сам, когда вы нажимаете кнопку действия («Выключить», «Добавить», «Откатить», «Применить»); повышение всегда подтверждается окном Windows.`, `So that nothing changes by accident. Write levels: “${levelLabel('R0')}” only looks; “${levelLabel('R1')}” turns entries on and off by a flag; “${levelLabel('R2')}” also uses the trash, edits, adds, applies profiles and installs. The level changes in the header, or by itself when you press an action button (Disable, Add, Roll back, Apply); raising it is always confirmed by a Windows dialog.`) },
  { q: t('Что значит «выключить в корзину»?', 'What does “disable (move to trash)” mean?'), a: t('У большинства MCP-серверов нет флага «выключено». Loadout вынимает запись из файла клиента и хранит её у себя в корзине. «Включить» вставляет её обратно на то же место.', 'Most MCP servers have no “disabled” flag. Loadout takes the entry out of the client file and keeps it in its trash. Enable puts it back in the same place.') },
  { q: t('Как отменить изменение?', 'How do I undo a change?'), a: t('Откройте Журнал (клавиша 5) и нажмите «Откатить» у нужной строки. Окно покажет, что вернётся, и подождёт подтверждения. Перед каждой записью Loadout делает копию файла.', 'Open the Journal (key 5) and press Roll back on the row. The window shows what comes back and waits for your confirmation. Loadout copies the file before every write.') },
  { q: t('Я выключил запись, а клиент её всё ещё видит', 'I disabled an entry but the client still sees it'), a: t('Клиенты обычно читают свои настройки при запуске. Закройте клиент и откройте снова.', 'Clients usually read their settings at start. Close the client and open it again.') },
  { q: t('Что значит «не определено»?', 'What does “unknown” mean?'), a: t('Флаг этой записи лежит там, куда Loadout не заглядывает (например, в настройках внутри приложения клиента). Такие строки по умолчанию скрыты флажком над таблицей.', 'The flag of this entry is somewhere Loadout does not read (for example, in settings inside the client app). Such rows are hidden by default by the checkbox above the table.') },
  { q: t('Что такое «область» (user, project, local…)?', 'What is a scope (user, project, local…)?'), a: t('Где лежит запись: user — для всех ваших проектов; project:<папка> и local — только для одной папки; managed и enterprise — заданы организацией; builtin — встроено в клиент; plugin:<имя> — пришло вместе с плагином; profile:<имя> — профиль DeepSeek; other — область, которую Loadout не знает. Одна и та же запись может быть в нескольких областях, тогда в ячейке видно «+N».', 'Where the entry lives: user is for all your projects; project:<folder> and local are for one folder only; managed and enterprise are set by an organisation; builtin comes with the client; plugin:<name> came with a plugin; profile:<name> is a DeepSeek profile; other is a scope Loadout does not know. The same entry can be in several scopes; the cell then shows “+N”.') },
  { q: t('Где лежат копии и корзина?', 'Where are the backups and the trash?'), a: t(`В папке ${BACKUP_DIR_HINT} вашего профиля Windows. Там конфиги целиком, вместе с ключами из env, поэтому никуда не отправляются.`, `In the ${BACKUP_DIR_HINT} folder of your Windows profile. They hold whole configs, env keys included, so they are never sent anywhere.`) },
  { q: t('Выходит ли Loadout в интернет?', 'Does Loadout go online?'), a: t('Сам — только проверить обновления на GitHub; это выключается кнопкой с номером версии в правом нижнем углу. Плагины и скилы скачиваются, только когда вы нажмёте кнопку установки.', 'On its own, only to check GitHub for updates; turn that off with the version button in the bottom-right corner. Plugins and skills are downloaded only when you press an install button.') },
]

interface Props {
  topic: Topic
  fx: Fx
  onFx: (m: Fx) => void
  onWelcome: () => void
  onClose: () => void
}

/** In-window help: getting started, what each section is for, questions and answers, shortcuts and appearance. */
export function Help({ topic, fx, onFx, onWelcome, onClose }: Props) {
  const isTab = (x: Topic): x is Tab => tabs().some((b) => b.id === x)
  const [tab, setTab] = useState<Tab>(isTab(topic) ? topic : 'sections')
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // a section topic scrolls to its entry and focuses it; otherwise focus goes to the current tab
    const el = !isTab(topic) ? document.getElementById(`help-${topic}`) : null
    if (el) {
      el.scrollIntoView({ block: 'nearest' })
      el.focus()
    } else first.current?.focus()
  }, []) // once, on open
  return (
    <Modal label={t('Справка', 'Help')} onEscape={onClose} wide>
      <div className="help-head">
        <h2>{t('Справка', 'Help')}</h2>
        <button className="toast-close" aria-label={t('Закрыть справку', 'Close Help')} onClick={onClose}>×</button>
      </div>
      <div className="bar help-tabs" role="group" aria-label={t('Темы справки', 'Help topics')}>
        {tabs().map((b) => (
          <button key={b.id} ref={b.id === tab ? first : undefined} className="chip" aria-pressed={tab === b.id} onClick={() => setTab(b.id)}>
            {b.label}
          </button>
        ))}
      </div>
      <div className="help-body">
        {tab === 'start' ? (
          <>
            <ol className="steps">
              <li>{t('Найдите запись: поиск над таблицей (клавиша /) или кнопки типов: плагины, MCP, скилы.', 'Find an entry: the search above the table (key /) or the type buttons: plugins, MCP, skills.')}</li>
              <li>{t('Нажмите на значок в столбце нужного клиента. Справа откроется инспектор: что это, где лежит и что с ним можно сделать.', 'Click the mark in the column of the client. The inspector opens on the right: what it is, where it lives and what you can do with it.')}</li>
              <li>{t('Нажмите «Включить» или «Выключить». Loadout спросит разрешение на запись, покажет, что изменится, и подождёт подтверждения. Отменить — в Журнале.', 'Press Enable or Disable. Loadout asks for permission to write, shows what will change and waits for your confirmation. Undo it in the Journal.')}</li>
            </ol>
            <p className="mute">{t('Пока вы ничего не подтвердили, Loadout ничего не меняет.', 'Until you confirm something, Loadout changes nothing.')}</p>
            <button onClick={onWelcome}>{t('Показать приветствие снова', 'Show the welcome card again')}</button>
          </>
        ) : tab === 'sections' ? (
          <dl className="help-list">
            {sectionHelp().map((s) => (
              <div key={s.id} id={`help-${s.id}`} tabIndex={-1} className={topic === s.id ? 'hit' : undefined}>
                <dt><b>{s.name}</b> <kbd>{s.key}</kbd></dt>
                <dd>{s.text}</dd>
              </div>
            ))}
          </dl>
        ) : tab === 'faq' ? (
          <div className="faq">
            {faq().map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
            <details>
              <summary>{t('Что значат значки в таблице?', 'What do the marks in the table mean?')}</summary>
              <ul className="legend">
                {(Object.keys(GLYPH) as (EntityState | 'none')[]).map((k) => (
                  <li key={k}><Glyph state={k} /> {GLYPH[k].label}</li>
                ))}
              </ul>
            </details>
          </div>
        ) : tab === 'keys' ? (
          <dl className="kv keys">
            <dt><kbd>F1</kbd> <kbd>?</kbd></dt><dd>{t('эта справка', 'this help')}</dd>
            <dt><kbd>Ctrl+K</kbd></dt><dd>{t('команды и поиск по всему окну', 'commands and search across the window')}</dd>
            <dt><kbd>1</kbd>–<kbd>7</kbd></dt><dd>{t('разделы (номера видны в меню слева)', 'sections (the numbers are in the menu on the left)')}</dd>
            <dt><kbd>/</kbd></dt><dd>{t('поиск в матрице', 'search the matrix')}</dd>
            <dt><kbd>j</kbd> <kbd>k</kbd> · <kbd>↓</kbd> <kbd>↑</kbd></dt><dd>{t('строка вниз / вверх', 'row down / up')}</dd>
            <dt><kbd>h</kbd> <kbd>l</kbd> · <kbd>←</kbd> <kbd>→</kbd></dt><dd>{t('клиент влево / вправо', 'client left / right')}</dd>
            <dt><kbd>Space</kbd></dt><dd>{t('включить / выключить выбранное', 'enable / disable the selection')}</dd>
            <dt><kbd>r</kbd></dt><dd>{t('перечитать конфиги', 're-read the configs')}</dd>
            <dt><kbd>Esc</kbd></dt><dd>{t('закрыть окно или справку', 'close a dialog or the help')}</dd>
          </dl>
        ) : (
          <div className="form">
            <label className="field">
              {t('Анимация', 'Animation')}
              <select value={fx} onChange={(e) => onFx(e.target.value as Fx)}>
                <option value="off">{fxLabel('off')}</option>
                <option value="low">{fxLabel('low')}</option>
                <option value="full">{fxLabel('full')}</option>
              </select>
            </label>
            <p className="mute small">{t('Вращение луча на Радаре, пульс у сломанных записей и подсветка свежих изменений. «Выкл» — без движения.', 'The radar beam, the pulse of broken entries and the highlight of fresh changes. Off means no motion.')}</p>
          </div>
        )}
      </div>
    </Modal>
  )
}
