/**
 * An assistant's detail page: identity and model, capability base, and the four core files, edited
 * in place and saved together, with the card's actions in the header.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { AssistantDetail as Detail, AssistantSubsets, AssistantView, CoreFileName, UpdateAssistantInput } from '@deepseek-ai/dsh-assistants/types'
import { Button, SegmentedTabs, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { AssistantAvatar } from './AssistantAvatar.tsx'
import { IdentityFields, modelKey, modelOf, nameValid, PresetChoices, SubsetFields, type IdentityValue } from './AssistantFields.tsx'
import type { AssistantsInjected, WizardOptions } from './assistants-source.ts'
import type { AssistantsLocaleKey } from './locales.ts'
import css from './AssistantDetail.module.css'
import form from './form.module.css'

/** Core files in the order the tabs show them. */
const FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md'] as const satisfies readonly CoreFileName[]
/** Copy key of each core file's tab. */
const FILE_LABELS = {
  'IDENTITY.md': 'fileIdentity', 'SOUL.md': 'fileSoul', 'USER.md': 'fileUser', 'AGENTS.md': 'fileAgents',
} as const satisfies Record<CoreFileName, AssistantsLocaleKey>

/** Everything the page edits. */
interface Draft {
  readonly identity: IdentityValue
  readonly preset: string
  readonly subsets: AssistantSubsets
  readonly files: Readonly<Record<CoreFileName, string>>
}

/**
 * The edited values of a saved assistant.
 * @param detail - the assistant and its core files.
 * @returns the draft before any edit.
 */
function draftOf({ assistant, files }: Detail): Draft {
  return {
    identity: {
      name: assistant.name, description: assistant.description, avatar: assistant.avatar,
      model: modelKey(assistant.model), effort: assistant.model?.reasoningEffort ?? '',
    },
    preset: assistant.preset ?? '',
    subsets: assistant.subsets ?? {},
    files,
  }
}

/**
 * The changes between the saved values and the draft.
 * @param saved - the values last saved.
 * @param draft - the edited values.
 * @returns only the changed fields; empty when nothing changed.
 */
function changesOf(saved: Draft, draft: Draft): UpdateAssistantInput {
  const { identity } = draft
  const files = FILES.filter(file => draft.files[file] !== saved.files[file])
  return {
    ...(identity.name === saved.identity.name ? {} : { name: identity.name }),
    ...(identity.description === saved.identity.description ? {} : { description: identity.description }),
    ...(JSON.stringify(identity.avatar) === JSON.stringify(saved.identity.avatar) ? {} : { avatar: identity.avatar }),
    ...(identity.model === saved.identity.model && identity.effort === saved.identity.effort
      ? {}
      : { model: modelOf(identity.model, identity.effort) ?? null }),
    ...(draft.preset === saved.preset ? {} : { preset: draft.preset === '' ? null : draft.preset }),
    ...(sameSubsets(draft.subsets, saved.subsets) ? {} : { subsets: draft.subsets }),
    ...(files.length === 0 ? {} : { files: Object.fromEntries(files.map(file => [file, draft.files[file]])) }),
  }
}

/** Whether two subsets allow the same items, whatever the order. */
function sameSubsets(a: AssistantSubsets, b: AssistantSubsets): boolean {
  const key = (subsets: AssistantSubsets) => JSON.stringify(['skills', 'connectors', 'knowledgeBases'].map(kind => subsets[kind as keyof AssistantSubsets]?.toSorted() ?? null))
  return key(a) === key(b)
}

/** Props of the detail page. */
export interface AssistantDetailProps extends Pick<AssistantsInjected, 'onChat' | 'onRead' | 'onUpdate' | 'onLoadOptions' | 'squareAvatar'> {
  readonly t: TranslateNS<'assistants'>
  readonly assistant: AssistantView
  readonly isDefault: boolean
  readonly onBack: () => void
  readonly onSetDefault: () => void
  readonly onDuplicate: () => void
  readonly onDelete: () => void
  /** Failure banners of the page's actions, shown under the header. */
  readonly alerts?: ReactNode
}

/**
 * Render the detail page of one assistant.
 * @param props - copy, the assistant, and the actions it drives.
 * @returns the page.
 */
