// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AssistantDetail, AssistantView, UpdateAssistantInput } from '@deepseek-ai/dsh-assistants/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { AssistantDetailPage } from '../src/client/AssistantDetail.tsx'
import type { WizardOptions } from '../src/client/assistants-source.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const assistant: AssistantView = {
  id: 'a1', name: '电商管家', description: '店铺', avatar: { kind: 'preset', key: 'ocean' },
  model: { provider: 'acme', model: 'think', reasoningEffort: 'low' }, preset: 'standard', createdAt: '2026-10-07T00:00:00Z',
}
const FILES = { 'IDENTITY.md': '# 身份\n', 'SOUL.md': '# 人格\n', 'USER.md': '# 用户信息\n', 'AGENTS.md': '# 工作方法\n' }
const options: WizardOptions = {
  models: [
    { provider: 'acme', providerName: 'Acme', id: 'chat', name: 'Chat', efforts: [] },
    { provider: 'acme', providerName: 'Acme', id: 'think', name: 'Think', efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'high' },
  ],
  presets: [{ id: 'standard', name: '标准' }, { id: 'ptc', name: 'PTC' }],
  capabilities: {
    skills: [{ id: 'aaa', name: 'aaa' }, { id: 'weekly-report', name: 'weekly-report' }],
    connectors: [{ id: 'feishu', name: 'feishu' }, { id: 'wecom', name: '企业微信' }],
    knowledgeBases: [{ id: 'kb1', name: '公司制度' }],
  },
}

async function mount(view: AssistantView = assistant, read?: () => Promise<AssistantDetail | string>) {
  let stored: AssistantDetail = { assistant: view, files: FILES }
  const props = {
    t: makeTranslate(zh), assistant: view, isDefault: false,
    onBack: vi.fn(), onChat: vi.fn(async (_id: string) => {}), onSetDefault: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(),
    onRead: vi.fn(read ?? (async (_id: string): Promise<AssistantDetail | string> => stored)),
    onUpdate: vi.fn(async (_id: string, input: UpdateAssistantInput): Promise<string | undefined> => {
      const assistant = { ...stored.assistant, ...(input.name === undefined ? {} : { name: input.name }) }
      stored = { assistant, files: { ...stored.files, ...input.files } }
      return undefined
    }),
    onLoadOptions: vi.fn(async () => options),
    squareAvatar: vi.fn(async (_file: Blob) => 'data:image/webp;base64,AAAA'),
  }
  render(<AssistantDetailPage {...props} />)
  await act(async () => { await Promise.resolve() })
  return props
}
const save = () => screen.getByRole<HTMLButtonElement>('button', { name: '保存' })
const discard = () => screen.getByRole<HTMLButtonElement>('button', { name: '放弃修改' })

