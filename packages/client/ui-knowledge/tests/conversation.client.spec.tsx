// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { KnowledgeBaseView, KnowledgeState } from '@deepseek-ai/dsh-knowledge-base/types'
import type { KnowledgeCitation, KnowledgeSelectionProjection } from '@deepseek-ai/dsh-knowledge-selection/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { citationsDefinition, knowledgeCitations, turnSources, type KnowledgeCitations } from '../src/client/citations.ts'
import type { KnowledgeSnapshot } from '../src/client/knowledge-source.ts'
import { KnowledgeCitationsCard } from '../src/client/KnowledgeCitations.tsx'
import { KnowledgePicker } from '../src/client/KnowledgePicker.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const t = makeTranslate(zh)
const cite = (over: Partial<KnowledgeCitation> & Pick<KnowledgeCitation, 'itemId' | 'item'>): KnowledgeCitation => ({
  knowledgeBaseId: 'b1', knowledgeBase: '公司制度', kind: 'file', chunk: 1, score: 0.5, snippet: '员工入职满一年享有年假。', ...over,
})
const result = (callId: string, citations: unknown): { type: string; data: unknown } => ({
  type: 'tool/result', data: { message: { role: 'tool', toolCallId: callId, content: 'x' }, meta: { citations } },
})

describe('knowledge citations from logged results', () => {
  it('reads the citations of a knowledge_search result and nothing else', () => {
    const one = cite({ itemId: 'f1', item: '年假制度.docx', source: '/a/年假制度.docx' })
    expect(knowledgeCitations(result('c1', [one]))).toEqual({ callId: 'c1', citations: [one] })
    expect(knowledgeCitations(result('c1', []))).toEqual({ callId: 'c1', citations: [] })
    expect(knowledgeCitations({ type: 'tool/call', data: {} })).toBeUndefined()
    expect(knowledgeCitations({ type: 'tool/result', data: null })).toBeUndefined()
    expect(knowledgeCitations({ type: 'tool/result', data: { message: { toolCallId: 'c1' } } })).toBeUndefined()
    expect(knowledgeCitations({ type: 'tool/result', data: { message: { toolCallId: 'c1' }, meta: { rows: 1 } } })).toBeUndefined()
    expect(knowledgeCitations({ type: 'tool/result', data: { message: 'x', meta: { citations: [] } } })).toBeUndefined()
    expect(knowledgeCitations(result('c1', [{ ...one, kind: 'folder' }]))).toBeUndefined()
    expect(knowledgeCitations(result('c1', [{ ...one, score: '1' }]))).toBeUndefined()
    expect(knowledgeCitations(result('c1', [{ ...one, source: 3 }]))).toBeUndefined()
    expect(knowledgeCitations(result('c1', [{ ...one, item: null }]))).toBeUndefined()
    expect(knowledgeCitations(result('c1', [[]]))).toBeUndefined()
  })

  it('lists each cited item once with its best passage, best first', () => {
    const sources = turnSources([
      { callId: 'c1', citations: [cite({ itemId: 'f1', item: 'a', score: 0.4 }), cite({ itemId: 'f2', item: 'b', score: 0.7 })] },
      { callId: 'c2', citations: [cite({ itemId: 'f1', item: 'a', score: 0.9, chunk: 3 }), cite({ itemId: 'f2', item: 'b', score: 0.2 })] },
      { callId: 'c3', citations: [cite({ knowledgeBaseId: 'b2', itemId: 'f1', item: 'a', score: 0.1 })] },
    ])
    expect(sources.map(entry => [entry.knowledgeBaseId, entry.itemId, entry.score, entry.chunk])).toEqual([
      ['b1', 'f1', 0.9, 3], ['b1', 'f2', 0.7, 1], ['b2', 'f1', 0.1, 1],
    ])
  })

  it('builds one hidden Chat node per result, anchored at its event', () => {
    const event = { ...result('c1', [cite({ itemId: 'f1', item: 'a' })]), seq: 9 }
    const match = citationsDefinition.match(event as never)
    expect(match).toEqual({ id: 'c1', role: 'start' })
    expect(citationsDefinition.match({ type: 'tool/call', data: {} } as never)).toBeNull()
    const state = citationsDefinition.start({} as never, { event } as never)
    expect(citationsDefinition.update({ state } as never)).toBe(state)
    const start = { event, location: { kind: 'main' } }
    expect(citationsDefinition.buildViewNode({ key: 'k', id: 'c1', state, start, matches: [] } as never)).toEqual({
      key: 'k', kind: 'knowledge-citations', id: 'c1', target: 'chat', anchorSeq: 9, location: { kind: 'main' }, visibility: 'hidden', data: state,
    })
    expect(citationsDefinition.buildViewNode({ key: 'k', id: 'c1', state, matches: [start] } as never)).toMatchObject({ anchorSeq: 9 })
    expect(citationsDefinition.buildViewNode({ key: 'k', id: 'c1', state: undefined, matches: [start] } as never)).toBeNull()
    expect(citationsDefinition.buildViewNode({ key: 'k', id: 'c1', state, matches: [] } as never)).toBeNull()
  })
})

