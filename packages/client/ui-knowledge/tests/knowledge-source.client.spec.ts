import { expect, it, vi } from 'vitest'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding/types'
import type { KnowledgeState } from '@deepseek-ai/dsh-knowledge-base/types'
import { createKnowledgeSource, type KnowledgeDependencies } from '../src/client/knowledge-source.ts'

const SETTINGS = { chunkStrategy: 'structured' as const, chunkSeparator: '\\n\\n', chunkSize: 1024, chunkOverlap: 200, documentCount: 6, threshold: 0 }
const base = (id: string, name: string) => ({
  id, name, embeddingModelId: 'local/q', embeddingModelName: 'Q', status: 'ready' as const, items: [], createdAt: '2026-10-05T00:00:00.000Z',
  dimensions: 4, settings: SETTINGS,
})
let revision = 0
/** A state newer than every one before it. */
const state = (...bases: ReturnType<typeof base>[]): KnowledgeState => ({ revision: ++revision, tenantId: 't-a', bases })
const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value })
const refused = (code: string, message = code, details: object = {}) =>
  Promise.resolve({ ok: false as const, error: { code, message, details } } as never)

function deps() {
  return {
    createBase: vi.fn<KnowledgeDependencies['createBase']>(() => ok(state(base('a', '甲'), base('b', '乙')))),
    renameBase: vi.fn<KnowledgeDependencies['renameBase']>(() => ok(state(base('a', '甲公司')))),
    deleteBase: vi.fn<KnowledgeDependencies['deleteBase']>(() => ok(state())),
    addFiles: vi.fn<KnowledgeDependencies['addFiles']>(() => ok({ added: 1, rejected: [{ name: 'a.png', reason: 'unsupported' as const }] })),
    reprocessItem: vi.fn<KnowledgeDependencies['reprocessItem']>(() => ok(state(base('a', '甲')))),
    deleteItem: vi.fn<KnowledgeDependencies['deleteItem']>(() => ok(state(base('a', '甲')))),
    updateSettings: vi.fn<KnowledgeDependencies['updateSettings']>(() => ok(state(base('a', '甲')))),
    reprocessAll: vi.fn<KnowledgeDependencies['reprocessAll']>(() => ok(state(base('a', '甲')))),
    recall: vi.fn<KnowledgeDependencies['recall']>(() => ok({ hits: [{ itemId: 'i1', itemName: 'a.md', itemKind: 'file', source: null, ordinal: 0, text: '年假', score: 0.8 }], durationMs: 12 })),
    addFolder: vi.fn<KnowledgeDependencies['addFolder']>(() => ok(state(base('a', '甲')))),
    addUrl: vi.fn<KnowledgeDependencies['addUrl']>(() => ok(state(base('a', '甲')))),
    createNote: vi.fn<KnowledgeDependencies['createNote']>(() => ok(state(base('a', '甲')))),
    updateNote: vi.fn<KnowledgeDependencies['updateNote']>(() => ok(state(base('a', '甲')))),
    getNote: vi.fn<KnowledgeDependencies['getNote']>(() => ok({ title: '笔记', content: '正文' })),
  }
}

it('adopts frames and results, selects a created knowledge base, and words known refusals', async () => {
  const d = deps()
  const source = createKnowledgeSource(d)
  const snapshot = () => source.hooks.knowledge.getSnapshot()
  source.publish(state(base('a', '甲')))
  const embedding: EmbeddingState = {
    local: { id: 'local/q', name: 'Q', status: 'installed', receivedBytes: 1, totalBytes: 1, dimensions: 4, error: null }, apiModels: [],
  }
  source.publishEmbedding(embedding)
  expect(snapshot()).toMatchObject({ state: { bases: [{ id: 'a' }] }, embedding: { local: { id: 'local/q' } }, selectedId: null })
  source.onSelect('a')
  expect(snapshot().selectedId).toBe('a')
  expect(await source.onCreate('乙', 'local/q')).toBe(true)
  expect(snapshot()).toMatchObject({ selectedId: 'b', busy: false, failure: null })
  d.createBase.mockReturnValueOnce(refused('knowledge/duplicate-name'))
  expect(await source.onCreate('乙', 'local/q')).toBe(false)
  expect(snapshot().failure).toEqual({ reason: 'duplicate-name' })
  d.renameBase.mockReturnValueOnce(refused('knowledge/invalid-name'))
  expect(await source.onRename('a', '')).toBe(false)
  expect(snapshot().failure).toEqual({ reason: 'invalid-name' })
  expect(await source.onRename('a', '甲公司')).toBe(true)
  expect(snapshot().state?.bases[0]!.name).toBe('甲公司')
  await source.onAddFiles('a', ['/x/a.png', '/x/b.txt'])
  expect(snapshot().added).toEqual({ added: 1, rejected: [{ name: 'a.png', reason: 'unsupported' }] })
  d.addFiles.mockReturnValueOnce(refused('knowledge/not-found', 'no knowledge base a'))
  await source.onAddFiles('a', ['/x/b.txt'])
  expect(snapshot()).toMatchObject({ added: null, failure: { reason: 'other', message: 'no knowledge base a' } })
  source.onDismiss()
  expect(snapshot()).toMatchObject({ added: null, failure: null })
  await source.onReprocess('a', 'i1')
  await source.onDeleteItem('a', 'i1')
  expect(d.reprocessItem).toHaveBeenCalledWith('a', 'i1')
  expect(d.deleteItem).toHaveBeenCalledWith('a', 'i1')
  await source.onDelete('a')
  expect(snapshot().state?.bases).toEqual([])
})

