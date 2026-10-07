// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AssistantTemplateView, CreateAssistantInput } from '@deepseek-ai/dsh-assistants/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { WizardOptions } from '../src/client/assistants-source.ts'
import { CreateAssistantWizard } from '../src/client/CreateAssistantWizard.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const templates: AssistantTemplateView[] = [
  { id: 'daily', name: '日常助手', description: '通用日常助手', avatar: { kind: 'preset', key: 'sun' } },
  { id: 'ecommerce', name: '电商管家', description: '综合店铺管家', avatar: { kind: 'preset', key: 'ocean' }, subsets: { connectors: ['feishu'] } },
]
const options: WizardOptions = {
  models: [
    { provider: 'acme', providerName: 'Acme', id: 'chat', name: 'Chat', efforts: [] },
    { provider: 'acme', providerName: 'Acme', id: 'think', name: 'Think', efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'high' },
  ],
  presets: [{ id: 'standard', name: '标准', description: '日常工具' }, { id: 'minimal', name: '极简' }],
  capabilities: {
    skills: [{ id: 'weekly-report', name: 'weekly-report', description: '写周报' }, { id: 'pdf', name: 'pdf' }],
    connectors: [{ id: 'feishu', name: 'feishu' }, { id: 'dingtalk', name: 'dingtalk' }],
    knowledgeBases: [],
  },
}

interface MountOptions {
  onCreate?: (input: CreateAssistantInput) => Promise<string | undefined>
  squareAvatar?: (file: Blob) => Promise<string>
  templates?: AssistantTemplateView[]
}

async function mount(over: MountOptions = {}) {
  const props = {
    t: makeTranslate(zh), open: true, templates: over.templates ?? templates, onClose: vi.fn(),
    onCreate: vi.fn(over.onCreate ?? (async (_input: CreateAssistantInput) => undefined)),
    onLoadOptions: vi.fn(async () => options),
    squareAvatar: vi.fn(over.squareAvatar ?? (async (_file: Blob) => 'data:image/webp;base64,AAAA')),
  }
  render(<CreateAssistantWizard {...props} />)
  await act(async () => { await Promise.resolve() })
  return props
}
const next = () => { fireEvent.click(screen.getByRole('button', { name: '下一步' })) }
const step = () => screen.getByText(/^第 \d \/ 5 步$/).textContent

