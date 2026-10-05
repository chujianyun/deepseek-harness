import { expect, it, vi } from 'vitest'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding/types'
import { createEmbeddingSource, type EmbeddingDependencies } from '../src/client/embedding-source.ts'

const state = (status: EmbeddingState['local']['status']): EmbeddingState => ({
  local: { id: 'local/qwen3-embedding-0.6b', name: 'Qwen3-Embedding-0.6B', status, receivedBytes: 0, totalBytes: 10, dimensions: null, error: null },
  apiModels: [],
})
const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value })
const refused = (message: string) => Promise.resolve({ ok: false as const, error: { code: 'embedding/request-failed', message } } as never)

function deps() {
  return {
    listProviders: vi.fn<EmbeddingDependencies['listProviders']>(() => ok([{ provider: 'acme', displayName: 'Acme' }])),
    startDownload: vi.fn<EmbeddingDependencies['startDownload']>(() => ok(state('downloading'))),
    pauseDownload: vi.fn<EmbeddingDependencies['pauseDownload']>(() => ok(state('paused'))),
    removeLocalModel: vi.fn<EmbeddingDependencies['removeLocalModel']>(() => ok(state('missing'))),
    addApiModel: vi.fn<EmbeddingDependencies['addApiModel']>(() => ok(state('installed'))),
    removeApiModel: vi.fn<EmbeddingDependencies['removeApiModel']>(() => ok(state('installed'))),
    openModels: vi.fn(),
  }
}

it('adopts Host frames and action results, and remembers the last refusal until the next action', async () => {
  const d = deps()
  const source = createEmbeddingSource(d)
  const snapshot = () => source.hooks.embedding.getSnapshot()
  expect(snapshot()).toEqual({ state: undefined, providers: [], busy: false, failure: null })
  source.publish(state('missing'))
  expect(snapshot().state?.local.status).toBe('missing')
  await source.onStart()
  expect(snapshot().state?.local.status).toBe('downloading')
  await source.onPause()
  await source.onRemoveLocal()
  expect(snapshot().state?.local.status).toBe('missing')
  await source.onRefreshProviders()
  expect(snapshot().providers).toEqual([{ provider: 'acme', displayName: 'Acme' }])
  d.addApiModel.mockReturnValueOnce(refused('HTTP 401: Invalid API key'))
  expect(await source.onAdd('acme', 'bge-m3')).toBe(false)
  expect(snapshot()).toMatchObject({ busy: false, failure: { message: 'HTTP 401: Invalid API key', users: null } })
  d.removeApiModel.mockReturnValueOnce(Promise.resolve({ ok: false as const, error: { code: 'embedding/model-in-use', message: 'used', details: { id: 'acme/bge-m3', users: ['产品手册'] } } } as never))
  await source.onRemoveApi('acme/bge-m3')
  expect(snapshot().failure).toEqual({ message: 'used', users: ['产品手册'] })
  expect(await source.onAdd('acme', 'bge-m3')).toBe(true)
  expect(snapshot().failure).toBeNull()
  await source.onRemoveApi('acme/bge-m3')
  expect(d.removeApiModel).toHaveBeenLastCalledWith('acme/bge-m3')
  d.listProviders.mockReturnValueOnce(refused('offline'))
  await source.onRefreshProviders()
  expect(snapshot().providers).toHaveLength(1)
  source.onOpenModels()
  expect(d.openModels).toHaveBeenCalledOnce()
})
