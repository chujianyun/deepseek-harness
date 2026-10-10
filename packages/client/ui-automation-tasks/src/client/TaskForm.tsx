/** The Add automation task form, shown by the Automation tasks page in place of its list. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, Checkbox, IconCloseOutlineRegular, Input, RiskConfirmation, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-schedule/client'
import type { TaskFormInjected, TaskFormOptions } from './form-options.ts'
import {
  initialValues, refusalProblem, toRequest, type FrequencyMode, type IntervalUnit, type Repeat, type TaskFormField,
  type TaskFormProblem, type TaskFormValues,
} from './form-model.ts'
import type { TaskFormLocaleKey } from './locales.ts'
import css from './TaskForm.module.css'

/** Full component props: the page's `onDone`, the root standard props, the translator, and the form face. */
export type TaskFormProps = PropsRuntime<'schedule.task.form'> & PropsLocale<'automationTaskForm'> & InjectFace<TaskFormInjected>

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

/** The built-in permission presets, named in the UI language like the composer's permission picker names them. */
const BUILT_IN_PRESETS = new Set(['read-only', 'workspace-write', 'danger-full-access'])

/** The preset an unattended task may take only after the user acknowledges its risk. */
const FULL_ACCESS = 'danger-full-access'

/** A preset's name: a built-in one still under its own value as name is localized; a renamed or other one keeps the catalog's. */
function presetLabel(value: string, name: string, t: TaskFormProps['t']): string {
  return BUILT_IN_PRESETS.has(value) && name === value ? t(`permission.${value}` as TaskFormLocaleKey) : name
}

/** The field whose message a value belongs under. */
const FIELD_OF: Record<keyof TaskFormValues, TaskFormField> = {
  title: 'title', workspaceId: 'workspace', prompt: 'prompt', assistantId: 'prompt', model: 'prompt', permission: 'prompt',
  connectors: 'prompt', mode: 'frequency', repeat: 'frequency', weekdays: 'frequency', time: 'frequency', interval: 'frequency',
  unit: 'frequency', date: 'frequency', start: 'window', end: 'window',
}

/** The next whole hour as a suggested run time, and today's date, both local. */
function suggested(now: Date): { time: string; date: string } {
  const next = new Date(now.getTime())
  next.setMinutes(0, 0, 0)
  next.setHours(next.getHours() + 1)
  const pad = (value: number) => String(value).padStart(2, '0')
  return {
    time: `${pad(next.getHours())}:00`,
    date: `${String(next.getFullYear())}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`,
  }
}

/**
 * Render the form: the fields of one automation task, then Cancel and Save at the bottom. Save
 * checks the fields, creates the task, and hands it to the page; a refusal shows under its field
 * and keeps everything entered.
 * @param props - the page's `onDone`, the workspaces, the translator, and the options and create call.
 * @returns the form.
 */
