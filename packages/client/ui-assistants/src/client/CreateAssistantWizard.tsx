/**
 * The creation wizard: four steps — start (a template or blank), identity and model, capability
 * base, and what the assistant should know about the user — then create.
 */

import { useEffect, useState } from 'react'
import type { AssistantAvatar as Avatar, AssistantTemplateView, CreateAssistantInput } from '@deepseek-ai/dsh-assistants/types'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { AssistantAvatar, PRESET_AVATAR_KEYS } from './AssistantAvatar.tsx'
import type { WizardOptions } from './assistants-source.ts'
import { AVATAR_TYPES } from './avatar-image.ts'
import css from './CreateAssistantWizard.module.css'

/** Longest name the wizard accepts, matching the Host's default. */
const MAX_NAME = 32
/** Preset avatars shown at a time; Shuffle shows the next batch. */
const BATCH = 8
const STEPS = ['stepStart', 'stepIdentity', 'stepPreset', 'stepUser'] as const

/** Props of the wizard. */
export interface CreateAssistantWizardProps {
  readonly t: TranslateNS<'assistants'>
  readonly open: boolean
  readonly templates: readonly AssistantTemplateView[]
  readonly onClose: () => void
  readonly onCreate: (input: CreateAssistantInput) => Promise<string | undefined>
  readonly onLoadOptions: () => Promise<WizardOptions>
  /** Crop and compress an uploaded image into an avatar data URL. */
  readonly squareAvatar: (file: Blob) => Promise<string>
}

/** A model choice: empty follows the global default, otherwise the JSON of `[provider, model]`. */
const modelKey = (provider: string, model: string): string => JSON.stringify([provider, model])

/**
 * Render the wizard dialog.
 * @param props - copy, templates, and the actions it drives.
 * @returns the dialog, or nothing while closed.
 */
