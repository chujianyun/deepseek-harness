import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TestSessions } from '../src/sessions.ts'

it('records a delete and answers it as met, keeping the fixture', async () => {
  const ctx = new Context()
  const sessions = new TestSessions(async (action) => { await action() }, ctx)
  const id = 's1' as SessionId
  expect(await sessions.delete(id)).toEqual({ ok: true, value: { deletedSessionIds: [id] } })
  expect(sessions.calls).toEqual([{ method: 'delete', args: [id] }])
  await sessions.disposeScopes()
  await ctx.fiber.dispose()
})
