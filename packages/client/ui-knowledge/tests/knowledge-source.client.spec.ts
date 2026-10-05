import { expect, it, vi } from 'vitest'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding/types'
import type { KnowledgeState } from '@deepseek-ai/dsh-knowledge-base/types'
import { createKnowledgeSource, type KnowledgeDependencies } from '../src/client/knowledge-source.ts'

const base = (id: string, name: string) => ({ id, name, embeddingModelId: 'local/q', embeddingModelName: 'Q', status: 'ready' as const, items: [], createdAt: '2026-10-05T00:00:00.000Z' })
const state = (...bases: ReturnType<typeof base>[]): KnowledgeState => ({ tenantId: 't-a', bases })
const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value })
const refused = (code: string, message = code) => Promise.resolve({ ok: false as const, error: { code, message, details: {} } } as never)

function deps() {
  return {
    createBase: vi.fn<KnowledgeDependencies['createBase']>(() => ok(state(base('a', '甲'), base('b', '乙')))),
    renameBase: vi.fn<KnowledgeDependencies['renameBase']>(() => ok(state(base('a', '甲公司')))),
    deleteBase: vi.fn<KnowledgeDependencies['deleteBase']>(() => ok(state())),
    addFiles: vi.fn<KnowledgeDependencies['addFiles']>(() => ok({ added: 1, rejected: [{ name: 'a.png', reason: 'unsupported' as const }] })),
    reprocessItem: vi.fn<KnowledgeDependencies['reprocessItem']>(() => ok(state(base('a', '甲')))),
    deleteItem: vi.fn<KnowledgeDependencies['deleteItem']>(() => ok(state(base('a', '甲')))),
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
