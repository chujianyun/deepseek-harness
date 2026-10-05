// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding/types'
import type { KnowledgeBaseView, KnowledgeState } from '@deepseek-ai/dsh-knowledge-base/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { KnowledgeSnapshot } from '../src/client/knowledge-source.ts'
import { KnowledgePage } from '../src/client/KnowledgePage.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); Reflect.deleteProperty(globalThis, '__DSH_HOST_PATHS__') })

const embedding = (localStatus: EmbeddingState['local']['status'] = 'installed'): EmbeddingState => ({
  local: { id: 'local/qwen', name: 'Qwen3-Embedding-0.6B', status: localStatus, receivedBytes: 1, totalBytes: 1, dimensions: 1024, error: null },
  apiModels: [{ id: 'acme/bge-m3', provider: 'acme', providerName: 'Acme 网关', model: 'bge-m3', dimensions: 1024, available: true }],
})
const base = (over: Partial<KnowledgeBaseView> = {}): KnowledgeBaseView => ({
  id: 'b1', name: '公司制度', embeddingModelId: 'local/qwen', embeddingModelName: 'Qwen3-Embedding-0.6B', status: 'ready', createdAt: '2026-10-05T00:00:00.000Z',
  dimensions: 1024,
  settings: { chunkStrategy: 'structured', chunkSeparator: '\\n\\n', chunkSize: 1024, chunkOverlap: 200, documentCount: 6, threshold: 0 },
  items: [
    { id: 'i1', kind: 'file', name: '年假制度.docx', size: 36_947, status: 'completed', error: null, chunkCount: 3, addedAt: '2026-10-05T00:00:01.000Z' },
    { id: 'i2', kind: 'file', name: '扫描件.pdf', size: 2048, status: 'failed', error: 'empty', chunkCount: 0, addedAt: '2026-10-05T00:00:02.000Z' },
    { id: 'i3', kind: 'file', name: '会议纪要.txt', size: 100, status: 'processing', error: null, chunkCount: 0, addedAt: '2026-10-05T00:00:03.000Z' },
  ],
  ...over,
})

function mount(state: KnowledgeState | undefined, extra: Partial<KnowledgeSnapshot> = {}, copy = zh) {
  const store = createSnapshotStore<KnowledgeSnapshot>({
    state, embedding: embedding(), selectedId: null, busy: false, failure: null, added: null, recall: null, ...extra,
  })
  const props = {
    t: makeTranslate(copy), useKnowledge: bindSnapshotSelector(store),
    onSelect: vi.fn((id: string) => { store.set({ ...store.getSnapshot(), selectedId: id }) }),
    onCreate: vi.fn(async () => true), onRename: vi.fn(async () => true), onDelete: vi.fn(async () => {}),
    onAddFiles: vi.fn(async () => {}), onReprocess: vi.fn(async () => {}), onDeleteItem: vi.fn(async () => {}), onDismiss: vi.fn(),
    onSaveSettings: vi.fn(async (_id: string, _patch: object) => true), onReprocessAll: vi.fn(async () => {}),
    onRecall: vi.fn(async (_id: string, _query: string) => {}),
  }
  render(<KnowledgePage {...props} />)
  return { props, store }
}