describe('creation wizard', () => {
  it('walks five steps forward and back, starting from the first template', async () => {
    await mount()
    expect(step()).toBe('第 1 / 5 步')
    expect(screen.getByRole('radio', { name: /日常助手/ }).getAttribute('aria-checked')).toBe('true')
    next()
    expect(step()).toBe('第 2 / 5 步')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '名称' }).value).toBe('日常助手')
    fireEvent.click(screen.getByRole('button', { name: '上一步' }))
    expect(step()).toBe('第 1 / 5 步')
    next(); next()
    expect(screen.getByRole('radio', { name: /跟随默认/ }).getAttribute('aria-checked')).toBe('true')
    next()
    expect(step()).toBe('第 4 / 5 步')
    expect(screen.getAllByRole<HTMLInputElement>('radio', { name: '全部（跟随全局）' }).map(radio => radio.checked)).toEqual([true, true, true])
    next()
    expect(step()).toBe('第 5 / 5 步')
    expect(screen.queryByRole('button', { name: '下一步' })).toBeNull()
  })

  it('shows Creating while the Host works, and sends no model when following the global one', async () => {
    let finish: (value: string | undefined) => void = () => {}
    const props = await mount({ onCreate: () => new Promise((resolve) => { finish = resolve }) })
    next()
    fireEvent.change(screen.getByRole('textbox', { name: '描述' }), { target: { value: '新的描述' } })
    next(); next(); next()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '创建' })) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在创建…' }).disabled).toBe(true)
    await act(async () => { finish(undefined); await Promise.resolve() })
    expect(props.onCreate.mock.calls[0]![0]).toMatchObject({ templateId: 'daily', description: '新的描述' })
    expect(props.onCreate.mock.calls[0]![0]).not.toHaveProperty('model')
  })

  it('starts blank when no template is offered', async () => {
    await mount({ templates: [] })
    expect(screen.getByRole('radio', { name: /空白/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('prefills the e-commerce template, and blank starts empty', async () => {
    await mount()
    fireEvent.click(screen.getByRole('radio', { name: /电商管家/ }))
    next()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '名称' }).value).toBe('电商管家')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '描述' }).value).toBe('综合店铺管家')
    fireEvent.click(screen.getByRole('button', { name: '上一步' }))
    fireEvent.click(screen.getByRole('radio', { name: /空白/ }))
    next()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '名称' }).value).toBe('')
    expect(screen.getByRole('alert').textContent).toBe('名称需为 1–32 个字符')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '下一步' }).disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '一'.repeat(33) } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '下一步' }).disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '店铺助手' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '下一步' }).disabled).toBe(false)
  })

  it('shuffles preset avatars, takes an upload, and refuses a non-image', async () => {
    const props = await mount()
    next()
    expect(screen.getByRole('button', { name: '头像 1' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '换一批' }))
    expect(screen.queryByRole('button', { name: '头像 1' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '头像 9' }))
    expect(screen.getByRole('button', { name: '头像 9' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '换一批' }))
    expect(screen.getByRole('button', { name: '头像 1' })).toBeTruthy()
    const file = screen.getByLabelText('上传图片')
    await act(async () => { fireEvent.change(file, { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } }) })
    expect(screen.getByRole('alert').textContent).toBe('只支持 PNG、JPG、WebP 图片')
    await act(async () => { fireEvent.change(file, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } }) })
    expect(props.squareAvatar).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('img[src="data:image/webp;base64,AAAA"]')).toBeTruthy()
    await act(async () => { fireEvent.change(file, { target: { files: [] } }) })
    expect(props.squareAvatar).toHaveBeenCalledOnce()
  })

  it('reports an image the browser cannot read', async () => {
    await mount({ squareAvatar: async () => { throw new Error('decode') } })
    next()
    await act(async () => { fireEvent.change(screen.getByLabelText('上传图片'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } }) })
    expect(screen.getByRole('alert').textContent).toBe('无法读取这张图片')
  })

  it('creates with the chosen model, effort, preset, and user information, then closes', async () => {
    const props = await mount()
    fireEvent.click(screen.getByRole('radio', { name: /电商管家/ }))
    next()
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: '["acme","chat"]' } })
    expect(screen.queryByRole('combobox', { name: '思考级别' })).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: '["acme","think"]' } })
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '思考级别' }).value).toBe('high')
    fireEvent.change(screen.getByRole('combobox', { name: '思考级别' }), { target: { value: 'low' } })
    next()
    fireEvent.click(screen.getByRole('radio', { name: /极简/ }))
    next()
    const connectors = screen.getByRole('group', { name: '连接器' })
    expect(within(connectors).getByRole<HTMLInputElement>('radio', { name: '仅选中' }).checked).toBe(true)
    expect(within(connectors).getByRole<HTMLInputElement>('checkbox', { name: '飞书' }).checked).toBe(true)
    expect(within(connectors).getByRole<HTMLInputElement>('checkbox', { name: '钉钉' }).checked).toBe(false)
    const skills = screen.getByRole('group', { name: 'Skill' })
    fireEvent.click(within(skills).getByRole('radio', { name: '仅选中' }))
    fireEvent.click(within(skills).getByRole('checkbox', { name: 'weekly-report' }))
    fireEvent.click(within(skills).getByRole('checkbox', { name: 'pdf' }))
    fireEvent.click(within(skills).getByRole('checkbox', { name: 'pdf' }))
    expect(within(screen.getByRole('group', { name: '知识库' })).queryByText('暂无可选项')).toBeNull()
    fireEvent.click(within(screen.getByRole('group', { name: '知识库' })).getByRole('radio', { name: '仅选中' }))
    expect(within(screen.getByRole('group', { name: '知识库' })).getByText('暂无可选项')).toBeTruthy()
    next()
    fireEvent.change(screen.getByRole('textbox', { name: '如何称呼你' }), { target: { value: '小明' } })
    fireEvent.change(screen.getByRole('textbox', { name: '偏好语言' }), { target: { value: '中文' } })
    fireEvent.change(screen.getByRole('textbox', { name: '备注' }), { target: { value: '杭州' } })
    fireEvent.change(screen.getByRole('textbox', { name: '补充背景' }), { target: { value: '天猫店运营' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '创建' })) })
    expect(props.onCreate).toHaveBeenCalledWith({
      templateId: 'ecommerce', name: '电商管家', description: '综合店铺管家', avatar: { kind: 'preset', key: 'ocean' },
      model: { provider: 'acme', model: 'think', reasoningEffort: 'low' }, preset: 'minimal',
      subsets: { connectors: ['feishu'], skills: ['weekly-report'], knowledgeBases: [] },
      user: { name: '小明', language: '中文', notes: '杭州', background: '天猫店运营' },
    })
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('follows the global model and default preset unless chosen, and shows a refusal', async () => {
    const props = await mount({ onCreate: async () => 'gone' })
    fireEvent.click(screen.getByRole('radio', { name: /空白/ }))
    next()
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '空白助手' } })
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: '["acme","think"]' } })
    fireEvent.change(screen.getByRole('combobox', { name: '思考级别' }), { target: { value: '' } })
    next(); next(); next()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '创建' })) })
    expect(props.onCreate.mock.calls[0]![0]).toMatchObject({ templateId: null, model: { provider: 'acme', model: 'think' }, subsets: {} })
    expect(props.onCreate.mock.calls[0]![0]).not.toHaveProperty('preset')
    expect(props.onCreate.mock.calls[0]![0].model).not.toHaveProperty('reasoningEffort')
    expect(screen.getByRole('alert').textContent).toBe('创建失败：gone')
    expect(props.onClose).not.toHaveBeenCalled()
  })
})

