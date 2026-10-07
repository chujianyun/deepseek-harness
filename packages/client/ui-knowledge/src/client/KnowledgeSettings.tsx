/**
 * A knowledge base's settings, after Cherry Studio's knowledge base settings without a rerank
 * model: file processing, embedding model, chunking, and retrieval. Changing the embedding model of
 * a knowledge base with documents asks first, as every document is processed again.
 */

import { useState, type ReactNode } from 'react'
import type { KnowledgeBaseView, KnowledgeChunkStrategy, KnowledgeSettingsPatch } from '@deepseek-ai/dsh-knowledge-base/types'
import { Button, Input, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { failureText, modelOptions, type KnowledgePageProps } from './shared.ts'
import css from './KnowledgePage.module.css'

/** The form's values; sizes stay text while typed. */
interface Draft {
  readonly embeddingModelId: string
  readonly chunkStrategy: KnowledgeChunkStrategy
  readonly chunkSeparator: string
  readonly chunkSize: string
  readonly chunkOverlap: string
  readonly documentCount: number
  readonly threshold: number
}

/** Why a chunking field cannot be saved. */
type ChunkError = 'chunkSizeInvalid' | 'chunkOverlapMustBeSmaller' | 'chunkSeparatorRequired'

function draftOf(base: KnowledgeBaseView): Draft {
  const { chunkStrategy, chunkSeparator, chunkSize, chunkOverlap, documentCount, threshold } = base.settings
  return {
    embeddingModelId: base.embeddingModelId, chunkStrategy, chunkSeparator,
    chunkSize: String(chunkSize), chunkOverlap: String(chunkOverlap), documentCount, threshold,
  }
}

/** Cherry Studio's chunking rules: a positive size, an overlap below it, and a separator when smart chunking is off. */
function chunkErrors(draft: Draft): Partial<Record<'chunkSize' | 'chunkOverlap' | 'chunkSeparator', ChunkError>> {
  const errors: Partial<Record<'chunkSize' | 'chunkOverlap' | 'chunkSeparator', ChunkError>> = {}
  const size = Number(draft.chunkSize)
  if (draft.chunkSize !== '' && size <= 0) errors.chunkSize = 'chunkSizeInvalid'
  if (draft.chunkSize !== '' && draft.chunkOverlap !== '' && size > 0 && Number(draft.chunkOverlap) >= size) {
    errors.chunkOverlap = 'chunkOverlapMustBeSmaller'
  }
  if (draft.chunkStrategy === 'delimiter' && draft.chunkSeparator === '') errors.chunkSeparator = 'chunkSeparatorRequired'
  return errors
}

/** The changed settings. */
function patchOf(saved: Draft, draft: Draft): KnowledgeSettingsPatch {
  const patch: { -readonly [Key in keyof KnowledgeSettingsPatch]: KnowledgeSettingsPatch[Key] } = {}
  if (draft.embeddingModelId !== saved.embeddingModelId) patch.embeddingModelId = draft.embeddingModelId
  if (draft.chunkStrategy !== saved.chunkStrategy) patch.chunkStrategy = draft.chunkStrategy
  if (draft.chunkSeparator !== saved.chunkSeparator) patch.chunkSeparator = draft.chunkSeparator
  if (draft.chunkSize !== saved.chunkSize) patch.chunkSize = Number(draft.chunkSize)
  if (draft.chunkOverlap !== saved.chunkOverlap) patch.chunkOverlap = Number(draft.chunkOverlap)
  if (draft.documentCount !== saved.documentCount) patch.documentCount = draft.documentCount
  if (draft.threshold !== saved.threshold) patch.threshold = draft.threshold
  return patch
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={css.settingsSection} aria-label={title}>
      <h3 className={css.sectionTitle}>{title}</h3>
      {children}
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <label className={css.settingsField}>
      <span className={css.settingsLabel}>
        <span>{label}</span>
        <span className={css.muted}>{hint}</span>
      </span>
      {children}
    </label>
  )
}

/**
 * Render the settings of the selected knowledge base.
 * @param props - the page props and the knowledge base.
 * @returns the settings form.
 */
