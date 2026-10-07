/**
 * Assistant form fields shared by the creation wizard and the detail page: identity and model, and
 * the capability base.
 */

import { useState } from 'react'
import type { AssistantAvatar as Avatar, AssistantModel } from '@deepseek-ai/dsh-assistants/types'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
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
 * Render the capability base choices: Follow default, then each preset.
 * @param props - copy, the presets, and the chosen one.
 * @returns the choices; a chosen preset the deployment no longer offers shows as unavailable.
 */
export function PresetChoices({ t, presets, value, onChange }: PresetChoicesProps) {
  const missing = value !== '' && !presets.some(item => item.id === value)
  const items: readonly WizardPreset[] = [
    { id: '', name: t('followDefault'), description: t('followDefaultDescription') },
    ...presets,
    ...(missing ? [{ id: value, name: t('presetUnavailable', { id: value }) }] : []),
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
