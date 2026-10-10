import { describe, expect, it, vi } from 'vitest'
import type { MarketUploadPreview } from '@deepseek-ai/dsh-skill-market/types'
import { createUploadSource, type UploadDependencies } from '../src/client/upload-source.ts'

const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value })
const fail = (code: string, message: string) => Promise.resolve({ ok: false as const, error: { code, message, details: {} } as never })
const preview = (dir: string): MarketUploadPreview => ({ dir, name: 'report-writer', description: 'd', fileCount: 2, sizeBytes: 10, problems: [], existing: null, suggestedVersion: '1.0.0' })

function deps() {
  return {
    uploadSources: vi.fn<UploadDependencies['uploadSources']>(() => ok([{ name: 'report-writer', description: 'd', dir: '/s/report-writer', source: 'user-dsh' }])),
    inspectFolder: vi.fn<UploadDependencies['inspectFolder']>(dir => ok(preview(dir))),
    uploadOptions: vi.fn<UploadDependencies['uploadOptions']>(() => ok({ categories: [], departments: [], employees: [] })),
    uploadSkill: vi.fn<UploadDependencies['uploadSkill']>(() => ok({ skillId: 's', name: 'report-writer', displayName: '周报助手', version: '1.0.0', mode: 'create', status: 'pending', reviewUrl: 'https://hub/r/1' })),
    pickDirectory: vi.fn<UploadDependencies['pickDirectory']>(async () => '/picked'),
    copy: vi.fn<UploadDependencies['copy']>(async () => true),
    published: vi.fn<UploadDependencies['published']>(),
  }
}

describe('upload source', () => {
  it('opens with the user\'s Skills and the choices, reads a folder, uploads, and copies the review link', async () => {
    const d = deps()
    const source = createUploadSource(d)
    await source.onOpenUpload()
    expect(source.hooks.upload.getSnapshot()).toMatchObject({ open: true, step: 'pick', sources: [{ name: 'report-writer' }], options: { categories: [] } })
    await source.onInspectFolder('/s/report-writer')
    expect(source.hooks.upload.getSnapshot()).toMatchObject({ step: 'form', preview: { dir: '/s/report-writer' } })
    await source.onSubmitUpload({ version: '1.0.0', visibility: 'tenant' })
    expect(d.uploadSkill).toHaveBeenCalledWith({ version: '1.0.0', visibility: 'tenant', dir: '/s/report-writer' })
    expect(source.hooks.upload.getSnapshot()).toMatchObject({ step: 'done', result: { status: 'pending' } })
    expect(d.published).not.toHaveBeenCalled()
    await source.onCopyReviewUrl()
    expect(d.copy).toHaveBeenCalledWith('https://hub/r/1')
    expect(source.hooks.upload.getSnapshot().copied).toBe(true)
    source.onCloseUpload()
    expect(source.hooks.upload.getSnapshot()).toMatchObject({ open: false, result: null })
  })

  it('refreshes the market after a published upload, and ignores a copy without a link', async () => {
    const d = deps()
    d.uploadSkill.mockReturnValueOnce(ok({ skillId: 's', name: 'report-writer', displayName: '周报助手', version: '1.0.0', mode: 'create', status: 'published', reviewUrl: null }))
    const source = createUploadSource(d)
    await source.onSubmitUpload({ version: '1.0.0' })
    expect(d.uploadSkill).not.toHaveBeenCalled()
    await source.onInspectFolder('/x')
    await source.onSubmitUpload({ version: '1.0.0' })
    expect(d.published).toHaveBeenCalledOnce()
    await source.onCopyReviewUrl()
    expect(d.copy).not.toHaveBeenCalled()
  })

  it('reports refusals and goes back to picking', async () => {
    const d = deps()
    d.uploadSources.mockReturnValueOnce(fail('skill-market/unavailable', 'down'))
    const source = createUploadSource(d)
    await source.onOpenUpload()
    expect(source.hooks.upload.getSnapshot()).toMatchObject({ sources: [], failure: { code: 'skill-market/unavailable' } })
    d.uploadOptions.mockReturnValueOnce(fail('hub-account/signed-out', 'x'))
    await source.onOpenUpload()
    expect(source.hooks.upload.getSnapshot()).toMatchObject({ options: null, failure: { code: 'hub-account/signed-out' } })
    d.inspectFolder.mockReturnValueOnce(fail('skill-market/unavailable', 'down'))
    await source.onInspectFolder('/x')
    expect(source.hooks.upload.getSnapshot()).toMatchObject({ step: 'pick', failure: { code: 'skill-market/unavailable' } })
    await source.onInspectFolder('/x')
    d.uploadSkill.mockReturnValueOnce(fail('skill-market/upload-rejected', '版本号格式应为 x.y.z（如 1.0.0）'))
    await source.onSubmitUpload({ version: 'v1' })
    expect(source.hooks.upload.getSnapshot()).toMatchObject({ step: 'form', busy: false, failure: { message: '版本号格式应为 x.y.z（如 1.0.0）' } })
    source.onBackToPick()
    expect(source.hooks.upload.getSnapshot()).toMatchObject({ step: 'pick', preview: null, failure: null })
  })

  it('reads the folder the chooser returns and does nothing when cancelled', async () => {
    const d = deps()
    const source = createUploadSource(d)
    await source.onBrowseFolder()
    expect(d.inspectFolder).toHaveBeenCalledWith('/picked')
    d.pickDirectory.mockResolvedValueOnce(null)
    await source.onBrowseFolder()
    expect(d.inspectFolder).toHaveBeenCalledOnce()
  })
})
