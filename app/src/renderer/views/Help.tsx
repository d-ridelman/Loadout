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
  { id: 'ctxkit', key: '7', name: t('Инструменты контекста', 'Context Toolkit'), text: t('Хуки, которые не дают агентам Claude Code, Codex, Antigravity и DeepSeek Harness тратить лимиты на чтение больших файлов целиком и длинные логи. Отметьте свои клиенты, нажмите «Предпросмотр», затем «Применить». Можно и не трогать: остальное работает без них.', 'Hooks that keep Claude Code, Codex, Antigravity and DeepSeek Harness agents from spending their limits on whole reads of large files and long logs. Tick your clients, press Preview, then Apply. You can also leave it alone: everything else works without it.') },
]

const faq = (): { q: string; a: string }[] => [
  { q: t('Что такое MCP-сервер, плагин, скил и хук?', 'What are an MCP server, a plugin, a skill and a hook?'), a: t('MCP-сервер — программа, которая даёт ИИ-клиенту новые инструменты (например, доступ к GitHub). Плагин — пакет для Claude Code, внутри может быть всё сразу. Скил — папка с инструкцией, которую модель читает, когда она нужна. Хук — команда, которую клиент запускает сам при событии.', 'An MCP server is a program that gives an AI client new tools (for example, access to GitHub). A plugin is a package for Claude Code that may hold all of these. A skill is a folder with instructions the model reads when it needs them. A hook is a command the client runs by itself on an event.') },
  { q: t('Как выключить MCP-сервер или плагин?', 'How do I disable an MCP server or a plugin?'), a: t('В матрице нажмите на значок ● в столбце нужного клиента, справа нажмите «Выключить». Если запись ещё не разрешена, Loadout спросит разрешение в окне подтверждения. Потом покажет, что изменится в файле, и подождёт подтверждения.', 'In the matrix, click the ● mark in the column of the client, then press Disable on the right. If writing is not allowed yet, Loadout asks for permission in a confirmation window. Then it shows what will change in the file and waits for your confirmation.') },
  { q: t('Зачем Loadout спрашивает разрешение на запись?', 'Why does Loadout ask for permission to write?'), a: t(`Чтобы ничего не менять случайно. Уровни записи: «${levelLabel('R0')}» — только смотреть; «${levelLabel('R1')}» — включать и выключать по флагу; «${levelLabel('R2')}» — ещё корзина, правка, добавление, копирование между клиентами, профили и установка. Уровень меняется в шапке или сам, когда вы нажимаете кнопку действия («Выключить», «Добавить», «Откатить», «Применить»); повышение всегда подтверждается в отдельном окне, которое страница не может нажать сама.`, `So that nothing changes by accident. Write levels: “${levelLabel('R0')}” only looks; “${levelLabel('R1')}” turns entries on and off by a flag; “${levelLabel('R2')}” also uses the trash, edits, adds, copies between clients, applies profiles and installs. The level changes in the header, or by itself when you press an action button (Disable, Add, Roll back, Apply); raising it is always confirmed in a separate window the page cannot press for you.`) },
  { q: t('Что значит «выключить в корзину»?', 'What does “disable (move to trash)” mean?'), a: t('У большинства MCP-серверов нет флага «выключено». Loadout вынимает запись из файла клиента и хранит её у себя в корзине. «Включить» вставляет её обратно на то же место.', 'Most MCP servers have no “disabled” flag. Loadout takes the entry out of the client file and keeps it in its trash. Enable puts it back in the same place.') },
  { q: t('Как отменить изменение?', 'How do I undo a change?'), a: t('Откройте Журнал (клавиша 5) и нажмите «Откатить» у нужной строки. Окно покажет, что вернётся, и подождёт подтверждения. Перед каждой записью Loadout делает копию файла.', 'Open the Journal (key 5) and press Roll back on the row. The window shows what comes back and waits for your confirmation. Loadout copies the file before every write.') },
  { q: t('Я выключил запись, а клиент её всё ещё видит', 'I disabled an entry but the client still sees it'), a: t('Клиенты обычно читают свои настройки при запуске. Закройте клиент и откройте снова.', 'Clients usually read their settings at start. Close the client and open it again.') },
  { q: t('Что значит «не определено»?', 'What does “unknown” mean?'), a: t('Флаг этой записи лежит там, куда Loadout не заглядывает (например, в настройках внутри приложения клиента). Такие строки по умолчанию скрыты флажком над таблицей.', 'The flag of this entry is somewhere Loadout does not read (for example, in settings inside the client app). Such rows are hidden by default by the checkbox above the table.') },
  { q: t('Что такое «область» (user, project, local…)?', 'What is a scope (user, project, local…)?'), a: t('Где лежит запись: user — для всех ваших проектов; project:<папка> и local — только для одной папки; managed и enterprise — заданы организацией; builtin — встроено в клиент; plugin:<имя> — пришло вместе с плагином; profile:<имя> — профиль DeepSeek; other — область, которую Loadout не знает. Одна и та же запись может быть в нескольких областях, тогда в ячейке видно «+N».', 'Where the entry lives: user is for all your projects; project:<folder> and local are for one folder only; managed and enterprise are set by an organisation; builtin comes with the client; plugin:<name> came with a plugin; profile:<name> is a DeepSeek profile; other is a scope Loadout does not know. The same entry can be in several scopes; the cell then shows “+N”.') },
  { q: t('Где лежат копии и корзина?', 'Where are the backups and the trash?'), a: t(`В папке ${BACKUP_DIR_HINT} вашего профиля Windows. Там конфиги целиком, вместе с ключами из env, поэтому никуда не отправляются.`, `In the ${BACKUP_DIR_HINT} folder of your Windows profile. They hold whole configs, env keys included, so they are never sent anywhere.`) },
  { q: t('Выходит ли Loadout в интернет?', 'Does Loadout go online?'), a: t('Сам — только проверить обновления на GitHub; это выключается кнопкой с номером версии в правом нижнем углу. Плагины и скилы скачиваются, только когда вы нажмёте кнопку установки, а модель для «Похожих скилов» — только по кнопке «Скачать модель» (с Hugging Face).', 'On its own, only to check GitHub for updates; turn that off with the version button in the bottom-right corner. Plugins and skills are downloaded only when you press an install button, and the model for “Similar skills” only on “Download the model” (from Hugging Face).') },
  { q: t('Что такое Инструменты контекста и нужны ли они мне?', 'What is Context Toolkit and do I need it?'), a: t('Это хуки — маленькая программа, которую ИИ-клиент сам запускает перед каждым действием агента. Она останавливает чтение большого файла целиком, широкий поиск и битые обратные слеши в командах и подсказывает агенту, как взять только нужный кусок. Так агент тратит меньше лимитов. Если лимиты у вас не кончаются, раздел можно не трогать: остальной Loadout работает и без него.', 'They are hooks: a small program the AI client runs by itself before each agent action. It stops whole reads of large files, broad searches and broken backslashes in commands, and tells the agent how to take only the part it needs. The agent spends fewer limits that way. If you never run out of limits, you can leave the section alone: the rest of Loadout works without it.') },
  { q: t('С чего начать в Инструментах контекста и что выбрать?', 'Where do I start in Context Toolkit and what should I pick?'), a: t('Откройте раздел (клавиша 7). В «Куда поставить» отметьте клиенты, которыми пользуетесь, остальное оставьте как есть: шлюз Stop и блок правил включены, модели и защиты не меняются. Нажмите «Предпросмотр» — окно покажет, какие файлы изменятся, — затем «Применить». После этого перезапустите клиенты; в Codex ещё введите /hooks и доверьте новым хукам.', 'Open the section (key 7). Under “Where to install”, tick the clients you use and leave the rest as it is: the Stop gate and the rules block are on, models and safeguards are not changed. Press Preview, which shows the files that will change, then Apply. Then restart the clients; in Codex also type /hooks and trust the new hooks.') },
  { q: t('Какие клиенты поддерживают Инструменты контекста?', 'Which clients does Context Toolkit support?'), a: t('Полностью — Claude Code (и вкладка Code в Claude Desktop). Codex — проверка команд и правок, без шлюза Stop. Antigravity — проверка команд; ограничение чтения файлов в разработке. DeepSeek Harness — чтение, команды и правки, нужен мост dsh-hooks-claude-code. OpenCode пока не поддерживается: у него нет хуков-команд. Подробно по каждому — в таблице «Куда поставить».', 'Fully: Claude Code (and the Code tab of Claude Desktop). Codex: commands and edits are checked, no Stop gate. Antigravity: commands are checked; limiting file reads is in progress. DeepSeek Harness: reads, commands and edits, needs the dsh-hooks-claude-code bridge. OpenCode is not supported yet: it has no command hooks. Details for each are in the “Where to install” table.') },
  { q: t('Как убрать Инструменты контекста?', 'How do I remove Context Toolkit?'), a: t('В разделе, в карточке «Откат», нажмите «Показать, что уберёт откат», проверьте список и нажмите красную кнопку. Отметьте выше клиенты, у которых в столбце «Сейчас» написано «стоят»: откат трогает только отмеченные. Уходят только наши хуки, блок правил и программа хуков; чужие хуки и ваши правки остаются. Модель и effort откат не возвращает — в выводе будет путь к копии settings.json.', 'In the section, in the Rollback card, press “Show what the rollback removes”, check the list and press the red button. Tick above the clients whose “Now” column says “installed”: the rollback touches only those. Only our hooks, the rules block and the hook program go; foreign hooks and your own edits stay. The rollback does not restore the model and effort: the output gives the path to the settings.json copy.') },
  { q: t('Что значат хук, шлюз Stop, советник, effort и защиты?', 'What do hook, Stop gate, advisor, effort and safeguards mean?'), a: t('Хук — команда, которую клиент запускает сам при событии. Шлюз Stop — хук конца ответа: если агент поправил код и не позвал проверку, он один раз вернёт агента доделать. Советник (advisor) — более сильная модель, к которой основная обращается за советом. Effort — сколько модель думает перед ответом. Защиты — правила вроде «спросить перед git push» или «не писать Co-Authored-By в коммит»; по умолчанию выключены.', 'A hook is a command the client runs by itself on an event. The Stop gate is a hook at the end of a reply: if the agent edited code and did not call a review, it sends the agent back once to finish. The advisor is a stronger model the main one turns to for advice. Effort is how much the model thinks before answering. Safeguards are rules such as “ask before git push” or “no Co-Authored-By in commits”; they are off by default.') },
  { q: t('Как перенести скил, хук или MCP-сервер в другой клиент?', 'How do I move a skill, a hook or an MCP server to another client?'), a: t('Одну запись — в инспекторе кнопкой «Копировать в клиент…»: клиенты, которые её не примут, видны в списке с причиной. Несколько сразу — «Добавить ▾ → Из другого клиента…»: выберите, откуда и куда, отметьте записи. Источник не меняется, предпросмотр показывает каждый файл, что не переносится и что проверить, весь пакет откатывается в журнале одной кнопкой. Скил копируется папкой, хук — только между Claude Code и Codex (в Codex его ещё нужно подтвердить в /hooks), MCP — между всеми, кроме DeepSeek. Исключение для отката: ~/.claude.json запущенный Claude Code часто переписывает сам, и тогда копию в него убирает команда claude mcp remove — предпросмотр её назовёт.', 'One entry: the Copy to client… button in the inspector; the clients that would not take it are listed with the reason. Several at once: Add ▾ → From another client…, pick where from and where to, tick the entries. The source does not change, the preview shows every file, what does not carry over and what to check, and the whole batch rolls back from the journal with one button. A skill is copied as a folder, a hook only between Claude Code and Codex (Codex also needs it confirmed in /hooks), an MCP server between all clients but DeepSeek. One exception for the rollback: a running Claude Code rewrites ~/.claude.json often, and then a copy there is removed with claude mcp remove; the preview names the command.') },
  { q: t('Можно ли включить для другого клиента то, что настроено в проекте?', 'Can I enable for another client what a project has set up?'), a: t('Да: в «Добавить ▾ → Из другого клиента…» выберите в «Где» проект. Loadout знает проекты, которые помнят Claude Code и Codex. Запись проекта копируется в тот же проект: MCP для Claude Code — в личную область local (не в общий .mcp.json), для Codex — в .codex/config.toml проекта, для OpenCode — в его opencode.json; скилы для Codex, Antigravity, DeepSeek и OpenCode — в общую папку .agents/skills. Если в файл проекта попадут значения env, предпросмотр предупредит: папка может быть под git.', 'Yes: in Add ▾ → From another client…, pick the project under Where. Loadout knows the projects Claude Code and Codex remember. A project entry is copied into the same project: MCP for Claude Code goes to the private local scope (not the shared .mcp.json), for Codex to the project’s .codex/config.toml, for OpenCode to its opencode.json; skills for Codex, Antigravity, DeepSeek and OpenCode go to the shared .agents/skills folder. If env values would land in a project file, the preview warns you: the folder may be under git.') },
  { q: t('Почему плагин нельзя скопировать в другой клиент?', 'Why can’t a plugin be copied to another client?'), a: t('Плагин — пакет, который ставит и обновляет сам клиент своим инструментом, правкой файла его не перенести. Окно «Копировать в клиент…» у плагина говорит, что делать в каждом клиенте: у Antigravity есть свой перевод (agy plugin import claude), Codex читает маркетплейсы Claude Code. Скилы и MCP-серверы внутри плагина Loadout тоже не копирует: копия перестала бы обновляться вместе с плагином. Полная таблица — в docs/TRANSFER.md.', 'A plugin is a package its client installs and updates with its own tool; a file edit cannot move it. The plugin’s Copy to client… window says what to do in each client: Antigravity has its own converter (agy plugin import claude), Codex reads Claude Code marketplaces. Loadout does not copy the skills and MCP servers inside a plugin either: the copy would stop updating with the plugin. The full table is in docs/TRANSFER.en.md.') },
  { q: t('Как работают «Похожие скилы»?', 'How do “Similar skills” work?'), a: t('Выберите скил в матрице: в инспекторе появится до трёх скилов с похожим по смыслу описанием, в том числе на другом языке. Их подбирает небольшая модель, которая один раз скачивается по кнопке и дальше работает на этом компьютере. Это подсказка, а не поиск дубликатов: примерно две подсказки из пяти действительно близки, а хотя бы одна полезная находится у семи скилов из десяти.', 'Select a skill in the matrix: the inspector lists up to three skills whose description means something close, in another language too. A small model picks them; it is downloaded once on a click and then runs on this computer. It is a hint, not a duplicate finder: about two picks in five are really close, and seven skills in ten get at least one useful hint.') },
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
