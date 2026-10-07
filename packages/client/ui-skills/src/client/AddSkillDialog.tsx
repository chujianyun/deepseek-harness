/** The "添加技能" dialog: pick a local Skill, check what would be uploaded, choose visibility and category, upload. */

import { useEffect, useState } from 'react'
import type {
  MarketFolderProblem, MarketUploadOptions, MarketUploadPreview, MarketUploadResult, MarketVisibility,
} from '@deepseek-ai/dsh-skill-market/types'
import { Button, Checkbox, fileSizeText, Input, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketFailure } from './market-source.ts'
import type { SkillsPageProps } from './SkillsPage.tsx'
import css from './SkillsPage.module.css'

/**
 * The locale key of one reason a folder cannot be uploaded.
 * @param problem - the reason.
 * @returns its `skills` locale key.
 */
function problemKey(problem: MarketFolderProblem) {
  switch (problem) {
    case 'unreadable': return 'problemUnreadable'
    case 'no-skill-md': return 'problemNoSkillMd'
    case 'no-frontmatter': return 'problemNoFrontmatter'
    case 'invalid-yaml': return 'problemInvalidYaml'
    case 'invalid-name': return 'problemInvalidName'
    case 'no-description': return 'problemNoDescription'
  }
}

/**
 * The text of a refused upload call: the Hub's own reason for a rejected upload, localized copy
 * for the market's refusals, otherwise the message.
 * @param failure - the refusal.
 * @param t - the `skills` translator.
 * @returns the text to show.
 */
function uploadFailureText(failure: MarketFailure, t: TranslateNS<'skills'>): string {
  if (failure.code === 'skill-market/unavailable') return t('failureUnavailable')
  if (failure.code === 'hub-account/signed-out') return t('failureSignedOut')
  return failure.message
}

/**
 * Render the dialog while it is open.
 * @param props - the page props.
 * @returns the dialog.
 */
export function AddSkillDialog(props: SkillsPageProps) {
  const { t, useUpload, onCloseUpload } = props
  const open = useUpload(snapshot => snapshot.open)
  const step = useUpload(snapshot => snapshot.step)
  const failure = useUpload(snapshot => snapshot.failure)
  const preview = useUpload(snapshot => snapshot.preview)
  const result = useUpload(snapshot => snapshot.result)
  return (
    <Modal open={open} title={t('addSkillTitle')} closeLabel={t('uninstallClose')} onClose={onCloseUpload} className={`${css.detail}`}>
      <div className={css.detailBody}>
        {failure !== null && <p className={css.failure} role="alert">{t('uploadFailed', { message: uploadFailureText(failure, t) })}</p>}
        {step === 'pick' && <PickStep {...props} />}
        {step === 'form' && preview !== null && <FormStep {...props} preview={preview} />}
        {step === 'done' && result !== null && <DoneStep {...props} result={result} />}
      </div>
    </Modal>
  )
}

