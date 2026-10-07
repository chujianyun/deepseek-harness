/**
 * The creation wizard: four steps — start (a template or blank), identity and model, capability
 * base, and what the assistant should know about the user — then create.
 */

import { useEffect, useState } from 'react'
import type { AssistantTemplateView, CreateAssistantInput } from '@deepseek-ai/dsh-assistants/types'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { AssistantAvatar, PRESET_AVATAR_KEYS } from './AssistantAvatar.tsx'
import { IdentityFields, modelOf, nameValid, PresetChoices, type IdentityValue } from './AssistantFields.tsx'
import type { WizardOptions } from './assistants-source.ts'
import css from './CreateAssistantWizard.module.css'
import form from './form.module.css'

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

/**
 * Render the wizard dialog.
 * @param props - copy, templates, and the actions it drives.
 * @returns the dialog, or nothing while closed.
 */
export function CreateAssistantWizard({ t, open, templates, onClose, onCreate, onLoadOptions, squareAvatar }: CreateAssistantWizardProps) {
  const first = templates[0]
  const [step, setStep] = useState(0)
  const [templateId, setTemplateId] = useState<string | null>(first?.id ?? null)
  const [identity, setIdentity] = useState<IdentityValue>({
    name: first?.name ?? '', description: first?.description ?? '', avatar: first?.avatar ?? { kind: 'preset', key: PRESET_AVATAR_KEYS[0] }, model: '', effort: '',
  })
  const [options, setOptions] = useState<WizardOptions>({ models: [], presets: [] })
  const [preset, setPreset] = useState('')
  const [user, setUser] = useState({ name: '', language: '', notes: '', background: '' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    void onLoadOptions().then(setOptions)
  }, [onLoadOptions])

  const pick = (template: AssistantTemplateView | null): void => {
    setTemplateId(template?.id ?? null)
    setIdentity({
      ...identity, name: template?.name ?? '', description: template?.description ?? '', avatar: template?.avatar ?? { kind: 'preset', key: PRESET_AVATAR_KEYS[0] },
    })
  }
  const submit = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const model = modelOf(identity.model, identity.effort)
    const refusal = await onCreate({
      templateId, name: identity.name, description: identity.description, avatar: identity.avatar, user,
      ...(model === undefined ? {} : { model }),
      ...(preset === '' ? {} : { preset }),
    })
    setBusy(false)
    if (refusal === undefined) onClose()
    else setFailure(t('createFailed', { message: refusal }))
  }
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
            : <Button variant="primary" disabled={step === 1 && !nameValid(identity.name)} onClick={() => { setStep(step + 1) }}>{t('next')}</Button>}
        </div>
      )}
    >
      <ol className={css.steps}>
        {STEPS.map((key, index) => <li key={key} aria-current={index === step ? 'step' : undefined}>{t(key)}</li>)}
      </ol>
      {step === 0 && (
        <ul className={form.choices} role="radiogroup" aria-label={t('stepStart')}>
          {[...templates, null].map(template => (
            <li key={template?.id ?? 'blank'}>
              <button
                type="button" role="radio" className={form.choice}
                aria-checked={templateId === (template?.id ?? null)}
                onClick={() => { pick(template) }}
              >
                <AssistantAvatar avatar={template?.avatar ?? { kind: 'preset', key: 'slate' }} name={template?.name ?? t('blank')} size={32} />
                <span className={form.choiceText}>
                  <span className={form.choiceName}>{template?.name ?? t('blank')}</span>
                  <span className={form.choiceDescription}>{template?.description ?? t('blankDescription')}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {step === 1 && (
        <IdentityFields
          t={t} value={identity} models={options.models} squareAvatar={squareAvatar}
          onChange={(patch) => { setIdentity({ ...identity, ...patch }) }}
        />
      )}
      {step === 2 && <PresetChoices t={t} presets={options.presets} value={preset} onChange={setPreset} />}
      {step === 3 && (
        <div className={form.form}>
          <p className={form.hint}>{t('userIntro')}</p>
          <div className={form.row}>
            <label className={form.field}>
              <span className={form.label}>{t('userName')}</span>
              <Input value={user.name} placeholder={t('userNamePlaceholder')} onChange={(event) => { setUser({ ...user, name: event.target.value }) }} />
            </label>
            <label className={form.field}>
              <span className={form.label}>{t('userLanguage')}</span>
              <Input value={user.language} placeholder={t('userLanguagePlaceholder')} onChange={(event) => { setUser({ ...user, language: event.target.value }) }} />
            </label>
          </div>
          <label className={form.field}>
            <span className={form.label}>{t('userNotes')}</span>
            <Input value={user.notes} placeholder={t('userNotesPlaceholder')} onChange={(event) => { setUser({ ...user, notes: event.target.value }) }} />
          </label>
          <label className={form.field}>
            <span className={form.label}>{t('userBackground')}</span>
            <textarea className={form.textarea} rows={4} value={user.background} placeholder={t('userBackgroundPlaceholder')} onChange={(event) => { setUser({ ...user, background: event.target.value }) }} />
          </label>
          {failure !== null && <p className={form.error} role="alert">{failure}</p>}
        </div>
      )}
    </Modal>
  )
}
