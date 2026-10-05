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
  items: [
    { id: 'i1', kind: 'file', name: '年假制度.docx', size: 36_947, status: 'completed', error: null, chunkCount: 3, addedAt: '2026-10-05T00:00:01.000Z' },
    { id: 'i2', kind: 'file', name: '扫描件.pdf', size: 2048, status: 'failed', error: 'empty', chunkCount: 0, addedAt: '2026-10-05T00:00:02.000Z' },
    { id: 'i3', kind: 'file', name: '会议纪要.txt', size: 100, status: 'processing', error: null, chunkCount: 0, addedAt: '2026-10-05T00:00:03.000Z' },
  ],
  ...over,
})

function mount(state: KnowledgeState | undefined, extra: Partial<KnowledgeSnapshot> = {}, copy = zh) {
  const store = createSnapshotStore<KnowledgeSnapshot>({
    state, embedding: embedding(), selectedId: null, busy: false, failure: null, added: null, ...extra,
  })
  const props = {
    t: makeTranslate(copy), useKnowledge: bindSnapshotSelector(store),
    onSelect: vi.fn((id: string) => { store.set({ ...store.getSnapshot(), selectedId: id }) }),
    onCreate: vi.fn(async () => true), onRename: vi.fn(async () => true), onDelete: vi.fn(async () => {}),
    onAddFiles: vi.fn(async () => {}), onReprocess: vi.fn(async () => {}), onDeleteItem: vi.fn(async () => {}), onDismiss: vi.fn(),
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
})