describe('KnowledgeCitationsCard', () => {
  function mount(results: readonly KnowledgeCitations[] | undefined, opened = true) {
    const openItem = vi.fn(async (_citation: KnowledgeCitation) => opened)
    const openUrl = vi.fn((_url: string) => {})
    const useCitations = vi.fn((_turn: string) => results)
    const props = { turn: { turn: 4 }, useCitations, openItem, openUrl, t } as Parameters<typeof KnowledgeCitationsCard>[0]
    render(<KnowledgeCitationsCard {...props} />)
    return { openItem, openUrl, useCitations }
  }

  it('shows nothing for a Turn without results or passages', () => {
    const { useCitations } = mount(undefined)
    expect(useCitations).toHaveBeenCalledWith('4')
    cleanup()
    mount([{ callId: 'c1', citations: [] }])
    expect(screen.queryByRole('region', { name: '引用来源' })).toBeNull()
  })

  it('opens a file or note copy on this machine and a page in the browser, and says when a copy is gone', async () => {
    const file = cite({ itemId: 'f1', item: '年假制度.docx', score: 0.9, chunk: 2 })
    const note = cite({ itemId: 'n1', item: '报销提醒', kind: 'note', score: 0.6 })
    const page = cite({ itemId: 'u1', item: '内网公告', kind: 'url', source: 'https://intra.example.com/n', score: 0.5 })
    const bare = cite({ itemId: 'u2', item: '无地址', kind: 'url', score: 0.1 })
    const { openItem, openUrl } = mount([{ callId: 'c1', citations: [file, note, page, bare] }], false)
    const region = screen.getByRole('region', { name: '引用来源' })
    expect(region.textContent).toContain('公司制度 · 第 2 块')
    expect(region.textContent).toContain('员工入职满一年享有年假。')
    fireEvent.click(screen.getByRole('button', { name: '在浏览器中打开 内网公告' }))
    expect(openUrl).toHaveBeenCalledWith('https://intra.example.com/n')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开 年假制度.docx' })) })
    expect(openItem).toHaveBeenCalledWith(file)
    expect(screen.getByRole('alert').textContent).toBe('无法打开 年假制度.docx：它的副本已不在本机。')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开 报销提醒' })) })
    expect(openItem).toHaveBeenLastCalledWith(note)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '在浏览器中打开 无地址' })) })
    expect(openItem).toHaveBeenLastCalledWith(bare)
  })

  it('clears the failure once a source opens', async () => {
    mount([{ callId: 'c1', citations: [cite({ itemId: 'f1', item: 'a.md' })] }])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开 a.md' })) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('KnowledgePicker', () => {
  const base = (id: string, name: string, status: KnowledgeBaseView['status'] = 'ready'): KnowledgeBaseView => ({
    id, name, embeddingModelId: 'local/q', embeddingModelName: 'Q', status, createdAt: '2026-10-05T00:00:00.000Z', dimensions: 4, items: [],
    settings: { chunkStrategy: 'structured', chunkSeparator: '\\n\\n', chunkSize: 1024, chunkOverlap: 200, documentCount: 6, threshold: 0 },
  })

  function mount(state: KnowledgeState | undefined, selection: KnowledgeSelectionProjection | undefined, outcome: () => Promise<'now' | 'next-step' | { failure: string }>) {
    const store = createSnapshotStore<KnowledgeSnapshot>({
      state, embedding: undefined, selectedId: null, busy: false, failure: null, added: null, recall: null,
    })
    const select = vi.fn(async (_ids: string[]) => outcome())
    const useKnowledge = bindSnapshotSelector(store)
    const props = { useProjection: () => selection, useKnowledge, select, t } as Parameters<typeof KnowledgePicker>[0]
    render(<KnowledgePicker {...props} />)
    return { select }
  }

  it('shows nothing while signed out', () => {
    mount(undefined, undefined, async () => 'now' as const)
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    mount({ revision: 1, tenantId: null, bases: [] }, undefined, async () => 'now' as const)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers no knowledge base before one exists, and closes on a second click', () => {
    mount({ revision: 1, tenantId: 't', bases: [] }, undefined, async () => 'now' as const)
    const button = screen.getByRole('button', { name: '知识库' })
    fireEvent.click(button)
    expect(screen.getByRole('group', { name: '本次会话可检索的知识库' }).textContent).toContain('还没有知识库')
    fireEvent.click(button)
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('selects knowledge bases for the session, marks those it cannot search yet, and tells when a choice waits for the next step', async () => {
    const answers: Array<'now' | 'next-step' | { failure: string }> = ['now', 'next-step', { failure: 'no knowledge base b9' }]
    const { select } = mount(
      { revision: 1, tenantId: 't', bases: [base('b1', '公司制度'), base('b2', '产品资料', 'rebuilding'), base('b3', '旧库', 'unavailable')] },
      { bases: [{ id: 'b1', name: '公司制度' }] },
      async () => answers.shift() ?? 'now',
    )
    fireEvent.click(screen.getByRole('button', { name: '知识库 1' }))
    const group = screen.getByRole('group')
    expect(group.textContent).toContain('重建中')
    expect(group.textContent).toContain('暂不可用')
    expect(screen.getByRole('checkbox', { name: '公司制度' })).toHaveProperty('checked', true)
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: '产品资料' })) })
    expect(select).toHaveBeenLastCalledWith(['b1', 'b2'])
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: '公司制度' })) })
    expect(select).toHaveBeenLastCalledWith([])
    expect(screen.getByRole('status').textContent).toBe('已勾选，从模型的下一步开始生效。')
    expect(screen.getByRole('button', { name: '知识库' })).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: '旧库' })) })
    expect(select).toHaveBeenLastCalledWith(['b3'])
    expect(screen.getByRole('status').textContent).toBe('no knowledge base b9')
    expect(screen.getByRole('checkbox', { name: '旧库' })).toHaveProperty('checked', false)
    expect(screen.getByRole('checkbox', { name: '公司制度' })).toHaveProperty('checked', true)
  })

  it('starts from no selection when the session has logged none', async () => {
    const { select } = mount({ revision: 1, tenantId: 't', bases: [base('b1', '公司制度')] }, undefined, async () => 'now' as const)
    fireEvent.click(screen.getByRole('button', { name: '知识库' }))
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: '公司制度' })) })
    expect(select).toHaveBeenCalledWith(['b1'])
  })
})