export function CreateAssistantWizard({ t, open, templates, onClose, onCreate, onLoadOptions, squareAvatar }: CreateAssistantWizardProps) {
  const first = templates[0]
  const [step, setStep] = useState(0)
  const [templateId, setTemplateId] = useState<string | null>(first?.id ?? null)
  const [name, setName] = useState(first?.name ?? '')
  const [description, setDescription] = useState(first?.description ?? '')
  const [avatar, setAvatar] = useState<Avatar>(first?.avatar ?? { kind: 'preset', key: PRESET_AVATAR_KEYS[0] })
  const [batch, setBatch] = useState(0)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [options, setOptions] = useState<WizardOptions>({ models: [], presets: [] })
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [preset, setPreset] = useState('')
  const [user, setUser] = useState({ name: '', language: '', notes: '', background: '' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    void onLoadOptions().then(setOptions)
  }, [onLoadOptions])

  const pick = (template: AssistantTemplateView | null): void => {
    setTemplateId(template?.id ?? null)
    setName(template?.name ?? '')
    setDescription(template?.description ?? '')
    setAvatar(template?.avatar ?? { kind: 'preset', key: PRESET_AVATAR_KEYS[0] })
  }
  const nameValid = name.trim() !== '' && Array.from(name.trim()).length <= MAX_NAME
  const chosenModel = options.models.find(item => modelKey(item.provider, item.id) === model)
  const upload = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    if (!AVATAR_TYPES.includes(file.type)) { setAvatarError(t('uploadInvalid')); return }
    try {
      setAvatar({ kind: 'image', dataUrl: await squareAvatar(file) })
      setAvatarError(null)
    } catch {
      // The browser could not decode the file as an image.
      setAvatarError(t('uploadFailed'))
    }
  }
  const submit = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const refusal = await onCreate({
      templateId, name, description, avatar, user,
      ...(chosenModel === undefined ? {} : {
        model: { provider: chosenModel.provider, model: chosenModel.id, ...(effort === '' ? {} : { reasoningEffort: effort }) },
      }),
      ...(preset === '' ? {} : { preset }),
    })
    setBusy(false)
    if (refusal === undefined) onClose()
    else setFailure(t('createFailed', { message: refusal }))
  }
  const shown = PRESET_AVATAR_KEYS.slice(batch * BATCH, batch * BATCH + BATCH)
  const last = step === STEPS.length - 1

  return (
    <Modal
      open={open}
      title={t('wizardTitle')}
      closeLabel={t('cancel')}
      onClose={onClose}
      className={css.dialog as string}
      footer={(
        <div className={css.footer}>
          <span className={css.stepOf}>{t('stepOf', { step: step + 1, total: STEPS.length })}</span>
          {step > 0 && <Button variant="outline" onClick={() => { setStep(step - 1) }}>{t('back')}</Button>}
          {last
            ? <Button variant="primary" disabled={busy} onClick={() => { void submit() }}>{busy ? t('creating') : t('finish')}</Button>
            : <Button variant="primary" disabled={step === 1 && !nameValid} onClick={() => { setStep(step + 1) }}>{t('next')}</Button>}
        </div>
      )}
    >
      <ol className={css.steps}>
        {STEPS.map((key, index) => <li key={key} aria-current={index === step ? 'step' : undefined}>{t(key)}</li>)}
      </ol>
      {step === 0 && (
        <ul className={css.choices} role="radiogroup" aria-label={t('stepStart')}>
          {[...templates, null].map(template => (
            <li key={template?.id ?? 'blank'}>
              <button
                type="button" role="radio" className={css.choice}
                aria-checked={templateId === (template?.id ?? null)}
                onClick={() => { pick(template) }}
              >
                <AssistantAvatar avatar={template?.avatar ?? { kind: 'preset', key: 'slate' }} name={template?.name ?? t('blank')} size={32} />
                <span className={css.choiceText}>
                  <span className={css.choiceName}>{template?.name ?? t('blank')}</span>
                  <span className={css.choiceDescription}>{template?.description ?? t('blankDescription')}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {step === 1 && (
        <div className={css.form}>
          <div className={css.field}>
            <label className={css.field}>
              <span className={css.label}>{t('name')}</span>
              <Input value={name} placeholder={t('namePlaceholder')} maxLength={MAX_NAME * 2} onChange={(event) => { setName(event.target.value) }} />
            </label>
            {!nameValid && <span className={css.error} role="alert">{t('nameInvalid', { max: MAX_NAME })}</span>}
          </div>
          <div className={css.field}>
            <span className={css.label}>{t('avatar')}</span>
            <div className={css.avatars}>
              <AssistantAvatar avatar={avatar} name={name} size={44} />
              {shown.map((key, index) => (
                <button
                  key={key} type="button" className={css.avatarChoice} aria-label={`${t('avatar')} ${String(batch * BATCH + index + 1)}`}
                  aria-pressed={avatar.kind === 'preset' && avatar.key === key}
                  onClick={() => { setAvatar({ kind: 'preset', key }); setAvatarError(null) }}
                >
                  <AssistantAvatar avatar={{ kind: 'preset', key }} name={name} size={28} />
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
            <textarea className={css.textarea} rows={3} value={description} placeholder={t('descriptionPlaceholder')} onChange={(event) => { setDescription(event.target.value) }} />
          </label>
          <div className={css.row}>
            <label className={css.field}>
              <span className={css.label}>{t('model')}</span>
              <select
                className={css.select} value={model} aria-label={t('model')}
                onChange={(event) => {
                  setModel(event.target.value)
                  setEffort(options.models.find(item => modelKey(item.provider, item.id) === event.target.value)?.defaultEffort ?? '')
                }}
              >
                <option value="">{t('followGlobal')}</option>
                {options.models.map(item => <option key={modelKey(item.provider, item.id)} value={modelKey(item.provider, item.id)}>{`${item.providerName} / ${item.name}`}</option>)}
              </select>
            </label>
            {chosenModel !== undefined && chosenModel.efforts.length > 0 && (
              <label className={css.field}>
                <span className={css.label}>{t('effort')}</span>
                <select className={css.select} value={effort} aria-label={t('effort')} onChange={(event) => { setEffort(event.target.value) }}>
                  {chosenModel.efforts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
            )}
          </div>
        </div>
      )}
      {step === 2 && (
        <div className={css.form}>
          <p className={css.hint}>{t('presetIntro')}</p>
          <ul className={css.choices} role="radiogroup" aria-label={t('stepPreset')}>
            {[{ id: '', name: t('followDefault'), description: t('followDefaultDescription') }, ...options.presets].map(item => (
              <li key={item.id}>
                <button type="button" role="radio" className={css.choice} aria-checked={preset === item.id} onClick={() => { setPreset(item.id) }}>
                  <span className={css.choiceText}>
                    <span className={css.choiceName}>{item.name}</span>
                    {item.description !== undefined && <span className={css.choiceDescription}>{item.description}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {step === 3 && (
        <div className={css.form}>
          <p className={css.hint}>{t('userIntro')}</p>
          <div className={css.row}>
            <label className={css.field}>
              <span className={css.label}>{t('userName')}</span>
              <Input value={user.name} placeholder={t('userNamePlaceholder')} onChange={(event) => { setUser({ ...user, name: event.target.value }) }} />
            </label>
            <label className={css.field}>
              <span className={css.label}>{t('userLanguage')}</span>
              <Input value={user.language} placeholder={t('userLanguagePlaceholder')} onChange={(event) => { setUser({ ...user, language: event.target.value }) }} />
            </label>
          </div>
          <label className={css.field}>
            <span className={css.label}>{t('userNotes')}</span>
            <Input value={user.notes} placeholder={t('userNotesPlaceholder')} onChange={(event) => { setUser({ ...user, notes: event.target.value }) }} />
          </label>
          <label className={css.field}>
            <span className={css.label}>{t('userBackground')}</span>
            <textarea className={css.textarea} rows={4} value={user.background} placeholder={t('userBackgroundPlaceholder')} onChange={(event) => { setUser({ ...user, background: event.target.value }) }} />
          </label>
          {failure !== null && <p className={css.error} role="alert">{failure}</p>}
        </div>
      )}
    </Modal>
  )
}
