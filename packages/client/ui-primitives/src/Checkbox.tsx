/** Controlled native checkbox with a caller-owned visible and accessible label. */

import clsx from 'clsx'
import css from './Checkbox.module.css'

/**
 * Render a labeled checkbox with native keyboard and form semantics.
 * @param props.checked - current checked state.
 * @param props.onChange - receives the requested checked state.
 * @param props.label - localized visible and accessible label.
 * @param props.disabled - whether the control refuses changes.
 * @param props.title - optional localized hover text.
 * @param props.className - extra class for the label's placement.
 * @param props.labelHidden - keep the label for assistive technology only, when the surrounding
 *   content already shows what the box selects.
 * @param props.indeterminate - show the mixed state (some, not all, of a group selected).
 * @returns the label containing its checkbox.
 */
export function Checkbox({ checked, onChange, label, disabled = false, title, className, labelHidden = false, indeterminate = false }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string | undefined
  className?: string | undefined
  labelHidden?: boolean
  indeterminate?: boolean
}) {
  return (
    <label className={clsx(css.checkbox, className)} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled}
        ref={(element) => { if (element !== null) element.indeterminate = indeterminate }}
        onChange={(event) => { onChange(event.target.checked) }} />
      <span className={labelHidden ? css.hiddenLabel : undefined}>{label}</span>
    </label>
  )
}