describe('subset choices', () => {
  it('waits for the choices, and goes back to All when switched', async () => {
    const props = {
      t: makeTranslate(zh), open: true, templates, onClose: vi.fn(), onCreate: vi.fn(async () => undefined),
      onLoadOptions: vi.fn(async () => ({ models: [], presets: [] })), squareAvatar: vi.fn(async () => ''),
    }
    render(<CreateAssistantWizard {...props} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('radio', { name: /电商管家/ }))
    next(); next(); next()
    const connectors = screen.getByRole('group', { name: '连接器' })
    expect(within(connectors).getByText('正在读取可选项…')).toBeTruthy()
    expect(within(connectors).queryByText('已失效')).toBeNull()
    fireEvent.click(within(connectors).getByRole('radio', { name: '全部（跟随全局）' }))
    expect(within(connectors).queryByRole('checkbox')).toBeNull()
  })
})

describe('subset search', () => {
  it('filters a long list by name and description and counts the selection', async () => {
    const many = Array.from({ length: 10 }, (_, index) => ({ id: `skill-${String(index)}`, name: `skill-${String(index)}`, ...index === 3 ? { description: '写周报' } : {} }))
    const props = {
      t: makeTranslate(zh), open: true, templates: [], onClose: vi.fn(), onCreate: vi.fn(async () => undefined),
      onLoadOptions: vi.fn(async () => ({ models: [], presets: [], capabilities: { skills: many, connectors: [], knowledgeBases: [] } })),
      squareAvatar: vi.fn(async () => ''),
    }
    render(<CreateAssistantWizard {...props} />)
    await act(async () => { await Promise.resolve() })
    next()
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '多' } })
    next(); next()
    const skills = screen.getByRole('group', { name: 'Skill' })
    expect(within(skills).queryByRole('textbox')).toBeNull()
    fireEvent.click(within(skills).getByRole('radio', { name: '仅选中' }))
    expect(within(skills).getAllByRole('checkbox')).toHaveLength(10)
    fireEvent.change(within(skills).getByRole('textbox', { name: 'Skill 搜索' }), { target: { value: '周报' } })
    expect(within(skills).getAllByRole('checkbox').map(box => box.closest('label')?.textContent)).toEqual(['skill-3'])
    fireEvent.click(within(skills).getByRole('checkbox', { name: 'skill-3' }))
    expect(within(skills).getByText('已选 1 项')).toBeTruthy()
    fireEvent.change(within(skills).getByRole('textbox', { name: 'Skill 搜索' }), { target: { value: '' } })
    expect(within(skills).getAllByRole('checkbox')).toHaveLength(10)
  })
})