describe('knowledge page', () => {
  it('waits for the first frame, and asks to sign in while signed out', () => {
    mount(undefined)
    expect(screen.queryByRole('heading')).toBeNull()
    cleanup()
    mount({ tenantId: null, bases: [] })
    expect(screen.getByText(zh.signedOut)).toBeTruthy()
  })

  it.each([zh, en])('lists knowledge bases and shows the selected one\'s files with their status', (copy) => {
    const { props } = mount({ tenantId: 't-a', bases: [base(), base({ id: 'b2', name: '产品资料', items: [], status: 'unavailable' })] }, {}, copy)
    const list = screen.getByRole('navigation', { name: copy.title })
    expect(within(list).getAllByRole('button').map(button => button.textContent)).toEqual([copy.create, '公司制度3', '产品资料0'])
    const detail = screen.getByRole('region', { name: '公司制度' })
    expect(detail.textContent).toContain('Qwen3-Embedding-0.6B')
    const rows = within(detail).getAllByRole('row').slice(1).map(row => row.textContent)
    expect(rows[0]).toContain(copy['status.completed'])
    expect(rows[1]).toContain(copy['error.empty'])
    expect(rows[2]).toContain(copy['status.processing'])
    fireEvent.click(within(detail).getAllByRole('button', { name: copy.reprocess })[1]!)
    expect(props.onReprocess).toHaveBeenCalledWith('b1', 'i2')
    // A file still processing can only be deleted.
    expect(within(within(detail).getByRole('cell', { name: copy.itemActions.replace('{name}', '会议纪要.txt') })).getAllByRole('button').map(button => button.textContent)).toEqual([copy.deleteItem])
    fireEvent.click(within(detail).getAllByRole('button', { name: copy.deleteItem })[0]!)
    expect(props.onDeleteItem).toHaveBeenCalledWith('b1', 'i1')
    fireEvent.click(within(list).getByRole('button', { name: '产品资料0' }))
    const other = screen.getByRole('region', { name: '产品资料' })
    expect(other.textContent).toContain(copy.unavailable)
    expect(other.textContent).toContain(copy.itemsEmpty)
  })

  it('shows empty states', () => {
    mount({ tenantId: 't-a', bases: [] })
    expect(screen.getByText(zh.listEmpty)).toBeTruthy()
    expect(screen.getByText(zh.detailEmpty)).toBeTruthy()
  })

  it('adds dropped and picked files by their local paths, and explains files without one', () => {
    const { props } = mount({ tenantId: 't-a', bases: [base()] })
    const file = (name: string) => new File(['x'], name)
    const zone = screen.getByText(zh.dropHint).parentElement!
    // Without the Desktop bridge, no file has a path.
    fireEvent.drop(zone, { dataTransfer: { files: [file('a.docx')] } })
    expect(screen.getByRole('alert').textContent).toBe(zh.noPath)
    Object.assign(globalThis, { __DSH_HOST_PATHS__: { pathFor: (picked: File) => picked.name === 'pasted' ? '' : `/docs/${picked.name}` } })
    fireEvent.dragOver(zone)
    expect(zone.getAttribute('data-dragging')).toBe('true')
    fireEvent.dragLeave(zone)
    fireEvent.drop(zone, { dataTransfer: { files: [file('a.docx'), file('pasted')] } })
    expect(props.onAddFiles).toHaveBeenLastCalledWith('b1', ['/docs/a.docx'])
    expect(screen.queryByRole('alert')).toBeNull()
    const input = screen.getByLabelText<HTMLInputElement>(zh.addFiles, { selector: 'input' })
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: zh.addFiles }))
    expect(click).toHaveBeenCalledOnce()
    fireEvent.change(input, { target: { files: [file('b.pdf')] } })
    expect(props.onAddFiles).toHaveBeenLastCalledWith('b1', ['/docs/b.pdf'])
    fireEvent.change(input, { target: { files: null } })
    expect(props.onAddFiles).toHaveBeenCalledTimes(2)
  })

  it('reports what was added and refused, or why an action failed, until dismissed', () => {
    const { props } = mount({ tenantId: 't-a', bases: [base()] }, { added: { added: 2, rejected: [{ name: 'logo.png', reason: 'unsupported' }, { name: 'big.pdf', reason: 'too-large' }] } })
    expect(screen.getByRole('alert').textContent).toContain('已添加 2 个文件logo.png：不支持的格式big.pdf：超过 100MB')
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(props.onDismiss).toHaveBeenCalledOnce()
    cleanup()
    mount({ tenantId: 't-a', bases: [base()] }, { added: { added: 1, rejected: [] } })
    expect(screen.getByRole('status').textContent).toContain('已添加 1 个文件')
    cleanup()
    mount({ tenantId: 't-a', bases: [base()] }, { failure: { reason: 'other', message: 'disk full' } })
    expect(screen.getByRole('alert').textContent).toContain('操作失败：disk full')
    cleanup()
    mount({ tenantId: 't-a', bases: [base()] }, { failure: { reason: 'invalid-name' } })
    expect(screen.getByRole('alert').textContent).toContain(zh['failure.invalid-name'])
    cleanup()
    // A failure shows even when no knowledge base is left to select, such as after deleting the last one fails.
    mount({ tenantId: 't-a', bases: [] }, { failure: { reason: 'other', message: 'disk full' } })
    expect(screen.getByRole('alert').textContent).toContain('操作失败：disk full')
  })

  it('creates a knowledge base with a chosen embedding model, warning about API models', async () => {
    const { props, store } = mount({ tenantId: 't-a', bases: [] })
    fireEvent.click(screen.getByRole('button', { name: zh.create }))
    const dialog = screen.getByRole('dialog', { name: zh.createTitle })
    const create = within(dialog).getByRole('button', { name: zh.confirmCreate })
    expect((create as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: ' 公司制度 ' } })
    const select = within(dialog).getByRole<HTMLSelectElement>('combobox')
    expect([...select.options].map(option => option.textContent)).toEqual(['Qwen3-Embedding-0.6B（本地）', 'bge-m3 · Acme 网关'])
    expect(within(dialog).queryByText(zh.privacy)).toBeNull()
    fireEvent.change(select, { target: { value: 'acme/bge-m3' } })
    expect(within(dialog).getByText(zh.privacy)).toBeTruthy()
    props.onCreate.mockResolvedValueOnce(false)
    act(() => { store.set({ ...store.getSnapshot(), failure: { reason: 'duplicate-name' } }) })
    await act(async () => { fireEvent.click(create) })
    expect(props.onCreate).toHaveBeenLastCalledWith('公司制度', 'acme/bge-m3')
    expect(within(dialog).getByRole('alert').textContent).toBe(zh['failure.duplicate-name'])
    await act(async () => { fireEvent.click(create) })
    expect(screen.queryByRole('dialog')).toBeNull()
    // Reopened, the form starts empty; Cancel closes it.
    fireEvent.click(screen.getByRole('button', { name: zh.create }))
    expect(within(screen.getByRole('dialog')).getByRole<HTMLInputElement>('textbox').value).toBe('')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers a downloading local model, and explains when no embedding model exists', () => {
    const { store } = mount({ tenantId: 't-a', bases: [] }, { embedding: embedding('downloading') })
    fireEvent.click(screen.getByRole('button', { name: zh.create }))
    expect(within(screen.getByRole('combobox')).getAllByRole('option')[0]!.textContent).toBe('Qwen3-Embedding-0.6B（本地，下载完成后可用）')
    act(() => { store.set({ ...store.getSnapshot(), embedding: { ...embedding('unsupported'), apiModels: [] } }) })
    expect(screen.getByText(zh.noModel)).toBeTruthy()
    act(() => { store.set({ ...store.getSnapshot(), embedding: undefined }) })
    expect(screen.getByText(zh.noModel)).toBeTruthy()
  })

  it('renames and deletes the selected knowledge base after confirmation', async () => {
    const { props, store } = mount({ tenantId: 't-a', bases: [base()] })
    fireEvent.click(screen.getByRole('button', { name: zh.rename }))
    const dialog = screen.getByRole('dialog', { name: zh.renameTitle })
    const field = within(dialog).getByRole<HTMLInputElement>('textbox')
    expect(field.value).toBe('公司制度')
    fireEvent.change(field, { target: { value: '甲公司制度' } })
    props.onRename.mockResolvedValueOnce(false)
    act(() => { store.set({ ...store.getSnapshot(), failure: { reason: 'other', message: 'offline' } }) })
    expect(within(dialog).getByRole('alert').textContent).toBe('操作失败：offline')
    act(() => { store.set({ ...store.getSnapshot(), failure: { reason: 'duplicate-name' } }) })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh.save })) })
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe(zh['failure.duplicate-name'])
    act(() => { store.set({ ...store.getSnapshot(), failure: null }) })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh.save })) })
    expect(props.onRename).toHaveBeenLastCalledWith('b1', '甲公司制度')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.rename }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.cancel }))
    fireEvent.click(screen.getByRole('button', { name: zh.deleteBase }))
    const confirm = screen.getByRole('dialog', { name: zh.deleteTitle })
    expect(confirm.textContent).toContain('将删除「公司制度」及其中的全部文件')
    fireEvent.click(within(confirm).getByRole('button', { name: zh.cancel }))
    expect(props.onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.deleteBase }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.confirmDelete }))
    expect(props.onDelete).toHaveBeenCalledWith('b1')
  })

  it('switches between files, settings, and the recall test, and shows a rebuild\'s progress', () => {
    mount({ tenantId: 't-a', bases: [base({ status: 'rebuilding' })] })
    const tabs = screen.getByRole('tablist', { name: zh.views })
    expect(within(tabs).getAllByRole('tab').map(tab => tab.textContent)).toEqual([zh['tab.files'], zh['tab.settings'], zh['tab.recall']])
    expect(screen.getByRole('status').textContent).toBe('正在用新的嵌入模型重建：已处理 2 / 3 个文档，完成前不能检索。')
    expect(screen.getByRole('progressbar', { name: zh.rebuildProgress }).getAttribute('value')).toBe('2')
    fireEvent.click(within(tabs).getByRole('tab', { name: zh['tab.settings'] }))
    expect(screen.getByRole('tabpanel').textContent).toContain(zh['settings.builtin'])
    fireEvent.click(within(tabs).getByRole('tab', { name: zh['tab.recall'] }))
    expect(screen.getByRole('tabpanel').textContent).toContain(zh['recall.emptyTitle'])
    fireEvent.click(within(tabs).getByRole('tab', { name: zh['tab.files'] }))
    expect(screen.getByRole('tabpanel').textContent).toContain('年假制度.docx')
  })

  it('edits settings with Cherry Studio\'s rules and saves only what changed', async () => {
    const { props, store } = mount({ tenantId: 't-a', bases: [base()] })
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.settings'] }))
    const panel = screen.getByRole('tabpanel')
    expect(within(panel).getAllByRole('region').map(region => region.getAttribute('aria-label'))).toEqual([
      zh['settings.fileProcessing'], zh['settings.embedding'], zh['settings.chunking'], zh['settings.retrieval'],
    ])
    expect(panel.textContent).not.toContain('重排')
    expect(panel.textContent).toContain('当前模型向量维度：1024')
    const save = within(panel).getByRole('button', { name: zh.save })
    const revert = within(panel).getByRole('button', { name: zh['settings.reset'] })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    const [separator, size, overlap] = within(panel).getAllByRole('textbox') as HTMLInputElement[]
    expect([separator!.value, size!.value, overlap!.value]).toEqual(['\\n\\n', '1024', '200'])
    // Sizes take digits only; an empty size cannot be saved; the overlap must stay below the size.
    fireEvent.change(size!, { target: { value: '1a2' } })
    expect(size!.value).toBe('12')
    expect(within(panel).getByRole('alert').textContent).toBe(zh['settings.chunkOverlapMustBeSmaller'])
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(size!, { target: { value: '' } })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(size!, { target: { value: '0' } })
    expect(within(panel).getByRole('alert').textContent).toBe(zh['settings.chunkSizeInvalid'])
    fireEvent.change(size!, { target: { value: '512' } })
    fireEvent.change(overlap!, { target: { value: '50' } })
    // Smart chunking off needs a separator.
    fireEvent.click(within(panel).getByRole('switch', { name: zh['settings.smartChunking'] }))
    fireEvent.change(separator!, { target: { value: '' } })
    expect(within(panel).getByRole('alert').textContent).toBe(zh['settings.chunkSeparatorRequired'])
    fireEvent.change(separator!, { target: { value: '###' } })
    fireEvent.click(within(panel).getByRole('switch', { name: zh['settings.smartChunking'] }))
    fireEvent.click(within(panel).getByRole('switch', { name: zh['settings.smartChunking'] }))
    // Reprocessing all waits for chunking changes to be saved.
    expect(within(panel).getByRole('button', { name: zh['settings.reprocessAll'] })).toHaveProperty('disabled', true)
    fireEvent.change(within(panel).getByRole('slider', { name: zh['settings.documentCount'] }), { target: { value: '3' } })
    fireEvent.change(within(panel).getByRole('slider', { name: zh['settings.threshold'] }), { target: { value: '0.35' } })
    expect(panel.textContent).toContain('0.35')
    await act(async () => { fireEvent.click(save) })
    expect(props.onSaveSettings).toHaveBeenCalledWith('b1', {
      chunkStrategy: 'delimiter', chunkSeparator: '###', chunkSize: 512, chunkOverlap: 50, documentCount: 3, threshold: 0.35,
    })
    // The Host's new settings make the form clean again.
    act(() => {
      store.set({ ...store.getSnapshot(), state: { tenantId: 't-a', bases: [base({ settings: {
        chunkStrategy: 'delimiter', chunkSeparator: '###', chunkSize: 512, chunkOverlap: 50, documentCount: 3, threshold: 0.35,
      } })] } })
    })
    expect(within(panel).getByRole('status').textContent).toBe(zh['settings.saved'])
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(panel).getByRole('button', { name: zh['settings.reprocessAll'] }))
    expect(props.onReprocessAll).toHaveBeenCalledWith('b1')
    // Revert drops unsaved edits.
    fireEvent.change(size!, { target: { value: '256' } })
    fireEvent.click(revert)
    expect(size!.value).toBe('512')
    props.onSaveSettings.mockResolvedValueOnce(false)
    fireEvent.change(size!, { target: { value: '256' } })
    await act(async () => { fireEvent.click(save) })
    expect(within(panel).queryByRole('status')).toBeNull()
  })

  it('asks before rebuilding for a new embedding model, and changes it directly when there are no documents', async () => {
    const { props } = mount({ tenantId: 't-a', bases: [base()] })
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.settings'] }))
    const model = screen.getByRole<HTMLSelectElement>('combobox', { name: zh.model })
    expect([...model.options].map(option => option.textContent)).toEqual(['Qwen3-Embedding-0.6B（本地）', 'bge-m3 · Acme 网关'])
    expect(screen.queryByText(zh.privacy)).toBeNull()
    fireEvent.change(model, { target: { value: 'acme/bge-m3' } })
    expect(screen.getByText(zh.privacy)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    const confirm = screen.getByRole('dialog', { name: zh['settings.rebuildTitle'] })
    expect(confirm.textContent).toContain('全部 3 个文档会重新分块和向量化')
    fireEvent.click(within(confirm).getByRole('button', { name: zh.cancel }))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(props.onSaveSettings).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh['settings.rebuildConfirm'] })) })
    expect(props.onSaveSettings).toHaveBeenCalledWith('b1', { embeddingModelId: 'acme/bge-m3' })
    cleanup()
    // No documents: nothing to rebuild, no question. A model Settings no longer lists still shows by name.
    const empty = mount({ tenantId: 't-a', bases: [base({ items: [], embeddingModelId: 'gone/m', embeddingModelName: 'gone-model', dimensions: null })] }, { embedding: undefined })
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.settings'] }))
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: zh.model })
    expect(select.options[0]!.textContent).toBe('gone-model')
    expect(screen.queryByText(/向量维度/u)).toBeNull()
    expect(screen.getByRole('button', { name: zh['settings.reprocessAll'] })).toHaveProperty('disabled', true)
    expect([...select.options].map(option => option.value)).toEqual(['gone/m'])
    act(() => { empty.store.set({ ...empty.store.getSnapshot(), embedding: embedding() }) })
    fireEvent.change(select, { target: { value: 'local/qwen' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.save })) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(empty.props.onSaveSettings).toHaveBeenCalledWith('b1', { embeddingModelId: 'local/qwen' })
  })

  it('runs a recall test under the retrieval settings and shows hits with sources and scores', async () => {
    const { props, store } = mount({ tenantId: 't-a', bases: [base({ settings: { ...base().settings, documentCount: 3, threshold: 0.2 } })] })
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.recall'] }))
    const panel = screen.getByRole('tabpanel')
    expect(panel.textContent).toContain('最多返回 3 个片段，相似度阈值 0.20')
    const submit = within(panel).getByRole('button', { name: zh['recall.submit'] })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(panel).getByRole('textbox'), { target: { value: ' 年假有几天 ' } })
    await act(async () => { fireEvent.click(submit) })
    expect(props.onRecall).toHaveBeenCalledWith('b1', '年假有几天')
    act(() => { store.set({ ...store.getSnapshot(), recall: { baseId: 'b1', query: '年假有几天', running: true, result: null, failure: null } }) })
    expect(within(panel).getByRole('status').textContent).toBe(zh['recall.searching'])
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    act(() => {
      store.set({ ...store.getSnapshot(), recall: { baseId: 'b1', query: '年假有几天', running: false, failure: null, result: { durationMs: 18, hits: [
        { itemId: 'i1', itemName: '年假制度.docx', ordinal: 0, text: '员工每年享有 5 天带薪年假', score: 0.8123 },
        { itemId: 'i3', itemName: '会议纪要.txt', ordinal: 2, text: '会议纪要', score: 0.2511 },
      ] } } })
    })
    expect(within(panel).getByRole('status').textContent).toBe('2 个结果 · 用时 18ms · 最高分 0.812')
    const hits = within(within(panel).getByRole('list', { name: zh['recall.results'] })).getAllByRole('listitem').map(item => item.textContent)
    expect(hits).toEqual(['#1年假制度.docx · 第 1 块相关度 0.812员工每年享有 5 天带薪年假', '#2会议纪要.txt · 第 3 块相关度 0.251会议纪要'])
    act(() => { store.set({ ...store.getSnapshot(), recall: { baseId: 'b1', query: 'x', running: false, failure: null, result: { durationMs: 3, hits: [] } } }) })
    expect(panel.textContent).toContain(zh['recall.noHits'])
    expect(panel.textContent).toContain('最高分 –')
    act(() => { store.set({ ...store.getSnapshot(), recall: { baseId: 'b1', query: 'x', running: false, result: null, failure: { reason: 'rebuilding' } } }) })
    expect(within(panel).getByRole('alert').textContent).toBe(zh['failure.rebuilding'])
    // Another knowledge base's test is not shown; Enter submits.
    act(() => { store.set({ ...store.getSnapshot(), recall: { baseId: 'b9', query: 'x', running: false, result: null, failure: { reason: 'probe-failed', message: 'x' } } }) })
    expect(panel.textContent).toContain(zh['recall.emptyTitle'])
    fireEvent.submit(within(panel).getByRole('textbox'))
    expect(props.onRecall).toHaveBeenCalledTimes(2)
    fireEvent.change(within(panel).getByRole('textbox'), { target: { value: '  ' } })
    fireEvent.submit(within(panel).getByRole('textbox'))
    expect(props.onRecall).toHaveBeenCalledTimes(2)
  })

  it('words a failed trial of a new embedding model, beside Save as well', () => {
    mount({ tenantId: 't-a', bases: [base()] }, { failure: { reason: 'probe-failed', message: 'HTTP 401' } })
    expect(screen.getByRole('alert').textContent).toContain('新的嵌入模型试用失败，未更换：HTTP 401')
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.settings'] }))
    expect(within(screen.getByRole('tabpanel')).getByRole('alert').textContent).toBe('新的嵌入模型试用失败，未更换：HTTP 401')
  })
})
