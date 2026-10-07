// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding/types'
import type { KnowledgeBaseView, KnowledgeItemView, KnowledgeState } from '@deepseek-ai/dsh-knowledge-base/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { KnowledgeSnapshot } from '../src/client/knowledge-source.ts'
import { KnowledgePage } from '../src/client/KnowledgePage.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); Reflect.deleteProperty(globalThis, '__DSH_HOST_PATHS__') })

const embedding: EmbeddingState = {
  local: { id: 'local/qwen', name: 'Qwen3-Embedding-0.6B', status: 'installed', receivedBytes: 1, totalBytes: 1, dimensions: 1024, error: null },
  apiModels: [],
}
const item = (over: Partial<KnowledgeItemView> & Pick<KnowledgeItemView, 'id' | 'kind' | 'name'>): KnowledgeItemView => ({
  parentId: null, source: null, size: 100, skipped: [], skippedCount: 0, status: 'completed', error: null, chunkCount: 1, addedAt: '2026-10-05T00:00:00.000Z', ...over,
})
const ITEMS: KnowledgeItemView[] = [
  item({ id: 'f1', kind: 'file', name: '年假制度.docx' }),
  item({
    id: 'd1', kind: 'folder', name: '制度', source: '/Users/me/制度', size: 300, status: 'processing', chunkCount: 2,
    skipped: [{ path: 'logo.png', reason: 'unsupported' }, { path: '人事/z.pdf', reason: 'limit' }], skippedCount: 7,
  }),
  item({ id: 'd1a', kind: 'file', name: 'a.md', parentId: 'd1', source: 'a.md', chunkCount: 2 }),
  item({ id: 'd1b', kind: 'file', name: 'b.txt', parentId: 'd1', source: '人事/b.txt', status: 'pending', chunkCount: 0 }),
  item({ id: 'd2', kind: 'folder', name: '旧资料', source: '/Users/me/旧资料', status: 'failed', error: 'folder-missing', chunkCount: 0 }),
  item({ id: 'u1', kind: 'url', name: '年假制度 - 内网', source: 'https://intra.example.com/leave', size: 2048, status: 'failed', error: 'unreachable', chunkCount: 3 }),
  item({ id: 'u2', kind: 'url', name: 'https://example.com/new', source: 'https://example.com/new', size: 0, status: 'pending', chunkCount: 0 }),
  item({ id: 'n1', kind: 'note', name: '报销提醒', size: 42 }),
]
const base = (items = ITEMS): KnowledgeBaseView => ({
  id: 'b1', name: '公司制度', embeddingModelId: 'local/qwen', embeddingModelName: 'Qwen3-Embedding-0.6B', status: 'ready',
  createdAt: '2026-10-05T00:00:00.000Z', dimensions: 1024, items,
  settings: { chunkStrategy: 'structured', chunkSeparator: '\\n\\n', chunkSize: 1024, chunkOverlap: 200, documentCount: 6, threshold: 0 },
})

function mount(items = ITEMS) {
  const state: KnowledgeState = { revision: 1, tenantId: 't-a', bases: [base(items)] }
  const store = createSnapshotStore<KnowledgeSnapshot>({
    state, embedding, selectedId: null, busy: false, failure: null, added: null, recall: null,
  })
  const props = {
    t: makeTranslate(zh), useKnowledge: bindSnapshotSelector(store),
    onSelect: vi.fn(), onCreate: vi.fn(async () => true), onRename: vi.fn(async () => true), onDelete: vi.fn(async () => {}),
    onAddFiles: vi.fn(async () => {}), onReprocess: vi.fn(async () => {}), onDeleteItem: vi.fn(async () => {}), onDismiss: vi.fn(),
    onSaveSettings: vi.fn(async () => true), onReprocessAll: vi.fn(async () => {}), onRecall: vi.fn(async () => {}),
    onAddFolder: vi.fn(async (_id: string, _path: string) => {}), onAddUrl: vi.fn(async (_id: string, _url: string) => true),
    onCreateNote: vi.fn(async (_id: string, _title: string, _content: string) => true),
    onUpdateNote: vi.fn(async (_id: string, _itemId: string, _title: string, _content: string) => true),
    onLoadNote: vi.fn(async (_id: string, _itemId: string): Promise<{ title: string; content: string } | undefined> => ({ title: '报销提醒', content: '发票十五天内提交' })),
  }
  render(<KnowledgePage {...props} />)
  return { props, store }
}