export function KnowledgeSettingsPanel(props: KnowledgePageProps & { base: KnowledgeBaseView }) {
  const { t, base, useKnowledge, onSaveSettings, onReprocessAll } = props
  const embedding = useKnowledge(snapshot => snapshot.embedding)
  const busy = useKnowledge(snapshot => snapshot.busy)
  const failure = useKnowledge(snapshot => snapshot.failure)
  const saved = draftOf(base)
  const [draft, setDraft] = useState<Draft>(saved)
  const [confirming, setConfirming] = useState(false)
  const [done, setDone] = useState(false)
  const edit = (change: Partial<Draft>): void => { setDraft({ ...draft, ...change }); setDone(false) }
  const patch = patchOf(saved, draft)
  const errors = chunkErrors(draft)
  const dirty = Object.keys(patch).length > 0
  const chunkingDirty = ['chunkStrategy', 'chunkSeparator', 'chunkSize', 'chunkOverlap'].some(key => key in patch)
  const canSave = dirty && !busy && draft.chunkSize !== '' && draft.chunkOverlap !== '' && Object.keys(errors).length === 0
  const options = modelOptions(t, embedding)
  const api = embedding?.apiModels.some(model => model.id === draft.embeddingModelId) ?? false
  const save = async (): Promise<void> => {
    setConfirming(false)
    if (await onSaveSettings(base.id, patch)) setDone(true)
  }
  const submit = (): void => {
    if (patch.embeddingModelId !== undefined && base.items.length > 0) setConfirming(true)
    else void save()
  }
  const digits = (value: string): string => value.replace(/\D/gu, '')
  return (
    <div className={css.settings}>
      <Section title={t('settings.fileProcessing')}>
        <Field label={t('settings.processor')} hint={t('settings.processorHint')}>
          <select className={css.select} value="builtin" disabled aria-label={t('settings.processor')}>
            <option value="builtin">{t('settings.builtin')}</option>
          </select>
        </Field>
      </Section>
      <Section title={t('settings.embedding')}>
        <Field label={t('model')} hint={t('settings.embeddingHint')}>
          <select className={css.select} value={draft.embeddingModelId} aria-label={t('model')}
            onChange={(event) => { edit({ embeddingModelId: event.target.value }) }}>
            {!options.some(option => option.id === base.embeddingModelId) && (
              <option value={base.embeddingModelId}>{base.embeddingModelName}</option>
            )}
            {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </Field>
        {base.dimensions !== null && <p className={css.muted}>{t('settings.dimensions', { count: String(base.dimensions) })}</p>}
        {api && <p className={css.muted}>{t('privacy')}</p>}
      </Section>
      <Section title={t('settings.chunking')}>
        <div className={css.settingsRow}>
          <span className={css.settingsLabel}>
            <span>{t('settings.smartChunking')}</span>
            <span className={css.muted}>{t('settings.smartChunkingHint')}</span>
          </span>
          <Switch label={t('settings.smartChunking')} checked={draft.chunkStrategy === 'structured'}
            onChange={(on) => { edit({ chunkStrategy: on ? 'structured' : 'delimiter' }) }} />
        </div>
        <Field label={t('settings.separator')} hint={t('settings.separatorHint')}>
          <Input value={draft.chunkSeparator} placeholder={t('settings.separatorPlaceholder')} onChange={(event) => { edit({ chunkSeparator: event.target.value }) }} />
        </Field>
        <Field label={t('settings.chunkSize')} hint={t('settings.chunkSizeHint')}>
          <Input value={draft.chunkSize} inputMode="numeric" onChange={(event) => { edit({ chunkSize: digits(event.target.value) }) }} />
        </Field>
        <Field label={t('settings.chunkOverlap')} hint={t('settings.chunkOverlapHint')}>
          <Input value={draft.chunkOverlap} inputMode="numeric" onChange={(event) => { edit({ chunkOverlap: digits(event.target.value) }) }} />
        </Field>
        {Object.values(errors).map(error => <p key={error} className={css.fieldError} role="alert">{t(`settings.${error}`)}</p>)}
        <div className={css.settingsRow}>
          <p className={css.warningText}>{t('settings.chunkChangeWarning')}</p>
          <Button variant="outline" disabled={busy || chunkingDirty || base.items.length === 0 || base.status === 'rebuilding'}
            title={chunkingDirty ? t('settings.saveFirst') : undefined} onClick={() => { void onReprocessAll(base.id) }}>
            {t('settings.reprocessAll')}
          </Button>
        </div>
      </Section>
      <Section title={t('settings.retrieval')}>
        <Field label={t('settings.documentCount')} hint={t('settings.documentCountHint')}>
          <span className={css.slider}>
            <input type="range" min={1} max={50} step={1} value={draft.documentCount} aria-label={t('settings.documentCount')}
              onChange={(event) => { edit({ documentCount: Number(event.target.value) }) }} />
            <span className={css.sliderValue}>{draft.documentCount}</span>
          </span>
        </Field>
        <Field label={t('settings.threshold')} hint={t('settings.thresholdHint')}>
          <span className={css.slider}>
            <input type="range" min={0} max={1} step={0.01} value={draft.threshold} aria-label={t('settings.threshold')}
              onChange={(event) => { edit({ threshold: Number(event.target.value) }) }} />
            <span className={css.sliderValue}>{draft.threshold.toFixed(2)}</span>
          </span>
        </Field>
      </Section>
      <div className={css.settingsFooter}>
        <Button variant="ghost" disabled={!dirty || busy} onClick={() => { setDraft(saved); setDone(false) }}>{t('settings.reset')}</Button>
        {done && !dirty && <span className={css.muted} role="status">{t('settings.saved')}</span>}
        {/* The page's notice sits above the fold; the refusal of a save shows here too. */}
        {failure !== null && <span className={css.fieldError} role="alert">{failureText(t, failure)}</span>}
        <Button variant="primary" disabled={!canSave} onClick={submit}>{t('save')}</Button>
      </div>
      <Modal open={confirming} title={t('settings.rebuildTitle')} closeLabel={t('close')} onClose={() => { setConfirming(false) }}
        description={t('settings.rebuildDescription', { count: String(base.items.length) })}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setConfirming(false) }}>{t('cancel')}</Button>
            <Button variant="primary" onClick={() => { void save() }}>{t('settings.rebuildConfirm')}</Button>
          </>
        )} />
    </div>
  )
}
