/**
 * Company assistant packages in the Assistants UI: the page's company section, where a package is
 * installed or updated, and an installed assistant's recommended scheduled tasks on its detail page.
 */

import { useEffect, useState } from 'react'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { AssistantPackageItem, AssistantPackageTaskTiming, InstalledPackageView, InstalledTaskView } from '@deepseek-ai/dsh-assistant-packages/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { AssistantAvatar } from './AssistantAvatar.tsx'
import { PACKAGES_BUSY, type PackageActionOutcome, type PackagesInjected } from './packages-source.ts'
import page from './AssistantsPage.module.css'
import detail from './AssistantDetail.module.css'
import form from './form.module.css'
import css from './PackageViews.module.css'

type T = PropsLocale<'assistants'>['t']

/** The packages face as a component reads it: `usePackages`, `useWorkspaces`, and the actions. */
export type PackagesProps = PropsLocale<'assistants'> & InjectFace<PackagesInjected>

/** Props of the company section: the copy, the packages face, and opening an installed assistant. */
export type CompanyPackagesProps = PackagesProps & { readonly onOpen: (assistantId: string) => void }

const WEEKDAY_KEYS = ['weekday1', 'weekday2', 'weekday3', 'weekday4', 'weekday5', 'weekday6', 'weekday7'] as const

/**
 * A recommended task's run time in words, such as «周一至周五 11:00».
 * @param t - the translator.
 * @param timing - the task's timing.
 * @returns the text.
 */
export function timingText(t: T, timing: AssistantPackageTaskTiming): string {
  if (timing.kind === 'daily') return t('timingDaily', { time: timing.time })
  if (timing.kind === 'cron') return t('timingCron', { expression: timing.expression })
  const days = timing.weekdays
  // The package validated weekdays as 1 through 7, at least one.
  const day = (d: number) => t(WEEKDAY_KEYS[d - 1] as (typeof WEEKDAY_KEYS)[number])
  const first = days[0] as number
  const last = days.at(-1) as number
  // A run of three or more consecutive days reads as a range, such as «周一至周五».
  const range = days.length > 2 && last - first === days.length - 1
  const label = days.length === 7
    ? t('everyDay')
    : range ? t('weekdayRange', { from: day(first), to: day(last) }) : days.map(day).join(t('listSeparator'))
  return t('timingWeekly', { days: label, time: timing.time })
}

/** A refusal in the user's language. */
const refusalText = (t: T, refusal: string): string => t('packageFailed', { message: refusal === PACKAGES_BUSY ? t('packageBusy') : refusal })

/** What an install or update did, in one line each. */
function outcomeLines(t: T, name: string, outcome: PackageActionOutcome, updated: boolean): string[] {
  const lines = [updated ? t('updateDone', { name, version: outcome.version }) : t('installDone', { name })]
  if (outcome.installedSkills.length > 0) lines.push(t('installedSkills', { skills: outcome.installedSkills.join(t('listSeparator')) }))
  if (outcome.missingSkills.length > 0) lines.push(t('missingSkills', { skills: outcome.missingSkills.join(t('listSeparator')) }))
  if (outcome.keptFiles.length > 0) lines.push(t('keptFiles', { files: outcome.keptFiles.join(t('listSeparator')) }))
  return lines
}

/**
 * The company section of the Assistants page: each package the company published, with Install,
 * Open for one installed here, and Update when a newer version is out.
 * @param props - copy, the packages face, and the opener.
 * @returns the section, or nothing while the deployment offers no packages.
 */