const source = (name: string) => { fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`, 'u') })) }
const pane = () => screen.getByRole('tabpanel', { name: /^(文件|文件夹|网址|笔记) \d/u })
function withPath(file: File, relative: string): File {
  Object.defineProperty(file, 'webkitRelativePath', { value: relative })
  return file
}

describe('knowledge sources', () => {
  it('counts each kind\'s top-level items, and lists only lone files under Files', () => {
    mount()
    // The list counts sources, not a folder's files.
    expect(within(screen.getByRole('navigation', { name: zh.title })).getByRole('button', { name: /^公司制度/u }).textContent).toBe('公司制度6')
    const tabs = within(screen.getByRole('tablist', { name: zh.sources })).getAllByRole('tab').map(tab => tab.textContent)
    expect(tabs).toEqual(['文件 1', '文件夹 2', '网址 2', '笔记 1'])
    expect(within(pane()).getAllByRole('row').slice(1).map(row => row.textContent?.split('36')[0])).toEqual([expect.stringContaining('年假制度.docx')])
    cleanup()
    mount([])
    for (const [tab, empty] of [['文件夹', zh.foldersEmpty], ['网址', zh.urlsEmpty], ['笔记', zh.notesEmpty]] as const) {
      source(tab)
      expect(pane().textContent).toContain(empty)
    }
  })

  it('adds a picked or dropped folder by its path, and shows its files, progress, and skipped files', async () => {
    const { props } = mount()
    source('文件夹')
    Object.defineProperty(globalThis, '__DSH_HOST_PATHS__', {
      configurable: true, value: { pathFor: (file: File) => (file.name === 'nopath.md' ? '' : `/Users/me/${file.webkitRelativePath || file.name}`) },
    })
    const input = within(pane()).getByLabelText(zh.addFolder, { selector: 'input' })
    expect(input.hasAttribute('webkitdirectory')).toBe(true)
    await act(async () => { fireEvent.change(input, { target: { files: [withPath(new File(['x'], 'a.md'), '新制度/人事/a.md')] } }) })
    expect(props.onAddFolder).toHaveBeenLastCalledWith('b1', '/Users/me/新制度')
    const zone = within(pane()).getByText(zh.folderHint).parentElement!
    await act(async () => { fireEvent.drop(zone, { dataTransfer: { files: [new File([''], '拖入的文件夹')] } }) })
    expect(props.onAddFolder).toHaveBeenLastCalledWith('b1', '/Users/me/拖入的文件夹')
    // No path: an empty pick, a file without a relative path, or no bridge.
    for (const files of [[], [withPath(new File(['x'], 'a.md'), '')], [withPath(new File(['x'], 'nopath.md'), 'x/nopath.md')]]) {
      await act(async () => { fireEvent.change(input, { target: { files } }) })
      expect(within(pane()).getByRole('alert').textContent).toBe(zh.noFolderPath)
    }
    Reflect.deleteProperty(globalThis, '__DSH_HOST_PATHS__')
    await act(async () => { fireEvent.drop(zone, { dataTransfer: { files: [] } }) })
    await act(async () => { fireEvent.drop(zone, { dataTransfer: { files: [new File([''], '无路径')] } }) })
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined)
    fireEvent.click(within(pane()).getByRole('button', { name: zh.addFolder }))
    expect(click).toHaveBeenCalledOnce()
    await act(async () => { fireEvent.change(input, { target: { files: [withPath(new File(['x'], 'a.md'), 'y/a.md')] } }) })
    expect(props.onAddFolder).toHaveBeenCalledTimes(2)

    const folder = within(pane()).getByRole('region', { name: '制度' })
    expect(folder.textContent).toContain('/Users/me/制度')
    expect(folder.textContent).toContain('2 个文件')
    expect(folder.textContent).toContain(zh['status.processing'])
    fireEvent.click(within(folder).getByRole('button', { name: '已跳过 7 个文件' }))
    expect(within(folder).getByRole('list', { name: zh.skippedList }).textContent).toBe('logo.png：不支持的格式人事/z.pdf：超过 1000 个文件的上限还有 5 个未列出')
    fireEvent.click(within(folder).getByRole('button', { name: zh.expand }))
    const files = within(folder).getByRole('table', { name: '制度 中的文件' })
    expect(within(files).getAllByRole('row').slice(1).map(row => row.firstElementChild?.textContent)).toEqual(['a.md', '人事/b.txt'])
    fireEvent.click(within(folder).getByRole('button', { name: zh.collapse }))
    expect(within(folder).queryByRole('table', { name: '制度 中的文件' })).toBeNull()
    const gone = within(pane()).getByRole('region', { name: '旧资料' })
    expect(gone.textContent).toContain(zh['error.folder-missing'])
    expect(within(gone).queryByRole('button', { name: /已跳过/u })).toBeNull()
    fireEvent.click(within(gone).getByRole('button', { name: zh.reprocess }))
    expect(props.onReprocess).toHaveBeenCalledWith('b1', 'd2')
  })

  it('adds a web page, and shows a page\'s title, address, and kept content after it became unreachable', async () => {
    const { props } = mount()
    source('网址')
    const field = within(pane()).getByRole('textbox', { name: zh.urlPlaceholder })
    const add = within(pane()).getByRole('button', { name: zh.addUrl })
    expect((add as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(field)
    expect(props.onAddUrl).not.toHaveBeenCalled()
    props.onAddUrl.mockResolvedValueOnce(false)
    fireEvent.change(field, { target: { value: ' ftp://x ' } })
    await act(async () => { fireEvent.click(add) })
    expect(props.onAddUrl).toHaveBeenLastCalledWith('b1', 'ftp://x')
    expect((field as HTMLInputElement).value).toBe(' ftp://x ')
    fireEvent.change(field, { target: { value: 'https://example.com/a' } })
    await act(async () => { fireEvent.submit(field) })
    expect((field as HTMLInputElement).value).toBe('')
    const rows = within(pane()).getAllByRole('row').slice(1)
    expect(rows[0]!.textContent).toContain('年假制度 - 内网https://intra.example.com/leave')
    expect(rows[0]!.textContent).toContain(zh['error.unreachable'])
    expect(rows[0]!.children[3]!.textContent).toBe('3')
    // Not fetched yet: the address is the name, shown once, with no size.
    expect(rows[1]!.firstElementChild!.textContent).toBe('https://example.com/new')
    expect(rows[1]!.children[1]!.textContent).toBe('–')
  })

  it('writes and edits notes within the length limit', async () => {
    const { props, store } = mount()
    source('笔记')
    fireEvent.click(within(pane()).getByRole('button', { name: zh.newNote }))
    let dialog = screen.getByRole('dialog', { name: zh.newNote })
    const save = () => within(screen.getByRole('dialog')).getByRole('button', { name: zh.save })
    expect((save() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(dialog).getByRole('textbox', { name: zh.noteTitle }), { target: { value: ' 会议 ' } })
    const body = within(dialog).getByRole('textbox', { name: zh.noteContent })
    fireEvent.change(body, { target: { value: '周一十点' } })
    expect(dialog.textContent).toContain('4 / 1,000,000 字')
    fireEvent.change(body, { target: { value: '字'.repeat(1_000_001) } })
    expect(within(dialog).getByRole('alert').textContent).toBe('正文 1,000,001 字，超过 1,000,000 字的上限，无法保存。')
    expect((save() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(body, { target: { value: '周一十点' } })
    props.onCreateNote.mockResolvedValueOnce(false)
    act(() => { store.set({ ...store.getSnapshot(), failure: { reason: 'invalid-note', field: 'title', max: 100 } }) })
    await act(async () => { fireEvent.click(save()) })
    expect(props.onCreateNote).toHaveBeenLastCalledWith('b1', '会议', '周一十点')
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('笔记标题需要 1 到 100 个字。')
    act(() => { store.set({ ...store.getSnapshot(), failure: null }) })
    await act(async () => { fireEvent.click(save()) })
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => { fireEvent.click(within(pane()).getByRole('button', { name: zh.editNote })) })
    expect(props.onLoadNote).toHaveBeenCalledWith('b1', 'n1')
    dialog = screen.getByRole('dialog', { name: zh.editNote })
    expect(within(dialog).getByRole('textbox', { name: zh.noteContent })).toHaveProperty('value', '发票十五天内提交')
    fireEvent.change(within(dialog).getByRole('textbox', { name: zh.noteContent }), { target: { value: '发票十天内提交' } })
    await act(async () => { fireEvent.click(save()) })
    expect(props.onUpdateNote).toHaveBeenCalledWith('b1', 'n1', '报销提醒', '发票十天内提交')
    expect(screen.queryByRole('dialog')).toBeNull()
    // A note that cannot be read opens nothing; Cancel closes the editor.
    props.onLoadNote.mockResolvedValueOnce(undefined)
    await act(async () => { fireEvent.click(within(pane()).getByRole('button', { name: zh.editNote })) })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(pane()).getByRole('button', { name: zh.newNote }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