function PickStep({ t, useUpload, onInspectFolder, onBrowseFolder }: SkillsPageProps) {
  const sources = useUpload(snapshot => snapshot.sources)
  const busy = useUpload(snapshot => snapshot.busy)
  const [path, setPath] = useState('')
  return (
    <>
      <p className={css.intro}>{t('addSkillIntro')}</p>
      <h3 className={css.groupTitle}>{t('customGroup')}</h3>
      {sources === null ? <p className={css.notice}>{t('loading')}</p> : sources.length === 0 ? <p className={css.notice}>{t('empty')}</p> : (
        <ul className={css.sourceList}>
          {sources.map(source => (
            <li key={source.dir}>
              <button type="button" className={css.sourceItem} disabled={busy} onClick={() => { void onInspectFolder(source.dir) }}>
                <span className={css.name}>{source.name}</span>
                <span className={css.meta}>{source.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3 className={css.groupTitle}>{t('otherFolder')}</h3>
      <form className={css.toolbar} onSubmit={(event) => { event.preventDefault(); if (path.trim() !== '') void onInspectFolder(path.trim()) }}>
        <Input className={`${css.search}`} value={path} placeholder={t('folderPlaceholder')} aria-label={t('folderPlaceholder')}
          onChange={(event) => { setPath(event.target.value) }} />
        <Button size="sm" variant="outline" type="submit" disabled={busy}>{t('readFolder')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void onBrowseFolder() }}>{t('browseFolder')}</Button>
      </form>
    </>
  )
}

function FormStep({ t, useUpload, onBackToPick, onSubmitUpload, preview }: SkillsPageProps & { preview: MarketUploadPreview }) {
  const options = useUpload(snapshot => snapshot.options)
  const busy = useUpload(snapshot => snapshot.busy)
  const [version, setVersion] = useState(preview.suggestedVersion)
  const [visibility, setVisibility] = useState<MarketVisibility>('tenant')
  const [departmentIds, setDepartmentIds] = useState<string[]>([])
  const [employeeIds, setEmployeeIds] = useState<string[]>([])
  const [categoryId, setCategoryId] = useState('')
  useEffect(() => { setVersion(preview.suggestedVersion) }, [preview.suggestedVersion])
  const creating = preview.existing === null
  const invalid = preview.problems.length > 0
  return (
    <>
      <PreviewFacts preview={preview} t={t} />
      {invalid ? (
        <ul className={css.problems} role="alert">
          {preview.problems.map(problem => <li key={problem}>{t(problemKey(problem))}</li>)}
        </ul>
      ) : (
        <form className={css.uploadForm} onSubmit={(event) => {
          event.preventDefault()
          void onSubmitUpload({
            version: version.trim(),
            ...creating ? {
              visibility,
              ...visibility === 'departments' ? { departmentIds } : {},
              ...visibility === 'employees' ? { employeeIds } : {},
              ...categoryId === '' ? {} : { categoryId },
            } : {},
          })
        }}>
          {preview.existing !== null && (
            <p className={css.notice}>{t('uploadAsVersion', { version: preview.existing.highestVersion })}</p>
          )}
          <label className={css.field}>
            <span>{t('uploadVersion')}</span>
            <Input value={version} aria-label={t('uploadVersion')} onChange={(event) => { setVersion(event.target.value) }} />
          </label>
          {creating && options !== null && (
            <CreateFields t={t} options={options} visibility={visibility} setVisibility={setVisibility}
              departmentIds={departmentIds} setDepartmentIds={setDepartmentIds}
              employeeIds={employeeIds} setEmployeeIds={setEmployeeIds} categoryId={categoryId} setCategoryId={setCategoryId} />
          )}
          <div className={css.dialogActions}>
            <Button variant="outline" onClick={onBackToPick}>{t('uploadBack')}</Button>
            <Button variant="primary" type="submit" disabled={busy || version.trim() === ''}>{busy ? t('uploading') : t('uploadSubmit')}</Button>
          </div>
        </form>
      )}
      {invalid && <div className={css.dialogActions}><Button variant="outline" onClick={onBackToPick}>{t('uploadBack')}</Button></div>}
    </>
  )
}

function PreviewFacts({ preview, t }: { preview: MarketUploadPreview; t: TranslateNS<'skills'> }) {
  return (
    <dl className={css.facts}>
      <dt>{t('previewName')}</dt><dd>{preview.name ?? '—'}</dd>
      <dt>{t('previewDescription')}</dt><dd>{preview.description ?? '—'}</dd>
      <dt>{t('previewFolder')}</dt><dd><code>{preview.dir}</code></dd>
      <dt>{t('previewFiles')}</dt><dd>{t('previewFileSummary', { count: String(preview.fileCount), size: fileSizeText(preview.sizeBytes) })}</dd>
    </dl>
  )
}

function CreateFields(props: {
  t: TranslateNS<'skills'>
  options: MarketUploadOptions
  visibility: MarketVisibility
  setVisibility: (value: MarketVisibility) => void
  departmentIds: string[]
  setDepartmentIds: (ids: string[]) => void
  employeeIds: string[]
  setEmployeeIds: (ids: string[]) => void
  categoryId: string
  setCategoryId: (id: string) => void
}) {
  const { t, options, visibility, setVisibility } = props
  const toggle = (list: string[], id: string, on: boolean) => on ? [...list, id] : list.filter(item => item !== id)
  return (
    <>
      <div className={css.field}>
        <span>{t('uploadVisibility')}</span>
        <SegmentedControl id="upload-visibility" label={t('uploadVisibility')} value={visibility} onChange={setVisibility} options={[
          { value: 'tenant', label: t('visibilityTenant') },
          { value: 'departments', label: t('visibilityDepartments') },
          { value: 'employees', label: t('visibilityEmployees') },
          { value: 'private', label: t('visibilityPrivate') },
        ]} />
      </div>
      {visibility === 'departments' && (
        <div className={css.choices}>
          {options.departments.map(department => (
            <Checkbox key={department.id} label={department.name} checked={props.departmentIds.includes(department.id)}
              onChange={(on) => { props.setDepartmentIds(toggle(props.departmentIds, department.id, on)) }} />
          ))}
        </div>
      )}
      {visibility === 'employees' && (
        <div className={css.choices}>
          {options.employees.map(employee => (
            <Checkbox key={employee.id} label={`${employee.name}（${employee.departmentName}）`} checked={props.employeeIds.includes(employee.id)}
              onChange={(on) => { props.setEmployeeIds(toggle(props.employeeIds, employee.id, on)) }} />
          ))}
        </div>
      )}
      <label className={css.field}>
        <span>{t('uploadCategory')}</span>
        <select className={css.select} value={props.categoryId} onChange={(event) => { props.setCategoryId(event.target.value) }}>
          <option value="">{t('noCategory')}</option>
          {options.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
      </label>
    </>
  )
}

function DoneStep({ t, useUpload, onCloseUpload, onCopyReviewUrl, result }: SkillsPageProps & { result: MarketUploadResult }) {
  const copied = useUpload(snapshot => snapshot.copied)
  const pending = result.status === 'pending'
  return (
    <>
      <p className={css.done} role="status">
        {pending ? t('uploadPending', { name: result.name, version: result.version }) : t('uploadPublished', { name: result.name, version: result.version })}
      </p>
      {pending && result.reviewUrl !== null && (
        <div className={css.toolbar}>
          <Input className={`${css.search}`} readOnly value={result.reviewUrl} aria-label={t('reviewLink')} />
          <Button size="sm" variant="outline" onClick={() => { void onCopyReviewUrl() }}>{copied ? t('codeCopied') : t('copyReviewLink')}</Button>
        </div>
      )}
      <p className={css.meta}>{t('uploadLocalKept')}</p>
      <div className={css.dialogActions}><Button variant="primary" onClick={onCloseUpload}>{t('uploadDone')}</Button></div>
    </>
  )
}
