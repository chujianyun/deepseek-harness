/**
 * The account sign-in block of a provider card: whether the account is
 * signed in, a sign-in or sign-out action, and while an attempt runs, what
 * its flow reported (the page to open, a code to enter) and the questions it
 * waits on. Flow messages and option labels are the provider's own text,
 * shown as received.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type {
  AuthorizationFlowView, AuthorizationPromptView, LlmProviderSignIn,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SignInActions } from './sign-in-source.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link AccountSignIn}. */
export interface AccountSignInProps {
  /** How the provider route signs in. */
  declaration: LlmProviderSignIn
  /** The Host's view of the flow; undefined until the first frame names it. */
  flow: AuthorizationFlowView | undefined
  /** An action for this flow is in flight. */
  busy: boolean
  /** The last refused action's message. */
  failure: string | undefined
  /** Disable every control (read-only settings or a card write in flight). */
  disabled: boolean
  actions: SignInActions
  t: (key: keyof typeof en) => string
}

/** One question of the running attempt: options to choose, or a field to fill. */
function Prompt({ prompt, disabled, onAnswer, t }: {
  prompt: AuthorizationPromptView
  disabled: boolean
  onAnswer: (value: string) => void
  t: AccountSignInProps['t']
}): ReactNode {
  const [draft, setDraft] = useState('')
  if (prompt.kind === 'select') {
    return (
      <div className={styles['field']} role="group" aria-label={prompt.message}>
        <span className={styles['fieldLabel']}>{prompt.message}</span>
        <span className={styles['signInActions']}>
          {prompt.options.map(option => (
            <button
              key={option.id}
              type="button"
              className={styles['secondaryButton']}
              title={option.description}
              disabled={disabled}
              onClick={() => { onAnswer(option.id) }}
            >
              {option.label}
            </button>
          ))}
        </span>
      </div>
    )
  }
  const value = draft.trim()
  return (
    <form
      className={styles['field']}
      onSubmit={(event) => {
        event.preventDefault()
        if (value.length > 0) onAnswer(value)
      }}
    >
      <span className={styles['fieldLabel']}>{prompt.message}</span>
      <span className={styles['signInActions']}>
        <input
          className={styles['input']}
          type={prompt.kind === 'secret' ? 'password' : 'text'}
          autoComplete="off"
          value={draft}
          placeholder={prompt.placeholder}
          aria-label={prompt.message}
          disabled={disabled}
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <button type="submit" className={styles['secondaryButton']} disabled={disabled || value.length === 0}>
          {t('signInSubmit')}
        </button>
      </span>
    </form>
  )
}

/**
 * Render the sign-in block.
 * @param props - the declaration, the Host view, and the actions.
 * @returns the block.
 */
export function AccountSignIn(props: AccountSignInProps): ReactNode {
  const { declaration, flow, t, actions } = props
  const key = declaration.key
  const attempt = flow?.attempt ?? null
  const running = attempt?.phase === 'running'
  const disabled = props.disabled || props.busy
  const signedIn = flow?.signedIn === true
  const pageUrl = running ? attempt.notices.findLast(notice => notice.url !== undefined)?.url : undefined
  const code = running ? attempt.notices.findLast(notice => notice.code !== undefined)?.code : undefined
  const latest = running ? attempt.notices.at(-1) : undefined
  return (
    <div className={styles['field']} role="group" aria-label={t('accountSignIn')}>
      <span className={styles['fieldLabel']}>{t('accountSignIn')}</span>
      <span className={styles['signInActions']}>
        <span className={styles['signInStatus']} role="status">{signedIn ? t('signedIn') : t('signedOut')}</span>
        {running
          ? (
            <button type="button" className={styles['secondaryButton']} disabled={disabled} onClick={() => { void actions.cancel(key) }}>
              {t('signInCancel')}
            </button>
          )
          : signedIn
            ? (
              <button type="button" className={styles['secondaryButton']} disabled={disabled} onClick={() => { void actions.signOut(key) }}>
                {t('signOut')}
              </button>
            )
            : (
              <button type="button" className={styles['primaryButton']} disabled={disabled} onClick={() => { void actions.begin(key, declaration.method) }}>
                {t('signIn')}
              </button>
            )}
      </span>
      {running
        ? (
          <div className={styles['signInAttempt']}>
            <p className={styles['advancedHint']}>{latest?.message ?? t('signInWaiting')}</p>
            {pageUrl === undefined
              ? null
              : (
                <a
                  className={styles['signInLink']}
                  href={pageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => { event.preventDefault(); actions.open(pageUrl) }}
                >
                  {t('signInOpenPage')}
                </a>
              )}
            {code === undefined
              ? null
              : <p className={styles['advancedHint']}>{t('signInCode')}: <code className={styles['signInCode']}>{code}</code></p>}
            {attempt.prompts.map(prompt => (
              <Prompt
                key={prompt.id}
                prompt={prompt}
                disabled={disabled}
                t={t}
                onAnswer={(value) => { void actions.answer(key, prompt.id, value) }}
              />
            ))}
          </div>
        )
        : null}
      {attempt?.phase === 'failed' ? <p role="alert" className={styles['error']}>{attempt.error}</p> : null}
      {attempt?.phase === 'cancelled' ? <p className={styles['advancedHint']}>{t('signInCancelled')}</p> : null}
      {props.failure === undefined ? null : <p role="alert" className={styles['error']}>{props.failure}</p>}
      {declaration.acceptsApiKey ? null : <p className={styles['advancedHint']}>{t('signInOnly')}</p>}
      <p className={styles['advancedHint']}>{t('signInRisk')}</p>
    </div>
  )
}
