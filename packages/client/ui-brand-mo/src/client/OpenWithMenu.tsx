/** MO's "打开方式" control on delivered and changed files: open with the default application, or show the file in its folder. */
import { useState } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular, IconRightUpOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client'
import css from './OpenWithMenu.module.css'

/**
 * Render the two-item menu over the file's authorized route; the card shows the opening state and any failure.
 * @param props - desktop availability, pending gesture, the native action, and localized copy.
 * @returns the control, or null without a desktop that can open files.
 */
export function OpenWithMenu(
  props: Pick<PropsRuntime<'deliverables.file.actions'>, 'available' | 'pending' | 'onAction'> & PropsLocale<'ui-brand-mo'>,
) {
  const [open, setOpen] = useState(false)
  if (!props.available) return null
  const { t } = props
  return <Menu
    className={css.anchor}
    open={open && !props.pending}
    portal
    dense
    autoFocus
    align="end"
    onClose={() => { setOpen(false) }}
    items={[
      { id: 'open', icon: <IconRightUpOutlineRegular />, label: t('openWith.default') },
      { id: 'reveal', icon: <IconFolderOpenOutlineRegular />, label: t('openWith.reveal') },
    ]}
    onSelect={(id) => {
      setOpen(false)
      void props.onAction(id === 'reveal' ? 'reveal' : 'open')
    }}
    anchor={<Button size="sm" variant="outline" className={css.button} disabled={props.pending} aria-haspopup="menu" aria-expanded={open}
      data-open-with=""
      onClick={() => { setOpen(value => !value) }}>
      {t('openWith.label')}<IconChevronDownOutlineRegular size={10} />
    </Button>}
  />
}
