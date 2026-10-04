// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { MarketUploadPreview } from '@deepseek-ai/dsh-skill-market/types'
import { AddSkillDialog } from '../src/client/AddSkillDialog.tsx'
import { MarketView } from '../src/client/MarketView.tsx'
import { pageProps } from './page-props.client.ts'

afterEach(cleanup)

const options = {
  categories: [{ id: 'c-doc', name: '文档' }],
  departments: [{ id: 'd-rd', parentId: null, name: '研发部' }],
  employees: [{ id: 'e-li', name: '李雷', departmentName: '研发部' }],
}
const preview = (extra: Partial<MarketUploadPreview> = {}): MarketUploadPreview => ({
  dir: '/Users/me/.dsh/skills/report-writer', name: 'report-writer', description: '生成周报', fileCount: 2, sizeBytes: 2048, problems: [], existing: null, suggestedVersion: '1.0.0', ...extra,
})

describe('添加技能 dialog', () => {
  it('opens from the market header', () => {
    const { props } = pageProps()
    render(<MarketView {...props} onShowInstalled={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '添加技能' }))
    expect(props.onOpenUpload).toHaveBeenCalledOnce()
  })

  it('offers the user\'s Skills, a typed folder, and the folder chooser', () => {
    const { props, uploadStore } = pageProps({}, {}, { open: true, sources: [{ name: 'report-writer', description: '生成周报', dir: '/s/report-writer', source: 'user-dsh' }] })
    render(<AddSkillDialog {...props} />)
    const dialog = screen.getByRole('dialog', { name: '添加技能到 Skill Hub' })
    fireEvent.click(within(dialog).getByRole('button', { name: /report-writer/ }))
    expect(props.onInspectFolder).toHaveBeenCalledWith('/s/report-writer')
    fireEvent.change(within(dialog).getByRole('textbox', { name: '文件夹路径' }), { target: { value: ' /tmp/other ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '读取' }))
    expect(props.onInspectFolder).toHaveBeenLastCalledWith('/tmp/other')
    fireEvent.click(within(dialog).getByRole('button', { name: '选择文件夹…' }))
    expect(props.onBrowseFolder).toHaveBeenCalledOnce()
    fireEvent.change(within(dialog).getByRole('textbox', { name: '文件夹路径' }), { target: { value: '  ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '读取' }))
    expect(props.onInspectFolder).toHaveBeenCalledTimes(2)
    uploadStore.set({ ...uploadStore.getSnapshot(), sources: [] })
  })

  it('shows loading and empty states while picking', () => {
    const { props } = pageProps({}, {}, { open: true, sources: null })
    const view = render(<AddSkillDialog {...props} />)
    expect(screen.getByText('正在读取 Skill…')).toBeTruthy()
    view.unmount()
    const empty = pageProps({}, {}, { open: true, sources: [] })
    render(<AddSkillDialog {...empty.props} />)
    expect(screen.getByText('还没有安装任何 Skill')).toBeTruthy()
  })

  it('previews a new Skill and submits version, visibility lists, and category', () => {
    const { props } = pageProps({}, {}, { open: true, step: 'form', preview: preview(), options })
    render(<AddSkillDialog {...props} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('2 个文件，2.0KB')
    expect((within(dialog).getByRole('textbox', { name: '版本号' }) as HTMLInputElement).value).toBe('1.0.0')
    fireEvent.click(within(dialog).getByRole('tab', { name: '特定部门' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '研发部' }))
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'c-doc' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '上传' }))
    expect(props.onSubmitUpload).toHaveBeenLastCalledWith({ version: '1.0.0', visibility: 'departments', departmentIds: ['d-rd'], categoryId: 'c-doc' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '研发部' }))
    fireEvent.click(within(dialog).getByRole('tab', { name: '特定员工' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '李雷（研发部）' }))
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: '' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '版本号' }), { target: { value: ' 1.0.0 ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '上传' }))
    expect(props.onSubmitUpload).toHaveBeenLastCalledWith({ version: '1.0.0', visibility: 'employees', employeeIds: ['e-li'] })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '李雷（研发部）' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '重新选择' }))
    expect(props.onBackToPick).toHaveBeenCalledOnce()
  })

  it('uploads a new version of the employee\'s Skill with the suggested version and no visibility', () => {
    const { props } = pageProps({}, {}, {
      open: true, step: 'form', options,
      preview: preview({ existing: { skillId: 's', highestVersion: '1.2.0', currentVersion: '1.2.0', workingStatus: null }, suggestedVersion: '1.2.1' }),
    })
    render(<AddSkillDialog {...props} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('你已有同名 Skill（最高版本 1.2.0），将作为它的新版本上传。')
    expect(within(dialog).queryByRole('tablist')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: '上传' }))
    expect(props.onSubmitUpload).toHaveBeenCalledWith({ version: '1.2.1' })
  })

  it('disables the upload while it is in flight', () => {
    const { props } = pageProps({}, {}, { open: true, step: 'form', options, busy: true, preview: preview() })
    render(<AddSkillDialog {...props} />)
    expect(screen.getByRole('button', { name: '上传中…' }).hasAttribute('disabled')).toBe(true)
  })

  it('lists why a folder cannot be uploaded', () => {
    const { props } = pageProps({}, {}, { open: true, step: 'form', options, preview: preview({
      name: null, description: null, problems: ['unreadable', 'no-skill-md', 'no-frontmatter', 'invalid-yaml', 'invalid-name', 'no-description'],
    }) })
    render(<AddSkillDialog {...props} />)
    expect(within(screen.getByRole('alert')).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      '无法读取这个文件夹', '文件夹里没有 SKILL.md', 'SKILL.md 缺少开头的 --- 元信息', 'SKILL.md 的元信息不是合法的 YAML',
      'SKILL.md 的 name 只能包含小写字母、数字和连字符', 'SKILL.md 缺少 description',
    ])
    expect(screen.queryByRole('button', { name: '上传' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }))
    expect(props.onBackToPick).toHaveBeenCalledOnce()
  })

  it('shows the Hub\'s reason verbatim and localizes market refusals', () => {
    const { props } = pageProps({}, {}, { open: true, step: 'form', options, preview: preview(), failure: { code: 'skill-market/upload-rejected', message: '新版本号必须高于已有的最高版本 1.2.0' } })
    render(<AddSkillDialog {...props} />)
    expect(screen.getByRole('alert').textContent).toBe('上传失败：新版本号必须高于已有的最高版本 1.2.0')
    cleanup()
    for (const [code, text] of [['skill-market/unavailable', '无法连接 Skill Hub，请稍后重试'], ['hub-account/signed-out', '请先登录 Skill Hub']] as const) {
      const view = pageProps({}, {}, { open: true, step: 'pick', sources: [], failure: { code, message: 'x' } })
      render(<AddSkillDialog {...view.props} />)
      expect(screen.getByRole('alert').textContent).toBe(`上传失败：${text}`)
      cleanup()
    }
  })

  it('reports a pending upload with its review link, and a published one', () => {
    const { props } = pageProps({}, {}, { open: true, step: 'done', result: { skillId: 's', name: 'report-writer', version: '1.0.0', mode: 'create', status: 'pending', reviewUrl: 'https://hub/skills/review/v1' } })
    render(<AddSkillDialog {...props} />)
    expect(screen.getByRole('status').textContent).toBe('已提交审核：report-writer 1.0.0')
    expect((screen.getByRole('textbox', { name: '审核链接' }) as HTMLInputElement).value).toBe('https://hub/skills/review/v1')
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(props.onCopyReviewUrl).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(props.onCloseUpload).toHaveBeenCalledOnce()
    cleanup()
    const published = pageProps({}, {}, { open: true, step: 'done', copied: true, result: { skillId: 's', name: 'report-writer', version: '1.0.1', mode: 'version', status: 'published', reviewUrl: null } })
    render(<AddSkillDialog {...published.props} />)
    expect(screen.getByRole('status').textContent).toBe('已发布：report-writer 1.0.1')
    expect(screen.queryByRole('textbox', { name: '审核链接' })).toBeNull()
    expect(screen.getByText('本地这份 Skill 保持原样，仍在「用户自定义」里。')).toBeTruthy()
  })

  it('shows the copied state', () => {
    const { props } = pageProps({}, {}, { open: true, step: 'done', copied: true, result: { skillId: 's', name: 'x', version: '1.0.0', mode: 'create', status: 'pending', reviewUrl: 'https://hub/r' } })
    render(<AddSkillDialog {...props} />)
    expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy()
  })
})