export function CompanyPackages(props: CompanyPackagesProps) {
  const { t, usePackages, onPackageInstall, onPackageUpdate, onOpen, onPackagesRefresh } = props
  const state = usePackages(snapshot => snapshot.state)
  const running = usePackages(snapshot => snapshot.running)
  const [notice, setNotice] = useState<{ readonly failed: boolean; readonly lines: readonly string[] } | null>(null)
  useEffect(() => { void onPackagesRefresh() }, [])
  if (state === undefined || state.tenantId === null) return null
  if (state.packages === null) {
    return (
      <section className={css.company} aria-label={t('companyTitle')}>
        <h2 className={css.companyTitle}>{t('companyTitle')}</h2>
        <p className={form.hint}>{t('companyUnavailable')}</p>
      </section>
    )
  }
  if (state.packages.length === 0) return null
  const installedOf = (item: AssistantPackageItem): InstalledPackageView | undefined =>
    state.installed.find(view => view.assistantId === item.installedAssistantId)
  const act = async (item: AssistantPackageItem, installed: InstalledPackageView | undefined): Promise<void> => {
    setNotice(null)
    const outcome = installed === undefined ? await onPackageInstall(item.id) : await onPackageUpdate(installed.assistantId)
    if (typeof outcome === 'string') setNotice({ failed: true, lines: [refusalText(t, outcome)] })
    else setNotice({ failed: false, lines: outcomeLines(t, item.manifest.displayName, outcome, installed !== undefined) })
  }
  return (
    <section className={css.company} aria-label={t('companyTitle')}>
      <h2 className={css.companyTitle}>{t('companyTitle')}</h2>
      <p className={form.hint}>{t('companyIntro')}</p>
      {notice !== null && (
        <div className={notice.failed ? page.alert : css.notice} role={notice.failed ? 'alert' : 'status'}>
          <span>{notice.lines.map(line => <span key={line} className={css.line}>{line}</span>)}</span>
          <Button variant="ghost" onClick={() => { setNotice(null) }}>{t('dismiss')}</Button>
        </div>
      )}
      <ul className={page.grid}>
        {state.packages.map((item) => {
          const installed = installedOf(item)
          const busy = running === item.id || (installed !== undefined && running === installed.assistantId)
          return (
            <li key={item.id} className={page.card} data-package-name={item.name}>
              <div className={css.packageBody}>
                <span className={page.cardHead}>
                  <AssistantAvatar avatar={{ kind: 'preset', key: item.manifest.avatar ?? '' }} name={item.manifest.displayName} size={36} />
                  <span className={page.name}>{item.manifest.displayName}</span>
                </span>
                <span className={page.description}>{item.manifest.description}</span>
                <span className={css.meta}>{t('packageMeta', { version: item.version, count: item.manifest.tasks.length })}</span>
              </div>
              <div className={page.actions}>
                {installed !== undefined && <Button variant="ghost" size="sm" onClick={() => { onOpen(installed.assistantId) }}>{t('openInstalled')}</Button>}
                {installed === undefined && (
                  <Button variant="primary" size="sm" disabled={running !== null} onClick={() => { void act(item, undefined) }}>{busy ? t('installing') : t('install')}</Button>
                )}
                {installed?.updateVersion != null && (
                  <Button variant="primary" size="sm" disabled={running !== null} onClick={() => { void act(item, installed) }}>
                    {busy ? t('updating') : t('updateTo', { version: installed.updateVersion })}
                  </Button>
                )}
                {installed !== undefined && installed.updateVersion === null && <span className={css.meta}>{t('installed')}</span>}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Props of the recommended tasks section: the packages face and the assistant shown. */
export type PackageTasksProps = PackagesProps & { readonly assistantId: string }

/**
 * An installed assistant's package and recommended scheduled tasks, each switched on or off here.
 * @param props - copy, the assistant, and the packages face.
 * @returns the section, or nothing for an assistant not installed from a package.
 */
export function PackageTasks(props: PackageTasksProps) {
  const { t, assistantId, usePackages, useWorkspaces, onTaskEnable, onTaskDisable, onPackageUpdate, onPackagesRefresh } = props
  const installed = usePackages(snapshot => snapshot.state?.installed.find(item => item.assistantId === assistantId))
  const running = usePackages(snapshot => snapshot.running)
  const workspaces = useWorkspaces(snapshot => snapshot.items)
  const [enabling, setEnabling] = useState<InstalledTaskView | null>(null)
  const [workspaceId, setWorkspaceId] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<readonly string[] | null>(null)
  useEffect(() => { void onPackagesRefresh() }, [assistantId])
  if (installed === undefined) return null
  const report = (refusal: string | undefined): void => { setFailure(refusal === undefined ? null : refusalText(t, refusal)) }
  const update = async (): Promise<void> => {
    setFailure(null)
    const outcome = await onPackageUpdate(assistantId)
    if (typeof outcome === 'string') report(outcome)
    else setNotice(outcomeLines(t, installed.displayName, outcome, true))
  }
  return (
    <section className={detail.section} aria-label={t('tasksTitle')}>
      <h2 className={detail.heading}>{t('tasksTitle')}</h2>
      <p className={form.hint}>
        {t('packageFrom', { name: installed.displayName, version: installed.version })}
        {installed.updateVersion !== null && (
          <Button variant="ghost" size="sm" className={css.inline} disabled={running !== null} onClick={() => { void update() }}>
            {running === assistantId ? t('updating') : t('updateTo', { version: installed.updateVersion })}
          </Button>
        )}
      </p>
      <p className={form.hint}>{t('tasksHint')}</p>
      {installed.missingSkills.length > 0 && <p className={form.error} role="alert">{t('missingSkills', { skills: installed.missingSkills.join(t('listSeparator')) })}</p>}
      {failure !== null && <p className={form.error} role="alert">{failure}</p>}
      {notice !== null && <p className={css.notice} role="status">{notice.map(line => <span key={line} className={css.line}>{line}</span>)}</p>}
      {installed.tasks.length === 0 && <p className={form.hint}>{t('tasksEmpty')}</p>}
      <ul className={css.tasks}>
        {installed.tasks.map(task => (
          <li key={task.id} className={css.task} data-task-id={task.id}>
            <span className={css.taskText}>
              <span className={css.taskTitle}>{task.title}</span>
              <span className={css.meta}>{`${timingText(t, task.timing)} · ${task.enabled === null ? t('taskOff') : t('taskOn')}`}</span>
              {task.outdated && <span className={css.outdated}>{t('taskOutdated')}</span>}
            </span>
            {task.enabled === null
              ? (
                <Button variant="outline" size="sm" disabled={running !== null} onClick={() => {
                  setEnabling(task)
                  setWorkspaceId(workspaces[0]?.workspaceId ?? '')
                }}>{t('enable')}</Button>
              )
              : <Button variant="ghost" size="sm" disabled={running !== null} onClick={() => { void onTaskDisable(assistantId, task.id).then(report) }}>{t('disable')}</Button>}
          </li>
        ))}
      </ul>
      {enabling !== null && (
        <Modal
          open title={t('enableTitle', { title: enabling.title })} closeLabel={t('dismiss')} onClose={() => { setEnabling(null) }}
          description={t('enableDescription', { timing: timingText(t, enabling.timing) })}
          footer={(
            <>
              <Button variant="outline" onClick={() => { setEnabling(null) }}>{t('cancel')}</Button>
              <Button variant="primary" disabled={workspaceId === ''} onClick={() => {
                const task = enabling
                setEnabling(null)
                void onTaskEnable(assistantId, task.id, workspaceId).then(report)
              }}>{t('enable')}</Button>
            </>
          )}
        >
          <label className={form.field}>
            <span className={form.label}>{t('workspace')}</span>
            <select className={form.select} value={workspaceId} aria-label={t('workspace')} onChange={(event) => { setWorkspaceId(event.target.value) }}>
              {workspaces.map(item => <option key={item.workspaceId} value={item.workspaceId}>{workspaceDisplayTitle(item.title, t('defaultWorkspace'))}</option>)}
            </select>
          </label>
        </Modal>
      )}
    </section>
  )
}
