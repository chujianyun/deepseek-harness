// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { EmbeddingProviderView, EmbeddingState, LocalModelView } from '@deepseek-ai/dsh-embedding/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { EmbeddingSnapshot } from '../src/client/embedding-source.ts'
import { EmbeddingSection } from '../src/client/EmbeddingSection.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const MB = 1024 * 1024
const local = (over: Partial<LocalModelView> = {}): LocalModelView => ({
  id: 'local/qwen3-embedding-0.6b', name: 'Qwen3-Embedding-0.6B', status: 'installed', receivedBytes: 700 * MB, totalBytes: 700 * MB, dimensions: 1024, error: null, ...over,
})
const acme: EmbeddingProviderView = { provider: 'acme', displayName: 'Acme 网关' }

function mount(state: EmbeddingState | undefined, extra: Partial<EmbeddingSnapshot> = {}, copy = zh) {
  const store = createSnapshotStore<EmbeddingSnapshot>({ state, providers: [acme], busy: false, failure: null, ...extra })
  const props = {
    t: makeTranslate(copy), useEmbedding: bindSnapshotSelector(store),
    onRefreshProviders: vi.fn(async () => {}), onStart: vi.fn(async () => {}), onPause: vi.fn(async () => {}),
    onRemoveLocal: vi.fn(async () => {}), onAdd: vi.fn(async () => true), onRemoveApi: vi.fn(async () => {}), onOpenModels: vi.fn(),
  }
  render(<EmbeddingSection {...props} />)
  return { props, store }
}

describe('embedding section, local model', () => {
  it.each([zh, en])('shows the installed model with its vector size and deletes it after confirmation', async (copy) => {
    const { props } = mount({ local: local(), apiModels: [] }, {}, copy)
    expect(props.onRefreshProviders).toHaveBeenCalledOnce()
    expect(screen.getByRole('region', { name: copy.nav }).textContent).toContain('Qwen3-Embedding-0.6B')
    expect(screen.getByText(copy['status.installed'])).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: copy.remove }))
    expect(screen.getByText(copy['local.removeHint'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: copy.cancel }))
    expect(props.onRemoveLocal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: copy.remove }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.confirmRemove })) })
    expect(props.onRemoveLocal).toHaveBeenCalledOnce()
  })

  it('shows download progress and pauses it', () => {
    const { props } = mount({ local: local({ status: 'downloading', receivedBytes: 307 * MB, dimensions: null }), apiModels: [] })
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('43')
    expect(screen.getByText('307MB / 700MB · 43%')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    expect(props.onPause).toHaveBeenCalledOnce()
  })

  it.each([
    ['paused', '继续', null],
    ['missing', '下载', null],
    ['failed', '重试', 'network'],
    ['damaged', '修复', null],
  ] as const)('offers the way forward when %s', (status, action, error) => {
    const { props } = mount({ local: local({ status, receivedBytes: status === 'missing' ? 0 : 10 * MB, error }), apiModels: [] })
    fireEvent.click(screen.getByRole('button', { name: action }))
    expect(props.onStart).toHaveBeenCalledOnce()
    if (status === 'failed') expect(screen.getByRole('alert').textContent).toBe(zh['error.network'])
    if (status === 'damaged') expect(screen.getByText(zh['local.damaged'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删除' }) === null).toBe(status === 'missing')
  })

  it('explains an unsupported computer without actions, and a failure with nothing downloaded', () => {
    mount({ local: local({ status: 'unsupported', receivedBytes: 0, totalBytes: 0, dimensions: null }), apiModels: [] })
    expect(screen.getByText(zh['local.unsupported'])).toBeTruthy()
    expect(screen.queryAllByRole('button').filter(button => button.textContent !== '添加')).toHaveLength(0)
    cleanup()
    mount({ local: local({ status: 'failed', receivedBytes: 0, error: 'storage' }), apiModels: [] }, { failure: { message: 'boom', users: null } })
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getAllByRole('alert').map(node => node.textContent)).toEqual(['操作失败：boom', zh['error.storage']])
    cleanup()
    mount({ local: local(), apiModels: [] }, { failure: { message: 'used', users: ['制度库', '合同库'] } })
    expect(screen.getByRole('alert').textContent).toBe('该模型正被 2 个知识库使用（制度库、合同库），不能删除。')
  })

  it('waits for the first frame before showing the model', () => {
    mount(undefined)
    expect(screen.queryByText('Qwen3-Embedding-0.6B', { exact: false })).toBeNull()
    expect(screen.getByText(zh['api.empty'])).toBeTruthy()
  })
})

describe('embedding section, API models', () => {
  it('lists models with their provider and size, flags an unavailable route, and removes one', () => {
    const { props } = mount({
      local: local(),
      apiModels: [
        { id: 'acme/bge-m3', provider: 'acme', providerName: 'Acme 网关', model: 'bge-m3', dimensions: 1024, available: true },
        { id: 'gone/e5', provider: 'gone', providerName: 'gone', model: 'e5', dimensions: 768, available: false },
      ],
    })
    expect(screen.getByText('Acme 网关 · 1024 维')).toBeTruthy()
    expect(screen.getByText(zh['api.unavailable'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除 e5' }))
    expect(props.onRemoveApi).toHaveBeenCalledWith('gone/e5')
  })

  it('adds a model on the chosen provider and clears the form when it succeeds', async () => {
    const { props, store } = mount({ local: local(), apiModels: [] })
    act(() => { store.set({ ...store.getSnapshot(), providers: [acme, { provider: 'silicon', displayName: '硅基流动' }] }) })
    const add = screen.getByRole('button', { name: '添加' })
    expect((add as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: '提供商' }), { target: { value: 'silicon' } })
    fireEvent.change(screen.getByRole('textbox', { name: '模型 ID' }), { target: { value: ' BAAI/bge-m3 ' } })
    const pending = Promise.withResolvers<boolean>()
    props.onAdd.mockReturnValueOnce(pending.promise)
    fireEvent.click(add)
    expect(props.onAdd).toHaveBeenCalledWith('silicon', 'BAAI/bge-m3')
    expect(screen.getByRole('button', { name: '正在测试…' })).toBeTruthy()
    await act(async () => { pending.resolve(true); await pending.promise })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '模型 ID' }).value).toBe('')
    // A refused add keeps the typed id.
    props.onAdd.mockResolvedValueOnce(false)
    fireEvent.change(screen.getByRole('textbox', { name: '模型 ID' }), { target: { value: 'bad' } })
    await act(async () => { fireEvent.submit(screen.getByRole('button', { name: '添加' }).closest('form')!) })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '模型 ID' }).value).toBe('bad')
    // A provider that disappears falls back to the first one.
    act(() => { store.set({ ...store.getSnapshot(), providers: [acme] }) })
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '提供商' }).value).toBe('acme')
  })

  it('points to Models when no provider can serve embeddings', () => {
    const { props } = mount({ local: local(), apiModels: [] }, { providers: [] })
    expect(screen.getByText(zh['api.noProvider'])).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '去配置模型' }))
    expect(props.onOpenModels).toHaveBeenCalledOnce()
  })
})
