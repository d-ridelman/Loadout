import { useEffect, useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { Entity, SimilarInfo, SimilarItem } from '../../shared/model'
import { t } from '../../shared/i18n'

/**
 * "Similar to this" for a skill: up to three skills with a close description, found by a small model on this computer. The model
 * is downloaded only on a click; the descriptions never leave the computer. Shown as a hint ("may be similar"), never as a
 * duplicate: the measurement found no reliable duplicates, only useful neighbours (ml-eval, about one in three is a good pick).
 */
export function Similar({ e, entities, onShow }: { e: Entity; entities: Entity[]; onShow: (x: Entity) => void }) {
  const [info, setInfo] = useState<SimilarInfo | null>(null)
  const [found, setFound] = useState<{ id: string; items: SimilarItem[] } | { id: string; error: string } | null>(null)

  useEffect(() => {
    let live = true
    void window.loadout.similar().then((i) => live && setInfo(i), () => undefined)
    const off = window.loadout.onSimilar((i) => setInfo(i))
    return () => {
      live = false
      off()
    }
  }, [])

  const ready = info?.state.status === 'ready'
  useEffect(() => {
    if (!ready) return
    let live = true
    setFound(null)
    void window.loadout.similarFind(e.id).then(
      (r) => live && setFound(r.ok ? { id: e.id, items: r.data } : { id: e.id, error: r.error }),
      (err: unknown) => live && setFound({ id: e.id, error: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      live = false
    }
    // a new scan (an edited description, a new skill) asks again; the vectors of unchanged texts stay in main's memory
  }, [e.id, ready, entities])

  if (!info) return null
  const s = info.state
  const clientName = (x: Entity) => CLIENTS.find((c) => c.id === x.client)?.name ?? x.client
  return (
    <section className="similar" aria-labelledby="similar-title" aria-busy={s.status === 'downloading' || (ready && found?.id !== e.id)}>
      <h3 id="similar-title">{t('Похожие скилы', 'Similar skills')}</h3>
      {s.status === 'ready' ? (
        found?.id !== e.id ? (
          <p className="mute small">{t('Ищу похожие…', 'Looking for similar skills…')}</p>
        ) : 'error' in found ? (
          <p className="mute small">{found.error}</p>
        ) : found.items.length === 0 ? (
          <p className="mute small">{t('Других скилов для сравнения нет.', 'There are no other skills to compare with.')}</p>
        ) : (
          <>
            <ul className="similar-list">
              {found.items.map((it) => {
                const x = entities.find((y) => y.id === it.id)
                return x ? (
                  <li key={it.id}>
                    <button onClick={() => onShow(x)} title={t('Показать в матрице', 'Show in the matrix')}>
                      <b>{x.name}</b> <span className="mute small">· {clientName(x)}</span>
                    </button>
                  </li>
                ) : null
              })}
            </ul>
            <p className="mute small">{t('Подобраны по смыслу описания; это подсказка, не дубликат.', 'Picked by the meaning of the description: a hint, not a duplicate.')}</p>
          </>
        )
      ) : s.status === 'downloading' ? (
        <>
          <progress max={100} value={s.percent} aria-label={t('Скачивание модели', 'Model download')} />
          <p className="mute small">{t(`Скачивается модель: ${s.percent} %`, `Downloading the model: ${s.percent} %`)}</p>
        </>
      ) : (
        <>
          <p className="mute small">
            {s.status === 'error'
              ? s.reason === 'corrupt'
                ? t('Файлы модели повреждены. Скачайте её заново.', 'The model files are damaged. Download it again.')
                : t('Не удалось скачать модель. Попробуйте позже.', 'Could not download the model. Try again later.')
              : t(
                  `Найдёт скилы с похожим описанием, в том числе на другом языке. Для этого один раз скачивается модель с Hugging Face (${info.mb} МБ); дальше она работает на этом компьютере, описания никуда не отправляются.`,
                  `Finds skills with a similar description, in another language too. A model is downloaded once from Hugging Face (${info.mb} MB); then it runs on this computer and the descriptions go nowhere.`,
                )}
          </p>
          <button onClick={() => void window.loadout.similarDownload()}>
            {t(`Скачать модель (${info.mb} МБ)`, `Download the model (${info.mb} MB)`)}
          </button>
        </>
      )}
    </section>
  )
}