describe('assistant detail page', () => {
  it('loads the assistant into its fields, with nothing to save yet', async () => {
    const props = await mount()
    expect(props.onRead).toHaveBeenCalledWith('a1')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '名称' }).value).toBe('电商管家')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '模型' }).value).toBe('["acme","think"]')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '思考级别' }).value).toBe('low')
    expect(screen.getByRole('radio', { name: '标准' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '身份 IDENTITY.md' }).value).toBe('# 身份\n')
    expect(save().disabled).toBe(true)
    expect(discard().disabled).toBe(true)
    expect(screen.getByRole('button', { name: '设为默认' })).toBeTruthy()
  })

  it('shows loading, then a read failure', async () => {
    let fail: (message: string) => void = () => {}
    await mount(assistant, () => new Promise((resolve) => { fail = resolve }))
    expect(screen.getByText('正在读取…')).toBeTruthy()
    await act(async () => { fail('gone'); await Promise.resolve() })
    expect(screen.getByRole('alert').textContent).toBe('无法读取这个智能体：gone')
  })

  it('saves only the changed fields and core files, then shows the stored result', async () => {
    const props = await mount()
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '海盗' } })
    fireEvent.change(screen.getByRole('textbox', { name: '描述' }), { target: { value: '新描述' } })
    fireEvent.click(screen.getByRole('button', { name: '头像 3' }))
    fireEvent.change(screen.getByRole('combobox', { name: '思考级别' }), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('radio', { name: 'PTC' }))
    fireEvent.click(screen.getByRole('tab', { name: '人格' }))
    fireEvent.change(screen.getByRole('textbox', { name: '人格 SOUL.md' }), { target: { value: '# 人格\n\n说话像海盗。\n' } })
    expect(discard().disabled).toBe(false)
    await act(async () => { fireEvent.click(save()) })
    expect(props.onUpdate).toHaveBeenCalledWith('a1', {
      name: '海盗', description: '新描述', avatar: { kind: 'preset', key: 'forest' },
      model: { provider: 'acme', model: 'think', reasoningEffort: 'high' }, preset: 'ptc', files: { 'SOUL.md': '# 人格\n\n说话像海盗。\n' },
    })
    expect(props.onRead).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status').textContent).toBe('已保存')
    expect(save().disabled).toBe(true)
  })

  it('returns the model and preset to the defaults', async () => {
    const props = await mount()
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('radio', { name: /跟随默认/ }))
    await act(async () => { fireEvent.click(save()) })
    expect(props.onUpdate).toHaveBeenCalledWith('a1', { model: null, preset: null })
  })

  it('discards edits, blocks an invalid name, and reports a refused save', async () => {
    const props = await mount()
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: ' ' } })
    expect(save().disabled).toBe(true)
    fireEvent.click(discard())
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '名称' }).value).toBe('电商管家')
    props.onUpdate.mockResolvedValueOnce('too long')
    fireEvent.click(screen.getByRole('tab', { name: '工作方法' }))
    fireEvent.change(screen.getByRole('textbox', { name: '工作方法 AGENTS.md' }), { target: { value: 'x' } })
    await act(async () => { fireEvent.click(save()) })
    expect(screen.getByRole('alert').textContent).toBe('保存失败：too long')
    expect(save().disabled).toBe(false)
  })

  it('marks a model and a preset the deployment no longer offers', async () => {
    await mount({ ...assistant, model: { provider: 'gone', model: 'old' }, preset: 'removed' })
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: '模型' })
    expect(select.selectedOptions[0]!.textContent).toBe('gone / old（已不可用，跟随全局）')
    expect(screen.queryByRole('combobox', { name: '思考级别' })).toBeNull()
    expect(screen.getByRole('radio', { name: 'removed（已不可用，跟随默认）' }).getAttribute('aria-checked')).toBe('true')
  })

  it('reads an assistant that follows every default', async () => {
    const { model: _model, preset: _preset, ...plain } = assistant
    await mount(plain)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '模型' }).value).toBe('')
    expect(screen.getByRole('radio', { name: /跟随默认/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('uploads an avatar and refuses a non-image', async () => {
    const props = await mount()
    const file = screen.getByLabelText('上传图片')
    await act(async () => { fireEvent.change(file, { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } }) })
    expect(screen.getByRole('alert').textContent).toBe('只支持 PNG、JPG、WebP 图片')
    await act(async () => { fireEvent.change(file, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } }) })
    await act(async () => { fireEvent.click(save()) })
    expect(props.onUpdate).toHaveBeenCalledWith('a1', { avatar: { kind: 'image', dataUrl: 'data:image/webp;base64,AAAA' } })
  })
})

describe('subsets on the detail page', () => {
  it('marks an item that is gone, clears it, and saves only a real change', async () => {
    const props = await mount({ ...assistant, subsets: { skills: ['weekly-report', 'old-skill'], connectors: ['wecom', 'feishu'] } })
    const skills = screen.getByRole('group', { name: 'Skill' })
    expect(within(skills).getByRole<HTMLInputElement>('checkbox', { name: 'old-skill' }).checked).toBe(true)
    expect(within(skills).getByText('已失效')).toBeTruthy()
    // What is gone, then what was selected, come first.
    const order = () => within(skills).getAllByRole('checkbox').map(box => box.closest('label')?.textContent)
    expect(order()).toEqual(['old-skill', 'weekly-report', 'aaa'])
    fireEvent.click(within(skills).getByRole('checkbox', { name: 'aaa' }))
    expect(order()).toEqual(['old-skill', 'weekly-report', 'aaa'])
    fireEvent.click(within(skills).getByRole('checkbox', { name: 'aaa' }))
    const connectors = screen.getByRole('group', { name: '连接器' })
    expect(within(connectors).getByRole('checkbox', { name: '飞书' })).toBeTruthy()
    expect(within(connectors).getByRole('checkbox', { name: '企业微信' })).toBeTruthy()
    // Unchecking and checking again in another order is no change.
    fireEvent.click(within(connectors).getByRole('checkbox', { name: '飞书' }))
    fireEvent.click(within(connectors).getByRole('checkbox', { name: '飞书' }))
    expect(save().disabled).toBe(true)
    fireEvent.click(within(skills).getByRole('checkbox', { name: 'old-skill' }))
    expect(within(skills).queryByText('已失效')).toBeNull()
    fireEvent.click(within(screen.getByRole('group', { name: '知识库' })).getByRole('radio', { name: '仅选中' }))
    fireEvent.click(within(screen.getByRole('group', { name: '知识库' })).getByRole('checkbox', { name: '公司制度' }))
    await act(async () => { fireEvent.click(save()) })
    expect(props.onUpdate).toHaveBeenCalledWith('a1', { subsets: { skills: ['weekly-report'], connectors: ['wecom', 'feishu'], knowledgeBases: ['kb1'] } })
  })
})
