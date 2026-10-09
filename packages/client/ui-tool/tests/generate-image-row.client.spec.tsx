// @vitest-environment jsdom
// generate_image on the web side: the Tool row (prompt summary, the result's own
// text as its body), the Turn data folding each Turn's generated images, and the
// Turn-tail entry showing them under the answer through `tool.call.generated-images`.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { StartedToolCall, ToolResultNode, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationMatch, ConversationStartMatch, MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolImagesOwnerProps, ToolTreeProps } from '../src/client/contract/slots.ts'
import { GenerateImageRow, generateImageToolview, generatedImageText } from '../src/client/tool/toolviews/generate-image-row.tsx'
import { generatedImagesDefinition, generatedImagesForClosing } from '../src/client/tool/generated/generated-images.ts'
import type { GeneratedImagesTurnData } from '../src/client/tool/generated/generated-images.ts'
import { GeneratedImagesTail } from '../src/client/tool/generated/GeneratedImagesTail.tsx'

afterEach(cleanup)

const SID = 's1' as SessionId
const t: ToolTreeProps['t'] = makeTranslate(zh, commonZh)
const ARGS = '{"prompt":"一只橘猫在窗台上晒太阳","size":"1536x1024"}'
const TEXT = 'Generated a 1536x1024 image/png image; it is shown to the user.\nRevised prompt: An orange cat on a sunny windowsill.'
const image: ImageAttachmentRef = {
  attachmentId: AttachmentId('sha256:ab12'), mediaType: 'image/png', bytes: 2048, width: 1536, height: 1024, name: 'generated-image.png',
}

const running = (): StartedToolCall => ({
  phase: 'start' as const, args: PartialArguments.fromText(ARGS), callId: 'c1', name: 'generate_image', argsRaw: ARGS,
  turn: 1, step: 1, time: 1_000, subCalls: [],
})

const settled = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1', name: 'generate_image',
  args: PartialArguments.fromText(ARGS), call: { name: 'generate_image', argsRaw: ARGS }, callTime: 1_000,
  content: [{ type: 'text', text: TEXT }, { type: 'image', attachment: image }],
  isError: false, subCalls: [], ...over,
})

const list = () => createSnapshotStore<SessionListState>({
  ids: [SID],
  byId: { [SID]: { id: SID, displayTitle: 'r', running: false, blank: false, updatedAt: 0, cwd: '/w/app' } },
  current: SID, phase: 'ready', projectionsBySession: {}, jobsBySession: {}, currentAddress: undefined,
} as never)

const rowProps = (block: StartedToolCall | ToolResultNode) => ({
  useDisclosure, callId: 'c1', toolName: 'generate_image',
  ...('kind' in block ? { phase: 'result' as const, block } : { phase: block.phase, block }),
  openFile: vi.fn(), loadImage: vi.fn(), sessionId: SID, useSessions: bindSnapshotSelector(list()), t,
}) as never as Parameters<typeof GenerateImageRow>[0]

describe('GenerateImageRow', () => {
  it('titles the row by the tool, summarizes it by the prompt, and expands to the result text', () => {
    const view = render(<GenerateImageRow {...rowProps(settled())} />)
    expect(view.container.textContent).toContain('生成图片')
    expect(view.container.textContent).toContain('一只橘猫在窗台上晒太阳')
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    expect(view.container.textContent).toContain('Revised prompt: An orange cat on a sunny windowsill.')
    expect(view.container.textContent).not.toContain('attachmentId')
  })

  it('shows a refusal as the row error', () => {
    const view = render(<GenerateImageRow {...rowProps(settled({
      isError: true, content: [{ type: 'text', text: 'Cannot generate images: no ChatGPT (Codex) account is signed in.' }],
    }))} />)
    expect(view.container.querySelector('[data-state]')?.getAttribute('data-state')).toBe('error')
    expect(view.container.textContent).toContain('no ChatGPT (Codex) account is signed in')
  })

  it('reads the result text only once the call settles', () => {
    expect(generatedImageText(running())).toBeNull()
    expect(generatedImageText(settled())).toBe(TEXT)
    render(<GenerateImageRow {...rowProps(running())} />)
  })

  it('registers under the generate_image key of the keyed toolview slot', () => {
    const registered: unknown[] = []
    const ctx = { slots: {
      inject: (_name: string, callback: () => () => void) => callback(),
      register: (options: unknown) => { registered.push(options); return () => undefined },
    } } as never
    generateImageToolview.apply(ctx)
    expect(registered).toEqual([{ name: 'tool.call.toolview', key: 'generate_image', locale: 'conversation' }])
    expect(generateImageToolview.inject).toEqual(['slots'])
  })
})

const event = (seq: number, type: string, data: unknown) =>
  ({ seq, time: seq, type, data, ...type === 'tool/result' ? { surfaceOp: 'append' } : {} }) as never
const update = (value: SessionEvent): ConversationMatch => ({ event: value, role: 'update', location: { kind: 'unresolved' } })
const callEvent = (seq: number, callId: string, name = 'generate_image') => event(seq, 'tool/call', { turn: 1, step: 1, callId, name, arguments: ARGS })
const resultEvent = (seq: number, callId: string, content: unknown[], isError = false) =>
  event(seq, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId }, content, isError } })