export function TaskForm({ t, onDone, useWorkspaces, loadOptions, onCreate }: TaskFormProps) {
  const workspaces = useWorkspaces(snapshot => snapshot.items)
  const [options, setOptions] = useState<TaskFormOptions | undefined>(undefined)
  const [values, setValues] = useState<TaskFormValues | undefined>(undefined)
  const [problems, setProblems] = useState<readonly TaskFormProblem[]>([])
  const [failure, setFailure] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState(true)
  const [risky, setRisky] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const mounted = useRef(true)
  const id = useId()
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    void loadOptions().then((loaded) => { if (mounted.current) setOptions(loaded) })
  }, [loadOptions])
  useEffect(() => {
    if (options === undefined) return
    const first = workspaces[0]?.workspaceId ?? ''
    if (values === undefined) {
      setValues(initialValues({ workspaceId: first, permission: options.defaultPermission, ...suggested(new Date()) }))
    }
    // An empty or removed workspace falls back to the first one listed.
    else if (values.workspaceId !== first && !workspaces.some(item => item.workspaceId === values.workspaceId)) {
      setValues({ ...values, workspaceId: first })
    }
  }, [options, workspaces, values])

  const header = (
    <header className={css.header} data-window-drag>
      <nav className={css.breadcrumb} aria-label={t('breadcrumb.current')}>
        <span>{t('breadcrumb.parent')}</span>
        <span aria-hidden="true">/</span>
        <h1 className={css.title}>{t('breadcrumb.current')}</h1>
      </nav>
    </header>
  )
  if (options === undefined || values === undefined) {
    return <div className={css.page}>{header}<p className={css.loading} role="status">{t('loading')}</p></div>
  }

  // Editing a field clears its message; the others stay until the next save.
  const set = (patch: Partial<TaskFormValues>): void => {
    setValues({ ...values, ...patch })
    const edited = new Set<TaskFormField>(Object.keys(patch).map(key => FIELD_OF[key as keyof TaskFormValues]))
    setProblems(current => current.filter(item => !edited.has(item.field)))
  }
  const problem = (field: TaskFormField): ReactNode => {
    const found = problems.find(item => item.field === field)
    if (found === undefined) return null
    return <p className={css.error} role="alert">{found.key === 'error.unknown' ? t('error.unknown', { message: failure }) : t(found.key)}</p>
  }
  const submit = async (): Promise<void> => {
    const built = toRequest(values, Intl.DateTimeFormat().resolvedOptions().timeZone)
    if ('problems' in built) { setProblems(built.problems); return }
    setProblems([])
    setSaving(true)
    const result = await onCreate(built.request).catch((error: unknown) => ({
      ok: false as const, error: { code: 'automation-tasks/failed', message: error instanceof Error ? error.message : String(error) },
    }))
    if (!mounted.current) return
    setSaving(false)
    if (result.ok) {
      onDone({ sessionId: result.value.sessionId, id: result.value.record.id })
      return
    }
    setFailure(result.error.message)
    setProblems([refusalProblem(result.error, values.start !== '' || values.end !== '')])
  }
  const modes: readonly [SegmentedTab<FrequencyMode>, ...SegmentedTab<FrequencyMode>[]] = [
    { value: 'periodic', label: t('mode.periodic'), id: `${id}-periodic`, panelId: `${id}-frequency` },
    { value: 'interval', label: t('mode.interval'), id: `${id}-interval`, panelId: `${id}-frequency` },
    { value: 'once', label: t('mode.once'), id: `${id}-once`, panelId: `${id}-frequency` },
  ]
  const label = (key: TaskFormLocaleKey, hint?: TaskFormLocaleKey) => (
    <span className={css.label}>{t(key)}{hint !== undefined && <span className={css.hint}>{t(hint)}</span>}</span>
  )

  return (
    <form className={css.page} aria-label={t('breadcrumb.current')} noValidate onSubmit={(event) => { event.preventDefault(); void submit() }}>
      {header}
      <div className={css.scroll}>
        {notice && (
          <div className={css.notice} role="note">
            <span className={css.noticeBadge}>{t('notice.label')}</span>
            <span className={css.noticeText}>{t('notice.text')}</span>
            <button type="button" className={css.noticeClose} aria-label={t('notice.dismiss')} onClick={() => { setNotice(false) }}>
              <IconCloseOutlineRegular size={14} />
            </button>
          </div>
        )}

        <label className={css.field}>
          {label('field.title')}
          <Input value={values.title} placeholder={t('field.titlePlaceholder')} aria-label={t('field.title')}
            onChange={(event) => { set({ title: event.target.value }) }} />
          {problem('title')}
        </label>

        <label className={css.field}>
          {label('field.workspace', 'field.optional')}
          <select className={css.select} value={values.workspaceId} aria-label={t('field.workspace')}
            onChange={(event) => { set({ workspaceId: event.target.value }) }}>
            {workspaces.map(item => (
              <option key={item.workspaceId} value={item.workspaceId}>{workspaceDisplayTitle(item.title, t('field.defaultWorkspace'))}</option>
            ))}
          </select>
          {problem('workspace')}
        </label>

        <div className={css.field}>
          {label('field.prompt')}
          <div className={css.composer}>
            <textarea className={css.prompt} value={values.prompt} placeholder={t('field.promptPlaceholder')} aria-label={t('field.prompt')}
              onChange={(event) => { set({ prompt: event.target.value }) }} />
            <div className={css.composerRow}>
              <select className={css.chip} value={values.assistantId} aria-label={t('field.assistant')}
                onChange={(event) => { set({ assistantId: event.target.value }) }}>
                <option value="">{t('field.generalMode')}</option>
                {options.assistants.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              <select className={css.chip} value={values.model} aria-label={t('field.model')}
                onChange={(event) => { set({ model: event.target.value }) }}>
                <option value="">{t('field.defaultModel')}</option>
                {options.models.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              {options.permissions.length > 0 && (
                <select className={css.chip} value={values.permission} aria-label={t('field.permission')}
                  onChange={(event) => {
                    // Full access waits for the risk confirmation below.
                    if (event.target.value === FULL_ACCESS) setRisky(true)
                    else set({ permission: event.target.value })
                  }}>
                  {options.permissions.map(item => (
                    <option key={item.value} value={item.value}>{presetLabel(item.value, item.label, t)}</option>
                  ))}
                </select>
              )}
            </div>
          </div>
          {problem('prompt')}
        </div>

        <fieldset className={css.field}>
          <legend className={css.legend}>{label('field.connectors', 'field.connectorsHint')}</legend>
          {options.connectors.length === 0
            ? <p className={css.muted}>{t('field.connectorsNone')}</p>
            : (
              <div className={css.connectors}>
                {options.connectors.map(connector => (
                  <Checkbox key={connector} checked={values.connectors.includes(connector)}
                    label={connector === 'feishu' || connector === 'dingtalk' ? t(`connector.${connector}`) : connector}
                    onChange={(checked) => {
                      const rest = values.connectors.filter(item => item !== connector)
                      set({ connectors: checked ? [...rest, connector] : rest })
                    }} />
                ))}
              </div>
            )}
        </fieldset>

        <fieldset className={css.field}>
          <legend className={css.legend}>{label('field.frequency', 'field.frequencyHint')}</legend>
          <SegmentedTabs className={css.modes} items={modes} value={values.mode} label={t('field.frequency')}
            onChange={(mode) => { set({ mode }) }} />
          <div className={css.frequency} id={`${id}-frequency`} role="tabpanel">
            {values.mode === 'periodic' && (
              <>
                <select className={css.select} value={values.repeat} aria-label={t('repeat.label')}
                  onChange={(event) => { set({ repeat: event.target.value as Repeat }) }}>
                  <option value="daily">{t('repeat.daily')}</option>
                  <option value="weekdays">{t('repeat.weekdays')}</option>
                  <option value="weekly">{t('repeat.weekly')}</option>
                </select>
                <input type="time" className={css.input} value={values.time} aria-label={t('time.label')}
                  onChange={(event) => { set({ time: event.target.value }) }} />
              </>
            )}
            {values.mode === 'interval' && (
              <>
                <span className={css.inline}>{t('interval.every')}</span>
                <input type="number" min={1} step={1} className={css.number} value={values.interval} aria-label={t('interval.value')}
                  onChange={(event) => { set({ interval: event.target.value }) }} />
                <select className={css.select} value={values.unit} aria-label={t('interval.unit')}
                  onChange={(event) => { set({ unit: event.target.value as IntervalUnit }) }}>
                  <option value="minutes">{t('unit.minutes')}</option>
                  <option value="hours">{t('unit.hours')}</option>
                </select>
              </>
            )}
            {values.mode === 'once' && (
              <>
                <input type="date" className={css.input} value={values.date} aria-label={t('date.label')}
                  onChange={(event) => { set({ date: event.target.value }) }} />
                <input type="time" className={css.input} value={values.time} aria-label={t('time.label')}
                  onChange={(event) => { set({ time: event.target.value }) }} />
              </>
            )}
          </div>
          {values.mode === 'periodic' && values.repeat === 'weekly' && (
            <div className={css.weekdays} role="group" aria-label={t('weekdays.label')}>
              {WEEKDAYS.map(day => (
                <button key={day} type="button" className={css.weekday} aria-pressed={values.weekdays.includes(day)}
                  onClick={() => {
                    const rest = values.weekdays.filter(item => item !== day)
                    set({ weekdays: values.weekdays.includes(day) ? rest : [...rest, day] })
                  }}>
                  {t(`weekday.${day}`)}
                </button>
              ))}
            </div>
          )}
          {problem('frequency')}
        </fieldset>

        <fieldset className={css.field}>
          <legend className={css.legend}>{label('field.window', 'field.windowHint')}</legend>
          <div className={css.frequency}>
            <input type="date" className={css.input} value={values.start} aria-label={t('window.start')}
              onChange={(event) => { set({ start: event.target.value }) }} />
            <span className={css.inline}>{t('window.to')}</span>
            <input type="date" className={css.input} value={values.end} aria-label={t('window.end')}
              onChange={(event) => { set({ end: event.target.value }) }} />
          </div>
          {problem('window')}
        </fieldset>
      </div>
      {problem('form')}
      <RiskConfirmation
        open={risky}
        title={t('risk.title')}
        description={t('risk.description')}
        acknowledgeLabel={t('risk.acknowledge')}
        cancelLabel={t('risk.cancel')}
        closeLabel={t('risk.close')}
        confirmLabel={t('risk.confirm')}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setAcknowledged(false); setRisky(false) }}
        onConfirm={() => { setAcknowledged(false); setRisky(false); set({ permission: FULL_ACCESS }) }}
      />
      <footer className={css.footer}>
        <Button type="button" variant="outline" disabled={saving} onClick={() => { onDone(undefined) }}>{t('action.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={saving}>{t(saving ? 'action.saving' : 'action.save')}</Button>
      </footer>
    </form>
  )
}