it('saves settings, reprocesses all, and keeps the recall test apart from action failures', async () => {
  const d = deps()
  const source = createKnowledgeSource(d)
  const snapshot = () => source.hooks.knowledge.getSnapshot()
  expect(await source.onSaveSettings('a', { documentCount: 3 })).toBe(true)
  expect(d.updateSettings).toHaveBeenCalledWith('a', { documentCount: 3 })
  d.updateSettings.mockReturnValueOnce(refused('knowledge/embedding-probe-failed', 'embedding model acme/x failed: 401', { id: 'acme/x', message: '401' }))
  expect(await source.onSaveSettings('a', { embeddingModelId: 'acme/x' })).toBe(false)
  expect(snapshot().failure).toEqual({ reason: 'probe-failed', message: '401' })
  await source.onReprocessAll('a')
  expect(d.reprocessAll).toHaveBeenCalledWith('a')
  expect(snapshot().failure).toBeNull()

  const pending = source.onRecall('a', '年假')
  expect(snapshot().recall).toEqual({ baseId: 'a', query: '年假', running: true, result: null, failure: null })
  await pending
  expect(snapshot().recall).toMatchObject({ running: false, result: { durationMs: 12 }, failure: null })
  // A new query keeps the previous hits of the same knowledge base on screen while it runs.
  d.recall.mockReturnValueOnce(refused('knowledge/rebuilding'))
  const again = source.onRecall('a', '报销')
  expect(snapshot().recall).toMatchObject({ running: true, result: { durationMs: 12 } })
  await again
  expect(snapshot().recall).toEqual({ baseId: 'a', query: '报销', running: false, result: null, failure: { reason: 'rebuilding' } })
  expect(snapshot().failure).toBeNull()
  void source.onRecall('b', '年假')
  expect(snapshot().recall).toMatchObject({ baseId: 'b', result: null })
})

it('adds folders and pages, writes notes, and words their refusals', async () => {
  const d = deps()
  const source = createKnowledgeSource(d)
  const snapshot = () => source.hooks.knowledge.getSnapshot()
  d.addFolder.mockReturnValueOnce(refused('knowledge/not-a-folder'))
  await source.onAddFolder('a', '/x/a.txt')
  expect(snapshot().failure).toEqual({ reason: 'not-a-folder' })
  await source.onAddFolder('a', '/x/dir')
  expect(d.addFolder).toHaveBeenLastCalledWith('a', '/x/dir')
  d.addUrl.mockReturnValueOnce(refused('knowledge/invalid-url'))
  expect(await source.onAddUrl('a', 'ftp://x')).toBe(false)
  expect(snapshot().failure).toEqual({ reason: 'invalid-url' })
  expect(await source.onAddUrl('a', 'https://x')).toBe(true)
  d.createNote.mockReturnValueOnce(refused('knowledge/invalid-note', 'too long', { field: 'content', max: 1_000_000 }))
  expect(await source.onCreateNote('a', '题', '长')).toBe(false)
  expect(snapshot().failure).toEqual({ reason: 'invalid-note', field: 'content', max: 1_000_000 })
  expect(await source.onCreateNote('a', '题', '文')).toBe(true)
  expect(await source.onUpdateNote('a', 'n', '题', '文')).toBe(true)
  expect(d.updateNote).toHaveBeenCalledWith('a', 'n', '题', '文')
  expect(await source.onLoadNote('a', 'n')).toEqual({ title: '笔记', content: '正文' })
  d.getNote.mockReturnValueOnce(refused('knowledge/not-found'))
  expect(await source.onLoadNote('a', 'gone')).toBeUndefined()
})

it('keeps the newer state when an action\'s answer arrives after a newer stream frame', async () => {
  const d = deps()
  const source = createKnowledgeSource(d)
  const snapshot = () => source.hooks.knowledge.getSnapshot()
  const stale = state(base('a', '处理中'))
  const fresh = state(base('a', '已失败'))
  d.reprocessItem.mockImplementationOnce(async () => {
    source.publish(fresh)
    return { ok: true as const, value: stale }
  })
  await source.onReprocess('a', 'i1')
  expect(snapshot().state).toBe(fresh)
  source.publish(stale)
  expect(snapshot().state).toBe(fresh)
  // A created knowledge base is still selected when its answer is the older state.
  d.createBase.mockImplementationOnce(async () => {
    const answer = state(base('a', '甲'), base('n', '新'))
    source.publish(state(base('a', '甲'), base('n', '新')))
    return { ok: true as const, value: answer }
  })
  expect(await source.onCreate('新', 'local/q')).toBe(true)
  expect(snapshot().selectedId).toBe('n')
})
