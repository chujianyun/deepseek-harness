// @vitest-environment jsdom
/** The row mark, the hover line, and the view-only composer rendered directly with hand-built props. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { en, zh } from '../src/client/locales.ts'
import {
  PulledBadge, PulledComposer, PulledHover, type PulledBadgeProps, type PulledDevices, type PulledHoverProps,
} from '../src/client/SessionSync.tsx'

afterEach(cleanup)

const pulled: PulledDevices = { ['from-a' as SessionId]: '前台电脑' }
const rowProps = (sessionId: string, copy = zh) => ({
  sessionId: sessionId as SessionId, t: makeTranslate(copy), usePulled: bindSnapshotSelector(createSnapshotStore(pulled)),
}) as Partial<PulledBadgeProps & PulledHoverProps> as PulledBadgeProps & PulledHoverProps

describe('rows of conversations from other computers', () => {
  it.each([[zh, '来自其他电脑：前台电脑'], [en, 'From another computer: 前台电脑']])('marks the row with the computer\'s name', (copy, label) => {
    render(<PulledBadge {...rowProps('from-a', copy)} />)
    expect(screen.getByRole('img', { name: label })).toHaveProperty('title', label)
  })

  it('names the computer in the hover card', () => {
    render(<PulledHover {...rowProps('from-a')} />)
    expect(screen.getByText('来自其他电脑 · 前台电脑')).toBeDefined()
  })

  it('leaves this computer\'s own rows alone', () => {
    const { container } = render(<><PulledBadge {...rowProps('own')} /><PulledHover {...rowProps('own')} /></>)
    expect(container.innerHTML).toBe('')
  })
})

describe('view-only composer', () => {
  it.each([
    [zh, '来自「前台电脑」的对话', '在这台电脑上只能查看，不能继续对话。'],
    [en, 'Conversation from “前台电脑”', 'On this computer it can be read, not continued.'],
  ])('says where the conversation comes from and that it is view-only', (copy, title, body) => {
    render(<PulledComposer matched={{ device: '前台电脑' }} t={makeTranslate(copy)} />)
    expect(screen.getByRole('status').textContent).toBe(`${title}${body}`)
  })
})
