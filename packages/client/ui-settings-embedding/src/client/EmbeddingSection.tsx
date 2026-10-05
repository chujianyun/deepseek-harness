/** Settings → Embedding models: the local model's download and the API embedding models. */

import { useEffect, useState } from 'react'
import { Button, fileSizeText, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocalModelStatus, LocalModelView } from '@deepseek-ai/dsh-embedding/types'
import type { EmbeddingInjected } from './embedding-source.ts'
import css from './EmbeddingSection.module.css'

/** Props the section reads from its `settings.section` registration: the translator and the embedding face. */
export type EmbeddingSectionProps = PropsLocale<'settings-embedding'> & InjectFace<EmbeddingInjected>

const TONE: Record<LocalModelStatus, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  unsupported: 'neutral', missing: 'neutral', downloading: 'info', paused: 'warning', installed: 'success', failed: 'danger', damaged: 'danger',
}

/**
 * Render the local model card and the API embedding model list with its add form.
 * @param props - the `settings-embedding` translator and the embedding face.
 * @returns the section.
 */
export function EmbeddingSection(props: EmbeddingSectionProps) {
  const { t, useEmbedding, onRefreshProviders } = props
  const local = useEmbedding(snapshot => snapshot.state?.local ?? null)
  const failure = useEmbedding(snapshot => snapshot.failure)
  useEffect(() => { void onRefreshProviders() }, [onRefreshProviders])
  return (
    <section className={css.section} aria-label={t('nav')}>
      <p className={css.intro}>{t('intro')}</p>
      {failure !== null && <p className={css.error} role="alert">{t('actionFailed', { message: failure })}</p>}
      {local !== null && <LocalCard {...props} local={local} />}
      <ApiModels {...props} />
    </section>
  )
}

function LocalCard({ t, local, useEmbedding, onStart, onPause, onRemoveLocal }: EmbeddingSectionProps & { local: LocalModelView }) {
  const busy = useEmbedding(snapshot => snapshot.busy)
  const [confirming, setConfirming] = useState(false)
  const { status } = local
  const showProgress = status === 'downloading' || status === 'paused' || (status === 'failed' && local.receivedBytes > 0)
  const percent = local.totalBytes === 0 ? 0 : Math.floor(local.receivedBytes / local.totalBytes * 100)
  return (
    <div className={css.card}>
      <div className={css.cardHead}>
        <div className={css.identity}>
          <span className={css.title}>{t('local.title')} · {local.name}</span>
          <span className={css.meta}>
            {t('local.subtitle')}
            {local.dimensions !== null && <> · {t('local.dimensions', { count: String(local.dimensions) })}</>}
          </span>
        </div>
        <Tag tone={TONE[status]}>{t(`status.${status}`)}</Tag>
      </div>
      {showProgress && (
        <div className={css.progress}>
          <div className={css.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t('local.title')}>
            <span className={css.fill} style={{ width: `${String(percent)}%` }} />
          </div>
          <span className={css.meta}>
            {t('local.progress', { received: fileSizeText(local.receivedBytes), total: fileSizeText(local.totalBytes) })} · {percent}%
          </span>
        </div>
      )}
      {status === 'unsupported' && <p className={css.meta}>{t('local.unsupported')}</p>}
      {status === 'damaged' && <p className={css.warning}>{t('local.damaged')}</p>}
      {status === 'failed' && local.error !== null && <p className={css.error} role="alert">{t(`error.${local.error}`)}</p>}
      {confirming && <p className={css.meta}>{t('local.removeHint')}</p>}
      {status !== 'unsupported' && (
        <div className={css.actions}>
          {status === 'downloading' && <Button variant="outline" disabled={busy} onClick={() => { void onPause() }}>{t('pause')}</Button>}
          {status === 'paused' && <Button variant="primary" disabled={busy} onClick={() => { void onStart() }}>{t('resume')}</Button>}
          {status === 'missing' && <Button variant="primary" disabled={busy} onClick={() => { void onStart() }}>{t('download')}</Button>}
          {status === 'failed' && <Button variant="primary" disabled={busy} onClick={() => { void onStart() }}>{t('retry')}</Button>}
          {status === 'damaged' && <Button variant="primary" disabled={busy} onClick={() => { void onStart() }}>{t('repair')}</Button>}
          {status !== 'missing' && (confirming
            ? (
              <>
                <Button variant="outline" disabled={busy} onClick={() => { setConfirming(false); void onRemoveLocal() }}>{t('confirmRemove')}</Button>
                <Button variant="ghost" onClick={() => { setConfirming(false) }}>{t('cancel')}</Button>
              </>
            )
            : <Button variant="ghost" disabled={busy} onClick={() => { setConfirming(true) }}>{t('remove')}</Button>)}
        </div>
      )}
    </div>
  )
}

function ApiModels({ t, useEmbedding, onAdd, onRemoveApi, onOpenModels }: EmbeddingSectionProps) {
  const models = useEmbedding(snapshot => snapshot.state?.apiModels ?? [])
  const providers = useEmbedding(snapshot => snapshot.providers)
  const busy = useEmbedding(snapshot => snapshot.busy)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [adding, setAdding] = useState(false)
  const selected = providers.some(item => item.provider === provider) ? provider : providers[0]?.provider ?? ''
  const add = async (): Promise<void> => {
    setAdding(true)
    if (await onAdd(selected, model.trim())) setModel('')
    setAdding(false)
  }
  return (
    <div className={css.card}>
      <div className={css.identity}>
        <span className={css.title}>{t('api.title')}</span>
        <span className={css.meta}>{t('api.subtitle')}</span>
      </div>
      {models.length === 0
        ? <p className={css.meta}>{t('api.empty')}</p>
        : (
          <ul className={css.list}>
            {models.map(item => (
              <li key={item.id} className={css.row}>
                <span className={css.model}>{item.model}</span>
                <span className={css.meta}>{item.providerName} · {t('local.dimensions', { count: String(item.dimensions) })}</span>
                {!item.available && <Tag tone="warning">{t('api.unavailable')}</Tag>}
                <Button variant="ghost" className={css.rowAction} disabled={busy} aria-label={t('api.removeLabel', { name: item.model })}
                  onClick={() => { void onRemoveApi(item.id) }}>{t('remove')}</Button>
              </li>
            ))}
          </ul>
        )}
      {providers.length === 0
        ? (
          <div className={css.notice}>
            <span className={css.meta}>{t('api.noProvider')}</span>
            <Button variant="outline" onClick={onOpenModels}>{t('api.openModels')}</Button>
          </div>
        )
        : (
          <form className={css.form} onSubmit={(event) => { event.preventDefault(); void add() }}>
            <label className={css.field}>
              <span className={css.label}>{t('api.provider')}</span>
              <select className={css.select} value={selected} onChange={(event) => { setProvider(event.target.value) }}>
                {providers.map(item => <option key={item.provider} value={item.provider}>{item.displayName}</option>)}
              </select>
            </label>
            <label className={css.field}>
              <span className={css.label}>{t('api.model')}</span>
              <Input value={model} placeholder={t('api.modelPlaceholder')} onChange={(event) => { setModel(event.target.value) }} />
            </label>
            <Button variant="primary" type="submit" disabled={busy || model.trim().length === 0}>{adding ? t('api.adding') : t('api.add')}</Button>
          </form>
        )}
      <p className={css.hint}>{t('api.privacy')}</p>
    </div>
  )
}