describe('generatedImagesDefinition', () => {
  const start = (): ConversationStartMatch => ({
    event: event(1, 'turn/start', { turn: 1 }), role: 'start', location: { kind: 'unresolved' },
  })
  const base = { key: 'generated-images:1', kind: 'generated-images', id: '1', matches: [], current: new Map() }
  const fold = (events: SessionEvent[]) => {
    let state = generatedImagesDefinition.start({ ...base, start: start(), state: undefined }, start(), { previous: () => undefined })
    for (const value of events) {
      if (generatedImagesDefinition.match(value) === null) continue
      state = generatedImagesDefinition.update({ ...base, start: start(), state }, update(value))
    }
    return state
  }

  it('matches the Turn start, generate_image calls, and appended results only', () => {
    expect(generatedImagesDefinition.match(event(1, 'turn/start', { turn: 3 }))).toEqual({ id: '3', role: 'start' })
    expect(generatedImagesDefinition.match(callEvent(2, 'c1'))).toEqual({ id: '1', role: 'update' })
    expect(generatedImagesDefinition.match(callEvent(2, 'c1', 'read'))).toBeNull()
    expect(generatedImagesDefinition.match(resultEvent(3, 'c1', []))).toEqual({ id: '1', role: 'update' })
    expect(generatedImagesDefinition.match(event(3, 'turn/end', { turn: 1 }))).toBeNull()
    const notStart = { ...start(), event: event(1, 'turn/end', {}) }
    expect(() => generatedImagesDefinition.start({ ...base, start: notStart, state: undefined }, notStart, { previous: () => undefined }))
      .toThrow('generated-images start requires turn/start')
  })

  it('collects the images of successful generate_image results, in order', () => {
    const state = fold([
      callEvent(2, 'c1'), resultEvent(3, 'c1', [{ type: 'text', text: TEXT }, { type: 'image', attachment: image }]),
      // A failed generation, a result of another tool, and a result without an image add nothing.
      callEvent(4, 'c2'), resultEvent(5, 'c2', [{ type: 'text', text: 'refused' }], true),
      resultEvent(6, 'other', [{ type: 'image', attachment: image }]),
      callEvent(7, 'c3'), resultEvent(8, 'c3', [{ type: 'text', text: 'no image' }]),
      event(9, 'turn/end', { turn: 1 }),
    ])
    expect(state.images).toEqual([{ seq: 3, attachment: image }])
  })

  it('publishes Turn data only for a Turn that generated images, reusing an unchanged publication', () => {
    const empty = fold([])
    expect(generatedImagesDefinition.buildLocationData!({ state: empty } as never, 'turn', null)).toBeNull()
    const state = fold([callEvent(2, 'c1'), resultEvent(3, 'c1', [{ type: 'image', attachment: image }])])
    const published = generatedImagesDefinition.buildLocationData!({ state } as never, 'turn', null)
    expect(published).toEqual({ kind: 'turn', turn: 1, key: 'generated-images', value: { images: state.images } })
    expect(generatedImagesDefinition.buildLocationData!({ state } as never, 'turn', published)).toBe(published)
    expect(generatedImagesDefinition.buildLocationData!({ state } as never, 'step', null)).toBeNull()
    expect(generatedImagesDefinition.buildLocationData!({ state: undefined } as never, 'turn', null)).toBeNull()
  })
})

describe('GeneratedImagesTail', () => {
  const owner = (images: GeneratedImagesTurnData['images'] | undefined, seq = 20): TurnTailOwnerProps => ({
    turn: { data: new Map(images === undefined ? [] : [['generated-images', { images }]]) } as never,
    seq,
    openFile: vi.fn(),
  })
  const gallery = () => vi.fn((_key: 'tool.call.generated-images', props: ToolImagesOwnerProps) => (
    <div data-images>{props.images.length}</div>
  ))
  const loadImage: MessageImageLoader = vi.fn(() => Promise.reject(new Error('not used')))
  type TailProps = Parameters<typeof GeneratedImagesTail>[0]
  const tail = (props: Record<string, unknown>) => <GeneratedImagesTail {...props as never as TailProps} />

  it('shows the Turn\'s images produced before its closing sequence', () => {
    const renderSlot = gallery()
    const later = { seq: 30, attachment: { ...image, attachmentId: AttachmentId('sha256:cd34') } }
    const view = render(tail({ ...owner([{ seq: 3, attachment: image }, later]), loadImage, renderSlot }))
    expect(view.container.querySelector('[data-generated-images]')).not.toBeNull()
    expect(renderSlot).toHaveBeenCalledWith('tool.call.generated-images', { images: [{ attachment: image }], loadImage, align: 'start' })
    expect(generatedImagesForClosing(owner([later]))).toEqual([])
  })

  it('renders nothing for a Turn without images or before the loader is injected', () => {
    const renderSlot = gallery()
    expect(render(tail({ ...owner(undefined), loadImage, renderSlot })).container.innerHTML).toBe('')
    expect(render(tail({ ...owner([{ seq: 3, attachment: image }]), renderSlot })).container.innerHTML).toBe('')
    expect(renderSlot).not.toHaveBeenCalled()
  })
})