export function AssistantDetailPage(props: AssistantDetailProps) {
  const { t, assistant, isDefault, onBack, onChat, onRead, onUpdate, onLoadOptions, squareAvatar } = props
  const ids = useId()
  const [saved, setSaved] = useState<Draft | undefined>(undefined)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [options, setOptions] = useState<WizardOptions>({ models: [], presets: [] })
  const [tab, setTab] = useState<CoreFileName>('IDENTITY.md')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ readonly kind: 'saved' | 'failed'; readonly text: string } | null>(null)

  const load = async (): Promise<void> => {
    const detail = await onRead(assistant.id)
    if (typeof detail === 'string') { setLoadError(detail); return }
    setSaved(draftOf(detail))
    setDraft(draftOf(detail))
  }
  useEffect(() => {
    void load()
    void onLoadOptions().then(setOptions)
  }, [assistant.id])

  const changes = saved === undefined || draft === undefined ? {} : changesOf(saved, draft)
  const dirty = Object.keys(changes).length > 0
  const save = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    const refusal = await onUpdate(assistant.id, changes)
    if (refusal === undefined) {
      // Renaming rewrites the identity file on the Host; read back what was stored.
      await load()
      setNotice({ kind: 'saved', text: t('saved') })
    } else {
      setNotice({ kind: 'failed', text: t('saveFailed', { message: refusal }) })
    }
    setBusy(false)
  }
  const edit = (next: Draft): void => {
    setDraft(next)
    setNotice(null)
  }
  const tabOf = (file: CoreFileName) => ({ value: file, label: t(FILE_LABELS[file]), id: `${ids}-tab-${file}`, panelId: `${ids}-panel-${file}` })
  const current = tabOf(tab)

  return (
    <div className={css.page}>
      <Button variant="ghost" size="sm" className={css.back} onClick={onBack}>{`← ${t('backToList')}`}</Button>
      <header className={css.header}>
        <AssistantAvatar avatar={assistant.avatar} name={assistant.name} size={40} />
        <h1 className={css.title}>{assistant.name}</h1>
        {isDefault && <Tag tone="neutral">{t('default')}</Tag>}
        <span className={css.actions}>
          <Button variant="outline" size="sm" onClick={() => { void onChat(assistant.id) }}>{t('chat')}</Button>
          {!isDefault && <Button variant="ghost" size="sm" onClick={props.onSetDefault}>{t('setDefault')}</Button>}
          <Button variant="ghost" size="sm" onClick={props.onDuplicate}>{t('duplicate')}</Button>
          <Button variant="ghost" size="sm" onClick={props.onDelete}>{t('delete')}</Button>
        </span>
      </header>
      {props.alerts}
      {loadError !== null && <p className={form.error} role="alert">{t('loadFailed', { message: loadError })}</p>}
      {loadError === null && draft === undefined && <p className={form.hint}>{t('loading')}</p>}
      {draft !== undefined && (
        <>
          <section className={css.section} aria-label={t('stepIdentity')}>
            <h2 className={css.heading}>{t('stepIdentity')}</h2>
            <IdentityFields
              t={t} value={draft.identity} models={options.models} squareAvatar={squareAvatar}
              onChange={(patch) => { edit({ ...draft, identity: { ...draft.identity, ...patch } }) }}
            />
            <p className={form.hint}>{t('modelHint')}</p>
          </section>
          <section className={css.section} aria-label={t('stepPreset')}>
            <h2 className={css.heading}>{t('stepPreset')}</h2>
            <PresetChoices t={t} presets={options.presets} value={draft.preset} onChange={(preset) => { edit({ ...draft, preset }) }} />
          </section>
          <section className={css.section} aria-label={t('stepSubsets')}>
            <h2 className={css.heading}>{t('stepSubsets')}</h2>
            <SubsetFields
              t={t} value={draft.subsets} options={options.capabilities}
              onChange={(subsets) => { edit({ ...draft, subsets }) }}
            />
          </section>
          <section className={css.section} aria-label={t('coreFiles')}>
            <h2 className={css.heading}>{t('coreFiles')}</h2>
            <p className={form.hint}>{t('coreFilesHint')}</p>
            <SegmentedTabs items={[tabOf(FILES[0]), ...FILES.slice(1).map(tabOf)]} value={tab} onChange={setTab} label={t('coreFiles')} className={css.tabs} />
            <div role="tabpanel" id={current.panelId} aria-labelledby={current.id}>
              <textarea
                className={`${form.textarea} ${css.file}`} rows={16} spellCheck={false} aria-label={`${current.label} ${tab}`}
                value={draft.files[tab]}
                onChange={(event) => { edit({ ...draft, files: { ...draft.files, [tab]: event.target.value } }) }}
              />
            </div>
          </section>
          <footer className={css.footer}>
            {notice !== null && (
              <span className={notice.kind === 'saved' ? css.saved : form.error} role={notice.kind === 'saved' ? 'status' : 'alert'}>{notice.text}</span>
            )}
            <Button variant="outline" disabled={!dirty || busy} onClick={() => { setDraft(saved); setNotice(null) }}>{t('discard')}</Button>
            <Button variant="primary" disabled={!dirty || busy || !nameValid(draft.identity.name)} onClick={() => { void save() }}>
              {busy ? t('saving') : t('save')}
            </Button>
          </footer>
        </>
      )}
    </div>
  )
}
