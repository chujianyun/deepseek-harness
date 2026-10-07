/**
 * Assistant form fields shared by the creation wizard and the detail page: identity and model, the
 * capability base, and the capability subsets.
 */

import { useState } from 'react'
import type {
  AssistantAvatar as Avatar, AssistantCapabilityOption, AssistantCapabilityOptions, AssistantModel, AssistantSubsets,
} from '@deepseek-ai/dsh-assistants/types'
import { Button, Checkbox, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { AssistantAvatar, PRESET_AVATAR_KEYS } from './AssistantAvatar.tsx'
import type { WizardModel, WizardPreset } from './assistants-source.ts'
import { AVATAR_TYPES } from './avatar-image.ts'
import css from './form.module.css'

/** Longest name the form accepts, matching the Host's default. */
export const MAX_NAME = 32
/** Preset avatars shown at a time; Shuffle shows the next batch. */
const BATCH = 8

/**
 * Whether a name can be saved.
 * @param name - the typed name.
 * @returns true when it has 1 to {@link MAX_NAME} characters after trimming.
 */
export function nameValid(name: string): boolean {
  return name.trim() !== '' && Array.from(name.trim()).length <= MAX_NAME
}

/**
 * Key of a model choice: empty follows the global default, otherwise the JSON of `[provider, model]`.
 * @param model - the chosen model, or undefined to follow the global default.
 * @returns the key the model select uses.
 */
export function modelKey(model: Pick<AssistantModel, 'provider' | 'model'> | undefined): string {
  return model === undefined ? '' : JSON.stringify([model.provider, model.model])
}

/**
 * The model a choice stands for.
 * @param key - the select's key.
 * @param effort - the chosen reasoning effort; empty means the model's default.
 * @returns the model, or undefined when the choice follows the global default.
 */
export function modelOf(key: string, effort: string): AssistantModel | undefined {
  if (key === '') return undefined
  const [provider, model] = JSON.parse(key) as [string, string]
  return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
}

/** What the identity fields edit. */
export interface IdentityValue {
  readonly name: string
  readonly description: string
  readonly avatar: Avatar
  /** {@link modelKey} of the chosen model. */
  readonly model: string
  readonly effort: string
}

/** Props of {@link IdentityFields}. */
export interface IdentityFieldsProps {
  readonly t: TranslateNS<'assistants'>
  readonly value: IdentityValue
  readonly onChange: (patch: Partial<IdentityValue>) => void
  readonly models: readonly WizardModel[]
  /** Crop and compress an uploaded image into an avatar data URL. */
  readonly squareAvatar: (file: Blob) => Promise<string>
}

/**
 * Render name, avatar, description, and model fields.
 * @param props - copy, the edited value, and the models to offer.
 * @returns the fields.
 */
export function IdentityFields({ t, value, onChange, models, squareAvatar }: IdentityFieldsProps) {
  const [batch, setBatch] = useState(0)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const chosen = models.find(item => modelKey({ provider: item.provider, model: item.id }) === value.model)
  const upload = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    if (!AVATAR_TYPES.includes(file.type)) { setAvatarError(t('uploadInvalid')); return }
    try {
      onChange({ avatar: { kind: 'image', dataUrl: await squareAvatar(file) } })
      setAvatarError(null)
    } catch {
      // The browser could not decode the file as an image.
      setAvatarError(t('uploadFailed'))
    }
  }
  const shown = PRESET_AVATAR_KEYS.slice(batch * BATCH, batch * BATCH + BATCH)
  const stored = value.model !== '' && chosen === undefined ? modelOf(value.model, '') : undefined
  return (
    <div className={css.form}>
      <div className={css.field}>
        <label className={css.field}>
          <span className={css.label}>{t('name')}</span>
          <Input value={value.name} placeholder={t('namePlaceholder')} maxLength={MAX_NAME * 2} onChange={(event) => { onChange({ name: event.target.value }) }} />
        </label>
        {!nameValid(value.name) && <span className={css.error} role="alert">{t('nameInvalid', { max: MAX_NAME })}</span>}
      </div>
      <div className={css.field}>
        <span className={css.label}>{t('avatar')}</span>
        <div className={css.avatars}>
          <AssistantAvatar avatar={value.avatar} name={value.name} size={44} />
          {shown.map((key, index) => (
            <button
              key={key} type="button" className={css.avatarChoice} aria-label={`${t('avatar')} ${String(batch * BATCH + index + 1)}`}
              aria-pressed={value.avatar.kind === 'preset' && value.avatar.key === key}
              onClick={() => { onChange({ avatar: { kind: 'preset', key } }); setAvatarError(null) }}
            >
              <AssistantAvatar avatar={{ kind: 'preset', key }} name={value.name} size={28} />
            </button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => { setBatch((batch + 1) % (PRESET_AVATAR_KEYS.length / BATCH)) }}>{t('shuffle')}</Button>
          <label className={css.upload}>
            {t('upload')}
            <input
              type="file" accept={AVATAR_TYPES.join(',')} aria-label={t('upload')}
              onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = '' }}
            />
          </label>
        </div>
        <span className={avatarError === null ? css.hint : css.error} role={avatarError === null ? undefined : 'alert'}>{avatarError ?? t('uploadHint')}</span>
      </div>
      <label className={css.field}>
        <span className={css.label}>{t('description')}</span>
        <textarea className={css.textarea} rows={3} value={value.description} placeholder={t('descriptionPlaceholder')} onChange={(event) => { onChange({ description: event.target.value }) }} />
      </label>
      <div className={css.row}>
        <label className={css.field}>
          <span className={css.label}>{t('model')}</span>
          <select
            className={css.select} value={value.model} aria-label={t('model')}
            onChange={(event) => {
              const next = models.find(item => modelKey({ provider: item.provider, model: item.id }) === event.target.value)
              onChange({ model: event.target.value, effort: next?.defaultEffort ?? '' })
            }}
          >
            <option value="">{t('followGlobal')}</option>
            {stored !== undefined && <option value={value.model}>{t('modelUnavailable', { name: `${stored.provider} / ${stored.model}` })}</option>}
            {models.map((item) => {
              const key = modelKey({ provider: item.provider, model: item.id })
              return <option key={key} value={key}>{`${item.providerName} / ${item.name}`}</option>
            })}
          </select>
        </label>
        {chosen !== undefined && chosen.efforts.length > 0 && (
          <label className={css.field}>
            <span className={css.label}>{t('effort')}</span>
            <select className={css.select} value={value.effort} aria-label={t('effort')} onChange={(event) => { onChange({ effort: event.target.value }) }}>
              {chosen.efforts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        )}
      </div>
    </div>
  )
}

/** Props of {@link PresetChoices}. */
export interface PresetChoicesProps {
  readonly t: TranslateNS<'assistants'>
  readonly presets: readonly WizardPreset[]
  /** Chosen preset id; empty follows the deployment default. */
  readonly value: string
  readonly onChange: (preset: string) => void
}

/**
 * Render the capability base choices: Follow default, and the preset an assistant already names.
 * @param props - copy, the presets, and the chosen one.
 * @returns the choices; a chosen preset the deployment no longer offers shows as unavailable.
 */
export function PresetChoices({ t, presets, value, onChange }: PresetChoicesProps) {
  // Agent presets are a developer concept: only following the default is offered. An assistant
  // that already names a preset keeps it on display, so it can be seen and moved back.
  const current = presets.find(item => item.id === value) ?? { id: value, name: t('presetUnavailable', { id: value }) }
  const items: readonly WizardPreset[] = [
    { id: '', name: t('followDefault'), description: t('followDefaultDescription') },
    ...(value === '' ? [] : [current]),
  ]
  return (
    <div className={css.form}>
      <p className={css.hint}>{t('presetIntro')}</p>
      <ul className={css.choices} role="radiogroup" aria-label={t('stepPreset')}>
        {items.map(item => (
          <li key={item.id}>
            <button type="button" role="radio" className={css.choice} aria-checked={value === item.id} onClick={() => { onChange(item.id) }}>
              <span className={css.choiceText}>
                <span className={css.choiceName}>{item.name}</span>
                {item.description !== undefined && <span className={css.choiceDescription}>{item.description}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The kinds a subset names, with the copy key of each group. */
const SUBSET_GROUPS = [
  ['skills', 'subsetSkills'], ['connectors', 'subsetConnectors'], ['knowledgeBases', 'subsetKnowledge'],
] as const

/** More choices than this get a search box. */
const SEARCHABLE = 8

/** Copy keys of the connectors the client names. */
const CONNECTOR_NAMES: Readonly<Record<string, 'connectorFeishu' | 'connectorDingtalk'>> = { feishu: 'connectorFeishu', dingtalk: 'connectorDingtalk' }

/** Props of {@link SubsetFields}. */
export interface SubsetFieldsProps {
  readonly t: TranslateNS<'assistants'>
  readonly value: AssistantSubsets
  readonly onChange: (subsets: AssistantSubsets) => void
  /** What can be chosen now; undefined until read. */
  readonly options: AssistantCapabilityOptions | undefined
}

/**
 * Render the Skill, connector, and knowledge base subsets: each All (follow global) or Only
 * selected, with a checklist of what is available now. A selected id no longer available shows as
 * unavailable, so it can be cleared.
 * @param props - copy, the subsets, and the available items.
 * @returns the three groups.
 */
export function SubsetFields({ t, value, onChange, options }: SubsetFieldsProps) {
  const [queries, setQueries] = useState<Partial<Record<keyof AssistantSubsets, string>>>({})
  // Ordered by the selection the form opened with, so a box does not jump when ticked.
  const [opened] = useState(value)
  const label = (kind: keyof AssistantSubsets, option: AssistantCapabilityOption): string => {
    const key = kind === 'connectors' ? CONNECTOR_NAMES[option.id] : undefined
    return key === undefined ? option.name : t(key)
  }
  const set = (kind: keyof AssistantSubsets, ids: readonly string[] | undefined): void => {
    const { [kind]: _old, ...rest } = value
    onChange(ids === undefined ? rest : { ...rest, [kind]: ids })
  }
  return (
    <div className={css.form}>
      <p className={css.hint}>{t('subsetIntro')}</p>
      {SUBSET_GROUPS.map(([kind, title]) => {
        const chosen = value[kind]
        const available = options?.[kind] ?? []
        const needle = (queries[kind] ?? '').trim().toLowerCase()
        const matching = needle === '' ? available : available.filter(option => `${option.name}\n${option.description ?? ''}`.toLowerCase().includes(needle))
        const first = (option: AssistantCapabilityOption): number => Number(opened[kind]?.includes(option.id) ?? false)
        const ordered = [...matching].sort((a, b) => first(b) - first(a))
        const gone = options === undefined ? [] : (chosen ?? []).filter(id => !available.some(option => option.id === id))
        return (
          <fieldset key={kind} className={css.group}>
            <legend className={css.label}>{t(title)}</legend>
            <div className={css.modes}>
              <label className={css.mode}>
                <input type="radio" name={`subset-${kind}`} checked={chosen === undefined} onChange={() => { set(kind, undefined) }} />
                {t('subsetAll')}
              </label>
              <label className={css.mode}>
                <input type="radio" name={`subset-${kind}`} checked={chosen !== undefined} onChange={() => { set(kind, []) }} />
                {t('subsetSelected')}
              </label>
            </div>
            {chosen !== undefined && available.length > SEARCHABLE && (
              <div className={css.searchRow}>
                <Input
                  value={queries[kind] ?? ''} placeholder={t('subsetSearch')} aria-label={`${t(title)} ${t('subsetSearch')}`}
                  onChange={(event) => { setQueries({ ...queries, [kind]: event.target.value }) }}
                />
                <span className={css.hint}>{t('subsetCount', { count: chosen.length })}</span>
              </div>
            )}
            {chosen !== undefined && (
              <div className={css.checklist}>
                {options === undefined && <span className={css.hint}>{t('subsetLoading')}</span>}
                {options !== undefined && available.length === 0 && gone.length === 0 && <span className={css.hint}>{t('subsetNone')}</span>}
                {/* Unavailable and selected items come first, so a long list never hides them. */}
                {gone.map(id => (
                  <span key={id} className={css.gone}>
                    <Checkbox
                      label={label(kind, { id, name: id })} checked
                      onChange={() => { set(kind, chosen.filter(item => item !== id)) }}
                    />
                    <Tag tone="warning">{t('subsetGone')}</Tag>
                  </span>
                ))}
                {ordered.map(option => (
                  <Checkbox
                    key={option.id} label={label(kind, option)} checked={chosen.includes(option.id)}
                    {...(option.description === undefined ? {} : { title: option.description })}
                    onChange={(on) => { set(kind, on ? [...chosen, option.id] : chosen.filter(id => id !== option.id)) }}
                  />
                ))}
              </div>
            )}
          </fieldset>
        )
      })}
    </div>
  )
}
