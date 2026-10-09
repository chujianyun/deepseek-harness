/**
 * The ChatGPT (Codex) card's image-generation switch: whether models are
 * offered `generate_image` while the account is signed in. It writes the
 * setting the moment it is flipped, independently of the card's Save.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link ImageGenerationSwitch}. */
export interface ImageGenerationSwitchProps {
  /** The stored setting. */
  enabled: boolean
  /** Lock the switch (read-only settings or a card write in flight). */
  disabled: boolean
  /** Store the new value; resolves to the refusal message, or undefined once stored. */
  onChange: (next: boolean) => Promise<string | undefined>
  t: (key: keyof typeof en) => string
}

/**
 * Render the switch with its hint and the last refusal.
 * @param props - the stored value, the write, and copy.
 * @returns the switch row.
 */
export function ImageGenerationSwitch(props: ImageGenerationSwitchProps): ReactNode {
  const { t } = props
  const [pending, setPending] = useState<boolean | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  return (
    <div className={styles['field']}>
      <span className={styles['signInActions']}>
        <Switch
          checked={pending ?? props.enabled}
          disabled={props.disabled || pending !== undefined}
          label={t('imageGeneration')}
          onChange={(next) => {
            setFailure(undefined)
            setPending(next)
            void props.onChange(next).then(setFailure).finally(() => { setPending(undefined) })
          }}
        />
        <span className={styles['signInStatus']}>{t('imageGeneration')}</span>
      </span>
      <p className={styles['advancedHint']}>{t('imageGenerationHint')}</p>
      {failure === undefined ? null : <p role="alert" className={styles['error']}>{failure}</p>}
    </div>
  )
}
